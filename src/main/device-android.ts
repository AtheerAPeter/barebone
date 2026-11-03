import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'
import type { DeviceButton, MobileDevice } from '../shared/types'
import {
  run,
  sleep,
  type DeviceDriver,
  type ScreenElement,
  type ScreenSize,
  type TextSize
} from './device-driver'
import { lineSplitter, type DeviceLogs, type LogLevel } from './device-logs'
import type { EmulatorGrpc, Pixels } from './emulator-grpc'
import { commandPath } from './shell-env'

/**
 * Android emulators and phones, through adb, and for emulators also through
 * their gRPC control channel (emulator-grpc.ts) where it is faster or can do
 * more: the screen, touches and typing.
 */

/** The Android SDK, where Android Studio and the command-line tools put it. */
export function androidSdk(): string | undefined {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library/Android/sdk'),
    join(homedir(), 'Android/Sdk'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android/Sdk')
  ]
  return candidates.find((dir): dir is string => Boolean(dir && existsSync(dir)))
}

const exe = process.platform === 'win32' ? '.exe' : ''

/** adb from the SDK, else from PATH. */
export async function adbPath(): Promise<string | undefined> {
  const sdk = androidSdk()
  const inSdk = sdk && join(sdk, 'platform-tools', `adb${exe}`)
  return inSdk && existsSync(inSdk) ? inSdk : commandPath('adb')
}

/** The emulator from the SDK, else from PATH. */
export async function emulatorPath(): Promise<string | undefined> {
  const sdk = androidSdk()
  const inSdk = sdk && join(sdk, 'emulator', `emulator${exe}`)
  return inSdk && existsSync(inSdk) ? inSdk : commandPath('emulator')
}

/** How long Android's UI dump may take; it waits for the screen to stop changing, which some never do. */
const DUMP_TIMEOUT_MS = 6_000

const KEY_CODES: Record<DeviceButton | 'enter' | 'backspace' | 'paste', number> = {
  home: 3,
  back: 4,
  'app-switch': 187,
  lock: 26,
  'volume-up': 24,
  'volume-down': 25,
  enter: 66,
  backspace: 67,
  paste: 279
}

const FONT_SCALES: Record<TextSize, string> = {
  small: '0.85',
  default: '1.0',
  large: '1.3',
  largest: '2.0'
}

/** A string as one argument of the device's shell, which `adb shell` hands its arguments to joined. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** RGBA pixels as an image; Electron's bitmaps are BGRA. */
function rgbaImage({ rgba, width, height }: Pixels): NativeImage {
  const bgra = Buffer.from(rgba)
  for (let i = 0; i < bgra.length; i += 4) {
    const red = bgra[i]
    bgra[i] = bgra[i + 2]
    bgra[i + 2] = red
  }
  return nativeImage.createFromBitmap(bgra, { width, height })
}

export class AndroidDevice implements DeviceDriver {
  private screen?: Promise<ScreenSize>

  constructor(
    readonly info: MobileDevice,
    private readonly adb: string,
    /** The emulator's control channel; none for phones and emulators without it. */
    private readonly emulator: EmulatorGrpc | undefined
  ) {}

  private shell(args: string[], timeout?: number): Promise<string> {
    return run(this.adb, ['-s', this.info.id, 'shell', ...args], { timeout }).then((out) =>
      out.toString()
    )
  }

  size(): Promise<ScreenSize> {
    this.screen ??= (async () => {
      // An override (wm size 720x1280) is what apps see, so it wins over the physical size.
      const sizes = await this.shell(['wm', 'size'])
      const densities = await this.shell(['wm', 'density'])
      const size = (
        sizes.match(/Override size: (\d+)x(\d+)/) ?? sizes.match(/Physical size: (\d+)x(\d+)/)
      )?.slice(1)
      const density = (densities.match(/Override density: (\d+)/) ??
        densities.match(/Physical density: (\d+)/))?.[1]
      if (!size || !density) throw new Error(`Could not read the screen size of ${this.info.name}.`)
      const scale = Number(density) / 160
      return {
        width: Math.round(Number(size[0]) / scale),
        height: Math.round(Number(size[1]) / scale),
        scale
      }
    })().catch((error) => {
      this.screen = undefined
      throw error
    })
    return this.screen
  }

