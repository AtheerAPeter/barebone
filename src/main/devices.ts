import { spawn } from 'node:child_process'
import type { NativeImage } from 'electron'
import type { DevicePlatform, MobileDevice, MobileToolCheck } from '../shared/types'
import { AndroidDevice, adbPath, emulatorPath } from './device-android'
import { run, sleep, type DeviceDriver, type ScreenElement } from './device-driver'
import { IosSimulator } from './device-ios'
import { DeviceLogs, formatLine, type LogLine } from './device-logs'
import { connectEmulator, emulatorRun } from './emulator-grpc'
import { Metro } from './metro'

/**
 * The simulators, emulators and phones on this computer, for the device tools
 * (devices-mcp.ts): which there are, booting them, their screens, and what
 * they log. Devices belong to the computer, not to a chat, so every chat and
 * the user share them. Nothing here runs while no agent uses a device, but the
 * log collection of the devices agents have used.
 */

/** How long a listing of the devices is used before they are listed again. */
const LIST_MS = 1_000
/** How long a command that lists devices may take; a busy emulator can leave adb hanging. */
const LIST_COMMAND_MS = 10_000
const PLATFORMS: DevicePlatform[] = ['ios', 'android']
/** How long booting may take: an emulator's first boot is slow. */
const BOOT_TIMEOUT_MS = 240_000
/** How long a read after an app loads waits for the element list to stop changing. */
const STEADY_MS = 4_000
/** How long a device may take to be off after it is told to shut down. */
const SHUTDOWN_TIMEOUT_MS = 30_000
/** React Native's toast at the bottom of a development build's screen, which covers what is under it. */
const WARNING_TOAST = /Open debugger to view (warnings|errors)/i

/** A screen as an agent reads it: what is on it, and how it looks. */
export interface ScreenRead {
  device: MobileDevice
  width: number
  height: number
  elements: ScreenElement[]
  /** Why there is no element list, when there is none. */
  elementsError?: string
  image: NativeImage
  /** It kept changing until the wait ran out. */
  moving: boolean
}

export class DeviceManager {
  readonly logs = new DeviceLogs()
  readonly metro: Metro
  /** Each booted device's driver, with the run of the device it was made for. */
  private drivers = new Map<string, { driver: DeviceDriver; run: string | undefined }>()
  /** Stops each device's log collection. */
  private logging = new Map<string, () => void>()
  /** Each device's screen as an agent last read it: refs point into its elements. */
  private reads = new Map<string, { elements: ScreenElement[]; image: NativeImage }>()
  /** Each simulator's device type, from the listing. */
  private deviceTypes = new Map<string, string>()
  /** When each simulator last booted, from the listing: a new time means a new run. */
  private iosBoots = new Map<string, string>()
  /** Each Android device's name and version, which take adb calls to read. */
  private androidInfo = new Map<string, { name: string; os: string; physical: boolean }>()
  /** Ports on this computer that Android devices reach at their own localhost, kept across boots. */
  private forwarded = new Set<number>()
  /** Android devices adb sees but cannot use yet, like a phone that has not allowed USB debugging. */
  private unready: string[] = []

  constructor() {
    this.metro = new Metro(this.logs, (port) => void this.forward(port))
  }

  /** The tools the devices need, and which of them are installed. */
  async checks(): Promise<MobileToolCheck[]> {
    const checks: MobileToolCheck[] = []
    if (process.platform === 'darwin') {
      checks.push({
        name: 'Xcode',
        found: await run('xcrun', ['--find', 'simctl']).then(
          () => true,
          () => false
        ),
        use: 'iOS simulators',
        install: 'Install Xcode from the App Store and open it once.'
      })
    }
    checks.push(
      {
        name: 'adb',
        found: Boolean(await adbPath()),
        use: 'Android emulators and phones',
        install: "Install Android Studio, or the SDK's platform-tools."
      },
      {
        name: 'Android Emulator',
        found: Boolean(await emulatorPath()),
        use: 'starting Android emulators',
        install: "Install it in Android Studio's SDK Manager."
      }
    )
    return checks
  }

