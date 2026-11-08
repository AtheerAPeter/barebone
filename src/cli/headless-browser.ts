import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { PageViewport, SavedTabs } from '../shared/types'
import type {
  BrowserPage,
  ChatBrowsers,
  Download,
  EditCommand,
  PageDialog,
  PaperSize
} from '../main/browser-tools'
import { PageDriver, type DevTools, type DriverPage } from '../main/page-driver'
import { userDataPath } from '../main/runtime'

/**
 * The browser agents use on a server: a headless Chromium, driven over the
 * DevTools protocol on a pipe (no port is opened), with the same tools as the
 * app's panel (browser-mcp.ts) through the same driver (page-driver.ts).
 * Each chat has its own tabs; all of them share one profile, kept on disk, so
 * logins survive restarts. The user sees pages only in the screenshots agents
 * take, which reach Telegram as the app's do.
 */

/** The page size; set_viewport changes a tab's. */
const WINDOW = { width: 1280, height: 800 }
/** Tabs one chat's browser may have open. */
const MAX_TABS = 20
/** DevTools commands answer in milliseconds; one that takes this long is stuck. */
const COMMAND_TIMEOUT = 30_000
/** How long an agent waits for a page to load before working with it as it is. */
const LOAD_WAIT_MS = 15_000

/** Inches of the paper sizes PDFs are saved in. */
const PAPER: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 8.27, height: 11.69 },
  Letter: { width: 8.5, height: 11 },
  Legal: { width: 8.5, height: 14 },
  A3: { width: 11.69, height: 16.54 },
  A5: { width: 5.83, height: 8.27 }
}

/** The letters of the editing shortcuts, pressed with Ctrl as on Linux. */
const EDIT_KEYS: Record<EditCommand, string> = {
  selectAll: 'a',
  copy: 'c',
  paste: 'v',
  cut: 'x',
  undo: 'z'
}

type Params = Record<string, unknown>
type Listener = (method: string, params: Params, sessionId?: string) => void

/**
 * The browser's executable: BAREBONE_CHROMIUM, or the Chromium Playwright
 * installs (`npx playwright-core install --with-deps chromium`).
 */
async function executable(): Promise<string> {
  const named = process.env.BAREBONE_CHROMIUM
  if (named) {
    if (!existsSync(named)) throw new Error(`BAREBONE_CHROMIUM is ${named}, which does not exist.`)
    return named
  }
  const { chromium } = await import('playwright-core')
  const path = chromium.executablePath()
  if (!existsSync(path)) {
    throw new Error(
      'Chromium is not installed on this server. In the Barebone folder, run: npx playwright-core install --with-deps chromium'
    )
  }
  return path
}

/**
 * The user agent of Chrome on Linux, as Chrome's reduced user agent has it.
 * Headless Chromium's own says HeadlessChrome, which sign-in pages turn away.
 */
