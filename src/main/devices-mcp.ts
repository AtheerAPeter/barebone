import { isAbsolute, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AndroidDevice } from './device-android'
import { sleep, type DeviceDriver, type ScreenElement } from './device-driver'
import { formatLine, type LogLine } from './device-logs'
import type { DeviceManager, ScreenRead } from './devices'
import { startCommand } from './metro'

/**
 * The device tools: an MCP server, next to the browser's (browser-mcp.ts,
 * under /devices), that drives the iOS simulators and Android emulators and
 * phones on this computer for testing mobile apps. Only listed while Settings
 * turns them on, so agents that do not build mobile apps never see them.
 *
 * Built around what made agents slow at this before: every action waits for
 * the screen to settle and returns it, elements are named and tapped by ref or
 * text in one set of coordinates on both platforms, waiting is for text and
 * not for seconds, and errors the app logs come back with the action.
 */

export const SERVER_NAME = 'harness_devices'

export const DEVICES_GUIDANCE =
  'These tools drive the iOS simulators and Android emulators and phones on this computer, which the user watches in the Simulator app and the emulator\'s window. Use them to run and test mobile apps (React Native, Expo or native) as a user would, instead of osascript, screen capture, or `xcrun simctl io`, `axe` and `adb shell input` commands. Name a device "ios" or "android" (the booted one of that platform) or by name, or "both" where a tool takes it. screen returns a screenshot and the elements on it, with refs (e1, e2…) and center points. Every action (tap, swipe, type, press, app) waits until the screen stops changing and returns the new screen, so never sleep or take another screenshot after one. Tap elements by ref or text; use x and y, in the screenshot\'s points (the same on both platforms), only for what has no element. Use wait_for to wait for text to appear or go (a reply streaming in, a screen loading), not sleep. After changing app code, check the change in the running app, on both platforms when it runs on both: Metro hot-reloads most edits, and metro reload reloads the apps. logs shows the apps\' logs, crashes and Metro\'s output; actions report errors the app logged meanwhile. Start Metro with the metro tool so its output (on iOS, the app\'s console output too) reaches logs. In Expo Go, open a project with app open_url at exp://127.0.0.1:<Metro\'s port>; a development build opens by its own scheme or by launching it. The apps may be signed in to real accounts: test only with actions safe to repeat, and never pay, delete real data or message other people unless the user asked.'

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

/** How long an action waits for the screen to settle before returning it as it is. */
const SETTLE_MS = 4_000
/** Longer after what loads a screen or an app. */
const LOAD_SETTLE_MS = 8_000
/** The longest wait_for waits: MCP clients give up on a call after 60 s. */
const MAX_WAIT_SECONDS = 50
/** Most elements listed; a long list is cut. */
const MAX_ELEMENTS = 200

export interface DevicesRouting {
  /** The chat a call comes from, by the chat ID it passes, else the only running one. */
  chatFor(id: string | undefined): string | undefined
  projectPath(chatId: string): string | undefined
  /** Ask the user to let the chat run a command, unless its agent asks for every call itself; throws when they say no. */
  allowCommand(chatId: string, title: string, command: string): Promise<void>
}

const chatArg = {
  chat_id: z
    .string()
    .optional()
    .describe('Your Barebone chat ID, if the conversation gave you one. Omit it otherwise.')
}

const deviceArg = z
  .string()
  .describe('"ios" or "android" for the booted device of that platform, or a device name')

const devicesArg = z
  .string()
  .describe(
    '"ios" or "android" for the booted device of that platform, "both" for the two, or a device name'
  )

const screenshotArg = {
  screenshot: z
    .boolean()
    .optional()
    .describe('Include the screenshot with the elements (default true); false saves tokens')
}

/** What to act on: an element by ref or text, or a point. */
const targetArgs = {
  ref: z.string().optional().describe('Element ref from the latest screen of this device, like e7'),
  text: z
    .string()
    .optional()
    .describe('Or: text the element shows (its label, value or test ID), whole or in part'),
  x: z.number().optional().describe('Or: points from the left, as in the screenshot'),
  y: z.number().optional().describe('Or: points from the top, as in the screenshot')
}

function short(value: string, length = 100): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > length ? `${line.slice(0, length)}…` : line
}

function center(element: ScreenElement): { x: number; y: number } {
  return {
    x: Math.round(element.x + element.width / 2),
    y: Math.round(element.y + element.height / 2)
  }
}

