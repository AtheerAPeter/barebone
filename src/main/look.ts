import { app, nativeTheme, shell, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, rmSync, watchFile, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { Look } from '../shared/types'
import * as store from './store'

/**
 * The user's own look for Barebone, which chats make for them (the
 * customize-look skill): look.css, a stylesheet the window and the remote
 * link's pages put after the app's own, so it can restyle and rearrange any
 * of it; and look.json, for the Mac window's chrome no stylesheet reaches.
 * Both are read again as soon as they are saved. View → Custom Look turns
 * them off, for when a stylesheet hides what the user would undo it with.
 */
export const LOOK_DIR = join(app.getPath('userData'), 'look')
export const LOOK_CSS = join(LOOK_DIR, 'look.css')
export const LOOK_JSON = join(LOOK_DIR, 'look.json')

/** Where the traffic lights sit unless look.json moves them: centred on the sidebar's 48px top row. */
export const WINDOW_BUTTONS = { x: 16, y: 17 }

/** The materials macOS can put behind the window (BrowserWindow.setVibrancy). */
const VIBRANCY = [
  'titlebar',
  'selection',
  'menu',
  'popover',
  'sidebar',
  'header',
  'sheet',
  'window',
  'hud',
  'fullscreen-ui',
  'tooltip',
  'content',
  'under-window',
  'under-page'
] as const
type Vibrancy = (typeof VIBRANCY)[number]

/** What look.json sets; each setting left out stays as the app has it. */
interface Chrome {
  /** Where the window's buttons sit, from the window's top left, or false to hide them. */
  windowButtons?: { x: number; y: number } | false
  /** A material behind the window, which shows where the page is transparent. */
  vibrancy?: Vibrancy
}

/** How often the files are checked for changes: soon enough to look live as they are saved. */
const POLL_MS = 300

const isPoint = (value: unknown): value is { x: number; y: number } =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as { x?: unknown }).x) &&
  Number.isFinite((value as { y?: unknown }).y)

/** look.json's settings, and what is wrong with it, said so a chat can fix it. */
function parseChrome(text: string): { chrome: Chrome; problems: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { chrome: {}, problems: [`look.json is not valid JSON: ${(error as Error).message}`] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { chrome: {}, problems: ['look.json must be a JSON object.'] }
  }
  const chrome: Chrome = {}
  const problems: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'windowButtons') {
      if (value === false) chrome.windowButtons = false
      else if (isPoint(value)) {
        chrome.windowButtons = { x: Math.round(value.x), y: Math.round(value.y) }
      } else problems.push('windowButtons must be {"x": number, "y": number}, or false.')
    } else if (key === 'vibrancy') {
      if (VIBRANCY.includes(value as Vibrancy)) chrome.vibrancy = value as Vibrancy
      else problems.push(`vibrancy must be one of: ${VIBRANCY.join(', ')}.`)
    } else {
      problems.push(`look.json has no "${key}" setting; it takes windowButtons and vibrancy.`)
    }
  }
  return { chrome, problems }
}

