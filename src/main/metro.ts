import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { lineSplitter, type DeviceLogs, type LogLevel } from './device-logs'
import { sleep } from './device-driver'
import { loadShellPath } from './shell-env'

/**
 * Metro, the server a React Native app in development loads its JavaScript
 * from: started here, so what it prints (bundling, and on iOS the app's own
 * console.log and errors) reaches the logs tool, or found running already,
 * started some other way. Either way it can reload the apps it serves.
 */

/** Metro's port unless a project picks another. */
const DEFAULT_PORT = 8081
/** How long start waits for Metro to answer. */
const START_TIMEOUT_MS = 90_000
/** How long stopping waits for Metro to end before it is killed. */
const STOP_GRACE_MS = 2_000

interface Job {
  child: ChildProcess
  command: string
  cwd: string
  port: number
  started: number
  /** How it ended, once it has. */
  ended?: string
}

/** The command that starts Metro in a project: Expo's when it uses Expo, else React Native's. */
export function startCommand(cwd: string): string {
  const file = join(cwd, 'package.json')
  if (!existsSync(file)) {
    throw new Error(`${cwd} has no package.json. Pass the folder of the app (cwd), or the command.`)
  }
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (deps.expo) return 'npx expo start'
  if (deps['react-native']) return 'npx react-native start'
  throw new Error(
    `${file} has neither expo nor react-native in its dependencies. Pass the folder of the app (cwd), or the command.`
  )
}

/** Whether Metro answers on this port. */
async function metroRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2000)
    })
    return (await response.text()).includes('packager-status:running')
  } catch {
    return false
  }
}

function levelOf(line: string): LogLevel {
  if (/\bERROR\b|\b\w*Error:|\berror\b/.test(line)) return 'error'
  if (/\bWARN(ING)?\b/i.test(line)) return 'warn'
  return 'info'
}

export class Metro {
  private job?: Job

  constructor(
    private readonly logs: DeviceLogs,
    /** Metro got a port: Android devices need it forwarded to reach it. */
    private readonly onPort: (port: number) => void
  ) {}

  /** The port of the Metro started here, else the default one. */
  get port(): number {
    return this.job && !this.job.ended ? this.job.port : DEFAULT_PORT
  }

  async status(): Promise<string> {
    const port = this.port
    const running = await metroRunning(port)
    const job = this.job
    if (job && !job.ended) {
      return `Metro was started here with \`${job.command}\` in ${job.cwd} ${Math.round((Date.now() - job.started) / 1000)}s ago, on port ${port}; it ${running ? 'answers' : 'does not answer yet'}. Its output is in logs (source "metro").`
    }
    const ended = job?.ended ? ` The Metro started here ended: ${job.ended}.` : ''
    return running
      ? `Metro runs on port ${port}, started outside Barebone, so its output is not in logs. It can still reload apps.${ended}`
      : `No Metro answers on port ${port}.${ended}`
  }

  /** Start Metro in `cwd`; resolves once it answers, with what it printed. */
  async start(cwd: string, command: string, env: Record<string, string>): Promise<string> {
    if (this.job && !this.job.ended) {
      throw new Error(
        `Metro started here already runs (\`${this.job.command}\` in ${this.job.cwd}). Stop it first.`
      )
    }
    const port = Number(command.match(/--port[= ](\d+)/)?.[1] ?? env.RCT_METRO_PORT ?? DEFAULT_PORT)
    if (await metroRunning(port)) {
      throw new Error(
        `Something already serves Metro on port ${port}, started outside Barebone. Use it as it is (reload works with it), or stop it and start it here so its output reaches logs.`
      )
    }
    await loadShellPath()
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, FORCE_COLOR: '0' }
    })
    const job: Job = { child, command, cwd, port, started: Date.now() }
    this.job = job
    const since = this.logs.cursor
    const onLine = lineSplitter((raw) => {
      const line = stripVTControlCharacters(raw)
      if (!line.trim()) return
      // Expo moves to the next free port when the asked one is taken.
      const at = line.match(/Waiting on https?:\/\/[^:\s]+:(\d+)/)
      if (at) job.port = Number(at[1])
      this.logs.add({
        time: Date.now(),
        source: 'metro',
        level: levelOf(line),
        tag: 'metro',
        text: line,
        // The app's console output, which Metro prints as "LOG  …", "WARN  …", "ERROR  …".
        js: /^\s*(LOG|INFO|WARN|ERROR|DEBUG)\s/.test(line)
      })
    })
    child.stdout?.on('data', onLine)
    child.stderr?.on('data', onLine)
    child.on('exit', (code, signal) => {
      job.ended = signal ? `stopped by ${signal}` : `exited with code ${code}`
    })
    child.on('error', (error) => {
      job.ended = `could not start: ${error.message}`
    })

    const deadline = Date.now() + START_TIMEOUT_MS
    while (!job.ended && Date.now() < deadline && !(await metroRunning(job.port))) {
      await sleep(1000)
    }
    const printed = this.logs
      .query({ since, sources: ['metro'] })
      .slice(-30)
      .map((line) => line.text)
      .join('\n')
    if (job.ended) throw new Error(`Metro ${job.ended}. It printed:\n${printed}`)
    if (Date.now() >= deadline) {
      return `Metro started but does not answer on port ${job.port} after ${START_TIMEOUT_MS / 1000}s. It printed:\n${printed}`
    }
    this.onPort(job.port)
    return `Metro runs on port ${job.port}. It printed:\n${printed}`
  }

  async stop(): Promise<string> {
    const job = this.job
    if (!job || job.ended) return 'No Metro started here is running.'
    this.signal('SIGTERM')
    const deadline = Date.now() + STOP_GRACE_MS
    while (!job.ended && Date.now() < deadline) await sleep(100)
    if (!job.ended) this.signal('SIGKILL')
    return 'Stopped Metro.'
  }

  /**
   * Signal the Metro started here, with its whole process group: the shell,
   * npx and the node process under it. Called with SIGTERM as the app quits.
   */
  signal(signal: NodeJS.Signals): void {
    const pid = this.job && !this.job.ended ? this.job.child.pid : undefined
    if (!pid) return
    try {
      process.kill(-pid, signal)
    } catch {
      // Already gone.
    }
  }

  /** Tell every app Metro serves to load its JavaScript again, as pressing r in Metro does. */
  async reload(): Promise<void> {
    const port = this.port
    if (!(await metroRunning(port))) throw new Error(`No Metro answers on port ${port}.`)
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error(`Metro on port ${port} did not take the reload.`))
      }, 5000)
      socket.onopen = () => {
        socket.send(JSON.stringify({ version: 2, method: 'reload' }))
        // Sent once it is out of the socket; give it a moment before closing.
        setTimeout(() => {
          clearTimeout(timer)
          socket.close()
          resolve()
        }, 300)
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`Could not connect to Metro's message socket on port ${port}.`))
      }
    })
  }
}
