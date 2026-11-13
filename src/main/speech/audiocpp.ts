import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { Package } from '../downloads'

/**
 * audio.cpp's server (github.com/0xShug0/audio.cpp), which runs the models
 * that are not Supertonic: VoxCPM2 and Stable Audio 3. It runs on Metal, on
 * this Mac only (127.0.0.1, a free port), started at the first request and
 * stopped after a while without one, which frees the memory its models take.
 * It loads a model at its first request and keeps it loaded until it stops.
 *
 * A server the app could not stop (it crashed, or was forced to quit) frees
 * its models' memory after the same while on its own, and is stopped when the
 * app starts one again: its process id is kept beside its config.
 */

/** A model the server runs, as its config takes it. */
export interface ServerModel {
  /** The name requests use. */
  id: string
  family: string
  path: string
  task: 'tts' | 'gen'
}

/** The server stops after this long without a request. */
const IDLE_MS = 5 * 60_000
/** How long it may take to answer once started, before starting fails. */
const START_MS = 30_000
/** What the server last printed, kept to say why it did not start. */
const LOG_LINES = 20

export class AudioCpp {
  private process?: ChildProcess
  /** The server's address once it answers. */
  private running?: Promise<string>
  /** The models it runs, as they were when it started. */
  private config?: string
  private idleTimer?: ReturnType<typeof setTimeout>
  /** Requests going on, waiting to start or sent: it is not idle while there are any. */
  private busy = 0
  /** Requests the server is answering now; a restart waits for them. */
  private sent = 0
  private drainWaiters: (() => void)[] = []

  constructor(
    private readonly engine: Package,
    /** The models on this Mac now; the server is started again when they change. */
    private readonly models: () => ServerModel[]
  ) {}

