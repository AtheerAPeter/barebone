import type { BrowserTab, RemoteBrowserView } from '../../shared/types'
import { encodeFrame } from '../../shared/wire'
import { normalizeUrl, type BuiltinBrowser, type ChatPage } from '../browser'
import { loadConfig, saveConfig } from './config'
import { handleRemote, listenRemote, onCallerGone, type Caller } from './registry'

/**
 * A chat's browser tab on a device of the remote link: a live picture of the
 * page (Chrome's screencast, sent as binary messages), and the device's taps,
 * scrolls and keys sent back to it. It is the Mac's own tab, signed in to the
 * user's accounts, so it is off until turned on in Settings on the Mac.
 *
 * A device shows one chat's tab at a time, and a chat's tab shows on one
 * device at a time: the device that opens it last has it. While a device shows
 * a tab, the page is laid out at the device's size, unless an agent set a size
 * of its own (set_viewport), which the device then shows scaled to fit.
 *
 * Only web pages (http, https) are shown and used. A tab showing a file on
 * the Mac shows nothing of it, and only web addresses can be opened.
 */

/** The page area on the device, in CSS pixels, and its pixels per CSS pixel. */
interface Size {
  width: number
  height: number
  ratio: number
}

interface View {
  caller: Caller
  chatId: string
  size: Size
  /** The device, as Settings names it; shown on the Mac by the page's size. */
  device: string
  /** Lets the chat's browser close again once nothing needs it. */
  release: () => void
  /** The tab shown: the chat's active one. */
  tab?: ChatPage
  /** Stops listening to that tab. */
  untab?: () => void
  /** The page is being cast to the device. */
  casting: boolean
  /** The page's renderer crashed; the cast starts again once it is back. */
  crashed: boolean
  /**
   * For each picture on its way to the device, oldest first: what lets the
   * next one come once the device has shown it. The device shows them in order.
   */
  acks: (() => void)[]
  /** The page was loading, when the device was last told about it. */
  loading: boolean
}

/** The smallest and biggest page a device may ask for, in CSS pixels. */
const MIN_SIDE = 200
const MAX_SIDE = 4000
/** Pictures have at most this many pixels per CSS pixel: a phone's 3 would be 2.25 times the pixels. */
const MAX_RATIO = 2
/** How long a device that lost its connection has to come back to the page as it left it. */
const RECONNECT_MS = 60_000
/** Changes to a chat's browser come in bursts (a page loading); the device hears of them once. */
const STATE_DELAY_MS = 50

