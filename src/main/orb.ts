import { ipcMain, WebContentsView, type BrowserWindow, type IpcMainEvent } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { OrbCorner, OrbState } from '../shared/types'

/**
 * The agent orb: while the chat is folded away, a round icon in a corner of
 * the browser page, with what the agent says and does next to it like
 * subtitles, and an input to steer it on hover (renderer/src/orb).
 *
 * It is a transparent view over the page, sized to what it shows, so the rest
 * of the page takes clicks as usual. The page is a native view drawn over the
 * window's HTML, so the orb cannot be part of the window's page.
 */

/** Between the orb's view and the page's edges. */
const MARGIN = 6

interface Size {
  width: number
  height: number
}

export class AgentOrb {
  private readonly view: WebContentsView
  private state: OrbState | null = null
  /** The part of the window the page fills, in window points; undefined while none shows. */
  private area?: Electron.Rectangle
  /** What the orb's page measures, and the corner it sits in. */
  private size: Size = { width: 0, height: 0 }
  private corner: OrbCorner = 'bottom-left'
  /** While the orb is dragged: where the pointer is, in window points. */
  private dragAt?: { x: number; y: number }

  constructor(
    private readonly window: BrowserWindow,
    /** The user asked for the whole chat back. */
    private readonly onUnfold: () => void
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/orb.cjs'),
        sandbox: true,
        contextIsolation: true
      }
    })
    // ARGB: fully transparent, so only what the orb draws covers the page.
    this.view.setBackgroundColor('#00000000')
    this.view.setVisible(false)
    window.contentView.addChildView(this.view)
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.view.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/orb.html`)
    } else {
      this.view.webContents.loadFile(join(import.meta.dirname, '../renderer/orb.html'))
    }
    this.view.webContents.on('did-finish-load', () => this.sendState())

    const fromOrb = (event: IpcMainEvent): boolean => event.sender === this.view.webContents
    ipcMain.on('orb:size', (event, size: Size, corner: OrbCorner) => {
      if (!fromOrb(event)) return
      this.size = size
      this.corner = corner
      this.place()
    })
    ipcMain.on('orb:unfold', (event) => {
      if (fromOrb(event)) this.onUnfold()
    })
    ipcMain.on('orb:drag', (event, screenX: number, screenY: number) => {
      if (!fromOrb(event)) return
      const content = this.window.getContentBounds()
      this.dragAt = { x: screenX - content.x, y: screenY - content.y }
      this.place()
    })
    ipcMain.on('orb:drop', (event) => {
      if (!fromOrb(event) || !this.dragAt || !this.area) return
      // The corner nearest to where it was let go.
      const { x, y } = this.dragAt
      const right = x > this.area.x + this.area.width / 2
      const bottom = y > this.area.y + this.area.height / 2
      this.corner = `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`
      this.dragAt = undefined
      this.view.webContents.send('orb:corner', this.corner)
      this.place()
    })
  }

  /** The selected chat's orb, while its chat is folded away; null hides it. */
  setState(state: OrbState | null): void {
    this.state = state
    this.sendState()
    this.place()
  }

  /** Whether the chat is folded into the orb: what it asks is not on screen. */
  folded(chatId: string): boolean {
    return this.state?.chatId === chatId
  }

  /** How loud the microphone is, 0 to 1, while the user dictates. */
  setLevel(level: number): void {
    if (!this.view.webContents.isLoading()) this.view.webContents.send('orb:level', level)
  }

  /** Dictated text, for the user to check and send from the orb's input. */
  draft(text: string): void {
    this.view.webContents.focus()
    this.view.webContents.send('orb:draft', text)
  }

  /** Where the page is now; undefined while none shows (the panel closed, or parked for a popup). */
  setArea(area: Electron.Rectangle | undefined): void {
    const widthChanged = area?.width !== this.area?.width
    this.area = area
    if (widthChanged) this.sendState()
    this.place()
  }

  private sendState(): void {
    if (this.view.webContents.isLoading()) return
    this.view.webContents.send('orb:state', this.state, this.maxWidth())
  }

  /** The widest the subtitles may be: within the page, and short enough to read at a glance. */
  private maxWidth(): number {
    return Math.max(160, Math.min(520, (this.area?.width ?? 520) - 2 * MARGIN))
  }

  private place(): void {
    const area = this.area
    if (!this.state || !area || this.size.width === 0) {
      this.view.setVisible(false)
      return
    }
    const width = Math.min(this.size.width, area.width - 2 * MARGIN)
    const height = Math.min(this.size.height, area.height - 2 * MARGIN)
    let x: number
    let y: number
    if (this.dragAt) {
      // Dragged, the orb's page shows the orb alone, centred under the pointer.
      x = this.dragAt.x - width / 2
      y = this.dragAt.y - height / 2
    } else {
      x = this.corner.endsWith('left') ? area.x + MARGIN : area.x + area.width - MARGIN - width
      y = this.corner.startsWith('top') ? area.y + MARGIN : area.y + area.height - MARGIN - height
    }
    this.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
    // Over the pages, including tabs opened since: adding it again puts it on top.
    this.window.contentView.addChildView(this.view)
    this.view.setVisible(true)
  }
}