async function userAgentOf(path: string): Promise<string> {
  const { stdout } = await promisify(execFile)(path, ['--version'])
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(stdout)?.[1]
  if (!major) throw new Error(`Could not read Chromium's version from "${stdout.trim()}".`)
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/** A running Chromium and its DevTools pipe: messages are JSON, each ended by a NUL byte. */
class Chromium {
  private next = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  /** Who gets each session's events, by session id; the browser's own have none. */
  private readonly sessions = new Map<string, Listener>()
  private exited = false

  private constructor(
    private readonly child: ChildProcess,
    private readonly input: Writable,
    output: Readable,
    readonly userAgent: string,
    private readonly onBrowserEvent: Listener,
    onExit: () => void
  ) {
    let buffered = ''
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      buffered += chunk
      for (let end = buffered.indexOf('\0'); end !== -1; end = buffered.indexOf('\0')) {
        const message = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        this.receive(JSON.parse(message))
      }
    })
    child.once('exit', (code, signal) => {
      this.exited = true
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Chromium exited (${signal ?? code}).`))
      }
      this.pending.clear()
      onExit()
    })
  }

  static async launch(onBrowserEvent: Listener, onExit: () => void): Promise<Chromium> {
    const path = await executable()
    const userAgent = await userAgentOf(path)
    const profile = join(userDataPath(), 'chromium')
    await mkdir(profile, { recursive: true })
    const args = [
      '--headless',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      `--user-agent=${userAgent}`,
      `--window-size=${WINDOW.width},${WINDOW.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Containers give /dev/shm 64 MB, too little for Chromium.
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      // Chromium refuses to start its sandbox as root; run Barebone as a user to keep it.
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank'
    ]
    const child = spawn(path, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    const [, , , input, output] = child.stdio as [null, null, Readable, Writable, Readable]
    const browser = new Chromium(child, input, output, userAgent, onBrowserEvent, onExit)
    try {
      await browser.send('Browser.getVersion')
    } catch {
      child.kill()
      throw new Error(`Chromium did not start: ${stderr.trim() || 'it gave no reason'}`)
    }
    return browser
  }

  private receive(message: {
    id?: number
    result?: unknown
    error?: { message: string }
    method?: string
    params?: Params
    sessionId?: string
  }): void {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) waiter?.reject(new Error(message.error.message))
      else waiter?.resolve(message.result)
      return
    }
    if (!message.method) return
    const params = message.params ?? {}
    if (message.sessionId)
      this.sessions.get(message.sessionId)?.(message.method, params, message.sessionId)
    else this.onBrowserEvent(message.method, params)
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.exited) return Promise.reject(new Error('Chromium is not running.'))
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chromium did not answer ${method} within ${COMMAND_TIMEOUT / 1000}s.`))
      }, COMMAND_TIMEOUT)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`)
    })
  }

  listen(sessionId: string, listener: Listener): void {
    this.sessions.set(sessionId, listener)
  }

  unlisten(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  async close(): Promise<void> {
    if (this.exited) return
    const exited = new Promise((resolve) => this.child.once('exit', resolve))
    await this.send('Browser.close').catch(() => this.child.kill())
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
    if (!this.exited) this.child.kill('SIGKILL')
  }
}

function siteOf(url: string): string {
  try {
    return new URL(url).host || 'This page'
  } catch {
    return 'This page'
  }
}

/** A free file name in the folder: "name.ext", then "name (1).ext", ... */
function uniquePath(folder: string, fileName: string): string {
  const ext = extname(fileName)
  const stem = basename(fileName, ext) || 'download'
  let path = join(folder, `${stem}${ext}`)
  for (let n = 1; existsSync(path); n++) path = join(folder, `${stem} (${n})${ext}`)
  return path
}

/** A file's name from its response headers, else from its URL. */
function fileNameOf(url: string, headers: Record<string, string> | undefined): string {
  const disposition = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-disposition'
  )?.[1]
  const named =
    disposition &&
    (/filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1] ??
      /filename="?([^";]+)"?/i.exec(disposition)?.[1])
  if (named) return basename(decodeURIComponent(named.trim()))
  try {
    return basename(decodeURIComponent(new URL(url).pathname)) || 'download'
  } catch {
    return 'download'
  }
}

/** A tab of a chat's headless browser: a page target and its DevTools session. */
export class HeadlessPage extends EventEmitter implements BrowserPage {
  readonly driver: PageDriver
  dialog?: PageDialog
  url = ''
  readonly scale = 1
  viewport?: PageViewport
  /** Settles once the tab has its page and session; the page loads its first URL after. */
  readonly ready: Promise<void>
  private sessionId?: string
  targetId?: string
  private mainFrame?: string
  private current = ''
  private pageTitle = ''
  private loadingNow = false
  private crashed = false
  private closed = false
  /** The driver's listener, while it is attached (see devtools). */
  private driverEvents?: { onEvent: Listener; onLost: () => void }
  /** Sessions of out-of-process iframes the driver attached to, which report here. */
  private readonly childSessions = new Set<string>()
  private readonly waiters = new Set<Listener>()
  private firstLoad?: Promise<void>