  /** Every device there is, booted ones first. */
  async list(platforms: DevicePlatform[] = PLATFORMS): Promise<MobileDevice[]> {
    const lists = await Promise.all(platforms.map((platform) => this.listPlatform(platform)))
    const devices = lists.flat().sort((a, b) => Number(b.booted) - Number(a.booted))
    this.forgetGone(devices, platforms)
    return devices
  }

  /**
   * One platform's devices. Each tool call asks; one listing serves the calls
   * that come at once. A platform is listed only when asked for, so an
   * emulator too busy to answer adb never holds up work on a simulator.
   */
  private listPlatform(platform: DevicePlatform): Promise<MobileDevice[]> {
    const listed = this.listings.get(platform)
    if (listed && Date.now() - listed.at < LIST_MS) return listed.devices
    const devices = (platform === 'ios' ? this.listIos() : this.listAndroid()).catch(() => [])
    this.listings.set(platform, { at: Date.now(), devices })
    return devices
  }

  /** Forget the last listing, after booting or shutting down a device. */
  private relist(platforms: DevicePlatform[] = PLATFORMS): Promise<MobileDevice[]> {
    for (const platform of platforms) this.listings.delete(platform)
    return this.list(platforms)
  }

  private listings = new Map<DevicePlatform, { at: number; devices: Promise<MobileDevice[]> }>()

