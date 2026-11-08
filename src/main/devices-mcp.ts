import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { NativeImage } from 'electron'
import { z } from 'zod'
import { AndroidDevice } from './device-android'
import { sleep, type DeviceDriver, type ScreenElement, type ScreenSize } from './device-driver'
import { IosSimulator } from './device-ios'
import { formatLine, type LogLine } from './device-logs'
import {
  isOnScreen,
  sameElements,
  sameScreen,
  warningToast,
  type DeviceManager,
  type ScreenRead
} from './devices'
import { startCommand } from './metro'
import { DEVICES_GUIDANCE, SERVER_NAME } from './devices-guidance'

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

export { SERVER_NAME, DEVICES_GUIDANCE } from './devices-guidance'

type ToolResult = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

/** How long an action waits for the screen to settle before returning it as it is. */
const SETTLE_MS = 4_000
/** Longer after what loads a screen or an app. */
const LOAD_SETTLE_MS = 8_000
/** How long an action first waits for the screen to settle, so it does not land mid-change (a reload, a sheet sliding in). */
const BEFORE_MS = 1_500
/**
 * The longest wait_for waits: MCP clients give up on a call after 60 s, and
 * reading the screen afterwards can take a few seconds on a busy emulator.
 */
const MAX_WAIT_SECONDS = 40
/** How long metro reload waits for Metro to bundle the reloaded app. */
const RELOAD_BUNDLE_MS = 20_000
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

/** Whether one element's frame is inside another's, as a toast's dismiss button is in the toast. */
function within(inner: ScreenElement, outer: ScreenElement): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

/**
 * What covers a point of `target`: an element listed after it (so drawn over
 * it) at the point, other than what holds it or what it holds.
 */
function overlayAt(
  target: ScreenElement,
  elements: ScreenElement[],
  point: { x: number; y: number }
): ScreenElement | undefined {
  return elements
    .slice(elements.indexOf(target) + 1)
    .find((e) => covers(e, point) && !within(target, e) && !within(e, target))
}

/** Whether a point is inside an element's frame. */
function covers(element: ScreenElement, point: { x: number; y: number }): boolean {
  return (
    point.x >= element.x &&
    point.x <= element.x + element.width &&
    point.y >= element.y &&
    point.y <= element.y + element.height
  )
}