  constructor(
    readonly id: string,
    private readonly chromium: Chromium,
    /** A page the browser opened itself (window.open), or a new one to create. */
    opened: string | undefined,
    /** The page it opens first, for a new tab. */
    private readonly startUrl: string,
    private readonly onNavigated: () => void
  ) {
    super()
    const devtools: DevTools = {
      attach: (onEvent, onLost) => {
        this.driverEvents = { onEvent, onLost }
      },
      detach: () => {
        this.driverEvents = undefined
      },
      send: (method, params, sessionId) => this.send(method, params, sessionId)
    }
    const driverPage: DriverPage = {
      devtools,
      url: () => this.current,
      committed: async () => {
        await this.ready
      },
      userAgent: () => chromium.userAgent,
      // Every headless page draws and gets real input.
      onScreen: () => true,
      capture: async () => {
        const { data } = await this.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png'
        })
        return Buffer.from(data, 'base64')
      },
      draw: async () => undefined
    }
    // The page answers its dialogs itself (see onEvent), so the driver's word of them is not needed.
    this.driver = new PageDriver(driverPage, () => undefined)
    this.ready = this.connect(opened)
  }

  private async connect(opened: string | undefined): Promise<void> {
    const targetId =
      opened ??
      (
        await this.chromium.send<{ targetId: string }>('Target.createTarget', {
          url: 'about:blank'
        })
      ).targetId
    this.targetId = targetId
    const { sessionId } = await this.chromium.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true
    })
    this.sessionId = sessionId
    this.chromium.listen(sessionId, (method, params, from) => this.onEvent(method, params, from))
    await this.send('Page.enable')
    // Pages that are not focused get no focus events, and the clipboard refuses them.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string; url: string } } }>(
      'Page.getFrameTree'
    )
    this.mainFrame = frameTree.frame.id
    this.current = frameTree.frame.url
    // A tab the browser opened has its page coming; a new one loads its own.
    this.firstLoad =
      opened || !this.startUrl
        ? Promise.resolve()
        : this.navigate(this.startUrl).catch(() => undefined)
  }

  /** Send to the page's session, or to one of its iframes'. */
  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The tab is closed.'))
    const session = sessionId ?? this.sessionId
    if (!session) return this.ready.then(() => this.send<T>(method, params, sessionId))
    return this.chromium.send<T>(method, params, session)
  }

  private onEvent(method: string, params: Params, from?: string): void {
    const own = from === this.sessionId
    if (own && method === 'Target.attachedToTarget') {
      // An iframe the driver follows: its events come with its own session.
      const child = params.sessionId as string
      this.childSessions.add(child)
      this.chromium.listen(child, (m, p, s) => this.onEvent(m, p, s))
    } else if (
      method === 'Target.detachedFromTarget' &&
      this.childSessions.delete(params.sessionId as string)
    ) {
      this.chromium.unlisten(params.sessionId as string)
    }
    if (own) this.onPageEvent(method, params)
    this.driverEvents?.onEvent(method, params, own ? undefined : from)
    for (const waiter of this.waiters) waiter(method, params)
  }

  private onPageEvent(method: string, params: Params): void {
    const frameId = (params.frame as { id?: string } | undefined)?.id ?? params.frameId
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as {
        id: string
        parentId?: string
        url: string
        urlFragment?: string
      }
      if (frame.parentId) return
      this.mainFrame = frame.id
      this.current = frame.url + (frame.urlFragment ?? '')
      this.url = this.current
      this.onNavigated()
    } else if (method === 'Page.navigatedWithinDocument' && frameId === this.mainFrame) {
      this.current = params.url as string
      this.url = this.current
      this.onNavigated()
    } else if (method === 'Page.frameStartedLoading' && frameId === this.mainFrame) {
      this.loadingNow = true
    } else if (method === 'Page.frameStoppedLoading' && frameId === this.mainFrame) {
      this.loadingNow = false
    } else if (method === 'Page.javascriptDialogOpening') {
      this.onDialog(params as { type: string; message: string; url: string })
    } else if (method === 'Page.javascriptDialogClosed') {
      this.dialog = undefined
    } else if (method === 'Inspector.targetCrashed') {
      this.crashed = true
      this.driverEvents?.onLost()
      this.dialog = undefined
    }
  }

  /**
   * alert() and confirm() wait for the agent's answer (handle_dialog). As in
   * the app, prompt() is dismissed at once, and a page asking before it is
   * left lets the agent leave.
   */
  private onDialog({ type, message, url }: { type: string; message: string; url: string }): void {
    if (type !== 'alert' && type !== 'confirm') {
      void this.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }).catch(
        () => undefined
      )
      return
    }
    const open: PageDialog = {
      type,
      message,
      site: siteOf(url),
      answer: (accept) => {
        if (this.dialog !== open) return
        this.dialog = undefined
        void this.send('Page.handleJavaScriptDialog', { accept }).catch(() => undefined)
      }
    }
    this.dialog = open
    this.emit('dialog')
  }

  /** The next page event `match` accepts, or undefined after `timeout`. */
  private until(
    match: (method: string, params: Params) => boolean,
    timeout: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const listener: Listener = (method, params) => {
        if (match(method, params)) finish(true)
      }
      const finish = (seen: boolean): void => {
        clearTimeout(timer)
        this.waiters.delete(listener)
        resolve(seen)
      }
      const timer = setTimeout(() => finish(false), timeout)
      this.waiters.add(listener)
    })
  }

  /** Whether the page crashed and is loaded again, once it is ready for an agent. */
  async prepare(): Promise<void> {
    await this.ready
    await Promise.race([
      this.firstLoad,
      new Promise((resolve) => setTimeout(resolve, LOAD_WAIT_MS))
    ])
    if (!this.crashed) return
    this.crashed = false
    const loaded = this.until((method) => method === 'Page.loadEventFired', LOAD_WAIT_MS)
    await this.send('Page.reload')
    await loaded
  }

  address(): string {
    return this.current
  }

  title(): string {
    return this.pageTitle
  }

  /** Kept by the browser from the target's info. */
  setTitle(title: string): void {
    this.pageTitle = title
  }

  loading(): boolean {
    return this.loadingNow
  }

  async navigate(url: string): Promise<void> {
    await this.ready
    const loaded = this.until(
      (method, params) =>
        method === 'Page.loadEventFired' ||
        (method === 'Page.frameStoppedLoading' && params.frameId === this.mainFrame),
      5 * 60_000
    )
    const result = await this.send<{ loaderId?: string; errorText?: string }>('Page.navigate', {
      url
    })
    if (result.errorText) {
      const code = result.errorText.replace(/^net::/, '')
      throw Object.assign(new Error(`${result.errorText} loading ${url}`), { code })
    }
    // Within the document (a #fragment): there is nothing to load.
    if (result.loaderId) await loaded
  }

  async back(): Promise<void> {
    const { currentIndex, entries } = await this.send<{
      currentIndex: number
      entries: { id: number }[]
    }>('Page.getNavigationHistory')
    if (currentIndex > 0) {
      await this.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id })
    }
  }

  async pdf(pageSize: PaperSize, landscape: boolean): Promise<Buffer> {
    const { width, height } = PAPER[pageSize]
    const { data } = await this.send<{ data: string }>('Page.printToPDF', {
      landscape,
      printBackground: true,
      paperWidth: width,
      paperHeight: height
    })
    return Buffer.from(data, 'base64')
  }

  /** The editing shortcuts are Ctrl and a letter on Linux, which Chromium runs from key presses. */
  edit(command: EditCommand): Promise<void> {
    return this.driver.press(EDIT_KEYS[command], ['ctrl'])
  }

  /** Paste an image as Ctrl+V would: put it on the browser's own clipboard, then paste. */
  async pasteImage(path: string): Promise<void> {
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[
      extname(path).toLowerCase()
    ]
    if (!type || !existsSync(path)) throw new Error(`Not an image file, or not found: ${path}`)
    const data = (await readFile(path)).toString('base64')
    await this.chromium.send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      origin: new URL(this.current).origin
    })
    // The clipboard takes PNG images; a JPEG is drawn into one first.
    const response = await this.send<{
      exceptionDetails?: { exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression: `(async () => {
          const blob = await (await fetch('data:${type};base64,${data}')).blob();
          const bitmap = await createImageBitmap(blob);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          const png = await canvas.convertToBlob({ type: 'image/png' });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        })()`,
      awaitPromise: true,
      userGesture: true
    })
    if (response.exceptionDetails) {
      throw new Error(
        `Could not put the image on the clipboard: ${response.exceptionDetails.exception?.description ?? 'the page refused it'}`
      )
    }
    await this.edit('paste')
  }

  private automating = 0

  async automate<T>(work: () => Promise<T>): Promise<T> {
    this.automating++
    try {
      return await work()
    } finally {
      this.automating--
    }
  }

  /** No one clicks in a headless page; wait_for_click is not offered (browser-mcp.ts). */
  awaitUser<T>(work: () => Promise<T>): Promise<T> {
    return work()
  }

  /** Lay the page out at a size, or the window's again: the window takes that size too, for screenshots. */
  async setViewport(viewport: PageViewport | undefined): Promise<void> {
    this.viewport = viewport
    await this.ready
    const { windowId } = await this.chromium.send<{ windowId: number }>(
      'Browser.getWindowForTarget',
      {
        targetId: this.targetId
      }
    )
    await this.chromium.send('Browser.setWindowBounds', {
      windowId,
      bounds: viewport ? { width: viewport.width, height: viewport.height } : WINDOW
    })
    this.driver.emulate(viewport)
    await this.driver.emulating
  }

  /** The page is gone: closed, or with the browser. */
  gone(): void {
    if (this.closed) return
    this.closed = true
    this.dialog = undefined
    this.driverEvents?.onLost()
    if (this.sessionId) this.chromium.unlisten(this.sessionId)
    for (const child of this.childSessions) this.chromium.unlisten(child)
  }

  close(): void {
    const targetId = this.targetId
    this.gone()
    if (targetId) void this.chromium.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }
}

