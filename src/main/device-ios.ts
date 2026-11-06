import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { app, nativeImage, type NativeImage } from 'electron'
import type { DeviceButton, MobileDevice } from '../shared/types'
import {
  run,
  sleep,
  type DeviceDriver,
  type ScreenElement,
  type ScreenSize,
  type TextSize
} from './device-driver'
import { lineSplitter, type DeviceLogs } from './device-logs'

/**
 * iOS simulators, through Xcode's `simctl` and serve-sim's native module
 * (github.com/EvanBacon/serve-sim), which talks to the simulator in this
 * process: touches, keys and buttons as the Simulator app sends them, and its
 * accessibility tree. None of it needs a macOS permission.
 */

/** serve-sim's native module, as far as it is used here. */
interface SimNative {
  SimHID: new (
    udid: string,
    foldableHelper: string
  ) => {
    /** A finger at a point given as a fraction of the screen (0 to 1). */
    touch(
      phase: 'begin' | 'move' | 'end',
      x: number,
      y: number,
      width: number,
      height: number,
      edge: number
    ): Promise<void>
    button(name: 'home' | 'lock'): Promise<void>
    /** A key by its HID usage code. */
    key(direction: 'down' | 'up', usage: number): Promise<void>
    close(): Promise<void>
  }
  /** The accessibility tree of what the simulator shows, as JSON. */
  axDescribe(udid: string): Promise<string>
}

let simNative: SimNative | undefined

/** Loaded once an iOS simulator is first used; unpacked from the app's asar (electron-builder.yml). */
function native(): SimNative {
  simNative ??= createRequire(import.meta.url)(
    join(app.getAppPath(), 'node_modules/serve-sim/dist/native/serve-sim-native.node')
  ) as SimNative
  return simNative
}

/** HID usage codes of the keys sent. */
const HID = { enter: 40, backspace: 42, v: 25, command: 227 }

const CONTENT_SIZES: Record<TextSize, string> = {
  small: 'small',
  default: 'large',
  large: 'extra-extra-large',
  largest: 'accessibility-extra-extra-extra-large'
}

const ROLES: Record<string, string> = {
  Button: 'button',
  StaticText: 'text',
  TextField: 'textfield',
  SecureTextField: 'textfield',
  TextArea: 'textfield',
  SearchField: 'textfield',
  Image: 'image',
  Switch: 'switch',
  CheckBox: 'switch',
  Slider: 'slider',
  Link: 'link',
  Heading: 'heading',
  Cell: 'cell',
  ScrollArea: 'scroll',
  TabGroup: 'tabs',
  Group: 'group',
  GenericElement: 'element'
}

/** Roles worth listing even without a name: they can be acted on. */
const ACTIONABLE = new Set(['button', 'textfield', 'switch', 'slider', 'link', 'scroll'])

interface AxNode {
  /** Like "Button" or "StaticText". */
  type?: string
  role_description?: string
  AXLabel?: string | null
  AXValue?: unknown
  AXUniqueId?: string | null
  title?: string | null
  frame?: { x: number; y: number; width: number; height: number }
  children?: AxNode[]
}

/** The named and actionable elements of the accessibility tree, in order on screen. */
function iosElements(tree: AxNode[]): ScreenElement[] {
  const elements: ScreenElement[] = []
  /** What is listed already: React Native nests a view in a view with the same label, and one is enough. */
  const listed = new Set<string>()
  const visit = (node: AxNode): void => {
    const type = node.type ?? ''
    const role = ROLES[type] ?? node.role_description ?? type.toLowerCase()
    const label = (node.AXLabel ?? node.title ?? '').trim()
    const value =
      node.AXValue === null || node.AXValue === undefined
        ? undefined
        : String(node.AXValue).trim() || undefined
    const id = node.AXUniqueId ?? undefined
    const frame = node.frame
    const key = frame && `${role} ${label} ${frame.x} ${frame.y} ${frame.width} ${frame.height}`
    const wanted =
      frame &&
      frame.width > 0 &&
      frame.height > 0 &&
      type !== 'Application' &&
      // A group with only an ID holds others, whose labels are listed; an ID on what can be
      // acted on (a testID on a button) is shown with it.
      (label || value || ACTIONABLE.has(role)) &&
      // Scroll views show their scroll bars as sliders; scrolling is a swipe anyway.
      !(role === 'slider' && /scroll bar/i.test(label))
    if (wanted && key && !listed.has(key)) {
      listed.add(key)
      elements.push({ role, label, value, id, ...frame })
    }
    for (const child of node.children ?? []) visit(child)
  }
  for (const root of tree) visit(root)
  return elements
}

