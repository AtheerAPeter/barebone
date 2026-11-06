import { execFile } from 'node:child_process'
import { cpus, loadavg } from 'node:os'
import type { NativeImage } from 'electron'
import type { DeviceButton, MobileDevice } from '../shared/types'
import type { DeviceLogs } from './device-logs'

/**
 * What the device tools (devices-mcp.ts) do with a booted device, the same
 * for an iOS simulator (device-ios.ts) and an Android
 * emulator or phone (device-android.ts). Every point is in the screen's points
 * (iOS points, Android dp), with the origin at the top left, so a screenshot
 * at point size and the elements on it share one set of coordinates.
 */
export interface DeviceDriver {
  readonly info: MobileDevice
  /** The screen's size in points, and how many pixels a point is. */
  size(): Promise<ScreenSize>
  /** The screen, at its size in points, or with `fullSize` in pixels. */
  screenshot(fullSize?: boolean): Promise<NativeImage>
  /** What is on screen, from the platform's accessibility tree. */
  elements(): Promise<ScreenElement[]>
  tap(x: number, y: number): Promise<void>
  hold(x: number, y: number, ms: number): Promise<void>
  swipe(x: number, y: number, toX: number, toY: number, ms: number): Promise<void>
  /** Type into the focused field. */
  type(text: string): Promise<void>
  key(key: 'enter' | 'backspace'): Promise<void>
  button(button: DeviceButton): Promise<void>
  openUrl(url: string): Promise<void>
  launch(app: string): Promise<void>
  terminate(app: string): Promise<void>
  install(path: string): Promise<void>
  uninstall(app: string): Promise<void>
  /** The apps the user installed, by bundle ID or package name. */
  apps(): Promise<string[]>
  appearance(mode: 'light' | 'dark'): Promise<void>
  textSize(size: TextSize): Promise<void>
  location(latitude: number, longitude: number): Promise<void>
  permission(app: string, name: string, action: 'grant' | 'revoke' | 'reset'): Promise<void>
  /** The language apps show, like "de" or "en-US"; on Android for one app. */
  language(code: string, app?: string): Promise<void>
  /** Whether the on-screen keyboard shows while a hardware keyboard is connected. */
  softwareKeyboard(on: boolean): Promise<void>
  /** Send an app a push notification, given as its JSON payload. */
  push(app: string, payload: string): Promise<void>
  /** Add a photo or video to the device's photo library. */
  addMedia(path: string): Promise<void>
  /** Copy what the device logs into `logs`, until the returned function is called. */
  collectLogs(logs: DeviceLogs): () => void
  shutdown(): Promise<void>
  /** Let go of the connections to the device, which keeps running. */
  close(): void
}

export interface ScreenSize {
  width: number
  height: number
  scale: number
}

/** An element on screen, its frame in points. */
export interface ScreenElement {
  /** button, text, textfield, image, switch… */
  role: string
  label: string
  value?: string
  /** testID / accessibilityIdentifier, or Android's resource-id. */
  id?: string
  x: number
  y: number
  width: number
  height: number
}

export type TextSize = 'small' | 'default' | 'large' | 'largest'

/** How long a device command may take before it is given up on. */
const COMMAND_TIMEOUT_MS = 60_000

/**
 * Run a command and return what it printed. Fails with what it printed to
 * stderr, which is where these tools say what went wrong.
 */
export function run(
  command: string,
  args: string[],
  {
    input,
    timeout = COMMAND_TIMEOUT_MS,
    env
  }: { input?: string | Buffer; timeout?: number; env?: Record<string, string> } = {}
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: 'buffer',
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: env && { ...process.env, ...env }
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        const said = stderr.toString().trim() || stdout.toString().trim()
        const timedOut = error.killed && error.signal === 'SIGTERM'
        reject(
          new Error(
            timedOut
              ? `${command} ${args[0] ?? ''} did not finish within ${timeout / 1000}s.${busyNote()}`
              : said || error.message
          )
        )
      }
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A note for errors about something that took too long, when this computer is
 * so busy (two native builds at once, say) that devices answer slowly.
 */
export function busyNote(): string {
  const load = loadavg()[0]
  const cores = cpus().length
  return load > cores * 1.5
    ? ` This computer is very busy (load ${load.toFixed(0)} on ${cores} cores), which slows simulators and emulators down.`
    : ''
}