  private async listIos(): Promise<MobileDevice[]> {
    if (process.platform !== 'darwin') return []
    const { devices } = JSON.parse(
      (
        await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
          timeout: LIST_COMMAND_MS
        })
      ).toString()
    ) as {
      devices: Record<
        string,
        {
          udid: string
          name: string
          state: string
          deviceTypeIdentifier: string
          lastBootedAt?: string
        }[]
      >
    }
    return Object.entries(devices).flatMap(([runtime, list]) => {
      // com.apple.CoreSimulator.SimRuntime.iOS-26-5: iPhones and iPads, not watches and TVs.
      const version = runtime.match(/\.iOS-([\d-]+)$/)?.[1]
      if (!version) return []
      return list.map((device): MobileDevice => {
        this.deviceTypes.set(device.udid, device.deviceTypeIdentifier)
        if (device.lastBootedAt) this.iosBoots.set(device.udid, device.lastBootedAt)
        return {
          id: device.udid,
          platform: 'ios',
          name: device.name,
          os: `iOS ${version.replace(/-/g, '.')}`,
          booted: device.state === 'Booted'
        }
      })
    })
  }

  private async listAndroid(): Promise<MobileDevice[]> {
    const adb = await adbPath()
    if (!adb) return []
    const attached = (await run(adb, ['devices'], { timeout: LIST_COMMAND_MS }))
      .toString()
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(([serial, state]) => serial && state)
    this.unready = attached
      .filter(([, state]) => state !== 'device')
      .map(([serial, state]) => `${serial} (${state})`)
    const serials = attached.filter(([, state]) => state === 'device').map(([serial]) => serial)
    const booted = await Promise.all(
      serials.map(async (serial): Promise<MobileDevice> => {
        let info = this.androidInfo.get(serial)
        if (!info) {
          const physical = !serial.startsWith('emulator-')
          // A busy emulator can take seconds to answer adb shell; what it does not say in time stays blank.
          const prop = (name: string): Promise<string> =>
            run(adb, ['-s', serial, 'shell', 'getprop', name], { timeout: LIST_COMMAND_MS })
              .then((out) => out.toString().trim())
              .catch(() => '')
          const name = physical
            ? (await prop('ro.product.model')) || serial
            : (await run(adb, ['-s', serial, 'emu', 'avd', 'name'], { timeout: LIST_COMMAND_MS }))
                .toString()
                .split('\n')[0]
                .trim()
          const version = await prop('ro.build.version.release')
          info = {
            name: name.replace(/_/g, ' '),
            os: version ? `Android ${version}` : '',
            physical
          }
          this.androidInfo.set(serial, info)
        }
        return { id: serial, platform: 'android', booted: true, ...info }
      })
    )
    // Emulators that are off, by their AVD names.
    const emulator = await emulatorPath()
    const avds = emulator
      ? (
          await run(emulator, ['-list-avds'], { timeout: LIST_COMMAND_MS }).catch(() =>
            Buffer.from('')
          )
        )
          .toString()
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('INFO'))
      : []
    const running = new Set(booted.map((device) => device.name))
    const off = avds
      .filter((avd) => !running.has(avd.replace(/_/g, ' ')))
      .map((avd): MobileDevice => ({
        id: avd,
        platform: 'android',
        name: avd.replace(/_/g, ' '),
        os: '',
        booted: false
      }))
    return [...booted, ...off]
  }

  /** Let go of the listed platforms' devices that are no longer booted. */
  private forgetGone(devices: MobileDevice[], platforms: DevicePlatform[]): void {
    const booted = new Set(devices.filter((d) => d.booted).map((d) => d.id))
    for (const [id, { driver }] of [...this.drivers]) {
      if (booted.has(id) || !platforms.includes(driver.info.platform)) continue
      this.forget(id)
      this.androidInfo.delete(id)
    }
  }

  /** Let go of a device's driver, its log collection and its screen as last read. */
  private forget(id: string): void {
    this.drivers.get(id)?.driver.close()
    this.drivers.delete(id)
    this.logging.get(id)?.()
    this.logging.delete(id)
    this.reads.delete(id)
  }

  /** Android devices adb sees but cannot use yet, and why. */
  notReady(): string[] {
    return this.unready
  }

  /**
   * The booted device a tool names: "ios" or "android" for the only booted one
   * of that platform, else its name or ID.
   */
  async device(spec: string): Promise<DeviceDriver> {
    const wanted = spec.trim().toLowerCase()
    const devices = await this.list(wanted === 'ios' || wanted === 'android' ? [wanted] : PLATFORMS)
    const found =
      wanted === 'ios' || wanted === 'android'
        ? devices.filter((d) => d.platform === wanted && d.booted)
        : devices.filter((d) => d.id.toLowerCase() === wanted || d.name.toLowerCase() === wanted)
    if (found.length === 0) {
      const booted = devices.filter((d) => d.booted).map((d) => `${d.name} (${d.platform})`)
      throw new Error(
        wanted === 'ios' || wanted === 'android'
          ? `No ${wanted === 'ios' ? 'iOS simulator' : 'Android device'} is booted. ${booted.length ? `Booted: ${booted.join(', ')}.` : 'None is.'} Boot one with the devices tool.`
          : `No device is named "${spec}". Call the devices tool to see them.`
      )
    }
    if (found.length > 1) {
      throw new Error(
        `Several are booted: ${found.map((d) => `"${d.name}"`).join(', ')}. Name the one to use.`
      )
    }
    const [info] = found
    if (!info.booted) throw new Error(`${info.name} is not booted. Boot it with the devices tool.`)
    return this.driverFor(info)
  }

  /** "both": the booted iOS simulator and Android device, or the one that is booted; else the one device named. */
  async devices(spec: string): Promise<DeviceDriver[]> {
    if (spec.trim().toLowerCase() !== 'both') return [await this.device(spec)]
    const booted = (await this.list()).filter((d) => d.booted)
    const platforms = PLATFORMS.filter((platform) => booted.some((d) => d.platform === platform))
    if (platforms.length === 0) {
      throw new Error(
        'No iOS simulator or Android device is booted. Boot one with the devices tool.'
      )
    }
    return Promise.all(platforms.map((platform) => this.device(platform)))
  }

  /**
   * Which run of a booted device this is. A device restarted outside these
   * tools keeps its ID, but the connections made to it before no longer work.
   */
  private runOf(info: MobileDevice): string | undefined {
    if (info.platform === 'ios') return this.iosBoots.get(info.id)
    return info.physical ? undefined : emulatorRun(info.id)
  }

  private async driverFor(info: MobileDevice): Promise<DeviceDriver> {
    const run = this.runOf(info)
    const known = this.drivers.get(info.id)
    if (known && known.run === run) return known.driver
    // Restarted since: connect to it afresh.
    if (known) this.forget(info.id)
    let driver: DeviceDriver
    if (info.platform === 'ios') {
      const type = this.deviceTypes.get(info.id)
      if (!type) throw new Error(`Could not tell what kind of device ${info.name} is.`)
      driver = new IosSimulator(info, type)
    } else {
      const adb = await adbPath()
      if (!adb) throw new Error('adb is not installed.')
      const emulator = info.physical
        ? undefined
        : await connectEmulator(info.id).catch(() => undefined)
      driver = new AndroidDevice(info, adb, emulator)
    }
    // Two calls at once may both have made one; keep the first.
    const raced = this.drivers.get(info.id)
    if (raced) return raced.driver
    this.drivers.set(info.id, { driver, run })
    this.logging.set(info.id, driver.collectLogs(this.logs))
    if (info.platform === 'android') await this.reverse(info.id, this.forwardedPorts())
    return driver
  }

  /** Boot a device; `cold` starts an emulator afresh instead of from its last snapshot. */
  async boot(spec: string, cold = false): Promise<MobileDevice> {
    const devices = await this.list()
    const wanted = spec.trim().toLowerCase()
    const info = devices.find(
      (d) => d.id.toLowerCase() === wanted || d.name.toLowerCase() === wanted
    )
    if (!info) throw new Error(`No device is named "${spec}". Call the devices tool to see them.`)
    if (info.booted) return info
    if (info.platform === 'ios') {
      await run('xcrun', ['simctl', 'boot', info.id])
      await run('xcrun', ['simctl', 'bootstatus', info.id, '-b'], { timeout: BOOT_TIMEOUT_MS })
      // Booted by simctl it has no window; the Simulator app shows it, as the emulator shows itself.
      await run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', info.id])
    } else {
      await this.bootEmulator(info.id, cold)
    }
    const now = (await this.relist([info.platform])).find((d) => d.name === info.name)
    if (!now?.booted) throw new Error(`${info.name} did not come up.`)
    return now
  }

  /**
   * Shut a device down and boot it again, as when it hangs or shows a dialog
   * saying the system is not responding; `cold` for an emulator not to come
   * back from the snapshot it hung in.
   */
  async restart(spec: string, cold = false): Promise<MobileDevice> {
    const driver = await this.device(spec)
    const { id, name, platform } = driver.info
    await driver.shutdown()
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
    // An emulator shows as offline while it quits; booting it again before it is gone fails.
    const up = async (): Promise<boolean> =>
      (await this.relist([platform])).some((d) => d.id === id && d.booted) ||
      this.unready.some((serial) => serial.startsWith(`${id} `))
    while (await up()) {
      if (Date.now() >= deadline) {
        throw new Error(`${name} did not shut down within ${SHUTDOWN_TIMEOUT_MS / 1000}s.`)
      }
      await sleep(1000)
    }
    // A simulator boots by its ID; an emulator that is off is listed by its AVD name.
    return this.boot(platform === 'ios' ? id : name, cold)
  }

  /** Start an emulator by its AVD name and wait until Android has finished starting. */
  private async bootEmulator(avd: string, cold: boolean): Promise<void> {
    const emulator = await emulatorPath()
    const adb = await adbPath()
    if (!emulator || !adb) throw new Error('The Android Emulator and adb need to be installed.')
    // It keeps running after the app quits, as an emulator started from Android Studio does.
    const args = ['-avd', avd, ...(cold ? ['-no-snapshot-load'] : [])]
    const child = spawn(emulator, args, { detached: true, stdio: 'ignore' })
    child.unref()
    let exited: number | null | undefined
    child.on('exit', (code) => (exited = code))
    const name = avd.replace(/_/g, ' ')
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited !== undefined) throw new Error(`The emulator exited with code ${exited}.`)
      const device = (await this.relist(['android'])).find((d) => d.booted && d.name === name)
      if (device) {
        const done = await run(adb, ['-s', device.id, 'shell', 'getprop', 'sys.boot_completed'])
          .then((out) => out.toString().trim() === '1')
          .catch(() => false)
        if (done) return
      }
      await sleep(2000)
    }
    throw new Error(`${name} did not finish starting within ${BOOT_TIMEOUT_MS / 1000}s.`)
  }

  async shutdown(spec: string): Promise<void> {
    const driver = await this.device(spec)
    await driver.shutdown()
    await this.relist([driver.info.platform])
  }

  /**
   * Let Android devices reach this port on this computer at their own
   * localhost: Metro's, or a backend's. Kept, so devices that boot later and
   * emulators that restart get it too.
   */
  async forward(port: number): Promise<void> {
    this.forwarded.add(port)
    const android = (await this.list(['android'])).filter((d) => d.booted)
    await Promise.all(android.map((d) => this.reverse(d.id, [port])))
  }

  /** The ports forwarded to Android devices, Metro's among them. */
  forwardedPorts(): number[] {
    return [...new Set([this.metro.port, ...this.forwarded])].sort((a, b) => a - b)
  }

  private async reverse(serial: string, ports: number[]): Promise<void> {
    const adb = await adbPath()
    if (!adb) return
    for (const port of ports) {
      await run(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]).catch((error) =>
        console.error(`adb reverse on ${serial}:`, error)
      )
    }
  }

  // --- The screen, as agents read it ----------------------------------------

  /**
   * Wait until the screen stops changing (an animation, a screen loading), for
   * up to `ms`; returns how it looks then.
   */
  async settle(driver: DeviceDriver, ms: number): Promise<{ image: NativeImage; moving: boolean }> {
    let image = await driver.screenshot()
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      await sleep(250)
      const next = await driver.screenshot()
      if (sameScreen(image, next)) return { image: next, moving: false }
      image = next
    }
    return { image, moving: true }
  }

  /**
   * The screen and what is on it; its elements become what refs (e1, e2…)
   * point at. `steady` is for after an app loads, when the element list can
   * still be the app that was in front before.
   */
  async read(
    driver: DeviceDriver,
    settled?: { image: NativeImage; moving: boolean },
    { steady = false }: { steady?: boolean } = {}
  ): Promise<ScreenRead> {
    const { width, height } = await driver.size()
    const { image, moving } = settled ?? { image: await driver.screenshot(), moving: false }
    let elements: ScreenElement[] = []
    let elementsError: string | undefined
    try {
      elements = await driver.elements()
      // A simulator's accessibility tree trails its screen while one app takes over from
      // another: read until two reads agree. Android's dump waits for the screen to be idle itself.
      if (steady && driver.info.platform === 'ios') {
        const deadline = Date.now() + STEADY_MS
        while (Date.now() < deadline) {
          const again = await driver.elements()
          if (sameElements(elements, again)) break
          elements = again
        }
      }
    } catch (error) {
      elementsError = (error as Error).message
    }
    this.reads.set(driver.info.id, { elements, image })
    return { device: driver.info, width, height, elements, elementsError, image, moving }
  }

  /** The elements of this device's screen as an agent last read it. */
  lastElements(driver: DeviceDriver): ScreenElement[] | undefined {
    return this.reads.get(driver.info.id)?.elements
  }

  /**
   * An element by its ref from the latest read of this device's screen, where
   * it is now (`now` is how the screen looks): when the screen changed since
   * it was read (a list scrolled, a sheet came up), it is looked for again by
   * its role, label and ID, so a ref never acts on what took its place.
   */
  async element(
    driver: DeviceDriver,
    ref: string,
    now: NativeImage
  ): Promise<{ element: ScreenElement; moved: boolean; elements: ScreenElement[] }> {
    const index = Number(ref.replace(/^e/i, '')) - 1
    const read = this.reads.get(driver.info.id)
    const element = read?.elements[index]
    if (!read || !element) {
      throw new Error(
        `No element ${ref} on the latest screen of ${driver.info.name}. Read it again with screen.`
      )
    }
    if (sameScreen(read.image, now)) return { element, moved: false, elements: read.elements }
    const named = Boolean(element.label || element.id)
    const elements = await driver.elements()
    const nearest = elements
      .filter((e) => e.role === element.role && e.label === element.label && e.id === element.id)
      .sort((a, b) => distance(a, element) - distance(b, element))[0]
    const moved = nearest ? distance(nearest, element) > 1 : true
    // Elements without a name are told apart only by where they are.
    if (!nearest || (moved && !named)) {
      throw new Error(
        `${ref} (${element.role}${element.label ? ` "${element.label}"` : ''}) is no longer where it was on the screen of ${driver.info.name}, which changed since it was read. Read it again with screen.`
      )
    }
    return { element: nearest, moved, elements }
  }

  /**
   * The elements showing this text now, best first: in their label, value or
   * ID, on screen before off it, the whole text before a part of it, and what
   * can be acted on before what cannot. With `field`, text fields come first.
   * With them, every element on the screen.
   */
  async find(
    driver: DeviceDriver,
    text: string,
    { field = false }: { field?: boolean } = {}
  ): Promise<{ matches: ScreenElement[]; elements: ScreenElement[] }> {
    const [elements, size] = await Promise.all([driver.elements(), driver.size()])
    const wanted = text.trim().toLowerCase()
    const fields = (e: ScreenElement): string[] =>
      [e.label, e.value ?? '', e.id ?? ''].map((f) => f.toLowerCase())
    const rank = (e: ScreenElement): number =>
      (isOnScreen(e, size) ? 0 : 16) +
      (field && e.role !== 'textfield' ? 8 : 0) +
      (fields(e).some((f) => f === wanted) ? 0 : 4) +
      (['text', 'image', 'heading'].includes(e.role) ? 1 : 0)
    const matches = elements
      .filter((e) => fields(e).some((f) => f.includes(wanted)))
      .sort((a, b) => rank(a) - rank(b))
    return { matches, elements }
  }

  /**
   * Errors the app hit since `since`: crashes, its JavaScript's errors, and
   * Metro's, which a screen alone may not show.
   */
  errorsSince(driver: DeviceDriver, since: number): LogLine[] {
    return this.logs.query({
      since,
      sources: [driver.info.name, 'metro'],
      level: 'error',
      match: (line) => line.crash === true || line.js === true || line.source === 'metro'
    })
  }

  formatErrors(lines: LogLine[]): string {
    if (lines.length === 0) return ''
    const shown = lines.slice(0, 5).map(formatLine).join('\n')
    const more = lines.length > 5 ? `\n(${lines.length - 5} more; see logs)` : ''
    return `\n\nErrors logged meanwhile:\n${shown}${more}`
  }

  /**
   * Stop collecting logs, and the Metro started here, when the app quits;
   * the devices keep running.
   */
  stopAll(): void {
    this.metro.signal('SIGTERM')
    for (const stop of this.logging.values()) stop()
    this.logging.clear()
    for (const { driver } of this.drivers.values()) driver.close()
    this.drivers.clear()
  }
}