  async screenshot(): Promise<NativeImage> {
    const { width, height } = await this.size()
    if (this.emulator) {
      // About this size: the emulator keeps the screen's shape, so it can be off by a pixel.
      return rgbaImage(await this.emulator.screenshot(width, height)).resize({ width, height })
    }
    const png = await run(this.adb, ['-s', this.info.id, 'exec-out', 'screencap', '-p'])
    return nativeImage.createFromBuffer(png).resize({ width, height, quality: 'good' })
  }

  async elements(): Promise<ScreenElement[]> {
    const { scale } = await this.size()
    let xml: string
    try {
      xml = (
        await run(this.adb, ['-s', this.info.id, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
          timeout: DUMP_TIMEOUT_MS
        })
      ).toString()
    } catch (error) {
      // The dump goes on on the device after adb gives up, and the next one queues behind it.
      await this.shell(['pkill', '-f', 'uiautomator']).catch(() => undefined)
      throw new Error(
        `Android's UI dump did not finish within ${DUMP_TIMEOUT_MS / 1000}s. It waits for the screen to stop changing, and something on it keeps moving (an animation, a spinner, streaming text). (${(error as Error).message})`
      )
    }
    return androidElements(xml, scale)
  }

  private async pixels(x: number, y: number): Promise<[number, number]> {
    const { scale } = await this.size()
    return [Math.round(x * scale), Math.round(y * scale)]
  }

  async tap(x: number, y: number): Promise<void> {
    const [px, py] = await this.pixels(x, y)
    if (this.emulator) {
      await this.emulator.touch(px, py, 1)
      await sleep(50)
      await this.emulator.touch(px, py, 0)
    } else {
      await this.shell(['input', 'tap', String(px), String(py)])
    }
  }

  async hold(x: number, y: number, ms: number): Promise<void> {
    const [px, py] = await this.pixels(x, y)
    if (this.emulator) {
      await this.emulator.touch(px, py, 1)
      await sleep(ms)
      await this.emulator.touch(px, py, 0)
    } else {
      await this.shell([
        'input',
        'swipe',
        String(px),
        String(py),
        String(px),
        String(py),
        String(ms)
      ])
    }
  }