function elementLine(element: ScreenElement, index: number): string {
  const { x, y } = center(element)
  const label = element.label ? ` "${short(element.label)}"` : ''
  const value =
    element.value && element.value !== element.label ? ` value "${short(element.value)}"` : ''
  const id = element.id ? ` id=${element.id}` : ''
  return `e${index + 1} ${element.role}${label}${value}${id} at ${x},${y} (${Math.round(element.width)}×${Math.round(element.height)})`
}

/** A screen as the tools return it: what is on it in text, then the screenshot. */
function screenContent(read: ScreenRead, note: string, screenshot: boolean): ToolResult['content'] {
  const { device } = read
  const lines = [
    `${note}${note ? '\n' : ''}${device.name} (${device.os}), ${read.width}×${read.height} points.${read.moving ? ' The screen was still changing when the wait ran out (an animation, a spinner or streaming text); this is how it looked then.' : ''}`
  ]
  if (read.elementsError) {
    lines.push(
      `No element list: ${read.elementsError} Use the screenshot and tap by x and y, or try screen again.`
    )
  } else if (read.elements.length === 0) {
    lines.push('No elements found on screen.')
  } else {
    lines.push(
      'Elements (center at x,y in points):',
      ...read.elements.slice(0, MAX_ELEMENTS).map(elementLine)
    )
    if (read.elements.length > MAX_ELEMENTS) {
      lines.push(`(${read.elements.length - MAX_ELEMENTS} more not listed)`)
    }
  }
  const content: ToolResult['content'] = [{ type: 'text', text: lines.join('\n') }]
  if (screenshot) {
    content.push({
      type: 'image',
      data: read.image.toJPEG(70).toString('base64'),
      mimeType: 'image/jpeg'
    })
  }
  return content
}