/** Each device type's screen, from its profile in Xcode: pixels and scale. */
const screens = new Map<string, Promise<ScreenSize>>()

async function screenOf(deviceType: string): Promise<ScreenSize> {
  let screen = screens.get(deviceType)
  if (!screen) {
    screen = (async () => {
      const { devicetypes } = JSON.parse(
        (await run('xcrun', ['simctl', 'list', 'devicetypes', '-j'])).toString()
      ) as { devicetypes: { identifier: string; bundlePath: string }[] }
      const type = devicetypes.find((t) => t.identifier === deviceType)
      if (!type) throw new Error(`Xcode does not know the device type ${deviceType}.`)
      const profile = JSON.parse(
        (
          await run('plutil', [
            '-convert',
            'json',
            '-o',
            '-',
            join(type.bundlePath, 'Contents/Resources/profile.plist')
          ])
        ).toString()
      ) as { mainScreenWidth: number; mainScreenHeight: number; mainScreenScale: number }
      const scale = profile.mainScreenScale
      return {
        width: Math.round(profile.mainScreenWidth / scale),
        height: Math.round(profile.mainScreenHeight / scale),
        scale
      }
    })()
    screens.set(deviceType, screen)
    screen.catch(() => screens.delete(deviceType))
  }
  return screen
}

/** Where the simulators' crash reports go; each names the simulator's UDID in its paths. */
const CRASH_REPORTS = join(homedir(), 'Library/Logs/DiagnosticReports')
const CRASH_POLL_MS = 3_000

export class IosSimulator implements DeviceDriver {
  private hidHandle?: InstanceType<SimNative['SimHID']>

  constructor(
    readonly info: MobileDevice,
    /** Its device type, like com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro. */
    private readonly deviceType: string
  ) {}

  private simctl(args: string[], input?: string): Promise<Buffer> {
    return run('xcrun', ['simctl', ...args], { input })
  }

  /** The simulator's touch and key input, connected on first use. */
  private get hid(): InstanceType<SimNative['SimHID']> {
    // No helper for foldable devices: iPhones and iPads do not fold.
    this.hidHandle ??= new (native().SimHID)(this.info.id, '')
    return this.hidHandle
  }

  size(): Promise<ScreenSize> {
    return screenOf(this.deviceType)
  }

  async screenshot(fullSize = false): Promise<NativeImage> {
    const { width, height } = await this.size()
    const file = join(tmpdir(), `barebone-${this.info.id}-${Date.now()}.png`)
    try {
      await this.simctl(['io', this.info.id, 'screenshot', '--type=png', file])
      const image = nativeImage.createFromPath(file)
      return fullSize ? image : image.resize({ width, height, quality: 'good' })
    } finally {
      await rm(file, { force: true })
    }
  }

  async elements(): Promise<ScreenElement[]> {
    return iosElements(JSON.parse(await native().axDescribe(this.info.id)) as AxNode[])
  }

  /** One step of a finger: down, moving, or lifting. */
  private async touch(phase: 'down' | 'move' | 'up', x: number, y: number): Promise<void> {
    const { width, height } = await this.size()
    const type = phase === 'down' ? 'begin' : phase === 'move' ? 'move' : 'end'
    await this.hid.touch(type, x / width, y / height, width, height, 0)
  }

  async tap(x: number, y: number): Promise<void> {
    await this.touch('down', x, y)
    await sleep(50)
    await this.touch('up', x, y)
  }

  async hold(x: number, y: number, ms: number): Promise<void> {
    await this.touch('down', x, y)
    await sleep(ms)
    await this.touch('up', x, y)
  }

  async swipe(x: number, y: number, toX: number, toY: number, ms: number): Promise<void> {
    // A finger moving at the screen's frame rate, as a real swipe reaches the app.
    const steps = Math.max(5, Math.round(ms / 16))
    await this.touch('down', x, y)
    for (let step = 1; step <= steps; step++) {
      await sleep(ms / steps)
      const t = step / steps
      await this.touch('move', x + (toX - x) * t, y + (toY - y) * t)
    }
    await this.touch('up', toX, toY)
  }

