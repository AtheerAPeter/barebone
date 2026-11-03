import { spawn } from 'node:child_process'
import type { NativeImage } from 'electron'
import type { DevicePlatform, MobileDevice, MobileToolCheck } from '../shared/types'
import { AndroidDevice, adbPath, emulatorPath } from './device-android'
import { run, sleep, type DeviceDriver, type ScreenElement } from './device-driver'
import { IosSimulator } from './device-ios'
import { DeviceLogs, formatLine, type LogLine } from './device-logs'
import { connectEmulator } from './emulator-grpc'
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
  private drivers = new Map<string, DeviceDriver>()
  /** Stops each device's log collection. */
  private logging = new Map<string, () => void>()
  /** The elements of each device's screen as an agent last read it, which refs point into. */
  private refs = new Map<string, ScreenElement[]>()
  /** Each simulator's device type, from the listing. */
  private deviceTypes = new Map<string, string>()
  /** Each Android device's name and version, which take adb calls to read. */
  private androidInfo = new Map<string, { name: string; os: string; physical: boolean }>()

  constructor() {
    this.metro = new Metro(this.logs, (port) => void this.forwardMetro(port))
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
        { udid: string; name: string; state: string; deviceTypeIdentifier: string }[]
      >
    }
    return Object.entries(devices).flatMap(([runtime, list]) => {
      // com.apple.CoreSimulator.SimRuntime.iOS-26-5: iPhones and iPads, not watches and TVs.
      const version = runtime.match(/\.iOS-([\d-]+)$/)?.[1]
      if (!version) return []
      return list.map((device): MobileDevice => {
        this.deviceTypes.set(device.udid, device.deviceTypeIdentifier)
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
    const serials = (await run(adb, ['devices'], { timeout: LIST_COMMAND_MS }))
      .toString()
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter(([serial, state]) => serial && state === 'device')
      .map(([serial]) => serial)
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

  /** Let go of the listed platforms' devices that are no longer booted: their drivers and logs. */
  private forgetGone(devices: MobileDevice[], platforms: DevicePlatform[]): void {
    const booted = new Set(devices.filter((d) => d.booted).map((d) => d.id))
    for (const [id, driver] of [...this.drivers]) {
      if (booted.has(id) || !platforms.includes(driver.info.platform)) continue
      this.drivers.get(id)?.close()
      this.drivers.delete(id)
      this.logging.get(id)?.()
      this.logging.delete(id)
      this.refs.delete(id)
      this.androidInfo.delete(id)
    }
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

  /** "both": the booted iOS simulator and Android device; else the one device named. */
  async devices(spec: string): Promise<DeviceDriver[]> {
    if (spec.trim().toLowerCase() !== 'both') return [await this.device(spec)]
    return Promise.all([this.device('ios'), this.device('android')])
  }

  private async driverFor(info: MobileDevice): Promise<DeviceDriver> {
    const known = this.drivers.get(info.id)
    if (known) return known
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
    if (raced) return raced
    this.drivers.set(info.id, driver)
    this.logging.set(info.id, driver.collectLogs(this.logs))
    return driver
  }

  async boot(spec: string): Promise<MobileDevice> {
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
      await this.bootEmulator(info.id)
    }
    const now = (await this.relist([info.platform])).find((d) => d.name === info.name)
    if (!now?.booted) throw new Error(`${info.name} did not come up.`)
    if (now.platform === 'android') await this.forwardMetro(this.metro.port)
    return now
  }

  /** Start an emulator by its AVD name and wait until Android has finished starting. */
  private async bootEmulator(avd: string): Promise<void> {
    const emulator = await emulatorPath()
    const adb = await adbPath()
    if (!emulator || !adb) throw new Error('The Android Emulator and adb need to be installed.')
    // It keeps running after the app quits, as an emulator started from Android Studio does.
    const child = spawn(emulator, ['-avd', avd], { detached: true, stdio: 'ignore' })
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

  /** Let Android devices reach Metro on this computer at localhost:<port>. */
  async forwardMetro(port: number): Promise<void> {
    const adb = await adbPath()
    if (!adb) return
    const android = (await this.list(['android'])).filter((d) => d.booted)
    await Promise.all(
      android.map((d) =>
        run(adb, ['-s', d.id, 'reverse', `tcp:${port}`, `tcp:${port}`]).catch((error) =>
          console.error(`adb reverse on ${d.name}:`, error)
        )
      )
    )
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

  /** The screen and what is on it; its elements become what refs (e1, e2…) point at. */
  async read(
    driver: DeviceDriver,
    settled?: { image: NativeImage; moving: boolean }
  ): Promise<ScreenRead> {
    const { width, height } = await driver.size()
    const { image, moving } = settled ?? { image: await driver.screenshot(), moving: false }
    let elements: ScreenElement[] = []
    let elementsError: string | undefined
    try {
      elements = await driver.elements()
    } catch (error) {
      elementsError = (error as Error).message
    }
    this.refs.set(driver.info.id, elements)
    return { device: driver.info, width, height, elements, elementsError, image, moving }
  }

  /** An element by its ref from the latest read of this device's screen. */
  element(driver: DeviceDriver, ref: string): ScreenElement {
    const index = Number(ref.replace(/^e/i, '')) - 1
    const element = this.refs.get(driver.info.id)?.[index]
    if (!element) {
      throw new Error(
        `No element ${ref} on the latest screen of ${driver.info.name}. Read it again with screen.`
      )
    }
    return element
  }

  /**
   * The element showing this text now: its label, value or ID, the whole of
   * it before a part of it, and what can be acted on before what cannot.
   */
  async find(driver: DeviceDriver, text: string): Promise<ScreenElement | undefined> {
    const elements = await driver.elements()
    this.refs.set(driver.info.id, elements)
    const wanted = text.trim().toLowerCase()
    const fields = (e: ScreenElement): string[] =>
      [e.label, e.value ?? '', e.id ?? ''].map((f) => f.toLowerCase())
    const rank = (e: ScreenElement): number =>
      ['text', 'image', 'heading'].includes(e.role) ? 1 : 0
    const byRank = (list: ScreenElement[]): ScreenElement | undefined =>
      [...list].sort((a, b) => rank(a) - rank(b))[0]
    return (
      byRank(elements.filter((e) => fields(e).some((f) => f === wanted))) ??
      byRank(elements.filter((e) => fields(e).some((f) => f.includes(wanted))))
    )
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
    for (const driver of this.drivers.values()) driver.close()
    this.drivers.clear()
  }
}

/**
 * Whether two screenshots show the same screen, compared small, so a blinking
 * cursor or a clock changing a pixel does not count as change.
 */
function sameScreen(a: NativeImage, b: NativeImage): boolean {
  const small = (image: NativeImage): Buffer => image.resize({ width: 48 }).toBitmap()
  const x = small(a)
  const y = small(b)
  if (x.length !== y.length) return false
  let difference = 0
  for (let i = 0; i < x.length; i++) difference += Math.abs(x[i] - y[i])
  return difference / x.length < 1
}
