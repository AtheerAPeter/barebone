import type { EventEmitter } from 'node:events'
import type { PageViewport } from '../shared/types'
import type { PageDriver } from './page-driver'

/**
 * What the browser tools (browser-mcp.ts) act on: a chat's browser and its
 * tabs. In the app it is the browser panel (browser.ts); on a server, where
 * the `barebone` command runs, a headless Chromium (cli/headless-browser.ts).
 */

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

/** The editing commands ⌘A/C/V/X/Z run. */
export type EditCommand = 'selectAll' | 'copy' | 'paste' | 'cut' | 'undo'

/** Paper sizes a page is saved as a PDF in. */
export type PaperSize = 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5'

/**
 * A tab of a chat's browser. Emits 'dialog' when the page opens a dialog,
 * which it waits on until answered (see `dialog`).
 */
export interface BrowserPage extends EventEmitter {
  /** Short id agents use: t1, t2, ... */
  readonly id: string
  readonly driver: PageDriver
  readonly dialog?: PageDialog
  /** The page it was last at, kept for reopening the tab. */
  readonly url: string
  /** The share of its set size (set_viewport) it is shown at; 1 when it is shown whole. */
  readonly scale: number
  /** Its address now. */
  address(): string
  title(): string
  /** Whether its main frame is loading a document. */
  loading(): boolean
  /**
   * Load a URL. Settles once it has loaded; fails with the network error's
   * code (as ERR_ABORTED when another navigation took over, or a file downloaded).
   */
  navigate(url: string): Promise<void>
  /** Go back in its history, if it can; settles once the way back has started. */
  back(): Promise<void>
  /** The page as a PDF file, as printing it would, with its backgrounds. */
  pdf(pageSize: PaperSize, landscape: boolean): Promise<Buffer>
  /** Run an editing command in the focused element, as the Edit menu does. */
  edit(command: EditCommand): Promise<void>
  /** Paste an image file into the focused element, as ⌘V would. */
  pasteImage(path: string): Promise<void>
  /** Run an agent tool call on the page. */
  automate<T>(work: () => Promise<T>): Promise<T>
  /**
   * Inside an agent tool call, wait for the user to act on the page (see
   * wait_for_click). Meanwhile the page is not automated.
   */
  awaitUser<T>(work: () => Promise<T>): Promise<T>
}

/** Each chat's browser, with its kind of tab. */
export interface ChatBrowsers<Page extends BrowserPage = BrowserPage> {
  /** Most recent first; agents read paths from here to use downloaded files. */
  readonly downloads: Download[]
  /**
   * Whether the user sees the pages and can act in them, as in the app's
   * panel. A headless browser's pages are seen only in screenshots.
   */
  readonly watched: boolean
  /** Why pages cannot be captured now, if they cannot (the app's window is closed). */
  readonly captureBlocked?: string
  /** Get a tab of a chat's browser ready for an agent: the given one, or the active one. */
  ensureReady(chatId: string, tabId?: string): Promise<Page>
  /** A chat's tabs, its browser opened if needed. */
  tabs(chatId: string): { tabs: Page[]; active: Page }
  /** Open a blank tab and make it the active one. */
  newTab(chatId: string): Page
  selectTab(chatId: string, tabId: string): Page
  /** Close a tab; a browser always keeps one. */
  closeTab(chatId: string, tabId: string): void
  /** Download a URL with the browser's logins and wait until the file is saved. */
  download(chatId: string, url: string): Promise<Download>
  /** Lay a tab's page out at a size (set_viewport), or as it was again (undefined). */
  setViewport(chatId: string, tab: Page, viewport: PageViewport | undefined): Promise<void>
}

export function normalizeUrl(input: string): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^[\d.]+(:\d+)?(\/|$)/.test(text))
    return `http://${text}`
  if (/^[^\s]+\.[^\s]{2,}$/.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}
