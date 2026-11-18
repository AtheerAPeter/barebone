import { spawn, type ChildProcess } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

/**
 * The tunnel that carries the remote link from the internet to this Mac: a
 * program (zrok.ts, cloudflare.ts) run as a child of the app, which takes
 * the link down when it stops. It is up once the pairing page answers at the
 * public address, and is started again when it stops or stops answering.
 */

/** One kind of tunnel: its program, its address, and how it is run. */
export interface TunnelProvider {
  /** In messages: "zrok". */
  name: string
  /** The port the local server must listen on, when the tunnel's route is set elsewhere; any free one otherwise. */
  port?: number
  /** The program, downloaded if need be; rejects when the tunnel is not set up, which is not tried again. */
  program(): Promise<string>
  /** The public address, made ready before each run (https://…, no trailing slash). */
  address(program: string): Promise<string>
  /** How to run the program to carry the local server's port. */
  command(port: number): { args: string[]; env?: Record<string, string> }
}

export interface TunnelEvents {
  /** The tunnel is up at this address. */
  online(url: string): void
  /** The tunnel stopped or could not start; it is tried again. */
  failed(message: string): void
}

/** After the tunnel stops by itself, wait this long before starting it again, growing to the cap. */
const RESTART_MS = 2000
const RESTART_CAP_MS = 60_000
/** How often, and how long, to check that the tunnel answers from the internet. */
const PROBE_EVERY_MS = 1000
const PROBE_FOR_MS = 60_000
/** While the tunnel is up, how often to check it still answers, and how many misses in a row restart it. */
const WATCH_EVERY_MS = 60_000
const WATCH_MISSES = 3
/** How long the program has to exit once asked before it is killed. */
const EXIT_GRACE_MS = 5000

/**
 * Whether the app's pairing page answers at the public address: the tunnel is
 * up end to end. zrok's notice page is skipped with its header for programs.
 */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/pair`, {
      headers: { skip_zrok_interstitial: '1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    })
    return response.ok
  } catch {
    return false
  }
}

export class Tunnel {
  private child?: ChildProcess
  private stopped = true
  private restartIn = RESTART_MS
  private restartTimer?: NodeJS.Timeout

  constructor(
    private provider: TunnelProvider,
    private events: TunnelEvents
  ) {}

  /**
   * Carry the local server's port until stop. Rejects when the tunnel is not
   * set up; one that cannot start or stops (out of reach, the Mac offline) is
   * reported and tried again.
   */
  async start(port: number): Promise<void> {
    this.stopped = false
    this.restartIn = RESTART_MS
    const program = await this.provider.program()
    await this.launch(program, port).catch((error: Error) => {
      this.events.failed(error.message)
      this.retry(program, port)
    })
  }

  private async launch(program: string, port: number): Promise<void> {
    const url = await this.provider.address(program)
    if (!this.stopped) this.spawn(program, port, url)
  }

  private retry(program: string, port: number): void {
    this.restartTimer = setTimeout(() => {
      if (this.stopped) return
      this.launch(program, port).catch((error: Error) => {
        this.events.failed(error.message)
        this.retry(program, port)
      })
    }, this.restartIn)
    this.restartIn = Math.min(this.restartIn * 2, RESTART_CAP_MS)
  }

  private spawn(program: string, port: number, url: string): void {
    const { args, env } = this.provider.command(port)
    const child = spawn(program, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env && { ...process.env, ...env }
    })
    this.child = child
    // The program says little when it writes to no terminal: its last line is kept for an error.
    let last = ''
    const read = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        const clean = stripVTControlCharacters(line).trim()
        if (clean) last = clean
      }
    }
    // Up once the pairing page answers at the public address. The program can
    // keep running with the tunnel out of reach (it never came up, or went
    // after the Mac slept or changed networks): then it is ended, and the exit
    // handler below starts it again.
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const restart = (why: string): void => {
      last = why
      endProcess(child)
    }
    void (async () => {
      const until = Date.now() + PROBE_FOR_MS
      while (!(await answers(url))) {
        if (this.child !== child) return
        if (Date.now() >= until) return restart('The link does not answer from the internet.')
        await wait(PROBE_EVERY_MS)
      }
      if (this.child !== child) return
      this.restartIn = RESTART_MS
      this.events.online(url)
      let misses = 0
      while (this.child === child) {
        await wait(WATCH_EVERY_MS)
        if (this.child !== child) return
        misses = (await answers(url)) ? 0 : misses + 1
        if (misses >= WATCH_MISSES && this.child === child) {
          return restart('The link stopped answering from the internet.')
        }
      }
    })()
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('error', (error) => (last = error.message))
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined
      if (this.stopped) return
      this.events.failed(last || `${this.provider.name} stopped (${code ?? 'killed'}).`)
      this.retry(program, port)
    })
  }

  /** Take the tunnel down; the program removes it as it exits. */
  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.restartTimer)
    const child = this.child
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      endProcess(child)
    })
  }
}

/** Ask the program to exit, which takes the tunnel down; kill it if it does not. */
function endProcess(child: ChildProcess): void {
  const force = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS)
  child.once('exit', () => clearTimeout(force))
  child.kill('SIGTERM')
}
