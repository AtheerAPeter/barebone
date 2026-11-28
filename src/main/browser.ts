import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  WebContentsView,
  session,
  type IpcMainEvent,
  type Session,
  type WebContents
} from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import {
  BROWSER_SIZES,
  DEFAULT_PROFILE,
  OWN_BROWSER,
  type BrowserSize,
  type BrowserState,
  type PageViewport,
  type Rect,
  type SavedTabs
} from '../shared/types'
import { PageDriver } from './page-driver'

/**
 * `persist:` partitions are stored on disk, so cookies, localStorage and
 * IndexedDB (logins) survive restarts. Each profile has its own partition:
 * the pages of its chats, and of the user's own browser while it is the
 * active profile, share its logins, and no other profile's.
 *
 * Each chat has its own browser with tabs, so several chats can automate the
 * browser at once. The panel shows the selected chat's active tab; every other
 * tab, and the tabs of other chats that are running, stay alive, parked out of
 * sight. A chat's browser is closed when the chat is neither selected nor
 * running, and its tabs are reopened next time.
 */

/** A profile's partition. The default profile's is the one from before profiles, with the logins from then. */
export function partitionFor(profileId: string): string {
  return profileId === DEFAULT_PROFILE ? 'persist:browser' : `persist:browser-${profileId}`
}

/** Sign a removed profile's browser out of everything, so nothing of it is left behind. */
export async function clearProfileData(profileId: string): Promise<void> {
  const profileSession = session.fromPartition(partitionFor(profileId))
  await profileSession.clearStorageData()
  await profileSession.clearCache()
}
const EMPTY_STATE: BrowserState = {
  tabs: [],
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false
}
/** Page size for chats working in the background before the panel was ever shown. */
const DEFAULT_BOUNDS = { x: 0, y: 0, width: 1024, height: 768 }
/** Tabs one chat's browser may have open. */
const MAX_TABS = 20
/** Corner radius of the page, matching .browser-viewport in styles.css. */
const PAGE_RADIUS = 12
/**
 * For tabs and the windows pages open as tabs, with their profile's partition.
 * With the sandbox on, iframes get no Node.js either way; they run the page
 * preload (see onPageDialog).
 */
const TAB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegrationInSubFrames: true,
  // A page that navigates would otherwise take the window's keyboard focus,
  // including from the composer mid-typing when the agent opens a page
  // (electron/electron#42578). Pages get focus from the user's own click, and
  // from an address the user enters (see navigate).
  focusOnNavigation: false
}

export interface Download {
  url: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
}

/** An alert() or confirm() a page is waiting on. */
export interface PageDialog {
  type: 'alert' | 'confirm'
  message: string
  /** The site asking, as shown to the user. */
  site: string
  /**
   * Answer it: OK, or Cancel. Missing for a dialog Electron shows itself (from
   * a frame the page preload does not run in), which only the user can answer.
   */
  answer?: (accept: boolean) => void
}

/** A free file name in the folder: "name.ext", then "name (1).ext", ... */
function uniquePath(folder: string, fileName: string): string {
  const ext = extname(fileName)
  const stem = basename(fileName, ext) || 'download'
  let path = join(folder, `${stem}${ext}`)
  for (let n = 1; existsSync(path); n++) path = join(folder, `${stem} (${n})${ext}`)
  return path
}

/**
 * Where a page waits out of sight: left of the window, at its size. Pages are
 * parked rather than hidden because Chromium sends no mouse input to a page
 * that was never shown, and pages of background chats must stay clickable.
 */
function parked(bounds: Electron.Rectangle): Electron.Rectangle {
  return { ...bounds, x: -bounds.width - 100 }
}

/**
 * Where a page goes in the panel's area: all of it, or the size it is laid out
 * at in the middle, scaled down to fit when it is bigger. The
 * scale is the share of the page's CSS pixels the view shows it at.
 */
function placed(
  viewport: PageViewport | undefined,
  area: Electron.Rectangle
): { bounds: Electron.Rectangle; scale: number } {
  if (!viewport) return { bounds: area, scale: 1 }
  const scale = Math.min(1, area.width / viewport.width, area.height / viewport.height)
  const width = Math.round(viewport.width * scale)
  const height = Math.round(viewport.height * scale)
  return {
    bounds: {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height
    },
    scale
  }
}

function siteOf(url: string): string {
  try {
    return new URL(url).host || 'This page'
  } catch {
    return 'This page'
  }
}

/** Whether two addresses have the same scheme and host; every file: address is one origin. */
function sameOrigin(a: string | undefined, b: string): boolean {
  try {
    const [x, y] = [new URL(a ?? ''), new URL(b)]
    return x.protocol === y.protocol && x.host === y.host
  } catch {
    return false
  }
}

/**
 * A tab of a chat's browser: its view, the driver agents use, and the dialog it
 * waits on. Emits 'dialog' when a dialog opens, and 'automate' when an agent
 * tool call starts on it.
 */