interface ChatTabs {
  tabs: HeadlessPage[]
  active: HeadlessPage
  next: number
}

export class HeadlessBrowser implements ChatBrowsers<HeadlessPage> {
  readonly downloads: Download[] = []
  /** Pages are seen only in screenshots. */
  readonly watched = false
  private chromium?: Promise<Chromium>
  /** The browser once it has started, until it exits. */
  private running?: Chromium
  private readonly chats = new Map<string, ChatTabs>()
  /** Downloads in progress, by the browser's id for them. */
  private readonly downloading = new Map<string, { download: Download; name: string }>()
  private readonly downloadDir = join(homedir(), 'Downloads')

  constructor(
    private readonly isRunning: (chatId: string) => boolean,
    /** Where each chat's tabs are kept, so they survive restarts. */
    private readonly savedTabs: {
      get(chatId: string): SavedTabs | undefined
      set(chatId: string, tabs: SavedTabs): void
    }
  ) {}

  /** The browser, started on first use, and again after it exits. */
  private start(): Promise<Chromium> {
    this.chromium ??= (async () => {
      const chromium = await Chromium.launch(
        (method, params) => this.onBrowserEvent(method, params),
        () => {
          this.chromium = undefined
          this.running = undefined
          for (const browser of this.chats.values()) for (const tab of browser.tabs) tab.gone()
          this.chats.clear()
        }
      )
      await chromium.send('Target.setDiscoverTargets', { discover: true })
      // Files a page downloads go to ~/Downloads, under their own names once done.
      await mkdir(this.downloadDir, { recursive: true })
      await chromium.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: join(userDataPath(), 'downloading'),
        eventsEnabled: true
      })
      this.running = chromium
      return chromium
    })().catch((error) => {
      this.chromium = undefined
      throw error
    })
    return this.chromium
  }

  private onBrowserEvent(method: string, params: Params): void {
    if (method === 'Target.targetInfoChanged') {
      const info = params.targetInfo as { targetId: string; title: string }
      this.pageOf(info.targetId)?.[1].setTitle(info.title)
    } else if (method === 'Target.targetCreated') {
      // A page a tab opened (window.open, a link to a new tab) becomes a tab of its chat.
      const info = params.targetInfo as { targetId: string; type: string; openerId?: string }
      const opener = info.type === 'page' && info.openerId ? this.pageOf(info.openerId) : undefined
      if (!opener) return
      const [chatId] = opener
      const browser = this.chats.get(chatId)
      if (!browser || browser.tabs.length >= MAX_TABS) return
      void this.start().then((chromium) => {
        const tab = this.addTab(chatId, browser, chromium, info.targetId, '')
        browser.active = tab
      })
    } else if (method === 'Target.targetDestroyed') {
      const found = this.pageOf(params.targetId as string)
      if (found) this.removeTab(found[0], found[1])
    } else if (method === 'Browser.downloadWillBegin') {
      const { guid, url, suggestedFilename } = params as {
        guid: string
        url: string
        suggestedFilename: string
      }
      const download: Download = { url, path: '', state: 'progressing' }
      this.downloads.unshift(download)
      this.downloads.splice(50)
      this.downloading.set(guid, { download, name: suggestedFilename })
    } else if (method === 'Browser.downloadProgress') {
      const { guid, state } = params as { guid: string; state: string }
      const entry = this.downloading.get(guid)
      if (!entry || state === 'inProgress') return
      this.downloading.delete(guid)
      if (state !== 'completed') {
        entry.download.state = 'cancelled'
        return
      }
      const path = uniquePath(this.downloadDir, entry.name)
      rename(join(userDataPath(), 'downloading', guid), path).then(
        () => {
          entry.download.path = path
          entry.download.state = 'completed'
        },
        () => (entry.download.state = 'interrupted')
      )
    }
  }

  private pageOf(targetId: string): [string, HeadlessPage] | undefined {
    for (const [chatId, browser] of this.chats) {
      const tab = browser.tabs.find((t) => t.targetId === targetId)
      if (tab) return [chatId, tab]
    }
    return undefined
  }

  private addTab(
    chatId: string,
    browser: ChatTabs | undefined,
    chromium: Chromium,
    opened: string | undefined,
    url: string
  ): HeadlessPage {
    const id = `t${browser?.next ?? 1}`
    if (browser) browser.next++
    const tab = new HeadlessPage(id, chromium, opened, url, () => this.saveTabs(chatId))
    tab.url = url
    tab.ready.catch((error) => console.error(`Could not open tab ${id}:`, error.message))
    browser?.tabs.push(tab)
    return tab
  }

  private removeTab(chatId: string, tab: HeadlessPage): void {
    tab.gone()
    const browser = this.chats.get(chatId)
    const index = browser?.tabs.indexOf(tab) ?? -1
    if (!browser || index === -1) return
    browser.tabs.splice(index, 1)
    if (browser.active === tab)
      browser.active = browser.tabs[Math.min(index, browser.tabs.length - 1)]
    // A browser always has a tab.
    if (!browser.tabs.length) this.chats.delete(chatId)
    else this.saveTabs(chatId)
  }

  private saveTabs(chatId: string): void {
    const browser = this.chats.get(chatId)
    if (!browser) return
    this.savedTabs.set(chatId, {
      urls: browser.tabs.map((tab) => (tab.url === 'about:blank' ? '' : tab.url)),
      active: browser.tabs.indexOf(browser.active)
    })
  }

  /**
   * A chat's browser, opened at its saved active tab if it is not open. Only
   * that tab comes back: every tab is a renderer process on a small server.
   */
  private async browserFor(chatId: string): Promise<ChatTabs> {
    const chromium = await this.start()
    const existing = this.chats.get(chatId)
    if (existing) return existing
    const saved = this.savedTabs.get(chatId)
    const urls = saved?.urls.length ? saved.urls : ['']
    const active = Math.min(saved?.active ?? 0, urls.length - 1)
    const first = this.addTab(chatId, undefined, chromium, undefined, urls[active])
    const browser: ChatTabs = { tabs: [first], active: first, next: 2 }
    this.chats.set(chatId, browser)
    return browser
  }

  private opened(chatId: string): ChatTabs {
    const browser = this.chats.get(chatId)
    if (!browser) throw new Error('This chat has no browser open yet. Use navigate first.')
    return browser
  }

  async ensureReady(chatId: string, tabId?: string): Promise<HeadlessPage> {
    const browser = await this.browserFor(chatId)
    const tab = tabId ? this.findTab(browser, tabId) : browser.active
    await tab.prepare()
    return tab
  }

  tabs(chatId: string): { tabs: HeadlessPage[]; active: HeadlessPage } {
    const browser = this.opened(chatId)
    return { tabs: browser.tabs, active: browser.active }
  }

  newTab(chatId: string): HeadlessPage {
    const browser = this.opened(chatId)
    if (browser.tabs.length >= MAX_TABS) {
      throw new Error(
        `This browser has ${MAX_TABS} tabs open, the most it can have. Close some first.`
      )
    }
    const tab = this.addTab(chatId, browser, this.runningChromium(), undefined, '')
    browser.active = tab
    this.saveTabs(chatId)
    return tab
  }

  /** The browser, which runs once a chat's browser is open (opened). */
  private runningChromium(): Chromium {
    if (!this.running) throw new Error('The browser is not running.')
    return this.running
  }

  selectTab(chatId: string, tabId: string): HeadlessPage {
    const browser = this.opened(chatId)
    browser.active = this.findTab(browser, tabId)
    this.saveTabs(chatId)
    return browser.active
  }

  closeTab(chatId: string, tabId: string): void {
    const browser = this.opened(chatId)
    const tab = this.findTab(browser, tabId)
    tab.dialog?.answer?.(false)
    if (browser.tabs.length === 1) {
      // A browser always keeps one tab: the last one goes blank instead.
      void tab.navigate('about:blank').catch(() => undefined)
      return
    }
    this.removeTab(chatId, tab)
    tab.close()
  }

  private findTab(browser: ChatTabs, tabId: string): HeadlessPage {
    const tab = browser.tabs.find((t) => t.id === tabId)
    if (!tab) {
      throw new Error(
        `There is no tab ${tabId}. Open tabs: ${browser.tabs.map((t) => t.id).join(', ')}.`
      )
    }
    return tab
  }

  /**
   * Download a URL with the browser's logins, into ~/Downloads. The browser
   * fetches it for the active tab's page, with that page's cookies.
   */
  async download(chatId: string, url: string): Promise<Download> {
    const page = (await this.ensureReady(chatId)) as HeadlessPage
    const { frameTree } = await page.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree'
    )
    const download: Download = { url, path: '', state: 'progressing' }
    this.downloads.unshift(download)
    this.downloads.splice(50)
    const { resource } = await page.send<{
      resource: {
        success: boolean
        netErrorName?: string
        httpStatusCode?: number
        stream?: string
        headers?: Record<string, string>
      }
    }>('Network.loadNetworkResource', {
      frameId: frameTree.frame.id,
      url: new URL(url).href,
      options: { disableCache: false, includeCredentials: true }
    })
    if (!resource.success || !resource.stream) {
      download.state = 'interrupted'
      throw new Error(
        `Could not download ${url}: ${resource.netErrorName ?? `HTTP ${resource.httpStatusCode}`}`
      )
    }
    const chunks: Buffer[] = []
    for (;;) {
      const read = await page.send<{ data: string; base64Encoded?: boolean; eof: boolean }>(
        'IO.read',
        { handle: resource.stream }
      )
      chunks.push(Buffer.from(read.data, read.base64Encoded ? 'base64' : 'utf8'))
      if (read.eof) break
    }
    await page.send('IO.close', { handle: resource.stream }).catch(() => undefined)
    download.path = uniquePath(this.downloadDir, fileNameOf(url, resource.headers))
    await mkdir(this.downloadDir, { recursive: true })
    await writeFile(download.path, Buffer.concat(chunks))
    download.state = 'completed'
    return download
  }

  async setViewport(
    _chatId: string,
    tab: HeadlessPage,
    viewport: PageViewport | undefined
  ): Promise<void> {
    const reload = (tab.viewport?.mobile ?? false) !== (viewport?.mobile ?? false)
    await tab.setViewport(viewport)
    // Pages read the touch screen and user agent as they load.
    if (reload && tab.address()) await tab.send('Page.reload')
  }

  /** Close the browsers of chats that are not running; their tabs are kept to reopen. */
  prune(): void {
    for (const [chatId, browser] of [...this.chats]) {
      if (this.isRunning(chatId)) continue
      this.chats.delete(chatId)
      for (const tab of browser.tabs) tab.close()
    }
  }

  closeChat(chatId: string): void {
    const browser = this.chats.get(chatId)
    this.chats.delete(chatId)
    for (const tab of browser?.tabs ?? []) tab.close()
  }

  async close(): Promise<void> {
    const chromium = this.chromium
    this.chromium = undefined
    this.running = undefined
    this.chats.clear()
    await (await chromium?.catch(() => undefined))?.close()
  }
}
