import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { Client, Metadata, ServiceError } from '@grpc/grpc-js'

/**
 * The Android emulator's own control channel: the gRPC service every emulator
 * since 30.x runs, which Android Studio shows its emulators through. It gives
 * the screen fast (raw pixels, in milliseconds), touches without adb's
 * half-second per command, and its clipboard, which pastes any text, where
 * `adb shell input text` types only ASCII. It is used only while an agent acts.
 *
 * Its address and token are in the discovery file the emulator writes while it
 * runs, and its API in the .proto files it ships, so this works with whatever
 * version the user has.
 */
export interface EmulatorGrpc {
  /** The screen as RGBA pixels, about the given size (the emulator keeps the screen's shape). */
  screenshot(width: number, height: number): Promise<Pixels>
  /** One finger at a point in pixels; pressure 0 lifts it. */
  touch(x: number, y: number, pressure: number): Promise<void>
  /** Put text on the device's clipboard, any characters. */
  clipboard(text: string): Promise<void>
  gps(latitude: number, longitude: number): Promise<void>
  close(): void
}

/** An image as RGBA pixels. */
export interface Pixels {
  rgba: Buffer
  width: number
  height: number
}

/** An image as the emulator sends it: its pixels, and its size in its format. */
interface Image {
  image: Buffer
  format: { width: number; height: number }
}

const pixels = ({ image, format }: Image): Pixels => ({
  rgba: image,
  width: format.width,
  height: format.height
})

/** Where emulators write their discovery files, by platform (as the emulator's own code has them). */
function discoveryDirs(): string[] {
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library/Caches/TemporaryItems/avd/running')]
  }
  if (process.platform === 'win32') {
    return [join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp/avd/running')]
  }
  return [
    ...(process.env.XDG_RUNTIME_DIR ? [join(process.env.XDG_RUNTIME_DIR, 'avd/running')] : []),
    join(tmpdir(), `android-${userInfo().username}`, 'avd/running')
  ]
}

/**
 * The discovery file of the emulator with this adb serial (emulator-5554): its
 * name, which holds the emulator's process ID, and its key=value pairs.
 */
function discovery(serial: string): { file: string; entries: Record<string, string> } | undefined {
  const port = serial.match(/^emulator-(\d+)$/)?.[1]
  if (!port) return undefined
  for (const dir of discoveryDirs()) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ini'))) {
      let entries: Record<string, string>
      try {
        entries = Object.fromEntries(
          readFileSync(join(dir, file), 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.includes('='))
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
        )
      } catch {
        // The emulator removed it as it quit.
        continue
      }
      if (entries['port.serial'] === port) return { file, entries }
    }
  }
  return undefined
}

/**
 * Which run of the emulator with this adb serial is up: a restarted emulator
 * keeps its serial but writes a new discovery file, with a new token.
 */
export function emulatorRun(serial: string): string | undefined {
  return discovery(serial)?.file
}

type Call<Request, Response> = (
  request: Request,
  metadata: Metadata,
  options: { deadline: number },
  callback: (error: ServiceError | null, response: Response) => void
) => void

/** How long a call may take: a busy emulator can leave one unanswered, which would hang the tool. */
const CALL_TIMEOUT_MS = 10_000

interface Controller extends Client {
  getScreenshot: Call<object, Image>
  sendTouch: Call<object, unknown>
  setClipboard: Call<object, unknown>
  setGps: Call<object, unknown>
}

/**
 * Connect to the emulator with this adb serial; undefined when it runs no
 * gRPC service (an old emulator, one started with it turned off) or is not an
 * emulator at all.
 */
export async function connectEmulator(serial: string): Promise<EmulatorGrpc | undefined> {
  const found = discovery(serial)?.entries
  const port = found?.['grpc.port']
  const protoDir = found?.['launcher.dir'] && join(found['launcher.dir'], 'lib')
  if (!port || !protoDir || !existsSync(join(protoDir, 'emulator_controller.proto'))) {
    return undefined
  }
  // Loaded only when an emulator is used: most users never start one.
  const grpc = await import('@grpc/grpc-js')
  const loader = await import('@grpc/proto-loader')
  const definition = await loader.load(join(protoDir, 'emulator_controller.proto'), {
    keepCase: true,
    enums: String,
    defaults: true,
    includeDirs: [protoDir]
  })
  const service = (
    grpc.loadPackageDefinition(definition) as unknown as {
      android: {
        emulation: { control: { EmulatorController: new (...args: unknown[]) => Controller } }
      }
    }
  ).android.emulation.control.EmulatorController
  const client = new service(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
    // A frame at full size is several MB; the default limit is 4 MB.
    'grpc.max_receive_message_length': -1
  })
  const metadata = new grpc.Metadata()
  if (found['grpc.token']) metadata.set('authorization', `Bearer ${found['grpc.token']}`)

  const call = <Response>(method: Call<object, Response>, request: object): Promise<Response> =>
    new Promise((resolve, reject) =>
      method.call(
        client,
        request,
        metadata,
        { deadline: Date.now() + CALL_TIMEOUT_MS },
        (error, response) =>
          error
            ? reject(new Error(`Emulator: ${error.details || error.message}`))
            : resolve(response)
      )
    )
  const format = (width: number, height: number): object => ({
    format: 'RGBA8888',
    width: Math.round(width),
    height: Math.round(height)
  })

  return {
    screenshot: async (width, height) =>
      pixels(await call(client.getScreenshot, format(width, height))),
    touch: async (x, y, pressure) => {
      await call(client.sendTouch, {
        touches: [{ x: Math.round(x), y: Math.round(y), identifier: 0, pressure }]
      })
    },
    clipboard: async (text) => {
      await call(client.setClipboard, { text })
    },
    gps: async (latitude, longitude) => {
      await call(client.setGps, { latitude, longitude, satellites: 12 })
    },
    close: () => client.close()
  }
}