/** Whether two element lists show the same: the same elements, values and places. */
export function sameElements(a: ScreenElement[], b: ScreenElement[]): boolean {
  const key = (e: ScreenElement): string =>
    `${e.role} ${e.label} ${e.value ?? ''} ${Math.round(e.x)} ${Math.round(e.y)}`
  return a.length === b.length && a.every((e, i) => key(e) === key(b[i]))
}

/** Whether an element's center is on the screen, not scrolled out of it. */
export function isOnScreen(
  element: ScreenElement,
  size: { width: number; height: number }
): boolean {
  const x = element.x + element.width / 2
  const y = element.y + element.height / 2
  return x >= 0 && x < size.width && y >= 0 && y < size.height
}

/** React Native's warning or error toast, when a development build shows it. */
export function warningToast(elements: ScreenElement[]): ScreenElement | undefined {
  return elements.find((e) => WARNING_TOAST.test(e.label))
}

/** How far apart two elements' corners are, in points. */
function distance(a: ScreenElement, b: ScreenElement): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Whether two screenshots show the same screen, compared small, so a blinking
 * cursor or a clock changing a pixel does not count as change.
 */
export function sameScreen(a: NativeImage, b: NativeImage): boolean {
  const small = (image: NativeImage): Buffer => image.resize({ width: 48 }).toBitmap()
  const x = small(a)
  const y = small(b)
  if (x.length !== y.length) return false
  let difference = 0
  for (let i = 0; i < x.length; i++) difference += Math.abs(x[i] - y[i])
  return difference / x.length < 1
}