  /** Press a key, with others held, by their HID usage codes. */
  private async press(usage: number, held: number[] = []): Promise<void> {
    for (const key of held) await this.hid.key('down', key)
    await this.hid.key('down', usage)
    await this.hid.key('up', usage)
    for (const key of held.reverse()) await this.hid.key('up', key)
  }

  async type(text: string): Promise<void> {
    // Pasted, as ⌘V does: any characters (ä, é, emoji), in one go.
    // Without a UTF-8 locale (an app opened from the Dock has none) pbcopy reads the text as Mac Roman.
    await run('xcrun', ['simctl', 'pbcopy', this.info.id], {
      input: text,
      env: { LANG: 'en_US.UTF-8' }
    })
    await this.press(HID.v, [HID.command])
  }

  async key(key: 'enter' | 'backspace'): Promise<void> {
    await this.press(HID[key])
  }

  async button(button: DeviceButton): Promise<void> {
    if (button === 'home' || button === 'lock') {
      await this.hid.button(button)
      return
    }
    if (button === 'app-switch') {
      // Twice quickly, as on an iPhone with a home button.
      await this.hid.button('home')
      await sleep(100)
      await this.hid.button('home')
      return
    }
    throw new Error(
      button === 'back'
        ? 'iOS has no back button: tap the back button on screen, or swipe right from the left edge.'
        : `iOS simulators have no ${button} button to press here.`
    )
  }

  async openUrl(url: string): Promise<void> {
    await this.whenStarted(['openurl', this.info.id, url], `open ${url}`)
  }

  async launch(app: string): Promise<void> {
    await this.whenStarted(['launch', this.info.id, app], `launch ${app}`)
  }

  /**
   * Run a simctl command that hangs while the simulator is still starting:
   * on a timeout, wait until it has started and try once more.
   */
  private async whenStarted(args: string[], what: string): Promise<void> {
    const attempt = (): Promise<Buffer> => run('xcrun', ['simctl', ...args], { timeout: 20_000 })
    try {
      await attempt()
    } catch (error) {
      if (!/did not finish|timed out/i.test((error as Error).message)) throw error
      await run('xcrun', ['simctl', 'bootstatus', this.info.id, '-b'], { timeout: 15_000 })
      await attempt().catch((again: Error) => {
        throw new Error(
          `Could not ${what} on ${this.info.name}: ${again.message} The simulator has started, so the app for it may not be installed, or the URL's scheme belongs to no app.`
        )
      })
    }
  }

  async terminate(app: string): Promise<void> {
    await this.simctl(['terminate', this.info.id, app])
  }

  async install(path: string): Promise<void> {
    await run('xcrun', ['simctl', 'install', this.info.id, path], { timeout: 300_000 })
  }

  async uninstall(app: string): Promise<void> {
    await this.simctl(['uninstall', this.info.id, app])
  }