export async function buildDevicesServer(
  manager: DeviceManager,
  routing: DevicesRouting
): Promise<McpServer> {
  // The MCP SDK takes ~150 ms to load; it loads with the first request, not at launch.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const server = new McpServer(
    { name: SERVER_NAME, version: '1.0.0' },
    { instructions: DEVICES_GUIDANCE }
  )

  /**
   * After an action: wait for the screen to settle, and return it with what
   * was done, errors the app logged meanwhile, and whether the user is at it.
   */
  const after = async (
    driver: DeviceDriver,
    done: string,
    since: number,
    { wait = SETTLE_MS, screenshot = true }: { wait?: number; screenshot?: boolean } = {}
  ): Promise<ToolResult['content']> => {
    // Give what the action started (a navigation, a keyboard) a moment to begin.
    await sleep(300)
    const read = await manager.read(driver, await manager.settle(driver, wait))
    const content = screenContent(read, done, screenshot)
    const errors = manager.formatErrors(manager.errorsSince(driver, since))
    if (errors && content[0].type === 'text') content[0].text += errors
    return content
  }

  /** The point an action is at: an element by ref or text, or x and y. */
  const pointOf = async (
    driver: DeviceDriver,
    target: { ref?: string; text?: string; x?: number; y?: number }
  ): Promise<{ x: number; y: number; what: string }> => {
    if (target.ref) {
      const element = manager.element(driver, target.ref)
      return {
        ...center(element),
        what: `${target.ref} ${element.role} "${short(element.label, 40)}"`
      }
    }
    if (target.text) {
      const element = await manager.find(driver, target.text)
      if (!element) {
        throw new Error(
          `Nothing on the screen of ${driver.info.name} shows "${target.text}". Read it with screen.`
        )
      }
      return {
        ...center(element),
        what: `${element.role} "${short(element.label || target.text, 40)}"`
      }
    }
    if (target.x !== undefined && target.y !== undefined) {
      return { x: target.x, y: target.y, what: `${target.x},${target.y}` }
    }
    throw new Error('Pass a ref, a text, or x and y.')
  }

  server.registerTool(
    'devices',
    {
      description:
        'List the iOS simulators and Android emulators and phones on this computer (booted or not), which tools are missing, and whether Metro runs; or boot or shut one down. Booting can take a minute or two.',
      inputSchema: {
        action: z.enum(['list', 'boot', 'shutdown']).optional().describe('list when left out'),
        device: z.string().optional().describe('boot and shutdown: the device name or ID')
      }
    },
    async ({ action = 'list', device }) => {
      if (action === 'list') {
        const [devices, checks, metro] = await Promise.all([
          manager.list(),
          manager.checks(),
          manager.metro.status()
        ])
        const booted = devices
          .filter((d) => d.booted)
          .map(
            (d) =>
              `- ${d.name} (${d.platform}${d.os ? `, ${d.os}` : ''}${d.physical ? ', a phone' : ''})`
          )
        // Xcode has a simulator of every model; those that are off, in one line per platform.
        const off = (['ios', 'android'] as const).flatMap((platform) => {
          const names = devices
            .filter((d) => !d.booted && d.platform === platform)
            .map((d) => (d.os ? `${d.name} (${d.os})` : d.name))
          return names.length
            ? [`Off, ${platform === 'ios' ? 'iOS' : 'Android'}: ${names.join(', ')}`]
            : []
        })
        const missing = checks
          .filter((c) => !c.found)
          .map((c) => `${c.name} is not installed, so no ${c.use}. To install it: ${c.install}`)
        return text(
          [
            booted.length ? 'Booted:' : 'No device is booted.',
            ...booted,
            ...(off.length ? ['', ...off] : []),
            ...(missing.length ? ['', ...missing] : []),
            '',
            metro
          ].join('\n')
        )
      }
      if (!device) throw new Error(`"device" is needed to ${action} a device.`)
      if (action === 'shutdown') {
        await manager.shutdown(device)
        return text(`Shut down ${device}.`)
      }
      const booted = await manager.boot(device)
      const [driver] = await manager.devices(booted.id)
      return {
        content: await after(driver, `${booted.name} is booted.`, manager.logs.cursor, {
          wait: LOAD_SETTLE_MS
        })
      }
    }
  )

  server.registerTool(
    'screen',
    {
      description:
        "Read a device's screen: its elements with refs (e1, e2…), roles, labels, values and center points, and a screenshot in the same points. Actions return the screen themselves; call this to look before acting.",
      inputSchema: { device: devicesArg, ...screenshotArg },
      annotations: { readOnlyHint: true }
    },
    async ({ device, screenshot = true }) => {
      // Both devices at once: each waits for its own screen to settle.
      const reads = await Promise.all(
        (await manager.devices(device)).map(async (driver) =>
          manager.read(driver, await manager.settle(driver, 2000))
        )
      )
      return { content: reads.flatMap((read) => screenContent(read, '', screenshot)) }
    }
  )

  server.registerTool(
    'tap',
    {
      description:
        'Tap an element by ref or text, or a point; with hold_ms, press and hold (a long press). Returns the screen once it settles.',
      inputSchema: {
        device: deviceArg,
        ...targetArgs,
        hold_ms: z.number().optional().describe('Hold this long, for a long press (e.g. 1000)'),
        ...screenshotArg
      }
    },
    async ({ device, hold_ms, screenshot, ...target }) => {
      const [driver] = await manager.devices(device)
      const since = manager.logs.cursor
      const point = await pointOf(driver, target)
      if (hold_ms) await driver.hold(point.x, point.y, hold_ms)
      else await driver.tap(point.x, point.y)
      const done = hold_ms ? `Held ${point.what} for ${hold_ms} ms.` : `Tapped ${point.what}.`
      return { content: await after(driver, done, since, { screenshot }) }
    }
  )

  server.registerTool(
    'swipe',
    {
      description:
        'Swipe: the finger moves in `direction` from an element, a point or the middle of the screen (up scrolls a list to later items), or from x,y to to_x,to_y. For the iOS back gesture, swipe right from x 2. Returns the screen once it settles.',
      inputSchema: {
        device: deviceArg,
        direction: z.enum(['up', 'down', 'left', 'right']).optional(),
        ...targetArgs,
        to_x: z.number().optional().describe('Where the finger ends, instead of direction'),
        to_y: z.number().optional(),
        distance: z
          .number()
          .optional()
          .describe('With direction: how far in points (default: half the screen)'),
        duration_ms: z.number().optional().describe('How long the swipe takes (default 300)'),
        ...screenshotArg
      }
    },
    async ({
      device,
      direction,
      to_x,
      to_y,
      distance,
      duration_ms = 300,
      screenshot,
      ...target
    }) => {
      const [driver] = await manager.devices(device)
      const since = manager.logs.cursor
      const size = await driver.size()
      const from =
        target.ref || target.text || target.x !== undefined
          ? await pointOf(driver, target)
          : { x: size.width / 2, y: size.height / 2, what: 'the middle of the screen' }
      let to: { x: number; y: number }
      if (to_x !== undefined && to_y !== undefined) {
        to = { x: to_x, y: to_y }
      } else if (direction) {
        const length =
          distance ?? (direction === 'up' || direction === 'down' ? size.height : size.width) / 2
        const dx = direction === 'left' ? -length : direction === 'right' ? length : 0
        const dy = direction === 'up' ? -length : direction === 'down' ? length : 0
        // Kept on screen: a swipe that leaves it is cut short by the system.
        to = {
          x: Math.min(Math.max(from.x + dx, 1), size.width - 1),
          y: Math.min(Math.max(from.y + dy, 1), size.height - 1)
        }
      } else {
        throw new Error('Pass a direction, or to_x and to_y.')
      }
      await driver.swipe(from.x, from.y, to.x, to.y, duration_ms)
      return {
        content: await after(
          driver,
          `Swiped from ${from.what} to ${Math.round(to.x)},${Math.round(to.y)}.`,
          since,
          { screenshot }
        )
      }
    }
  )

  server.registerTool(
    'type',
    {
      description:
        'Type text into the focused field, or first tap a field by ref, text or point; any characters (umlauts, emoji) on both platforms. submit presses Enter after. Returns the screen once it settles.',
      inputSchema: {
        device: deviceArg,
        value: z.string().describe('The text to type'),
        ...targetArgs,
        submit: z.boolean().optional().describe('Press Enter afterwards'),
        ...screenshotArg
      }
    },
    async ({ device, value, submit, screenshot, ...target }) => {
      const [driver] = await manager.devices(device)
      const since = manager.logs.cursor
      let into = ''
      if (target.ref || target.text || target.x !== undefined) {
        const point = await pointOf(driver, target)
        await driver.tap(point.x, point.y)
        // The keyboard comes up before typing reaches the field.
        await sleep(500)
        into = ` into ${point.what}`
      }
      await driver.type(value)
      if (submit) await driver.key('enter')
      return {
        content: await after(driver, `Typed${into}${submit ? ' and pressed Enter' : ''}.`, since, {
          screenshot
        })
      }
    }
  )

  server.registerTool(
    'press',
    {
      description:
        'Press a hardware button or key: home, back (Android), app-switch, lock, volume-up, volume-down (Android), enter or backspace. Returns the screen once it settles.',
      inputSchema: {
        device: deviceArg,
        button: z.enum([
          'home',
          'back',
          'app-switch',
          'lock',
          'volume-up',
          'volume-down',
          'enter',
          'backspace'
        ]),
        ...screenshotArg
      }
    },
    async ({ device, button, screenshot }) => {
      const [driver] = await manager.devices(device)
      const since = manager.logs.cursor
      if (button === 'enter' || button === 'backspace') await driver.key(button)
      else await driver.button(button)
      return { content: await after(driver, `Pressed ${button}.`, since, { screenshot }) }
    }
  )

  server.registerTool(
    'wait_for',
    {
      description: `Wait until text shows on screen (or with gone, until it is no longer there): a reply streaming in, a screen loading, a spinner ending. Up to ${MAX_WAIT_SECONDS}s. Returns the screen.`,
      inputSchema: {
        device: deviceArg,
        text: z
          .string()
          .describe('Text an element shows: its label, value or test ID, whole or in part'),
        gone: z.boolean().optional().describe('Wait for it to go instead'),
        timeout: z
          .number()
          .optional()
          .describe(`Seconds, at most ${MAX_WAIT_SECONDS} (default 15)`),
        ...screenshotArg
      }
    },
    async ({ device, text: wanted, gone = false, timeout = 15, screenshot }) => {
      const [driver] = await manager.devices(device)
      const since = manager.logs.cursor
      const started = Date.now()
      const deadline = started + Math.min(timeout, MAX_WAIT_SECONDS) * 1000
      let problem = ''
      for (;;) {
        try {
          const found = Boolean(await manager.find(driver, wanted))
          problem = ''
          if (found !== gone) {
            const seconds = ((Date.now() - started) / 1000).toFixed(1)
            const done = `"${wanted}" ${gone ? 'went' : 'showed'} after ${seconds}s.`
            return { content: await after(driver, done, since, { screenshot }) }
          }
        } catch (error) {
          problem = ` The last check failed: ${(error as Error).message}`
        }
        if (Date.now() >= deadline) break
        await sleep(500)
      }
      const done = `"${wanted}" ${gone ? 'is still there' : 'did not show'} after ${Math.min(timeout, MAX_WAIT_SECONDS)}s.${problem}`
      return { content: await after(driver, done, since, { wait: 0, screenshot }) }
    }
  )

  server.registerTool(
    'app',
    {
      description:
        'Apps on a device: open_url (a deep link, or exp://127.0.0.1:<port> for Expo Go), launch, terminate or restart an app by bundle ID (iOS) or package name (Android), install a .app or .apk, uninstall, or list the installed apps. Returns the screen after open_url, launch and restart.',
      inputSchema: {
        device: devicesArg,
        action: z.enum([
          'open_url',
          'launch',
          'terminate',
          'restart',
          'install',
          'uninstall',
          'list'
        ]),
        app: z.string().optional().describe('Bundle ID or package name, like com.example.app'),
        url: z.string().optional().describe('open_url: the URL'),
        path: z
          .string()
          .optional()
          .describe('install: the .app (iOS simulator) or .apk (Android) path'),
        ...screenshotArg,
        ...chatArg
      }
    },
    async ({ device, action, app, url, path, screenshot, chat_id }) => {
      const drivers = await manager.devices(device)
      const content: ToolResult['content'] = []
      for (const driver of drivers) {
        const since = manager.logs.cursor
        const name = driver.info.name
        if (action === 'list') {
          const apps = await driver.apps()
          content.push({
            type: 'text',
            text: `Apps installed on ${name}: ${apps.join(', ') || 'none'}.`
          })
          continue
        }
        if (action === 'open_url') {
          if (!url) throw new Error('"url" is needed to open a URL.')
          await driver.openUrl(url)
          content.push(
            ...(await after(driver, `Opened ${url}.`, since, { wait: LOAD_SETTLE_MS, screenshot }))
          )
          continue
        }
        if (action === 'install') {
          if (!path) throw new Error('"path" is needed to install an app.')
          const project = routing.chatFor(chat_id) && routing.projectPath(routing.chatFor(chat_id)!)
          const file = isAbsolute(path) || !project ? path : resolve(project, path)
          await driver.install(file)
          content.push({ type: 'text', text: `Installed ${file} on ${name}.` })
          continue
        }
        if (!app) throw new Error(`"app" is needed to ${action} an app.`)
        if (action === 'uninstall') {
          await driver.uninstall(app)
          content.push({ type: 'text', text: `Uninstalled ${app} from ${name}.` })
          continue
        }
        if (action === 'terminate' || action === 'restart') {
          await driver.terminate(app).catch((error) => {
            // Restarting an app that is not running just launches it.
            if (action === 'terminate') throw error
          })
        }
        if (action === 'terminate') {
          content.push({ type: 'text', text: `Stopped ${app} on ${name}.` })
          continue
        }
        await driver.launch(app)
        const done = `${action === 'restart' ? 'Restarted' : 'Launched'} ${app}.`
        content.push(...(await after(driver, done, since, { wait: LOAD_SETTLE_MS, screenshot })))
      }
      return { content }
    }
  )

  server.registerTool(
    'settings',
    {
      description:
        "Change a device's settings: light or dark appearance, text size, location, or an app's permission (iOS: camera, photos, location, contacts, microphone, calendar…; Android: CAMERA, ACCESS_FINE_LOCATION, POST_NOTIFICATIONS… or a full permission name).",
      inputSchema: {
        device: devicesArg,
        appearance: z.enum(['light', 'dark']).optional(),
        text_size: z.enum(['small', 'default', 'large', 'largest']).optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        permission: z
          .object({
            app: z.string().describe('Bundle ID or package name'),
            name: z.string().describe('The permission'),
            action: z.enum(['grant', 'revoke', 'reset'])
          })
          .optional()
      }
    },
    async ({ device, appearance, text_size, latitude, longitude, permission }) => {
      const done: string[] = []
      for (const driver of await manager.devices(device)) {
        const name = driver.info.name
        if (appearance) {
          await driver.appearance(appearance)
          done.push(`${name} is in ${appearance} mode.`)
        }
        if (text_size) {
          await driver.textSize(text_size)
          done.push(`${name} has ${text_size} text.`)
        }
        if (latitude !== undefined && longitude !== undefined) {
          await driver.location(latitude, longitude)
          done.push(`${name} is at ${latitude}, ${longitude}.`)
        }
        if (permission) {
          await driver.permission(permission.app, permission.name, permission.action)
          done.push(
            `${permission.action} ${permission.name} for ${permission.app} on ${name}: done.`
          )
        }
      }
      if (!done.length) throw new Error('Pass a setting to change.')
      return text(`${done.join(' ')} Call screen to see the result.`)
    }
  )

  server.registerTool(
    'logs',
    {
      description:
        "Read what the devices and Metro logged: the apps' JavaScript console output and errors (Android always; iOS through a Metro started with the metro tool), crashes, native errors and Metro's bundling output. Pass since (the number the last call said) to get only newer lines.",
      inputSchema: {
        source: z
          .string()
          .optional()
          .describe('"metro", a device ("ios", "android", "both" or a name), or "all" (default)'),
        since: z.number().optional().describe('Only lines numbered this or higher'),
        level: z
          .enum(['debug', 'info', 'warn', 'error'])
          .optional()
          .describe('The lowest level shown (default info)'),
        app: z
          .string()
          .optional()
          .describe("Only this app's lines: its bundle ID, package name or process name"),
        grep: z
          .string()
          .optional()
          .describe('Only lines matching this (a regular expression, case-insensitive)'),
        limit: z.number().optional().describe('At most this many of the newest lines (default 100)')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ source = 'all', since, level = 'info', app, grep, limit = 100 }) => {
      let sources: string[] | undefined
      let pids = new Set<number>()
      if (source === 'metro') sources = ['metro']
      else if (source !== 'all') {
        const drivers = await manager.devices(source)
        sources = drivers.map((d) => d.info.name)
        if (app) {
          for (const driver of drivers) {
            if (driver instanceof AndroidDevice)
              pids = new Set([...pids, ...(await driver.pids(app))])
          }
        }
      }
      let pattern: RegExp | undefined
      if (grep) {
        try {
          pattern = new RegExp(grep, 'i')
        } catch {
          pattern = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        }
      }
      const appName = app?.toLowerCase()
      const matches = (line: LogLine): boolean =>
        (!appName ||
          line.tag.toLowerCase().includes(appName) ||
          line.text.toLowerCase().includes(appName) ||
          (line.pid !== undefined && pids.has(line.pid))) &&
        (!pattern || pattern.test(`${line.tag}: ${line.text}`))
      const lines = manager.logs.query({ since, sources, level, match: matches })
      const shown = lines.slice(-Math.min(Math.max(limit, 1), 500))
      const next = manager.logs.cursor
      const cut =
        lines.length > shown.length
          ? `(${lines.length - shown.length} older lines not shown)\n`
          : ''
      return text(
        shown.length
          ? `${cut}${shown.map(formatLine).join('\n')}\n\nFor newer lines next time, pass since=${next}.`
          : `No lines match${since ? ` since #${since}` : ''}. For newer lines next time, pass since=${next}. Lines are collected from the moment a device is first used with these tools or shown in the panel.`
      )
    }
  )

  server.registerTool(
    'metro',
    {
      description:
        "Metro, which serves a React Native app's JavaScript in development. status: whether it runs. start: in the app's folder (cwd, relative to the project), with `npx expo start` or `npx react-native start` unless you pass a command, and env for its variables; it runs until stopped, and its output goes to logs. stop. reload: reload every app Metro serves (works with any running Metro) and return their screens.",
      inputSchema: {
        action: z.enum(['status', 'start', 'stop', 'reload']),
        cwd: z.string().optional().describe("start: the app's folder (default: the project's)"),
        command: z
          .string()
          .optional()
          .describe('start: the command, like "npx expo start --port 8082"'),
        env: z.record(z.string(), z.string()).optional().describe('start: environment variables'),
        ...screenshotArg,
        ...chatArg
      }
    },
    async ({ action, cwd, command, env, screenshot, chat_id }) => {
      const metro = manager.metro
      if (action === 'status') return text(await metro.status())
      if (action === 'stop') return text(await metro.stop())
      if (action === 'start') {
        const chatId = routing.chatFor(chat_id)
        const project = chatId && routing.projectPath(chatId)
        if (!chatId || !project) {
          throw new Error('Could not tell which chat this is. Pass your chat ID as "chat_id".')
        }
        const folder = cwd ? resolve(project, cwd) : project
        const run = command ?? startCommand(folder)
        await routing.allowCommand(chatId, `Start Metro: ${run}`, run)
        return text(await metro.start(folder, run, env ?? {}))
      }
      const since = manager.logs.cursor
      await metro.reload()
      await manager.forwardMetro(metro.port)
      const booted = (await manager.list()).filter((d) => d.booted)
      const content: ToolResult['content'] = [
        { type: 'text', text: `Told the apps Metro serves on port ${metro.port} to reload.` }
      ]
      for (const device of booted) {
        const [driver] = await manager.devices(device.id)
        content.push(...(await after(driver, '', since, { wait: LOAD_SETTLE_MS, screenshot })))
      }
      return { content }
    }
  )

  return server
}