export class ChatPage extends EventEmitter {
  readonly driver: PageDriver
  dialog?: PageDialog
  /** The message box showing the dialog to the user, while it is on screen. */
  box?: AbortController
  /** In the panel, as opposed to parked out of sight. */
  shown = false
  /** The window is starting to capture it, to record it as a video (recording.ts). */
  capturing = false
  /** The page it shows, kept for reopening the tab after the browser closes. */
  url = ''
  /** The page's icon, once the page has declared one. */
  favicon?: string
  /** The size an agent set the page to (set_viewport); it has the user's size while there is none. */
  viewport?: PageViewport
  /** The device of the remote link that set that size to its own, if one did (remote/browser.ts). */
  viewportBy?: string
  /** The share of the page's size the panel shows it at, while it has one. */
  scale = 1
  /**
   * A device of the remote link shows the page (remote/browser.ts). What it does
   * there is done far from the Mac, where no one may be to answer a dialog.
   */
  viewedRemotely = false
  /**
   * A reopened tab that has not loaded its page yet. Every page is a renderer
   * process, so saved tabs load when they are first used, not all at once.
   */
  unloaded = false
  /** The tab's first load, once started; an agent's navigation must not race it. */
  private firstLoad?: Promise<void>
  /** Agent tool calls in progress on this page. */
  private automating = 0
  /** The ones among them that wait for the user to act (see awaitUser). */
  private awaitingUser = 0

  constructor(
    /** Short id agents use: t1, t2, ... */
    readonly id: string,
    readonly view: WebContentsView,
    /** The tab whose page opened this one (window.open, a link to a new tab). */
    readonly openedBy?: ChatPage
  ) {
    super()
    this.contents = view.webContents
    this.driver = new PageDriver(
      this.contents,
      (native) => {
        if (native) this.openDialog({ ...native, site: siteOf(this.contents.getURL()) })
        else if (this.dialog && !this.dialog.answer) this.closeDialog()
      },
      () => this.shown
    )
  }

  /**
   * The page's contents. Kept from the start: once they are destroyed, the
   * view's webContents is undefined, and code still holding the tab (the remote
   * link's view of it) must be able to ask whether they are.
   */
  readonly contents: WebContents

  /**
   * Load the page of a reopened tab, if it has not been loaded yet. Settles
   * when its first load has loaded or failed, also when that load had started
   * already. Emits 'load' as that first load starts.
   */
  load(): Promise<void> {
    if (this.unloaded) {
      this.unloaded = false
      this.firstLoad = this.contents.loadURL(this.url || 'about:blank').catch(() => undefined)
      this.emit('load')
    }
    return this.firstLoad ?? Promise.resolve()
  }

  /**
   * Whether an agent tool call is acting on the page. One that waits for the
   * user does not count: what happens then is the user's doing.
   */
  get automated(): boolean {
    return this.automating > this.awaitingUser
  }

  /** Run an agent tool call on the page. */
  async automate<T>(work: () => Promise<T>): Promise<T> {
    this.automating++
    this.emit('automate')
    try {
      return await work()
    } finally {
      this.automating--
    }
  }

  /**
   * Inside an agent tool call, wait for the user to act on the page (see
   * wait_for_click). Meanwhile the page is not automated, so leaving a page
   * with unsaved changes asks the user as usual.
   */
  async awaitUser<T>(work: () => Promise<T>): Promise<T> {
    this.awaitingUser++
    try {
      return await work()
    } finally {
      this.awaitingUser--
    }
  }

  openDialog(dialog: PageDialog): void {
    this.dialog = dialog
    this.emit('dialog')
  }

  /** Forget the dialog and take its message box off the screen. Emits 'dialogClosed'. */
  closeDialog(): void {
    this.box?.abort()
    this.box = undefined
    const had = this.dialog
    this.dialog = undefined
    if (had) this.emit('dialogClosed')
  }

  /** Cancel the dialog if there is one, so the page can go on (or go away). */
  dismissDialog(): void {
    this.dialog?.answer?.(false)
  }
}

/** The tabs of one chat's browser. */
interface ChatTabs {
  /** Its profile's partition, which its tabs and the windows they open use. */
  partition: string
  tabs: ChatPage[]
  active?: ChatPage
  /** The tab the agent acted on last, while its turn runs; shown highlighted. */
  controlled?: ChatPage
  /** For the next tab's id. */
  next: number
  /** While its saved tabs are being reopened, which must not overwrite what was saved. */
  restoring: boolean
}

export class BuiltinBrowser {
  /** Most recent first; agents read paths from here to use downloaded files. */
  readonly downloads: Download[] = []
  /** download() calls waiting for their file, matched by page and URL. */
  private downloadWaiters: {
    contents: WebContents
    url: string
    done: (download: Download) => void
  }[] = []

  private chats = new Map<string, ChatTabs>()
  /** The profiles' sessions in use, by partition, each set up once (see sessionFor). */
  private sessions = new Map<string, Session>()
  private activeChat?: string
  /** Where the panel is, in window points; undefined while the panel is closed. */
  private panelBounds?: Electron.Rectangle
  /** Where pages are laid out: the panel, or where it was last while it is closed. */
  private pageArea: Electron.Rectangle = DEFAULT_BOUNDS
  /** The panel is open but its page is out of sight for a moment, while the user resizes it. */
  private panelHidden = false
  private waitingForPanel: (() => void)[] = []
  /** Chats whose browser stays open whatever the panel shows, and how many keep each open. */
  private kept = new Map<string, number>()
  /** The size the user picked for chats' pages (see setSize). */
  private size: BrowserSize = 'panel'
  /** Told when the user picks a size in the panel's menu, to keep it. */
  onSizePicked?: (size: BrowserSize) => void
  /** Told where the panel's page is after every layout; undefined while none shows. */
  onPageArea?: (area: Electron.Rectangle | undefined) => void
  /** Told when a chat's browser changed: its tabs, their pages, their sizes. */
  onChatChanged?: (chatId: string) => void