  /** Send a request to the server, starting it first when it is not running. */
  async request(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    this.busy++
    clearTimeout(this.idleTimer)
    try {
      const url = await this.started()
      this.sent++
      try {
        const response = await fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal
        })
        if (!response.ok) {
          const message = await response.text().catch(() => '')
          throw new Error(`audio.cpp answered ${response.status}: ${errorText(message)}`)
        }
        // Read whole here, so the server has answered by the time it counts as done.
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: response.headers
        })
      } finally {
        this.sent--
        if (this.sent === 0) for (const done of this.drainWaiters.splice(0)) done()
      }
    } finally {
      this.busy--
      this.keepAlive()
    }
  }

  /** Stop the server, cutting off what it was making; it starts again at the next request. */
  stop(): void {
    clearTimeout(this.idleTimer)
    this.kill()
    this.running = undefined
    this.config = undefined
  }

  private kill(): void {
    this.process?.kill()
    this.process = undefined
  }

  private keepAlive(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.busy === 0) this.stop()
      else this.keepAlive()
    }, IDLE_MS)
  }

  /** Once the server has answered every request sent to it. */
  private drained(): Promise<void> {
    if (this.sent === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  /**
   * The running server's address, started with the models on this Mac now.
   * Decided at once, with no wait before, so requests that come together
   * share one start; a server running other models is started again once it
   * has answered what it was asked.
   */
  private started(): Promise<string> {
    const models = this.models()
    const config = JSON.stringify(models)
    if (this.running && this.config === config) return this.running
    const restart = this.running !== undefined
    this.config = config
    const running = (async () => {
      if (restart) {
        await this.drained()
        this.kill()
      }
      return this.start(models)
    })()
    this.running = running
    // A start that failed is tried again by the next request.
    running.catch(() => {
      if (this.running === running) this.stop()
    })
    return running
  }

  private async start(models: ServerModel[]): Promise<string> {
    if (!this.engine.ready()) throw new Error('The audio engine is not on this Mac.')
    const pidFile = join(this.engine.dir, 'barebone-server.pid')
    await stopLeftBehind(pidFile)
    const port = await freePort()
    const file = join(this.engine.dir, 'barebone-server.json')
    await writeFile(
      file,
      JSON.stringify(
        {
          host: '127.0.0.1',
          port,
          // The build downloaded for this computer (speech/index.ts): Metal on the Mac, the CPU on Linux.
          backend: process.platform === 'darwin' ? 'metal' : 'cpu',
          lazy_load: true,
          max_loaded_models: 0,
          idle_unload_ms: IDLE_MS,
          // Music takes minutes at most; a request never waits on another forever.
          busy_timeout_ms: 600_000,
          models: models.map((model) => ({ ...model, mode: 'offline' }))
        },
        null,
        2
      )
    )
    // Its model specs are found from its working directory.
    const child = spawn(join(this.engine.dir, 'audiocpp_server'), ['--config', file, '--no-ui'], {
      cwd: this.engine.dir,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.process = child
    const log: string[] = []
    const keep = (chunk: Buffer): void => {
      log.push(...chunk.toString().split('\n').filter(Boolean))
      log.splice(0, Math.max(0, log.length - LOG_LINES))
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    let exited = false
    // It could not be started at all: the file is gone or cannot run.
    child.once('error', (error) => {
      exited = true
      log.push(error.message)
    })
    child.once('exit', () => {
      exited = true
      if (this.process === child) {
        this.process = undefined
        this.running = undefined
        this.config = undefined
      }
    })
    if (child.pid) await writeFile(pidFile, String(child.pid))
    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + START_MS
    while (Date.now() < deadline) {
      if (exited) throw new Error(`the audio engine stopped: ${log.slice(-3).join(' ')}`)
      const ok = await fetch(`${url}/health`)
        .then((r) => r.ok)
        .catch(() => false)
      if (ok) return url
      await sleep(200)
    }
    child.kill()
    throw new Error(`the audio engine did not start within ${START_MS / 1000}s`)
  }
}

const run = promisify(execFile)

/** Stop the server a run of the app before left behind, if it still runs. */
async function stopLeftBehind(pidFile: string): Promise<void> {
  const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
  await rm(pidFile, { force: true })
  if (!Number.isInteger(pid) || pid <= 0) return
  // Only that server: a process id the system gave to another program since is left alone.
  const command = await run('/bin/ps', ['-p', String(pid), '-o', 'command='])
    .then(({ stdout }) => stdout)
    .catch(() => '')
  if (command.includes('audiocpp_server') && command.includes('barebone-server.json')) {
    process.kill(pid)
  }
}

/** A port nothing listens on now, on this Mac only. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port'))
      )
    })
  })
}

/** The message in an error the server answered with, which comes as JSON or text. */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string }
    const error = parsed.error
    return (typeof error === 'string' ? error : error?.message) ?? body
  } catch {
    return body.slice(0, 300)
  }
}

/** A WAV file's samples, mono, as floats from -1 to 1. */
export function readWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('the audio is not a WAV file')
  let format = 0
  let channels = 1
  let sampleRate = 0
  let bits = 16
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = text(at)
    const size = view.getUint32(at + 4, true)
    const start = at + 8
    if (id === 'fmt ') {
      format = view.getUint16(start, true)
      channels = view.getUint16(start + 2, true)
      sampleRate = view.getUint32(start + 4, true)
      bits = view.getUint16(start + 14, true)
    } else if (id === 'data') {
      const end = Math.min(start + size, bytes.length)
      const step = (bits / 8) * channels
      const frames = Math.floor((end - start) / step)
      const samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        const offset = start + i * step
        // The first channel; voices and music come mono or as near-identical channels.
        if (format === 3 && bits === 32) samples[i] = view.getFloat32(offset, true)
        else if (bits === 16) samples[i] = view.getInt16(offset, true) / 0x8000
        else if (bits === 24) {
          const value =
            view.getUint8(offset) |
            (view.getUint8(offset + 1) << 8) |
            (view.getInt8(offset + 2) << 16)
          samples[i] = value / 0x800000
        } else throw new Error(`WAV with ${bits}-bit samples is not supported`)
      }
      return { samples, sampleRate }
    }
    at = start + size + (size % 2)
  }
  throw new Error('the WAV file has no audio')
}