  async apps(): Promise<string[]> {
    const plist = await this.simctl(['listapps', this.info.id])
    const apps = JSON.parse(
      (await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist })).toString()
    ) as Record<string, { ApplicationType?: string }>
    return Object.entries(apps)
      .filter(([, app]) => app.ApplicationType === 'User')
      .map(([id]) => id)
      .sort()
  }

  async appearance(mode: 'light' | 'dark'): Promise<void> {
    await this.simctl(['ui', this.info.id, 'appearance', mode])
  }

  async textSize(size: TextSize): Promise<void> {
    await this.simctl(['ui', this.info.id, 'content_size', CONTENT_SIZES[size]])
  }

  async location(latitude: number, longitude: number): Promise<void> {
    await this.simctl(['location', this.info.id, 'set', `${latitude},${longitude}`])
  }

  async permission(app: string, name: string, action: 'grant' | 'revoke' | 'reset'): Promise<void> {
    await this.simctl(['privacy', this.info.id, action, name, app])
  }

  async language(code: string): Promise<void> {
    // For every app, as Settings sets it; apps read it as they start.
    const defaults = ['spawn', this.info.id, 'defaults', 'write', '-g']
    await this.simctl([...defaults, 'AppleLanguages', '-array', code])
    await this.simctl([...defaults, 'AppleLocale', '-string', code.replace('-', '_')])
  }

  async softwareKeyboard(): Promise<void> {
    throw new Error(
      "An iOS simulator shows its on-screen keyboard only while Simulator's I/O > Keyboard > Connect Hardware Keyboard is off, which only Simulator's own menu changes. Ask the user to press ⌘K in the Simulator window."
    )
  }

  async push(app: string, payload: string): Promise<void> {
    await this.simctl(['push', this.info.id, app, '-'], payload)
  }

  async addMedia(path: string): Promise<void> {
    await this.simctl(['addmedia', this.info.id, path])
  }

  /**
   * What the simulator logged in the last minutes that matches an os_log
   * predicate, at every level: what the collected log leaves out, like a
   * library's own subsystem.
   */
  async showLog(predicate: string, minutes: number): Promise<string[]> {
    const out = await run(
      'xcrun',
      [
        'simctl',
        'spawn',
        this.info.id,
        'log',
        'show',
        '--style',
        'compact',
        '--info',
        '--debug',
        '--last',
        `${minutes}m`,
        '--predicate',
        predicate
      ],
      { timeout: 30_000 }
    )
    // The first line is the column header.
    return out.toString().split('\n').slice(1).filter(Boolean)
  }

  collectLogs(logs: DeviceLogs): () => void {
    // Only errors and React Native's own lines: everything else is thousands of lines a minute of UIKit.
    const child = spawn(
      'xcrun',
      [
        'simctl',
        'spawn',
        this.info.id,
        'log',
        'stream',
        '--style',
        'ndjson',
        '--level',
        'info',
        '--predicate',
        'messageType == error OR messageType == fault OR subsystem BEGINSWITH "com.facebook.react"'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    child.stdout.on(
      'data',
      lineSplitter((line) => {
        let entry: {
          messageType?: string
          processImagePath?: string
          processID?: number
          subsystem?: string
          eventMessage?: string
        }
        try {
          entry = JSON.parse(line)
        } catch {
          return
        }
        if (!entry.eventMessage) return
        const type = entry.messageType ?? ''
        logs.add({
          time: Date.now(),
          source: this.info.name,
          level:
            type === 'Error' || type === 'Fault' ? 'error' : type === 'Debug' ? 'debug' : 'info',
          tag: basename(entry.processImagePath ?? 'unknown'),
          text: entry.eventMessage,
          pid: entry.processID,
          js: entry.subsystem?.startsWith('com.facebook.react') === true,
          // Apps, Expo Go too, run from the simulator's app containers; the rest is the system.
          system: !entry.processImagePath?.includes('/Containers/Bundle/Application/')
        })
      })
    )
    child.on('error', (error) => console.error(`Log of ${this.info.name}:`, error))

    // An app that crashes leaves a report; this simulator's name its UDID in their paths.
    const started = Date.now()
    const seen = new Set<string>()
    const timer = setInterval(() => {
      if (!existsSync(CRASH_REPORTS)) return
      for (const file of readdirSync(CRASH_REPORTS)) {
        const path = join(CRASH_REPORTS, file)
        if (!file.endsWith('.ips') || seen.has(path)) continue
        try {
          if (statSync(path).mtimeMs < started) continue
          seen.add(path)
          const report = readFileSync(path, 'utf8')
          if (!report.includes(this.info.id)) continue
          const header = JSON.parse(report.slice(0, report.indexOf('\n'))) as { app_name?: string }
          const exception = report.match(/"exception"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"/)?.[1]
          logs.add({
            time: Date.now(),
            source: this.info.name,
            level: 'error',
            tag: header.app_name ?? 'app',
            text: `crashed${exception ? ` (${exception})` : ''}. Report: ${path}`,
            crash: true
          })
        } catch {
          // Still being written; read on the next pass.
          seen.delete(path)
        }
      }
    }, CRASH_POLL_MS)

    return () => {
      child.kill()
      clearInterval(timer)
    }
  }

  async shutdown(): Promise<void> {
    await this.simctl(['shutdown', this.info.id])
  }

  close(): void {
    void this.hidHandle?.close()
    this.hidHandle = undefined
  }
}