/** A page the link may show and use: a web page, or none yet. */
export function webPage(url: string): boolean {
  if (!url || url === 'about:blank') return true
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export interface RemoteBrowserHost {
  chatExists(chatId: string): boolean
  sendTo(caller: Caller, channel: string, args: unknown[]): boolean
  sendBinary(caller: Caller, data: Uint8Array): boolean
  deviceOf(caller: Caller): string | undefined
}

export class RemoteBrowser {
  private views = new Set<View>()
  /** Chats whose browser changed, to tell their devices about shortly. */
  private dirty = new Set<string>()
  private dirtyTimer?: NodeJS.Timeout

  constructor(
    private readonly browser: BuiltinBrowser,
    private readonly host: RemoteBrowserHost
  ) {
    browser.onChatChanged = (chatId) => {
      if (![...this.views].some((view) => view.chatId === chatId)) return
      this.dirty.add(chatId)
      this.dirtyTimer ??= setTimeout(() => this.refreshDirty(), STATE_DELAY_MS)
    }
    // A device that lost its connection (a phone locked, a network change) comes back to the
    // page as it left it: the chat's browser stays open, at its size, for a while.
    onCallerGone((caller) => {
      const view = this.viewOf(caller)
      if (view) this.close(view, undefined, RECONNECT_MS)
    })
    this.register()
  }

  get allowed(): boolean {
    return loadConfig().browser === true
  }

  /** Turn it on or off (Settings on the Mac). Off closes every device's view. */
  setAllowed(on: boolean): void {
    loadConfig().browser = on || undefined
    saveConfig()
    if (!on) for (const view of [...this.views]) this.close(view, 'off')
  }

  private register(): void {
    handleRemote('remoteBrowser:allowed', () => this.allowed)
    handleRemote('remoteBrowser:open', (caller, chatId: unknown, size: unknown) =>
      this.open(caller, chatId, size)
    )
    handleRemote('remoteBrowser:resize', (caller, size: unknown) => {
      const view = this.use(caller)
      view.size = sizeFrom(size)
      if (view.tab) {
        this.fit(view, view.tab)
        this.restartCast(view)
      }
    })
    handleRemote('remoteBrowser:close', (caller) => {
      const view = this.viewOf(caller)
      if (view) this.close(view)
    })
    listenRemote('remoteBrowser:ack', (caller) => this.viewOf(caller)?.acks.shift()?.())

    // Input goes to the page only, as an agent's does (page-driver.ts).
    handleRemote('remoteBrowser:tap', (caller, x: unknown, y: unknown) =>
      this.page(caller).driver.clickAt({ x: num(x), y: num(y) }, 'left', 1)
    )
    handleRemote(
      'remoteBrowser:scroll',
      (caller, x: unknown, y: unknown, dx: unknown, dy: unknown) =>
        this.page(caller).driver.wheel({ x: num(x), y: num(y) }, num(dy), num(dx))
    )
    handleRemote('remoteBrowser:type', (caller, text: unknown) =>
      this.page(caller).driver.typeText(str(text).slice(0, 1000))
    )
    handleRemote('remoteBrowser:key', (caller, key: unknown) =>
      this.page(caller).driver.press(str(key), [])
    )
    handleRemote('remoteBrowser:focused', (caller) => this.page(caller).driver.focusedField())
    handleRemote('remoteBrowser:answer', (caller, accept: unknown) => {
      this.page(caller).dialog?.answer?.(accept === true)
    })

    handleRemote('remoteBrowser:navigate', (caller, input: unknown) => {
      const view = this.use(caller)
      const url = normalizeUrl(str(input))
      if (!/^https?:/i.test(url)) throw new Error('Only web addresses open from here.')
      // The Mac's keyboard focus stays where it is.
      return this.browser.navigate(url, view.chatId, false).catch(() => undefined)
    })
    handleRemote('remoteBrowser:back', (caller) => this.browser.back(this.use(caller).chatId))
    handleRemote('remoteBrowser:forward', (caller) => this.browser.forward(this.use(caller).chatId))
    handleRemote('remoteBrowser:reload', (caller) => this.browser.reload(this.use(caller).chatId))
    handleRemote('remoteBrowser:selectTab', (caller, tabId: unknown) => {
      this.browser.selectTab(this.use(caller).chatId, str(tabId))
    })
    handleRemote('remoteBrowser:closeTab', (caller, tabId: unknown) => {
      this.browser.closeTab(this.use(caller).chatId, str(tabId))
    })
    handleRemote('remoteBrowser:newTab', (caller) => {
      this.browser.newTab(this.use(caller).chatId)
    })
  }

  /** Show a chat's tab on a device; another device showing it stops. */
  private open(caller: Caller, chatId: unknown, size: unknown): RemoteBrowserView {
    this.checkAllowed()
    if (typeof chatId !== 'string' || !this.host.chatExists(chatId)) {
      throw new Error('There is no such chat.')
    }
    const own = this.viewOf(caller)
    if (own) this.close(own)
    for (const other of [...this.views]) {
      if (other.chatId === chatId) this.close(other, 'elsewhere')
    }
    const view: View = {
      caller,
      chatId,
      size: sizeFrom(size),
      device: (this.host.deviceOf(caller) ?? 'Remote link').split(' · ')[0],
      release: this.browser.keepOpen(chatId),
      casting: false,
      crashed: false,
      acks: [],
      loading: false
    }
    this.views.add(view)
    this.follow(view)
    return this.viewState(view)
  }

  /**
   * Stop showing the tab on the device, telling it why if it is still there.
   * With `keepFor`, the chat's browser stays open, and the page at the
   * device's size, that much longer.
   */
  private close(view: View, reason?: 'elsewhere' | 'off', keepFor?: number): void {
    if (!this.views.delete(view)) return
    const tab = view.tab
    this.unfollow(view, keepFor !== undefined)
    if (reason) this.host.sendTo(view.caller, 'remoteBrowser:closed', [view.chatId, reason])
    if (keepFor === undefined) return view.release()
    setTimeout(() => {
      if (tab && ![...this.views].some((other) => other.tab === tab)) this.unfit(view.chatId, tab)
      view.release()
    }, keepFor)
  }

  /** Show the chat's active tab, if it is not the one shown. */
  private follow(view: View): void {
    const tab = this.browser.activePage(view.chatId)
    if (tab === view.tab) return
    this.unfollow(view)
    if (!tab) return
    view.tab = tab
    view.loading = tab.contents.isLoading()
    tab.viewedRemotely = true
    const dialogChanged = (): void => this.sendState(view)
    const crashed = (): void => {
      view.crashed = true
      view.casting = false
    }
    tab.on('dialog', dialogChanged)
    tab.on('dialogClosed', dialogChanged)
    tab.contents.on('render-process-gone', crashed)
    view.untab = () => {
      tab.off('dialog', dialogChanged)
      tab.off('dialogClosed', dialogChanged)
      if (!tab.contents.isDestroyed()) tab.contents.off('render-process-gone', crashed)
    }
    this.fit(view, tab)
    this.cast(view)
  }

  /** Stop showing the tab; the page fills the Mac's panel again unless `keepSize`. */
  private unfollow(view: View, keepSize = false): void {
    const tab = view.tab
    if (!tab) return
    view.untab?.()
    view.untab = undefined
    view.tab = undefined
    view.acks = []
    if (view.casting) tab.driver.stopScreencast()
    view.casting = false
    view.crashed = false
    tab.viewedRemotely = false
    if (!keepSize) this.unfit(view.chatId, tab)
  }

  /** The page fills the Mac's panel again, unless an agent has set a size since. */
  private unfit(chatId: string, tab: ChatPage): void {
    if (tab.viewportBy !== undefined && !tab.contents.isDestroyed()) {
      void this.browser.setViewport(chatId, tab, undefined).catch(() => undefined)
    }
  }

  /**
   * Lay the page out at the device's size, unless an agent set one: as the
   * device starts showing the tab, and when its size changes.
   */
  private fit(view: View, tab: ChatPage): void {
    if (tab.viewport && tab.viewportBy === undefined) return
    const { width, height } = view.size
    if (
      tab.viewport?.width === width &&
      tab.viewport.height === height &&
      tab.viewportBy === view.device
    ) {
      return
    }
    void this.browser
      .setViewport(view.chatId, tab, { width, height, mobile: false }, view.device)
      .catch(() => undefined)
  }

  /** Cast the page to the device while it is a web page; stop while it is not. */
  private cast(view: View): void {
    const tab = view.tab
    if (!tab || view.crashed) return
    const shown = webPage(tab.contents.getURL() || tab.url)
    if (!shown) {
      if (view.casting) tab.driver.stopScreencast()
      view.casting = false
      view.acks = []
      return
    }
    if (view.casting) return
    view.casting = true
    const { width, height, ratio } = view.size
    tab.driver
      .screencast(width * ratio, height * ratio, (frame, ack) => {
        if (view.tab !== tab || !this.views.has(view)) return
        // A page that went to a file shows nothing of it, also in a picture made as it went.
        if (!webPage(tab.contents.getURL())) return
        view.acks.push(ack)
        const header = {
          chatId: view.chatId,
          tab: tab.id,
          width: frame.width,
          height: frame.height
        }
        if (!this.host.sendBinary(view.caller, encodeFrame(header, frame.jpeg))) this.close(view)
      })
      .catch(() => {
        if (view.tab === tab) view.casting = false
      })
  }

  /** Cast again, at the device's new size. */
  private restartCast(view: View): void {
    if (view.casting) view.tab?.driver.stopScreencast()
    view.casting = false
    view.acks = []
    this.cast(view)
  }

  private refreshDirty(): void {
    this.dirtyTimer = undefined
    const chats = [...this.dirty]
    this.dirty.clear()
    for (const view of [...this.views]) {
      if (!chats.includes(view.chatId)) continue
      this.follow(view)
      const tab = view.tab
      if (tab) {
        // Back from a crash, once the page is loading again.
        if (view.crashed && !tab.contents.isCrashed()) view.crashed = false
        // Not fitted again here: clicking the size on the Mac gives the panel the page back.
        this.cast(view)
        // A page that finished loading out of sight is pictured: it tells of no change by itself.
        const loading = tab.contents.isLoading()
        if (view.loading && !loading && view.casting && !view.acks.length) tab.driver.castNow()
        view.loading = loading
      }
      this.sendState(view)
    }
  }

  private sendState(view: View): void {
    if (this.views.has(view)) {
      this.host.sendTo(view.caller, 'remoteBrowser:state', [this.viewState(view)])
    }
  }

  /** What the device shows of the chat's browser: no address or title of pages it does not show. */
  private viewState(view: View): RemoteBrowserView {
    const state = this.browser.state(view.chatId)
    const hidden = (tab: Pick<BrowserTab, 'url' | 'title'>): boolean => !webPage(tab.url)
    const tab = view.tab
    const dialog = tab?.dialog
    const local = hidden(state)
    return {
      ...state,
      chatId: view.chatId,
      ...(this.browser.windowMinimized ? { minimized: true } : {}),
      tabs: state.tabs.map((t) => (hidden(t) ? { ...t, url: '', title: 'A page on your Mac' } : t)),
      ...(local ? { url: '', title: 'A page on your Mac', local: true } : {}),
      ...(dialog && !local
        ? {
            dialog: {
              type: dialog.type,
              message: dialog.message,
              site: dialog.site,
              answerable: Boolean(dialog.answer)
            }
          }
        : {})
    }
  }

  private viewOf(caller: Caller): View | undefined {
    for (const view of this.views) if (view.caller === caller) return view
    return undefined
  }

  private checkAllowed(): void {
    if (!this.allowed) {
      throw new Error('Turn on "Phones can use the browser" in Settings on your Mac.')
    }
  }

  /** The device's view, for a request it makes on it. */
  private use(caller: Caller): View {
    this.checkAllowed()
    const view = this.viewOf(caller)
    if (!view) throw new Error('Open the browser first.')
    return view
  }

  /** The page the device shows, to act on; a page it does not show cannot be used. */
  private page(caller: Caller): ChatPage {
    const tab = this.use(caller).tab
    if (!tab || !webPage(tab.contents.getURL() || tab.url)) {
      throw new Error('This page shows only on your Mac.')
    }
    return tab
  }
}

function num(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Bad request.')
  return value
}

function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Bad request.')
  return value
}

function sizeFrom(value: unknown): Size {
  const { width, height, ratio } = (value ?? {}) as Record<string, unknown>
  const side = (n: unknown): number => Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, num(n))))
  return {
    width: side(width),
    height: side(height),
    ratio: Math.min(MAX_RATIO, Math.max(1, num(ratio)))
  }
}