/** A file's text; undefined when there is none. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export class CustomLook {
  private css: string | undefined
  private json: string | undefined
  private chrome: Chrome = {}
  private problems: string[] = []
  /** Whether the window was made transparent (windowOptions), which lasts as long as it does. */
  private seeThrough = false

  /** `changed` runs after either file changes on disk, once it has been read. */
  constructor(private readonly changed: () => void) {}

  start(): void {
    this.read()
    // Polled, so a file made, replaced or deleted is seen the same way, and
    // the folder need not exist.
    const onStat = (current: Stats, previous: Stats): void => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.ino === previous.ino
      ) {
        return
      }
      this.read()
      this.changed()
    }
    watchFile(LOOK_CSS, { interval: POLL_MS }, onStat)
    watchFile(LOOK_JSON, { interval: POLL_MS }, onStat)
  }

  private read(): void {
    this.problems = []
    try {
      this.css = readText(LOOK_CSS)
    } catch (error) {
      this.css = undefined
      this.problems.push(`look.css could not be read: ${(error as Error).message}`)
    }
    try {
      this.json = readText(LOOK_JSON)
    } catch (error) {
      this.json = undefined
      this.problems.push(`look.json could not be read: ${(error as Error).message}`)
    }
    const parsed = this.json?.trim() ? parseChrome(this.json) : { chrome: {}, problems: [] }
    this.chrome = parsed.chrome
    this.problems.push(...parsed.problems)
  }

  /** Whether there is a look to turn off: look.css or look.json is there. */
  exists(): boolean {
    return this.css !== undefined || this.json !== undefined
  }

  /** Off in View → Custom Look: the app looks as it comes, files and all left as they are. */
  private on(): boolean {
    return !store.getState().customLookOff
  }

  /** look.json's chrome while the look is on; it is the Mac window's alone. */
  private activeChrome(): Chrome {
    return this.on() && process.platform === 'darwin' ? this.chrome : {}
  }

  /** What the window and the remote link's pages draw. */
  look(): Look {
    const on = this.on()
    return {
      css: on ? (this.css ?? '') : '',
      hideWindowButtons: this.activeChrome().windowButtons === false,
      files: this.exists(),
      on
    }
  }

  /**
   * Back to the app's own look: look.css and look.json go to the Trash, so a
   * reset made by mistake can be undone there. Read again at once, rather than
   * at the next check of the files.
   */
  async reset(): Promise<void> {
    for (const path of [LOOK_CSS, LOOK_JSON]) {
      if (!existsSync(path)) continue
      // A server (deploy/vps) has no Trash.
      if (process.platform === 'darwin') await shell.trashItem(path)
      else rmSync(path, { force: true })
    }
    this.read()
  }

  /**
   * How the window is made. A vibrancy shows only through a window made
   * transparent: Electron makes every other window opaque (setOpaque:YES in
   * NativeWindowMac::OnWidgetInitialized), and macOS does not clear what is
   * behind an opaque window's see-through pixels, so earlier frames stay on
   * screen. A transparent window has no native shadow (Electron's documented
   * limit), so only a look that asks for a vibrancy as the window opens gets
   * one; a vibrancy asked for later waits until Barebone is opened again.
   */
  windowOptions(): { transparent: boolean } {
    this.seeThrough = Boolean(this.activeChrome().vibrancy)
    return { transparent: this.seeThrough }
  }

  /** The vibrancy the window shows: look.json's, when the window was made to show one. */
  private vibrancy(): Vibrancy | undefined {
    return this.seeThrough ? this.activeChrome().vibrancy : undefined
  }

  /** The window's own color behind the page, in the theme; clear for a transparent window. */
  background(): string {
    if (this.seeThrough) return '#00000000'
    return nativeTheme.shouldUseDarkColors ? '#0d0d0d' : '#f9f9f9'
  }

  /** Put look.json's chrome on the window, or the app's own where it sets none. */
  applyTo(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    window.setBackgroundColor(this.background())
    if (process.platform !== 'darwin') return
    const { windowButtons } = this.activeChrome()
    window.setWindowButtonPosition(windowButtons || WINDOW_BUTTONS)
    window.setWindowButtonVisibility(windowButtons !== false)
    window.setVibrancy(this.vibrancy() ?? null)
  }

  /**
   * What see_app shows a chat: a picture of the window, an outline of its
   * parts (of one part, with its styles, for a selector), the design tokens
   * when asked, and the state of the look's files.
   */
  async see(
    window: BrowserWindow | undefined,
    part: string | undefined,
    tokens: boolean
  ): Promise<{ image?: string; text: string }> {
    if (!window || window.isDestroyed()) throw new Error("Barebone's window is not open.")
    const notes = [this.describe()]
    let image: string | undefined
    if (window.isVisible() && !window.isMinimized()) {
      const shot = await window.webContents.capturePage()
      // At the window's own size: a Retina picture is four times the pixels and says no more.
      const width = window.getContentBounds().width
      const sized = shot.getSize().width > width ? shot.resize({ width }) : shot
      if (!sized.isEmpty()) image = sized.toPNG().toString('base64')
    }
    if (!image) {
      notes.push('The window is hidden or minimized, so there is no picture, only the outline.')
    }
    notes.push(
      "The browser panel's page is a separate view drawn over the window, so it is not in the picture, and no stylesheet reaches it."
    )
    const outline = (await window.webContents.executeJavaScript(
      `(${outlinePage.toString()})(${JSON.stringify(part ?? null)}, ${tokens})`
    )) as string
    return { image, text: `${notes.join('\n')}\n\n${outline}` }
  }

  /** Where the files are and what is wrong with them. */
  private describe(): string {
    const lines = [
      `look.css: ${LOOK_CSS} (${this.css === undefined ? 'not made yet' : `${this.css.split('\n').length} lines`})`,
      `look.json: ${LOOK_JSON} (${this.json === undefined ? 'not made yet' : 'there'})`
    ]
    if (!this.on()) {
      lines.push(
        'The user turned the custom look off (View → Custom Look), so the window shows the app as it comes. Changes to the files show once they turn it on again.'
      )
    }
    if (process.platform !== 'darwin' && this.json !== undefined) {
      lines.push(
        "look.json's settings are for the Mac window; this computer's window ignores them."
      )
    }
    const asked = this.activeChrome().vibrancy
    if (asked && !this.seeThrough) {
      lines.push(
        `The vibrancy "${asked}" shows once Barebone is opened again: the window has to be made see-through as it opens. Tell the user to quit Barebone (⌘Q) and open it again.`
      )
    } else if (asked) {
      lines.push(
        `The vibrancy "${asked}" is behind the window. The picture cannot show it: there it is plain, as if nothing were behind the window.`
      )
    } else if (this.seeThrough) {
      lines.push(
        'The window was opened see-through for a vibrancy look.json no longer asks for. It has no shadow until Barebone is opened again.'
      )
    }
    for (const problem of this.problems) lines.push(`Problem: ${problem}`)
    return lines.join('\n')
  }
}

