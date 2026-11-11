import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { zrokBinary } from './zrok-binary'

/**
 * The tunnel that carries the remote link from the internet to this Mac:
 * zrok (zrok.io, free), which the app downloads (zrok-binary.ts) and joins to
 * the user's account once with their account token. The share is public
 * under a name kept for this Mac, so its address stays the same; zrok runs as
 * a child of the app and takes the share down when it stops.
 */

/** Where zrok keeps the account an environment was enabled with. */
const ENVIRONMENT = join(homedir(), '.zrok2', 'environment.json')
/** How long zrok may take to answer a command (enable, names). */
const COMMAND_TIMEOUT = 60_000
/** After the share stops by itself, wait this long before starting it again, growing to the cap. */
const RESTART_MS = 2000
const RESTART_CAP_MS = 60_000

/** Whether zrok is joined to an account on this Mac. */
export function zrokEnabled(): boolean {
  return existsSync(ENVIRONMENT)
}

function run(zrok: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(zrok, args, { timeout: COMMAND_TIMEOUT }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      // zrok writes its errors as "[ERROR]: …" lines; the last says why.
      const said = `${stderr}\n${stdout}`
        .split('\n')
        .map((line) => stripVTControlCharacters(line).trim())
        .filter(Boolean)
        .pop()
      reject(new Error(said || error.message))
    })
  )
}

/** Join zrok to the user's account with the account token from myzrok.io. */
export async function enableZrok(token: string): Promise<void> {
  const trimmed = token.trim()
  if (!/^[\w-]{6,}$/.test(trimmed)) throw new Error('That does not look like a zrok account token.')
  const zrok = await zrokBinary()
  await run(zrok, [
    'enable',
    trimmed,
    '--headless',
    '--description',
    `Barebone on ${hostname().replace(/\.local$/, '')}`
  ])
}

/** A new name for this Mac's share: random, so the address says nothing about who is behind it. */
export function newShareName(): string {
  return `bb${randomBytes(6).toString('hex')}`
}

interface ZrokName {
  name: string
  namespaceName: string
  /** The share holding the name, while one does. */
  shareToken?: string
}

async function names(zrok: string): Promise<ZrokName[]> {
  return JSON.parse(await run(zrok, ['list', 'names', '--json'])) as ZrokName[]
}

/**
 * Make sure the name is the account's and free, creating it the first time;
 * its public address, as https://<name>.<namespace> (zrok's names list gives
 * both). The name is this Mac's alone, so a share holding it as the link opens
 * was left by a run of the app that ended without taking it down (a crash, a
 * power cut): it is deleted, or the new share could not take the name.
 */
async function ensureName(zrok: string, name: string): Promise<string> {
  let found = (await names(zrok)).find((n) => n.name === name)
  if (!found) {
    await run(zrok, ['create', 'name', name])
    found = (await names(zrok)).find((n) => n.name === name)
  }
  if (!found) throw new Error(`zrok did not keep the name ${name}.`)
  if (found.shareToken) await run(zrok, ['delete', 'share', found.shareToken])
  return `https://${found.name}.${found.namespaceName}`
}

/** How often, and how long, to check that the share answers from the internet. */
const PROBE_EVERY_MS = 1000
const PROBE_FOR_MS = 60_000
/** While the share is up, how often to check it still answers, and how many misses in a row restart it. */
const WATCH_EVERY_MS = 60_000
const WATCH_MISSES = 3
/** How long zrok has to exit once asked before it is killed. */
const EXIT_GRACE_MS = 5000

/**
 * Whether the app's pairing page answers at the public address: the share is
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

export interface TunnelEvents {
  /** The share is up at this address. */
  online(url: string): void
  /** The share stopped or could not start; it is tried again. */
  failed(message: string): void
}

export class ZrokTunnel {
  private child?: ChildProcess
  private stopped = true
  private restartIn = RESTART_MS
  private restartTimer?: NodeJS.Timeout

  constructor(private events: TunnelEvents) {}

  /**
   * Share the local server under the name, until stop. Rejects when zrok is
   * not set up; a share that cannot start or stops (zrok out of reach, the
   * Mac offline) is reported and tried again.
   */
  async start(port: number, name: string): Promise<void> {
    this.stopped = false
    this.restartIn = RESTART_MS
    if (!zrokEnabled()) throw new Error('zrok is not joined to your account yet.')
    const zrok = await zrokBinary()
    await this.launch(zrok, port, name).catch((error: Error) => {
      this.events.failed(error.message)
      this.retry(zrok, port, name)
    })
  }

  private async launch(zrok: string, port: number, name: string): Promise<void> {
    const url = await ensureName(zrok, name)
    if (!this.stopped) this.spawn(zrok, port, name, url)
  }

  private retry(zrok: string, port: number, name: string): void {
    this.restartTimer = setTimeout(() => {
      if (this.stopped) return
      this.launch(zrok, port, name).catch((error: Error) => {
        this.events.failed(error.message)
        this.retry(zrok, port, name)
      })
    }, this.restartIn)
    this.restartIn = Math.min(this.restartIn * 2, RESTART_CAP_MS)
  }

  private spawn(zrok: string, port: number, name: string, url: string): void {
    const child = spawn(
      zrok,
      [
        'share',
        'public',
        `http://127.0.0.1:${port}`,
        '--name-selection',
        `public:${name}`,
        '--headless',
        // A zrok agent running on this Mac would otherwise take the share over.
        '--force-local'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    this.child = child
    // zrok says little when it writes to no terminal: its last line is kept for an error.
    let last = ''
    const read = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        const clean = stripVTControlCharacters(line).trim()
        if (clean) last = clean
      }
    }
    // Up once the pairing page answers at the public address. zrok can keep
    // running with its share out of reach (it never came up, or went after
    // the Mac slept or changed networks): then it is ended, and the exit
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
      this.events.failed(last || `zrok stopped (${code ?? 'killed'}).`)
      this.retry(zrok, port, name)
    })
  }

  /** Take the share down; zrok removes it from the account as it exits. */
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

/** Ask zrok to exit, which takes its share down; kill it if it does not. */
function endProcess(child: ChildProcess): void {
  const force = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS)
  child.once('exit', () => clearTimeout(force))
  child.kill('SIGTERM')
}