function elementLine(element: ScreenElement, index: number, size: ScreenSize | ScreenRead): string {
  const { x, y } = center(element)
  const label = element.label ? ` "${short(element.label)}"` : ''
  const value =
    element.value && element.value !== element.label ? ` value "${short(element.value)}"` : ''
  const id = element.id ? ` id=${element.id}` : ''
  const off = isOnScreen(element, size) ? '' : ' (off screen)'
  return `e${index + 1} ${element.role}${label}${value}${id} at ${x},${y} (${Math.round(element.width)}×${Math.round(element.height)})${off}`
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
      ...read.elements.slice(0, MAX_ELEMENTS).map((element, i) => elementLine(element, i, read))
    )
    if (read.elements.length > MAX_ELEMENTS) {
      lines.push(`(${read.elements.length - MAX_ELEMENTS} more not listed)`)
    }
    if (warningToast(read.elements)) {
      lines.push(
        "React Native's warning toast shows at the bottom. A tap by ref or text on what it covers dismisses it first; its warnings are in logs (level warn)."
      )
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

/** The port of a URL at this computer's localhost, which an Android device reaches only when it is forwarded. */
function localPort(url: string): number | undefined {
  if (!URL.canParse(url)) return undefined
  const { hostname, port } = new URL(url)
  return ['localhost', '127.0.0.1'].includes(hostname) && port ? Number(port) : undefined
}

/** A value inside an os_log predicate's double quotes. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`
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

  /** A path an agent passes, relative to its chat's project. */
  const projectFile = (chatId: string | undefined, path: string): string => {
    const chat = routing.chatFor(chatId)
    const project = chat && routing.projectPath(chat)
    return isAbsolute(path) || !project ? path : resolve(project, path)
  }

  /** Before an action: wait for the screen to settle, and return how it looks. */
  const before = async (driver: DeviceDriver): Promise<NativeImage> =>
    (await manager.settle(driver, BEFORE_MS)).image

  /**
   * After an action: wait for the screen to settle, and return it with what
   * was done, whether it changed from `shown` (how it looked before), and
   * errors the app logged meanwhile. `load` is for what loads an app or a
   * screen, which takes longer.
   */
  const after = async (
    driver: DeviceDriver,
    done: string,
    since: number,
    {
      wait,
      load = false,
      screenshot = true,
      shown
    }: { wait?: number; load?: boolean; screenshot?: boolean; shown?: NativeImage } = {}
  ): Promise<ToolResult['content']> => {
    // Give what the action started (a navigation, a keyboard) a moment to begin.
    await sleep(300)
    const settled = await manager.settle(driver, wait ?? (load ? LOAD_SETTLE_MS : SETTLE_MS))
    const earlier = manager.lastElements(driver)
    const read = await manager.read(driver, settled, { steady: load })
    // Both the picture and what is on it: a few letters typed hardly change the picture.
    const unchanged =
      shown &&
      earlier &&
      !settled.moving &&
      sameScreen(shown, settled.image) &&
      sameElements(earlier, read.elements)
        ? ' The screen looks the same as before, so it may have had no effect.'
        : ''
    const content = screenContent(read, `${done}${unchanged}`, screenshot)
    const errors = manager.formatErrors(manager.errorsSince(driver, since))
    if (errors && content[0].type === 'text') content[0].text += errors
    return content
  }

  /** Dismiss React Native's warning toast, which covers `target`, and say what it warned of. */
  const dismissToast = async (
    driver: DeviceDriver,
    toast: ScreenElement,
    target: ScreenElement
  ): Promise<string> => {
    // Its dismiss button is at its right end.
    await driver.tap(toast.x + toast.width - 4, toast.y + toast.height / 2)
    await sleep(500)
    if (warningToast(await driver.elements())) {
      throw new Error(
        `React Native's warning toast covers ${target.role} "${short(target.label, 40)}", and tapping its dismiss button did not close it. Look at the screenshot and tap the toast's ×.`
      )
    }
    const warnings = manager.logs
      .query({
        sources: [driver.info.name, 'metro'],
        level: 'warn',
        match: (line) => line.js === true
      })
      .slice(-3)
      .map(formatLine)
    return ` React Native's warning toast covered it, so it was dismissed first. ${warnings.length ? `Its latest warnings:\n${warnings.join('\n')}` : 'Its warnings are not in logs (on iOS they reach it through a Metro started with the metro tool).'}`
  }

  /**
   * The point an action is at: an element by ref or text, or x and y. `now`
   * is how the screen looks; `field` is for typing, which goes into text fields.
   */
  const pointOf = async (
    driver: DeviceDriver,
    target: { ref?: string; text?: string; x?: number; y?: number },
    now: NativeImage,
    { field = false }: { field?: boolean } = {}
  ): Promise<{ x: number; y: number; what: string; note: string; element?: ScreenElement }> => {
    if (target.x !== undefined && target.y !== undefined && !target.ref && !target.text) {
      return { x: target.x, y: target.y, what: `${target.x},${target.y}`, note: '' }
    }
    let element: ScreenElement
    let elements: ScreenElement[]
    let what: string
    if (target.ref) {
      const found = await manager.element(driver, target.ref, now)
      element = found.element
      elements = found.elements
      what = `${target.ref} ${element.role} "${short(element.label, 40)}"${found.moved ? ' (moved since the screen was read)' : ''}`
    } else if (target.text) {
      const found = await manager.find(driver, target.text, { field })
      const [best] = found.matches
      if (!best) {
        throw new Error(
          `Nothing on the screen of ${driver.info.name} shows "${target.text}". Read it with screen.`
        )
      }
      element = best
      elements = found.elements
      const alike = found.matches.filter((e) => e.role === best.role && e.label === best.label)
      what = `${best.role} "${short(best.label || target.text, 40)}"${alike.length > 1 ? ` (the first of ${alike.length} alike; pass a ref for another)` : ''}`
    } else {
      throw new Error('Pass a ref, a text, or x and y.')
    }
    if (!isOnScreen(element, await driver.size())) {
      throw new Error(
        `${what} is off screen, at ${center(element).x},${center(element).y}. Swipe to bring it into view first.`
      )
    }
    const point = center(element)
    // React Native's warning toast covers the bottom of the screen; the action is meant for what is under it.
    const toast = warningToast(elements)
    if (toast && toast !== element && covers(toast, point) && !within(element, toast)) {
      return { ...point, what, element, note: await dismissToast(driver, toast, element) }
    }
    // Something drawn over its middle, like a floating toolbar: act on a part of it nothing covers.
    const overlay = overlayAt(element, elements, point)
    if (!overlay) return { ...point, what, element, note: '' }
    const size = await driver.size()
    const free = [0.25, 0.75, 0.1, 0.9]
      .flatMap((f) => [
        { x: point.x, y: Math.round(element.y + element.height * f) },
        { x: Math.round(element.x + element.width * f), y: point.y }
      ])
      .find(
        (p) =>
          p.x >= 0 &&
          p.x < size.width &&
          p.y >= 0 &&
          p.y < size.height &&
          !overlayAt(element, elements, p)
      )
    const over = `${overlay.role}${overlay.label ? ` "${short(overlay.label, 40)}"` : ''}`
    if (!free) {
      throw new Error(
        `${what} is under ${over}, which covers all of it. Scroll it out from under it first.`
      )
    }
    return {
      ...free,
      what,
      element,
      note: ` Its middle is under ${over}, so the action went to ${free.x},${free.y}, where nothing covers it.`
    }
  }

  server.registerTool(
    'devices',
    {
      description:
        "List the iOS simulators and Android emulators and phones on this computer (booted or not), which tools are missing, the ports forwarded to Android devices, and whether Metro runs. Or boot one, shut it down, or restart it (when it hangs, or shows that something is not responding; cold boots an emulator afresh instead of from its snapshot); booting can take a minute or two. Or forward a port on this computer, like a backend's, to every Android device's localhost, now and after they boot again.",
      inputSchema: {
        action: z
          .enum(['list', 'boot', 'shutdown', 'restart', 'forward'])
          .optional()
          .describe('list when left out'),
        device: z.string().optional().describe('boot, shutdown and restart: the device name or ID'),
        cold: z
          .boolean()
          .optional()
          .describe('boot and restart: start an emulator without its last snapshot (Android)'),
        port: z.number().optional().describe('forward: the port')
      }
    },
    async ({ action = 'list', device, cold = false, port }) => {
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
        const unready = manager.notReady()
        const notReady = unready.length
          ? [
              '',
              `Connected but not usable yet: ${unready.join(', ')}. A phone that is unauthorized needs to be unlocked and to allow USB debugging for this computer; one that is offline, to be plugged in again.`
            ]
          : []
        const missing = checks
          .filter((c) => !c.found)
          .map((c) => `${c.name} is not installed, so no ${c.use}. To install it: ${c.install}`)
        return text(
          [
            booted.length ? 'Booted:' : 'No device is booted.',
            ...booted,
            ...notReady,
            ...(off.length ? ['', ...off] : []),
            ...(missing.length ? ['', ...missing] : []),
            '',
            `Ports Android devices reach at their localhost: ${manager.forwardedPorts().join(', ')}.`,
            metro
          ].join('\n')
        )
      }
      if (action === 'forward') {
        if (!port) throw new Error('"port" is needed to forward a port.')
        await manager.forward(port)
        return text(
          `Android devices reach port ${port} of this computer at their localhost:${port}, now and after they boot again.`
        )
      }
      if (!device) throw new Error(`"device" is needed to ${action} a device.`)
      if (action === 'shutdown') {
        await manager.shutdown(device)
        return text(`Shut down ${device}.`)
      }
      const booted =
        action === 'restart'
          ? await manager.restart(device, cold)
          : await manager.boot(device, cold)
      const [driver] = await manager.devices(booted.id)
      const done = `${booted.name} is ${action === 'restart' ? 'restarted' : 'booted'}.`
      return {
        content: await after(driver, done, manager.logs.cursor, { load: true })
      }
    }
  )

  server.registerTool(
    'screen',
    {
      description:
        "Read a device's screen: its elements with refs (e1, e2…), roles, labels, values and center points, and a screenshot in the same points. Actions return the screen themselves; call this to look before acting. save_to also saves a full-size PNG, for a merge request or the user.",
      inputSchema: {
        device: devicesArg,
        ...screenshotArg,
        save_to: z
          .string()
          .optional()
          .describe(
            'A .png path (relative to the project) to save the screenshot at full size; with both devices, each gets its platform added to the name'
          ),
        ...chatArg
      }
    },
    async ({ device, screenshot = true, save_to, chat_id }) => {
      const drivers = await manager.devices(device)
      // Both devices at once: each waits for its own screen to settle.
      const reads = await Promise.all(
        drivers.map(async (driver) => manager.read(driver, await manager.settle(driver, 2000)))
      )
      const notes = await Promise.all(
        drivers.map(async (driver) => {
          if (!save_to) return ''
          const path = projectFile(chat_id, save_to)
          const file =
            drivers.length > 1
              ? `${path.slice(0, path.length - extname(path).length)}-${driver.info.platform}.png`
              : path
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, (await driver.screenshot(true)).toPNG())
          return `Saved the screenshot at ${file}.`
        })
      )
      const only =
        device.trim().toLowerCase() === 'both' && drivers.length === 1
          ? `Only ${drivers[0].info.platform === 'ios' ? 'an iOS simulator' : 'an Android device'} is booted.`
          : ''
      return {
        content: reads.flatMap((read, i) =>
          screenContent(read, [i === 0 ? only : '', notes[i]].filter(Boolean).join(' '), screenshot)
        )
      }
    }
  )

  server.registerTool(
    'tap',
    {
      description:
        'Tap an element by ref or text, or a point; with hold_ms, press and hold (a long press). Waits for the screen to settle first, so a tap does not land mid-change, and returns the screen once it settles again, saying when it did not change.',
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
      const shown = await before(driver)
      const point = await pointOf(driver, target, shown)
      if (hold_ms) await driver.hold(point.x, point.y, hold_ms)
      else await driver.tap(point.x, point.y)
      const done = `${hold_ms ? `Held ${point.what} for ${hold_ms} ms.` : `Tapped ${point.what}.`}${point.note}`
      return { content: await after(driver, done, since, { screenshot, shown }) }
    }
  )

  server.registerTool(
    'swipe',
    {
      description:
        'Swipe: the finger moves in `direction` from an element, a point or the middle of the screen (up scrolls a list to later items), or from x,y to to_x,to_y. For the iOS back gesture, swipe right from x 2. Returns the screen once it settles, saying when it did not change (the end of a list).',
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
      const shown = await before(driver)
      const from =
        target.ref || target.text || target.x !== undefined
          ? await pointOf(driver, target, shown)
          : { x: size.width / 2, y: size.height / 2, what: 'the middle of the screen', note: '' }
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
          `Swiped from ${from.what} to ${Math.round(to.x)},${Math.round(to.y)}.${from.note}`,
          since,
          { screenshot, shown }
        )
      }
    }
  )

  server.registerTool(
    'type',
    {
      description:
        'Type text into the focused field, or first tap a text field by ref, text or point; any characters (umlauts, emoji) on both platforms, but only ASCII on an Android phone. submit presses Enter after. Returns the screen once it settles.',
      inputSchema: {
        device: deviceArg,
        value: z.string().describe('The text to type (`text` names the field to type into)'),
        ...targetArgs,
        submit: z.boolean().optional().describe('Press Enter afterwards'),
        ...screenshotArg
      }
    },
    async ({ device, value, submit, screenshot, ...target }) => {
      const [driver] = await manager.devices(device)
      const since = manager.logs.cursor
      const shown = await before(driver)
      let into = ''
      let note = ''
      if (target.ref || target.text || target.x !== undefined) {
        let point = await pointOf(driver, target, shown, { field: true })
        await driver.tap(point.x, point.y)
        // What shows the text is no field, like a composer that becomes one, or a button that
        // opens a screen with one: tapped, the field showing the text is typed into.
        if (target.text && point.element && point.element.role !== 'textfield') {
          const opened = await manager.settle(driver, SETTLE_MS)
          const tapped = point.what
          point = await pointOf(driver, target, opened.image, { field: true })
          if (point.element?.role !== 'textfield') {
            throw new Error(
              `Tapped ${tapped}, which is not a text field, and no text field showing "${target.text}" came up. Read the screen, and name the field by its placeholder, value, ID or ref.`
            )
          }
          await driver.tap(point.x, point.y)
          note = ` ${tapped} is not a text field; tapping it brought up this one.`
        }
        // The keyboard comes up before typing reaches the field.
        await sleep(500)
        into = ` into ${point.what}`
        note = `${point.note}${note}`
      }
      await driver.type(value)
      if (submit) await driver.key('enter')
      const done = `Typed${into}${submit ? ' and pressed Enter' : ''}.${note}`
      return {
        content: await after(driver, done, since, {
          screenshot,
          shown
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
      const shown = await before(driver)
      if (button === 'enter' || button === 'backspace') await driver.key(button)
      else await driver.button(button)
      return { content: await after(driver, `Pressed ${button}.`, since, { screenshot, shown }) }
    }
  )

  server.registerTool(
    'wait_for',
    {
      description: `Wait until text shows on screen (or with gone, until it is no longer there): a reply streaming in, a screen loading, a spinner ending. Up to ${MAX_WAIT_SECONDS}s; call it again to wait longer. Returns the screen.`,
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
      const seconds = Math.min(timeout, MAX_WAIT_SECONDS)
      const capped =
        timeout > MAX_WAIT_SECONDS
          ? ` (timeout is in seconds, at most ${MAX_WAIT_SECONDS}: call wait_for again to wait longer)`
          : ''
      const deadline = started + seconds * 1000
      let problem = ''
      for (;;) {
        try {
          const found = (await manager.find(driver, wanted)).matches.length > 0
          problem = ''
          if (found !== gone) {
            const took = ((Date.now() - started) / 1000).toFixed(1)
            const done = `"${wanted}" ${gone ? 'went' : 'showed'} after ${took}s.`
            return { content: await after(driver, done, since, { screenshot }) }
          }
        } catch (error) {
          problem = ` The last check failed: ${(error as Error).message}`
        }
        if (Date.now() >= deadline) break
        await sleep(500)
      }
      const done = `"${wanted}" ${gone ? 'is still there' : 'did not show'} after ${seconds}s${capped}.${problem}`
      return { content: await after(driver, done, since, { wait: 0, screenshot }) }
    }
  )

  server.registerTool(
    'app',
    {
      description:
        'Apps on a device: open_url (a deep link, or exp://127.0.0.1:<port> for Expo Go; on Android its localhost port is forwarded), launch, terminate or restart an app by bundle ID (iOS) or package name (Android), install a .app or .apk, uninstall, list the installed apps, push a notification to an app (iOS simulators), or add_media: add a photo or video to the photo library. Returns the screen after open_url, launch, restart and push.',
      inputSchema: {
        device: devicesArg,
        action: z.enum([
          'open_url',
          'launch',
          'terminate',
          'restart',
          'install',
          'uninstall',
          'list',
          'push',
          'add_media'
        ]),
        app: z.string().optional().describe('Bundle ID or package name, like com.example.app'),
        url: z.string().optional().describe('open_url: the URL'),
        path: z
          .string()
          .optional()
          .describe(
            'install: the .app (iOS simulator) or .apk (Android) path; add_media: the image or video'
          ),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'push: the notification, like {"aps":{"alert":{"title":"Hi","body":"…"}}}, with any data the app reads'
          ),
        ...screenshotArg,
        ...chatArg
      }
    },
    async ({ device, action, app, url, path, payload, screenshot, chat_id }) => {
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
          const port = localPort(url)
          if (port && driver.info.platform === 'android') await manager.forward(port)
          await driver.openUrl(url)
          content.push(
            ...(await after(driver, `Opened ${url}.`, since, { load: true, screenshot }))
          )
          continue
        }
        if (action === 'install' || action === 'add_media') {
          if (!path)
            throw new Error(
              `"path" is needed to ${action === 'install' ? 'install an app' : 'add media'}.`
            )
          const file = projectFile(chat_id, path)
          if (action === 'install') await driver.install(file)
          else await driver.addMedia(file)
          content.push({
            type: 'text',
            text:
              action === 'install'
                ? `Installed ${file} on ${name}.`
                : `Added ${file} to the photos of ${name}.`
          })
          continue
        }
        if (!app) throw new Error(`"app" is needed to ${action} an app.`)
        if (action === 'uninstall') {
          await driver.uninstall(app)
          content.push({ type: 'text', text: `Uninstalled ${app} from ${name}.` })
          continue
        }
        if (action === 'push') {
          if (!payload) throw new Error('"payload" is needed to push a notification.')
          await driver.push(app, JSON.stringify(payload))
          content.push(
            ...(await after(driver, `Pushed a notification to ${app}.`, since, { screenshot }))
          )
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
        content.push(...(await after(driver, done, since, { load: true, screenshot })))
      }
      return { content }
    }
  )

  server.registerTool(
    'settings',
    {
      description:
        "Change a device's settings: light or dark appearance, text size, location, language (iOS: for every app; Android: for one app, Android 13 and later; apps show it once restarted), the on-screen keyboard while a hardware keyboard is connected (Android), or an app's permission (iOS: camera, photos, location, contacts, microphone, calendar…; Android: CAMERA, ACCESS_FINE_LOCATION, POST_NOTIFICATIONS… or a full permission name).",
      inputSchema: {
        device: devicesArg,
        appearance: z.enum(['light', 'dark']).optional(),
        text_size: z.enum(['small', 'default', 'large', 'largest']).optional(),
        latitude: z.number().optional(),
        longitude: z.number().optional(),
        language: z.string().optional().describe('A language code, like "de" or "en-US"'),
        app: z.string().optional().describe('language on Android: the app to set it for'),
        software_keyboard: z
          .boolean()
          .optional()
          .describe('Show the on-screen keyboard even with a hardware keyboard (Android)'),
        permission: z
          .object({
            app: z.string().describe('Bundle ID or package name'),
            name: z.string().describe('The permission'),
            action: z.enum(['grant', 'revoke', 'reset'])
          })
          .optional()
      }
    },
    async ({
      device,
      appearance,
      text_size,
      latitude,
      longitude,
      language,
      app,
      software_keyboard,
      permission
    }) => {
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
        if (language) {
          await driver.language(language, app)
          done.push(
            `${app && driver.info.platform === 'android' ? app : name} is in ${language}; restart the app to see it.`
          )
        }
        if (software_keyboard !== undefined) {
          await driver.softwareKeyboard(software_keyboard)
          done.push(
            `${name} ${software_keyboard ? 'shows' : 'hides'} the on-screen keyboard with a hardware keyboard.`
          )
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
        "Read what the devices and Metro logged: the apps' JavaScript console output and errors (Android always; iOS through a Metro started with the metro tool), crashes, native errors and Metro's bundling output; the system's own lines only with system. Pass since (the number the last call said) to get only newer lines. On an iOS simulator, subsystem (and category) reads what that os_log subsystem logged in the last minutes at every level, like expo-updates' own lines.",
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
        system: z
          .boolean()
          .optional()
          .describe(
            "Also the iOS system's own lines (SpringBoard, locationd…), left out by default"
          ),
        subsystem: z
          .string()
          .optional()
          .describe('iOS: an os_log subsystem to read, like "expo.modules.updates"'),
        category: z.string().optional().describe('With subsystem: only this category'),
        minutes: z.number().optional().describe('With subsystem: how far back (default 10)'),
        limit: z.number().optional().describe('At most this many of the newest lines (default 100)')
      },
      annotations: { readOnlyHint: true }
    },
    async ({
      source = 'all',
      since,
      level = 'info',
      app,
      grep,
      system = false,
      subsystem,
      category,
      minutes = 10,
      limit = 100
    }) => {
      let pattern: RegExp | undefined
      if (grep) {
        try {
          pattern = new RegExp(grep, 'i')
        } catch {
          pattern = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        }
      }
      const most = Math.min(Math.max(limit, 1), 500)
      if (subsystem) {
        const simulators = (
          await manager.devices(source === 'all' || source === 'metro' ? 'ios' : source)
        ).filter((driver): driver is IosSimulator => driver instanceof IosSimulator)
        if (!simulators.length) throw new Error('subsystem reads the log of iOS simulators.')
        const predicate = `subsystem == ${quoted(subsystem)}${category ? ` AND category == ${quoted(category)}` : ''}`
        const parts = await Promise.all(
          simulators.map(async (simulator) => {
            const lines = (await simulator.showLog(predicate, minutes)).filter(
              (line) => !pattern || pattern.test(line)
            )
            return `${simulator.info.name}, ${predicate}, last ${minutes} minutes: ${lines.length ? `\n${lines.slice(-most).join('\n')}` : 'nothing.'}`
          })
        )
        return text(parts.join('\n\n'))
      }
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
      const appName = app?.toLowerCase()
      const matches = (line: LogLine): boolean =>
        (system || Boolean(appName) || !line.system) &&
        (!appName ||
          line.tag.toLowerCase().includes(appName) ||
          line.text.toLowerCase().includes(appName) ||
          (line.pid !== undefined && pids.has(line.pid))) &&
        (!pattern || pattern.test(`${line.tag}: ${line.text}`))
      const lines = manager.logs.query({ since, sources, level, match: matches })
      const shown = lines.slice(-most)
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
        "Metro, which serves a React Native app's JavaScript in development. status: whether it runs. start: in the app's folder (cwd, relative to the project), with `npx expo start` or `npx react-native start` unless you pass a command, and env for its variables; it runs until stopped, and its output goes to logs. stop. reload: reload every app Metro serves (works with any running Metro), wait for the Metro started here to bundle them, and return their screens.",
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
      await manager.forward(metro.port)
      let bundled = ''
      if (metro.runsHere) {
        const lines = await metro.bundled(since, RELOAD_BUNDLE_MS)
        bundled = lines.length
          ? ` Metro: ${lines.join('; ')}`
          : ` Metro bundled nothing within ${RELOAD_BUNDLE_MS / 1000}s, so no app may be loading from it (a release build, or a build loading another server).`
      }
      const booted = (await manager.list()).filter((d) => d.booted)
      const content: ToolResult['content'] = [
        {
          type: 'text',
          text: `Told the apps Metro serves on port ${metro.port} to reload.${bundled}`
        }
      ]
      for (const device of booted) {
        const [driver] = await manager.devices(device.id)
        content.push(...(await after(driver, '', since, { load: true, screenshot })))
      }
      return { content }
    }
  )

  return server
}