/**
 * Run in the window's page: its parts as an indented outline of tags, ids,
 * classes and titles, with their sizes near the top; runs of alike siblings
 * (chats, messages) show two and a count. For a selector, that part in depth,
 * with the styles of the first element it matches. Self-contained, as it is
 * sent to the page as source.
 */
function outlinePage(selector: string | null, withTokens: boolean): string {
  const MAX_LINES = 400
  const lines: string[] = []
  let root: Element | null
  try {
    root = selector ? document.querySelector(selector) : document.getElementById('root')
  } catch {
    return `"${selector}" is not a valid CSS selector.`
  }
  if (!root) return `Nothing on the page matches "${selector}".`
  const maxDepth = selector ? 40 : 10
  const indent = (depth: number): string => '  '.repeat(depth)
  /** tag#id.class.class: what a selector would name it by. */
  const name = (el: Element): string =>
    el.tagName.toLowerCase() +
    (el.id ? `#${el.id}` : '') +
    Array.from(el.classList, (c) => `.${c}`).join('')
  const label = (el: Element, depth: number): string => {
    let line = indent(depth) + name(el)
    const title = el.getAttribute('title') ?? el.getAttribute('aria-label')
    if (title) line += ` title="${title.slice(0, 60)}"`
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (own) line += ` "${own.length > 40 ? `${own.slice(0, 40)}…` : own}"`
    return line
  }
  const box = (el: Element): string => {
    const r = el.getBoundingClientRect()
    return `${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`
  }
  const walk = (el: Element, depth: number): void => {
    if (lines.length >= MAX_LINES) return
    const hidden = getComputedStyle(el).display === 'none'
    let line = label(el, depth)
    if (hidden) line += ' (display: none)'
    else if (selector || depth <= 4) line += `  [${box(el)}]`
    lines.push(line)
    const kids = Array.from(el.children).filter(
      (k) => !['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK'].includes(k.tagName)
    )
    if (hidden || el.tagName.toLowerCase() === 'svg' || kids.length === 0) return
    if (depth >= maxDepth) {
      lines.push(`${indent(depth + 1)}…`)
      return
    }
    for (let i = 0; i < kids.length;) {
      let j = i + 1
      while (j < kids.length && name(kids[j]) === name(kids[i])) j++
      walk(kids[i], depth + 1)
      if (j - i > 1) walk(kids[i + 1], depth + 1)
      if (j - i > 2) lines.push(`${indent(depth + 1)}… ${j - i - 2} more ${name(kids[i])}`)
      i = j
    }
  }
  lines.push(`html${Array.from(document.documentElement.classList, (c) => `.${c}`).join('')}`)
  if (selector) {
    const count = document.querySelectorAll(selector).length
    lines.push(`"${selector}" matches ${count} element${count === 1 ? '' : 's'}; the first:`)
  }
  walk(root, selector ? 0 : 1)
  if (lines.length >= MAX_LINES) lines.push('… cut short: pass a selector to see one part whole.')

  if (selector) {
    const style = getComputedStyle(root)
    const keys = [
      'display',
      'position',
      'inset',
      'flex-direction',
      'order',
      'grid-template-columns',
      'grid-template-rows',
      'gap',
      'width',
      'height',
      'padding',
      'margin',
      'background',
      'color',
      'font',
      'border',
      'border-radius',
      'box-shadow',
      'backdrop-filter',
      'opacity',
      'z-index',
      '-webkit-app-region'
    ]
    lines.push('', 'Its computed styles:')
    for (const key of keys) {
      const value = style.getPropertyValue(key)
      if (value) lines.push(`${key}: ${value}`)
    }
    const inline = root.getAttribute('style')
    if (inline) lines.push(`Inline style (set by the app; override it with !important): ${inline}`)
  }

  if (withTokens) {
    const names = new Set<string>()
    const collect = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (
          rule instanceof CSSStyleRule &&
          rule.selectorText.split(',').some((s) => s.trim() === ':root')
        ) {
          for (const property of Array.from(rule.style)) {
            if (property.startsWith('--')) names.add(property)
          }
        } else if (rule instanceof CSSGroupingRule) {
          collect(rule.cssRules)
        }
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        collect(sheet.cssRules)
      } catch {
        // A sheet from elsewhere keeps its rules to itself.
      }
    }
    const rootStyle = getComputedStyle(document.documentElement)
    const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    lines.push('', `Design tokens on :root, as they are in the ${theme} theme now:`)
    for (const token of names) lines.push(`${token}: ${rootStyle.getPropertyValue(token).trim()}`)
  }
  return lines.join('\n')
}