  constructor(
    private readonly window: BrowserWindow,
    private readonly onState: (state: BrowserState) => void,
    /** Open the panel in this chat: now if it is the selected chat, else when it is selected. */
    private readonly requestShow: (chatId: string) => void,
    private readonly isRunning: (chatId: string) => boolean,
    /** Where each chat's tabs are kept, so they survive restarts. */
    private readonly savedTabs: {
      get(chatId: string): SavedTabs | undefined
      set(chatId: string, tabs: SavedTabs): void
    },
    /** The partition of a chat's profile (see partitionFor); for OWN_BROWSER, the active profile's. */
    private readonly partitionOf: (chatId: string) => string
  ) {
    ipcMain.on('page:dialog', (event, type, message) => this.onPageDialog(event, type, message))
    // A minimized window draws nothing, its pages included: whoever shows them is told.
    for (const event of ['minimize', 'restore'] as const) {
      window.on(event as 'minimize', () => {
        for (const chatId of this.chats.keys()) this.onChatChanged?.(chatId)
      })
    }
  }

  /** A profile's session, set up for pages the first time it is used. */
  private sessionFor(partition: string): Session {
    const existing = this.sessions.get(partition)
    if (existing) return existing
    const browserSession = session.fromPartition(partition)
    this.sessions.set(partition, browserSession)
    // Pages get no microphone or camera. Electron grants every permission a
    // page asks for unless told otherwise, and the app may use the microphone
    // (for voice input), so any page an agent opens could listen without asking.
    // The window capturing a tab to record it (recording.ts) is asked here too,
    // as that tab: with no device, from the window's own origin (a page asking
    // itself has the page's), while the recording starts. It is let through.
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission !== 'media') return callback(true)
      if (!('mediaTypes' in details)) return callback(false)
      const noDevice = !details.mediaTypes?.length
      const fromWindow = sameOrigin(details.securityOrigin, this.window.webContents.getURL())
      callback(noDevice && fromWindow && this.pageOf(contents)?.[1].capturing === true)
    })
    // Routes alert() and confirm() to the app (see onPageDialog). Registered on
    // the session, so it also runs in windows that pages open as tabs.
    browserSession.registerPreloadScript({
      type: 'frame',
      id: 'barebone-page',
      filePath: join(import.meta.dirname, '../preload/page.cjs')
    })
    // Save straight to ~/Downloads instead of showing a Save dialog, which an
    // agent cannot answer, and record where each file went.
    browserSession.on('will-download', (_event, item, contents) => {
      // A new Linux account (a server's container) may have no Downloads folder yet.
      const folder = app.getPath('downloads')
      mkdirSync(folder, { recursive: true })
      const download: Download = {
        url: item.getURL(),
        path: uniquePath(folder, item.getFilename()),
        state: 'progressing'
      }
      item.setSavePath(download.path)
      this.downloads.unshift(download)
      this.downloads.splice(50)
      // The download() call that asked for this file, if any (the first URL is
      // the one requested, before redirects).
      const requested = item.getURLChain()[0]
      const waiter = this.downloadWaiters.find(
        (w) => w.contents === contents && w.url === requested
      )
      if (waiter) this.downloadWaiters.splice(this.downloadWaiters.indexOf(waiter), 1)
      item.once('done', (_e, state) => {
        download.state = state
        waiter?.done(download)
      })
    })
    // Some sign-in pages (Google in particular) reject user agents that mention Electron.
    // Electron also adds the app's name without spaces and its version, as Barebone/1.0.64.
    browserSession.setUserAgent(
      browserSession
        .getUserAgent()
        .replace(/\sElectron\/\S+/, '')
        .replace(` ${app.getName().replace(/\s/g, '')}/${app.getVersion()}`, '')
    )
    return browserSession
  }

  /** A chat's browser, opened with its saved tabs if it is not open. */
  private browserFor(chatId: string): ChatTabs {
    const existing = this.chats.get(chatId)
    if (existing) return existing
    const partition = this.partitionOf(chatId)
    this.sessionFor(partition)
    const browser: ChatTabs = { partition, tabs: [], next: 1, restoring: true }
    this.chats.set(chatId, browser)
    const saved = this.savedTabs.get(chatId)
    for (const url of saved?.urls.length ? saved.urls : ['']) this.addTab(chatId, browser, { url })
    browser.active = browser.tabs[Math.min(saved?.active ?? 0, browser.tabs.length - 1)]
    void browser.active.load()
    browser.restoring = false
    this.layout()
    return browser
  }

  /**
   * Open a tab in a chat's browser: a new page, or a window one of its pages
   * opened (window.open, a link to a new tab), which keeps its tie to the
   * page that opened it, so sign-in popups can report back.
   */
  private addTab(
    chatId: string,
    browser: ChatTabs,
    options: {
      url?: string
      /** What Electron passes to createWindow for a window a page opened. */
      opened?: Electron.BrowserWindowConstructorOptions
      openedBy?: ChatPage
      activate?: boolean
    }
  ): ChatPage {
    const webPreferences = { ...TAB_PREFERENCES, partition: browser.partition }
    const view = new WebContentsView(options.opened ?? { webPreferences })
    view.setBorderRadius(PAGE_RADIUS)
    const tab = new ChatPage(`t${browser.next++}`, view, options.openedBy)
    const contents = tab.contents
    // Tabs out of sight and tabs of background chats keep running their automation.
    contents.setBackgroundThrottling(false)
    contents.setWindowOpenHandler((details) => {
      if (browser.tabs.length >= MAX_TABS) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences },
        createWindow: (opened) =>
          this.addTab(chatId, browser, {
            opened,
            openedBy: tab,
            // ⌘-click opens a link in the background, as in Chrome.
            activate: details.disposition !== 'background-tab'
          }).contents
      }
    })
    for (const event of [
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated',
      'did-start-loading',
      'did-stop-loading'
    ] as const) {
      contents.on(event as 'did-stop-loading', () => {
        this.changed(chatId)
      })
    }
    // Remember every page as it is reached, so the tab (and its agent) can pick
    // up there after the browser is closed or the app restarts.
    const remember = (): void => {
      tab.url = contents.getURL()
      this.saveTabs(chatId)
    }
    contents.on('did-navigate', remember)
    contents.on('did-navigate-in-page', remember)
    // A new page has its own icon, if any; until it declares one the tab shows none.
    contents.on('did-navigate', () => (tab.favicon = undefined))
    contents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0]
      this.changed(chatId)
    })
    // The agent's work moves to whichever tab it acts on.
    tab.on('automate', () => {
      if (browser.controlled === tab) return
      browser.controlled = tab
      this.changed(chatId)
    })
    // A page with unsaved changes asks before it is left. Electron would
    // silently stay; the agent was asked to leave, the user is asked. A page
    // used from the remote link leaves too, and so does one left while the
    // window is not in front, which no one at the Mac did: asking would hold
    // the whole app (the box is modal) until someone at the Mac answered.
    contents.on('will-prevent-unload', (event) => {
      if (tab.automated || tab.viewedRemotely || !this.window.isFocused()) {
        event.preventDefault()
        return
      }
      const choice = dialog.showMessageBoxSync(this.window, {
        type: 'question',
        buttons: ['Leave', 'Stay'],
        defaultId: 0,
        cancelId: 1,
        message: 'Leave this page?',
        detail: 'Changes you made may not be saved.'
      })
      if (choice === 0) event.preventDefault()
    })
    contents.on('render-process-gone', () => {
      tab.driver.detach()
      tab.closeDialog()
      this.changed(chatId)
    })
    // Closed by the page itself (window.close()) or with the rest of the browser.
    contents.once('destroyed', () => this.removeTab(chatId, tab))
    view.setBounds(parked(this.pageArea))
    this.window.contentView.addChildView(view)
    browser.tabs.push(tab)
    if (options.activate || !browser.active) browser.active = tab
    if (!options.opened) {
      tab.url = options.url ?? ''
      tab.unloaded = true
    }
    // The page gets the user's size as it loads; a tab not loaded yet has no page to lay out.
    const sized = (): void => {
      if (this.sizeOf(chatId, tab)) void this.resize(chatId, tab, undefined).catch(() => undefined)
    }
    if (tab.unloaded) tab.once('load', sized)
    else sized()
    // Reopened tabs wait until they are used; the active one is loaded by browserFor.
    if (!options.opened && !browser.restoring) void tab.load()
    if (!browser.restoring) {
      this.layout()
      this.saveTabs(chatId)
      this.changed(chatId)
    }
    return tab
  }

  /** Take a closed tab out of its browser; the tab that opened it, or a neighbour, becomes active. */
  private removeTab(chatId: string, tab: ChatPage): void {
    tab.closeDialog()
    tab.driver.detach()
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
    const browser = this.chats.get(chatId)
    const index = browser?.tabs.indexOf(tab) ?? -1
    if (!browser || index === -1) return
    browser.tabs.splice(index, 1)
    if (browser.controlled === tab) browser.controlled = undefined
    if (browser.active === tab) {
      browser.active =
        tab.openedBy && browser.tabs.includes(tab.openedBy)
          ? tab.openedBy
          : browser.tabs[Math.min(index, browser.tabs.length - 1)]
      void browser.active?.load()
    }
    // A browser always has a tab.
    if (!browser.tabs.length) this.addTab(chatId, browser, { url: '' })
    this.layout()
    this.saveTabs(chatId)
    this.changed(chatId)
  }

  private saveTabs(chatId: string): void {
    const browser = this.chats.get(chatId)
    if (!browser || browser.restoring || !browser.active) return
    this.savedTabs.set(chatId, {
      urls: browser.tabs.map((tab) => (tab.url === 'about:blank' ? '' : tab.url)),
      active: browser.tabs.indexOf(browser.active)
    })
  }

  /** A chat's tabs, its browser opened if needed. */
  tabs(chatId: string): { tabs: ChatPage[]; active: ChatPage } {
    const browser = this.browserFor(chatId)
    return { tabs: browser.tabs, active: browser.active! }
  }

  /** Open a blank tab in a chat's browser and make it the active one. */
  newTab(chatId: string): ChatPage {
    const browser = this.browserFor(chatId)
    if (browser.tabs.length >= MAX_TABS) {
      throw new Error(
        `This browser has ${MAX_TABS} tabs open, the most it can have. Close some first.`
      )
    }
    return this.addTab(chatId, browser, { url: '', activate: true })
  }

  /** Make a tab the active one, shown in the panel when its chat is selected. */
  selectTab(chatId: string, tabId: string): ChatPage {
    const browser = this.browserFor(chatId)
    const tab = this.findTab(browser, tabId)
    browser.active = tab
    void tab.load()
    this.layout()
    this.saveTabs(chatId)
    this.changed(chatId)
    return tab
  }

  /** Close a tab. A page waiting on a dialog is answered Cancel first. */
  closeTab(chatId: string, tabId: string): void {
    const tab = this.findTab(this.browserFor(chatId), tabId)
    tab.dismissDialog()
    this.removeTab(chatId, tab)
    tab.contents.close()
  }

  private findTab(browser: ChatTabs, tabId: string): ChatPage {
    const tab = browser.tabs.find((t) => t.id === tabId)
    if (!tab) {
      const open = browser.tabs.map((t) => t.id).join(', ')
      throw new Error(`There is no tab ${tabId}. Open tabs: ${open}.`)
    }
    return tab
  }

  private pageOf(contents: WebContents): [string, ChatPage] | undefined {
    for (const [chatId, browser] of this.chats) {
      const tab = browser.tabs.find((t) => t.contents === contents)
      if (tab) return [chatId, tab]
    }
    return undefined
  }

  /**
   * alert() and confirm() from a page, sent by its preload. The page waits
   * until it is answered: by the user in a message box (shown while the page
   * is in the panel), or by the agent. Replying null lets the page show
   * Electron's own dialog, which Chromium blocks for cross-origin iframes.
   */
  private onPageDialog(event: IpcMainEvent, type: unknown, message: unknown): void {
    const entry = this.pageOf(event.sender)
    const frame = event.senderFrame
    if (
      !entry ||
      !frame ||
      entry[1].dialog ||
      (type !== 'alert' && type !== 'confirm') ||
      typeof message !== 'string' ||
      frame.origin !== event.sender.mainFrame.origin
    ) {
      event.returnValue = null
      return
    }
    const [, page] = entry
    const open: PageDialog = {
      type,
      message,
      site: siteOf(frame.origin),
      answer: (accept) => {
        if (page.dialog !== open) return
        page.closeDialog()
        event.returnValue = type === 'confirm' ? accept : true
      }
    }
    page.openDialog(open)
    this.showDialog()
  }

  /** Show the dialog of the page in the panel, if it has one, in a message box. */
  private showDialog(): void {
    const page = this.activePage()
    const open = page?.dialog
    if (!page?.shown || !open?.answer || page.box) return
    const box = new AbortController()
    page.box = box
    dialog
      .showMessageBox(this.window, {
        type: open.type === 'alert' ? 'info' : 'question',
        message: `${open.site} says`,
        detail: open.message,
        buttons: open.type === 'alert' ? ['OK'] : ['OK', 'Cancel'],
        defaultId: 0,
        cancelId: open.type === 'alert' ? 0 : 1,
        noLink: true,
        signal: box.signal
      })
      .then(({ response }) => {
        // Aborted when the agent answered first or the page went away.
        if (!box.signal.aborted) open.answer?.(response === 0)
      })
  }

  /** Close a chat's browser and all its tabs. */
  private closeBrowser(chatId: string): void {
    const browser = this.chats.get(chatId)
    if (!browser) return
    this.chats.delete(chatId)
    for (const tab of browser.tabs) {
      tab.dismissDialog()
      tab.closeDialog()
      tab.driver.detach()
      // A turn ending while the app quits closes its browser after the window is gone.
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
      tab.contents.close()
    }
  }

  /** Close browsers that nothing needs: not shown in the panel, not running, not kept open. */
  prune(): void {
    for (const chatId of [...this.chats.keys()]) {
      const shown = chatId === this.activeChat && this.panelBounds
      if (!shown && !this.isRunning(chatId) && !this.kept.has(chatId)) this.closeBrowser(chatId)
    }
  }

  /**
   * Keep a chat's browser open, opening it if needed, until the returned
   * function is called: while a device of the remote link shows it.
   */
  keepOpen(chatId: string): () => void {
    this.kept.set(chatId, (this.kept.get(chatId) ?? 0) + 1)
    this.browserFor(chatId)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.kept.get(chatId) ?? 1) - 1
      if (left > 0) this.kept.set(chatId, left)
      else this.kept.delete(chatId)
      this.prune()
    }
  }

  /** A chat whose turn ended no longer controls a tab: its highlight goes. */
  endControl(): void {
    for (const [chatId, browser] of this.chats) {
      if (!browser.controlled || this.isRunning(chatId)) continue
      browser.controlled = undefined
      this.changed(chatId)
    }
  }

  /**
   * The panel's ⋮ menu, at a point in the window. A native menu: an HTML one
   * would open under the page, which is drawn above the window's content.
   */
  showMenu(x: number, y: number): void {
    // The renderer measures in CSS pixels; the menu is placed in window points (see setBounds).
    const zoom = this.window.webContents.getZoomFactor()
    Menu.buildFromTemplate([
      { label: 'New Tab', click: () => this.newActiveChatTab() },
      { label: 'Reload', click: () => this.reload() },
      { type: 'separator' },
      { label: 'Sign Out Everywhere…', click: () => void this.confirmClearData() }
    ]).popup({ window: this.window, x: Math.round(x * zoom), y: Math.round(y * zoom) })
  }

  /** The panel's size menu, at a point in the window: the sizes the user can lay pages out at. */
  showSizeMenu(x: number, y: number): void {
    const zoom = this.window.webContents.getZoomFactor()
    const item = (size: BrowserSize, label: string): Electron.MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked: this.size === size,
      click: () => {
        this.setSize(size)
        this.onSizePicked?.(size)
      }
    })
    const { desktop, phone } = BROWSER_SIZES
    Menu.buildFromTemplate([
      item('panel', 'Fit to Panel'),
      item('desktop', `Desktop  ${desktop!.width} × ${desktop!.height}`),
      item('phone', `Phone  ${phone!.width} × ${phone!.height}`)
    ]).popup({ window: this.window, x: Math.round(x * zoom), y: Math.round(y * zoom) })
  }

  /**
   * Lay chats' pages out at a size, those an agent or a device of the remote
   * link set no size of its own for. The user's own browser always fills its view.
   */
  setSize(size: BrowserSize): void {
    if (!(size in BROWSER_SIZES)) throw new Error(`There is no browser size "${size}".`)
    if (size === this.size) return
    const before = BROWSER_SIZES[this.size]
    this.size = size
    for (const [chatId, browser] of this.chats) {
      if (chatId === OWN_BROWSER) continue
      for (const tab of browser.tabs) {
        // A tab not loaded yet gets the size as it loads.
        if (tab.viewport || tab.unloaded) continue
        void this.resize(chatId, tab, before).catch(() => undefined)
      }
    }
    this.emitState()
  }

  /** The size a tab's page is laid out at: an agent's or a device's, else the user's; none fills the panel. */
  private sizeOf(chatId: string, tab: ChatPage): PageViewport | undefined {
    if (tab.viewport) return tab.viewport
    return chatId === OWN_BROWSER ? undefined : BROWSER_SIZES[this.size]
  }

  /**
   * Clear the cookies and site data of the profile of the chat the panel
   * shows, once the user confirms; it signs them out of every site there.
   */
  private async confirmClearData(): Promise<void> {
    const partition = this.activeChat && this.chats.get(this.activeChat)?.partition
    if (!partition) return
    const { response } = await dialog.showMessageBox(this.window, {
      type: 'warning',
      message: 'Sign out everywhere?',
      detail:
        "This clears all cookies and site data in this profile's built-in browser, so you're signed out of every site in it. Other profiles stay signed in.",
      buttons: ['Sign Out', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response === 0) await this.clearData(partition)
  }

  /**
   * Put the selected chat's active tab in the panel and park every other tab,
   * each page at the size it has there.
   */
  private layout(): void {
    for (const [chatId, browser] of this.chats) {
      for (const tab of browser.tabs) {
        const size = this.sizeOf(chatId, tab)
        const { bounds, scale } = placed(size, this.pageArea)
        tab.shown =
          this.panelBounds !== undefined &&
          chatId === this.activeChat &&
          tab === browser.active &&
          !this.panelHidden
        tab.view.setBounds(tab.shown ? bounds : parked(bounds))
        // A page at a set size is scaled anew as the panel changes size; one
        // not loaded yet gets its scale as it loads.
        if (size && !tab.unloaded && scale !== tab.scale) tab.driver.emulate(size, scale)
        tab.scale = scale
      }
    }
    this.showDialog()
    this.onPageArea?.(this.panelHidden ? undefined : this.panelBounds)
  }

  /**
   * Lay a tab's page out at a size (set_viewport), or at the user's again
   * (undefined). Settles once the page has it. `by` names the device of the
   * remote link that set the size, when one did.
   */
  async setViewport(
    chatId: string,
    tab: ChatPage,
    viewport: PageViewport | undefined,
    by?: string
  ): Promise<void> {
    const before = this.sizeOf(chatId, tab)
    tab.viewport = viewport
    tab.viewportBy = viewport && by
    await this.resize(chatId, tab, before)
  }

  /**
   * Lay a tab's page out at the size it has now (see sizeOf), after it had
   * `before`. Settles once the page has it; one turned into a phone's page or
   * back reloads, as pages read the touch screen and user agent as they load.
   */
  private async resize(
    chatId: string,
    tab: ChatPage,
    before: PageViewport | undefined
  ): Promise<void> {
    const size = this.sizeOf(chatId, tab)
    const reload = (before?.mobile ?? false) !== (size?.mobile ?? false)
    tab.scale = placed(size, this.pageArea).scale
    // So the page is laid out once: at its new size before its view changes
    // to show it, or at its view's size once the view fills the panel again.
    if (size) {
      tab.driver.emulate(size, tab.scale)
      await tab.driver.emulating.catch(() => undefined)
    }
    this.layout()
    if (!size) tab.driver.emulate(undefined)
    this.changed(chatId)
    await tab.driver.emulating
    if (reload && tab.contents.getURL()) tab.contents.reload()
  }

  /** The chat whose browser the panel shows. */
  setActiveChat(chatId: string | undefined): void {
    this.activeChat = chatId
    if (chatId && this.panelBounds) this.browserFor(chatId)
    this.layout()
    this.prune()
    this.emitState()
  }

  /** Called by the renderer with the panel's rect, or null when the panel is closed. */
  setBounds(rect: Rect | null): void {
    if (!rect) {
      this.panelBounds = undefined
      this.panelHidden = false
      this.layout()
      this.prune()
      return
    }
    // The renderer measures in CSS pixels, which change with the app's zoom level;
    // the native view is placed in window points.
    const zoom = this.window.webContents.getZoomFactor()
    this.panelBounds = {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom)
    }
    this.pageArea = this.panelBounds
    if (this.activeChat) this.browserFor(this.activeChat)
    this.layout()
    for (const resolve of this.waitingForPanel.splice(0)) resolve()
    this.emitState()
  }

  /**
   * Park the panel's page while the panel stays open: the native view would
   * swallow the pointer while the user drags the panel's edge. Unlike closing
   * the panel, this keeps every page as it is.
   */
  setPanelHidden(hidden: boolean): void {
    this.panelHidden = hidden
    this.layout()
  }

  /**
   * A picture of the page in the panel, as a data URL, or null when the panel
   * shows none. The renderer shows it in the page's place while the page is
   * parked for a popup: the native view is drawn over all of the app's HTML.
   */
  async capturePanel(): Promise<string | null> {
    const page = this.activePage()
    if (!page?.shown) return null
    const image = await page.contents.capturePage()
    if (image.isEmpty()) return null
    // JPEG encodes in about a quarter of PNG's time (~5 ms against ~25 ms for a panel).
    return `data:image/jpeg;base64,${image.toJPEG(90).toString('base64')}`
  }

  /**
   * Get a tab of a chat's browser ready for an agent: the given one, or the
   * active one. The chat's panel is opened, so the user sees what the agent
   * does: at once in the selected chat, waiting for it to show, and in any
   * other chat when the user selects it.
   */
  async ensureReady(chatId: string, tabId?: string): Promise<ChatPage> {
    if (chatId === this.activeChat && !this.panelBounds) {
      const shown = new Promise<void>((resolve) => this.waitingForPanel.push(resolve))
      this.requestShow(chatId)
      await Promise.race([shown, new Promise((resolve) => setTimeout(resolve, 3000))])
    } else if (chatId !== this.activeChat) {
      this.requestShow(chatId)
    }
    const browser = this.browserFor(chatId)
    const tab = tabId ? this.findTab(browser, tabId) : browser.active!
    // A reopened tab loads its page on first use. A new one may still be
    // loading its first page, which would abort a navigation started now.
    await loadedWithin(tab.load())
    // A page whose renderer crashed comes back by loading it again.
    if (tab.contents.isCrashed()) await reloadAndWait(tab.contents)
    return tab
  }

  /** Download a URL with the browser's logins and wait until the file is saved. */
  download(chatId: string, url: string): Promise<Download> {
    const contents = this.tabs(chatId).active.contents
    return new Promise<Download>((resolve, reject) => {
      const waiter = {
        contents,
        url: new URL(url).href,
        done: (download: Download) => {
          clearTimeout(timer)
          resolve(download)
        }
      }
      const timer = setTimeout(() => {
        this.downloadWaiters = this.downloadWaiters.filter((w) => w !== waiter)
        reject(new Error('Download did not finish within 5 minutes'))
      }, 300_000)
      this.downloadWaiters.push(waiter)
      contents.downloadURL(url)
    })
  }

  /** Open a link from a chat message in a new tab of the selected chat's browser. */
  async open(url: string): Promise<void> {
    if (!this.activeChat) return
    await this.ensureReady(this.activeChat)
    await this.newTab(this.activeChat).contents.loadURL(normalizeUrl(url))
  }

  // Toolbar actions act on a chat's active tab: the one the panel shows, by
  // default, or the one a device of the remote link shows. A dialog the page
  // waits on is cancelled first, as Chrome does when you leave a page.

  /**
   * Go to an address, or search for the words. `focus` gives the page the
   * window's keyboard focus, for an address entered in the panel: the page is
   * where the user works next, as in Chrome.
   */
  navigate(input: string, chatId = this.activeChat, focus = true): Promise<void> {
    if (!chatId) return Promise.resolve()
    const page = this.tabs(chatId).active
    page.dismissDialog()
    if (focus) page.contents.focus()
    return page.contents.loadURL(normalizeUrl(input))
  }

  back(chatId = this.activeChat): void {
    const page = this.activePage(chatId)
    page?.dismissDialog()
    if (page?.contents.navigationHistory.canGoBack()) page.contents.navigationHistory.goBack()
  }

  forward(chatId = this.activeChat): void {
    const page = this.activePage(chatId)
    page?.dismissDialog()
    if (page?.contents.navigationHistory.canGoForward()) page.contents.navigationHistory.goForward()
  }

  reload(chatId = this.activeChat): void {
    const page = this.activePage(chatId)
    page?.dismissDialog()
    page?.contents.reload()
  }

  /** The tab buttons of the panel, for the selected chat. */
  selectActiveChatTab(tabId: string): void {
    if (this.activeChat) this.selectTab(this.activeChat, tabId)
  }

  closeActiveChatTab(tabId: string): void {
    if (this.activeChat) this.closeTab(this.activeChat, tabId)
  }

  newActiveChatTab(): void {
    if (this.activeChat) this.newTab(this.activeChat)
  }

  /** The page the panel shows has the user's size again, whatever size an agent set it to. */
  async resetViewport(): Promise<void> {
    const page = this.activePage()
    if (this.activeChat && page?.viewport) await this.setViewport(this.activeChat, page, undefined)
  }

  /** Minimized: macOS draws nothing for it, so pages cannot be pictured until it is restored. */
  get windowMinimized(): boolean {
    return this.window.isMinimized()
  }

  /** Minimized or hidden: macOS draws nothing for it, so pages cannot be captured. */
  get windowHidden(): boolean {
    return this.window.isMinimized() || !this.window.isVisible()
  }

  /** A chat's active tab (the one the panel shows by default), if its browser is open. */
  activePage(chatId = this.activeChat): ChatPage | undefined {
    return chatId ? this.chats.get(chatId)?.active : undefined
  }

  /** Clear a profile's cookies and site data, and reload its pages. */
  private async clearData(partition: string): Promise<void> {
    await this.sessionFor(partition).clearStorageData()
    for (const browser of this.chats.values()) {
      if (browser.partition !== partition) continue
      for (const tab of browser.tabs) {
        tab.dismissDialog()
        // A tab that has not loaded yet will load with the cleared data anyway.
        if (!tab.unloaded) tab.contents.reload()
      }
    }
  }

  /** Make sure logins written moments ago reach disk before quitting. */
  async flush(): Promise<void> {
    for (const browserSession of this.sessions.values()) {
      await browserSession.cookies.flushStore()
      browserSession.flushStorageData()
    }
  }

  /** A chat's browser (the selected chat by default), without opening it. */
  state(chatId = this.activeChat): BrowserState {
    const browser = chatId ? this.chats.get(chatId) : undefined
    const contents = browser?.active?.contents
    const size = chatId === OWN_BROWSER ? undefined : this.size
    if (!browser || !contents) {
      const saved = chatId ? this.savedTabs.get(chatId) : undefined
      return { ...EMPTY_STATE, size, url: saved?.urls[saved.active] ?? '' }
    }
    const shownUrl = (url: string): string => (url === 'about:blank' ? '' : url)
    const { viewport, scale, viewportBy } = browser.active!
    return {
      size,
      viewport: viewport && { ...viewport, scale, ...(viewportBy ? { by: viewportBy } : {}) },
      tabs: browser.tabs.map((tab) => ({
        id: tab.id,
        title: tab.contents.getTitle(),
        url: shownUrl(tab.contents.getURL() || tab.url),
        loading: tab.contents.isLoading(),
        favicon: tab.favicon,
        controlled: tab === browser.controlled
      })),
      activeTab: browser.active?.id,
      // A blank page shows as an empty address bar, with its placeholder.
      url: shownUrl(contents.getURL()),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    }
  }

  /** Close a deleted chat's browser. */
  closeChat(chatId: string): void {
    this.closeBrowser(chatId)
  }

  /**
   * Open a chat's browser anew, from its saved tabs, if it is open: the user's
   * own browser when the active profile changed, so it has that profile's tabs
   * and logins.
   */
  reopen(chatId: string): void {
    if (!this.chats.has(chatId)) return
    this.closeBrowser(chatId)
    if (chatId === this.activeChat && this.panelBounds) this.browserFor(chatId)
    this.layout()
    this.emitState()
  }

  /**
   * Close every browser before the app quits, keeping each chat's saved tabs.
   * Left to the window's teardown, each page closing would count as a tab the
   * user closed: the last one would be replaced by a blank tab on the closing
   * window, which crashes the app and saves the blank tab over the chat's tabs.
   */
  closeAll(): void {
    for (const chatId of [...this.chats.keys()]) this.closeBrowser(chatId)
  }

  private emitState(): void {
    this.onState(this.state())
  }

  /** A chat's browser changed: the panel shows it anew if it is the selected chat's. */
  private changed(chatId: string): void {
    if (chatId === this.activeChat) this.emitState()
    this.onChatChanged?.(chatId)
  }
}

/** How long an agent waits for a page to load before working with it as it is. */
const LOAD_WAIT_MS = 15_000

/** Wait for a page load to settle, or LOAD_WAIT_MS, whichever comes first. */
function loadedWithin(load: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    load,
    new Promise<void>((resolve) => (timer = setTimeout(resolve, LOAD_WAIT_MS)))
  ]).finally(() => clearTimeout(timer))
}

/** Reload a page and wait until it has loaded, or failed to, or LOAD_WAIT_MS passed. */
function reloadAndWait(contents: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      contents.off('did-finish-load', done)
      contents.off('did-fail-load', done)
      resolve()
    }
    const timer = setTimeout(done, LOAD_WAIT_MS)
    contents.on('did-finish-load', done)
    contents.on('did-fail-load', done)
    contents.reload()
  })
}

export function normalizeUrl(input: string): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^[\d.]+(:\d+)?(\/|$)/.test(text))
    return `http://${text}`
  if (/^[^\s]+\.[^\s]{2,}$/.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}