  async swipe(x: number, y: number, toX: number, toY: number, ms: number): Promise<void> {
    const [px, py] = await this.pixels(x, y)
    const [tx, ty] = await this.pixels(toX, toY)
    if (!this.emulator) {
      await this.shell([
        'input',
        'swipe',
        String(px),
        String(py),
        String(tx),
        String(ty),
        String(ms)
      ])
      return
    }
    // A finger moving at the screen's frame rate, as a real swipe reaches the app.
    const steps = Math.max(5, Math.round(ms / 16))
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      await this.emulator.touch(px + (tx - px) * t, py + (ty - py) * t, 1)
      await sleep(ms / steps)
    }
    await this.emulator.touch(tx, ty, 0)
  }

  async type(text: string): Promise<void> {
    if (this.emulator) {
      // Pasted, any characters (ä, é, emoji): through the emulator's clipboard and Android's paste key.
      await this.emulator.clipboard(text)
      await this.shell(['input', 'keyevent', String(KEY_CODES.paste)])
      return
    }
    // `input text` takes no spaces (%s stands for one) and only ASCII.
    if (!/^[\x20-\x7e]*$/.test(text)) {
      throw new Error(
        `${this.info.name} can only be sent ASCII text: adb has no way to type other characters on a phone.`
      )
    }
    await this.shell(['input', 'text', shellQuote(text.replace(/ /g, '%s'))])
  }

  async key(key: 'enter' | 'backspace'): Promise<void> {
    await this.shell(['input', 'keyevent', String(KEY_CODES[key])])
  }

  async button(button: DeviceButton): Promise<void> {
    await this.shell(['input', 'keyevent', String(KEY_CODES[button])])
  }

  async openUrl(url: string): Promise<void> {
    const out = await this.shell([
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      shellQuote(url)
    ])
    if (/Error:/.test(out)) throw new Error(out.trim())
  }

  async launch(app: string): Promise<void> {
    // The activity the home screen opens the app with, like com.example/.MainActivity.
    const resolved = await this.shell([
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-c',
      'android.intent.category.LAUNCHER',
      shellQuote(app)
    ])
    const activity = resolved.trim().split('\n').at(-1)?.trim()
    if (!activity?.includes('/')) {
      throw new Error(`${app} is not installed, or has no activity to launch.`)
    }
    const out = await this.shell(['am', 'start', '-n', shellQuote(activity)])
    if (/Error:/.test(out)) throw new Error(out.trim())
  }

  async terminate(app: string): Promise<void> {
    await this.shell(['am', 'force-stop', shellQuote(app)])
  }

  async install(path: string): Promise<void> {
    await run(this.adb, ['-s', this.info.id, 'install', '-r', path], { timeout: 300_000 })
  }

  async uninstall(app: string): Promise<void> {
    await run(this.adb, ['-s', this.info.id, 'uninstall', app])
  }

  async apps(): Promise<string[]> {
    const out = await this.shell(['pm', 'list', 'packages', '-3'])
    return out
      .split('\n')
      .map((line) => line.replace(/^package:/, '').trim())
      .filter(Boolean)
      .sort()
  }

  async appearance(mode: 'light' | 'dark'): Promise<void> {
    await this.shell(['cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no'])
  }

  async textSize(size: TextSize): Promise<void> {
    await this.shell(['settings', 'put', 'system', 'font_scale', FONT_SCALES[size]])
  }

  async location(latitude: number, longitude: number): Promise<void> {
    if (this.emulator) return this.emulator.gps(latitude, longitude)
    if (this.info.physical)
      throw new Error(`The location of ${this.info.name}, a phone, cannot be set.`)
    await run(this.adb, [
      '-s',
      this.info.id,
      'emu',
      'geo',
      'fix',
      String(longitude),
      String(latitude)
    ])
  }

  async permission(app: string, name: string, action: 'grant' | 'revoke' | 'reset'): Promise<void> {
    const permission = name.includes('.') ? name : `android.permission.${name.toUpperCase()}`
    if (action === 'grant') {
      await this.shell(['pm', 'grant', shellQuote(app), permission])
      return
    }
    await this.shell(['pm', 'revoke', shellQuote(app), permission])
    if (action === 'reset') {
      // Asked again on next use, as if never answered.
      await this.shell([
        'pm',
        'clear-permission-flags',
        shellQuote(app),
        permission,
        'user-set',
        'user-fixed'
      ])
    }
  }

  collectLogs(logs: DeviceLogs): () => void {
    // From now on: what was logged before is in `adb logcat -d`.
    const child = spawn(
      this.adb,
      ['-s', this.info.id, 'logcat', '-v', 'threadtime', '-T', '1', '-b', 'main,system,crash'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    let buffer = 'main'
    child.stdout.on(
      'data',
      lineSplitter((line) => {
        const marker = line.match(/^--------- (?:beginning of|switch to) (\w+)/)
        if (marker) {
          buffer = marker[1]
          return
        }
        const match = line.match(
          /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+\d+ ([VDIWEFA]) (.*?)\s*: (.*)$/
        )
        if (!match) return
        const [, pid, level, tag, text] = match
        logs.add({
          time: Date.now(),
          source: this.info.name,
          level: LOG_LEVELS[level],
          tag,
          text,
          pid: Number(pid),
          js: tag === 'ReactNativeJS',
          crash: buffer === 'crash' || (tag === 'AndroidRuntime' && level === 'E')
        })
      })
    )
    child.on('error', (error) => console.error(`logcat of ${this.info.name}:`, error))
    return () => child.kill()
  }

  /** The process IDs an app runs as now, to find its lines in the log. */
  async pids(app: string): Promise<number[]> {
    const out = await this.shell(['pidof', shellQuote(app)]).catch(() => '')
    return out.split(/\s+/).filter(Boolean).map(Number)
  }

  async shutdown(): Promise<void> {
    if (this.info.physical)
      throw new Error(`${this.info.name} is a phone; it cannot be shut down from here.`)
    await run(this.adb, ['-s', this.info.id, 'emu', 'kill'])
  }

  close(): void {
    this.emulator?.close()
  }
}

const LOG_LEVELS: Record<string, LogLevel> = {
  V: 'debug',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'error',
  A: 'error'
}

interface XmlNode {
  attrs: Record<string, string>
  children: XmlNode[]
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** uiautomator's XML as a tree of nodes. */
function parseDump(xml: string): XmlNode[] {
  const roots: XmlNode[] = []
  const open: XmlNode[] = []
  for (const [, attributes, selfClosing, closing] of xml.matchAll(
    /<node\b([^>]*?)(\/?)>|(<\/node>)/g
  )) {
    if (closing) {
      open.pop()
      continue
    }
    const node: XmlNode = {
      attrs: Object.fromEntries(
        [...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [
          key,
          decodeXml(value)
        ])
      ),
      children: []
    }
    ;(open.at(-1)?.children ?? roots).push(node)
    if (!selfClosing) open.push(node)
  }
  return roots
}

function roleOf(attrs: Record<string, string>): string {
  const type = attrs.class ?? ''
  if (/EditText/.test(type)) return 'textfield'
  if (/Switch|CheckBox|ToggleButton|RadioButton/.test(type) || attrs.checkable === 'true') {
    return 'switch'
  }
  if (attrs.clickable === 'true' || /Button/.test(type)) return 'button'
  if (/Image/.test(type)) return 'image'
  if (attrs.scrollable === 'true') return 'scroll'
  return 'text'
}

/** The text of a node's descendants, which is what a button made of a view and a text reads as. */
function innerText(node: XmlNode): string {
  return node.children
    .flatMap((child) => [child.attrs['content-desc'] || child.attrs.text || '', innerText(child)])
    .filter(Boolean)
    .join(' ')
    .slice(0, 120)
}

/**
 * The elements worth naming: what can be tapped or typed into (labelled by
 * its own text, else its children's), text outside those, and what scrolls.
 */
function androidElements(xml: string, scale: number): ScreenElement[] {
  const elements: ScreenElement[] = []
  const visit = (node: XmlNode, inControl: boolean): void => {
    const { attrs } = node
    const bounds = attrs.bounds
      ?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
      ?.slice(1)
      .map(Number)
    const role = roleOf(attrs)
    const own = attrs['content-desc'] || attrs.text || ''
    const control = role === 'button' || role === 'textfield' || role === 'switch'
    const id = attrs['resource-id']?.replace(/^.*:id\//, '') || undefined
    const shown = bounds && bounds[2] > bounds[0] && bounds[3] > bounds[1]
    // Views that only hold others (the root, a layout with an ID) are left out; their text is listed.
    if (shown && (control || role === 'scroll' || (own && !inControl))) {
      const label = control && !own && role !== 'textfield' ? innerText(node) : own
      elements.push({
        role,
        label: role === 'textfield' ? attrs.hint || '' : label,
        value:
          role === 'textfield'
            ? attrs.text || undefined
            : role === 'switch'
              ? attrs.checked === 'true'
                ? 'on'
                : 'off'
              : undefined,
        id,
        x: bounds[0] / scale,
        y: bounds[1] / scale,
        width: (bounds[2] - bounds[0]) / scale,
        height: (bounds[3] - bounds[1]) / scale
      })
    }
    for (const child of node.children) visit(child, inControl || control)
  }
  for (const root of parseDump(xml)) visit(root, false)
  return elements
}
