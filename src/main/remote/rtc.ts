import { BrowserWindow, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { IceServer, RtcCandidate, RtcCommand, RtcEvent } from '../../shared/rtc'

/**
 * The browser's tabs as live video for devices of the remote link
 * (shared/rtc.ts), streamed by a hidden page (renderer/rtc.html): capturing a
 * tab and WebRTC are web APIs. The page opens with the first stream and
 * closes a while after the last one ends.
 *
 * Phones on mobile networks seldom reach a home connection directly, so a
 * TURN relay carries the video then: Cloudflare's, when a TURN key is set with
 * BAREBONE_TURN_KEY_ID and BAREBONE_TURN_KEY_TOKEN. Its short-lived
 * credentials are made here, on the Mac or server; the key never leaves it.
 * Without one, STUN alone connects where the networks allow it, and a device
 * that cannot connect gets pictures as before.
 */

/** How long the page stays open with no stream. */
const IDLE_MS = 60_000
/** How long TURN credentials last, and how long before their end new ones are made. */
const TURN_TTL_S = 86_400
const TURN_RENEW_MS = 3_600_000
const STUN: IceServer = { urls: 'stun:stun.cloudflare.com:3478' }

export interface StreamEvents {
  offer(sdp: string, iceServers: IceServer[]): void
  candidate(candidate: RtcCandidate): void
  failed(message: string): void
}

export class RtcStreams {
  private window?: BrowserWindow
  private ready?: Promise<void>
  private streams = new Map<number, { events: StreamEvents; iceServers: IceServer[] }>()
  private nextId = 1
  private idle?: NodeJS.Timeout
  private turn?: { servers: IceServer[]; until: number }

  constructor() {
    ipcMain.on('rtc:event', (event: IpcMainEvent, message: RtcEvent) => {
      if (event.sender !== this.window?.webContents) return
      if (message.t === 'ready') return
      const stream = this.streams.get(message.id)
      if (!stream) return
      if (message.t === 'offer') stream.events.offer(message.sdp, stream.iceServers)
      else if (message.t === 'candidate') stream.events.candidate(message.candidate)
      else if (message.t === 'failed') {
        this.streams.delete(message.id)
        stream.events.failed(message.message)
      }
    })
  }

  /**
   * Stream a tab, at most this many pixels, which are `ratio` to a CSS pixel;
   * its offer and candidates come through events.
   */
  async open(
    tab: WebContents,
    width: number,
    height: number,
    ratio: number,
    events: StreamEvents
  ): Promise<number> {
    clearTimeout(this.idle)
    const id = this.nextId++
    const iceServers = await this.iceServers()
    this.streams.set(id, { events, iceServers })
    const window = await this.page()
    // Bound to the page that captures it, and good for that one capture.
    const sourceId = tab.getMediaSourceId(window.webContents)
    this.send({ t: 'open', id, sourceId, width, height, ratio, iceServers })
    return id
  }

  answer(id: number, sdp: string): void {
    if (this.streams.has(id)) this.send({ t: 'answer', id, sdp })
  }

  candidate(id: number, candidate: RtcCandidate): void {
    if (this.streams.has(id)) this.send({ t: 'candidate', id, candidate })
  }

  close(id: number): void {
    if (!this.streams.delete(id)) return
    this.send({ t: 'close', id })
    if (!this.streams.size) {
      clearTimeout(this.idle)
      this.idle = setTimeout(() => this.shut(), IDLE_MS)
    }
  }

  private send(command: RtcCommand): void {
    const window = this.window
    if (window && !window.isDestroyed()) window.webContents.send('rtc:command', command)
  }

  private page(): Promise<BrowserWindow> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      const window = new BrowserWindow({
        show: false,
        width: 64,
        height: 64,
        skipTaskbar: true,
        webPreferences: {
          preload: join(import.meta.dirname, '../preload/rtc.cjs'),
          sandbox: true,
          contextIsolation: true,
          // Hidden, it would otherwise be slowed down as a page in the background.
          backgroundThrottling: false
        }
      })
      this.window = window
      const readied = (event: IpcMainEvent, message: RtcEvent): void => {
        if (event.sender !== window.webContents || message.t !== 'ready') return
        ipcMain.off('rtc:event', readied)
        resolve()
      }
      ipcMain.on('rtc:event', readied)
      window.webContents.on('render-process-gone', () => {
        ipcMain.off('rtc:event', readied)
        reject(new Error('The video streamer stopped.'))
        this.shut()
      })
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/rtc.html`)
      } else {
        void window.loadFile(join(import.meta.dirname, '../renderer/rtc.html'))
      }
    })
    return this.ready.then(() => {
      if (!this.window) throw new Error('The video streamer stopped.')
      return this.window
    })
  }

  /** Close the page; its streams fail, and their devices get pictures. */
  private shut(): void {
    clearTimeout(this.idle)
    const window = this.window
    this.window = undefined
    this.ready = undefined
    const streams = [...this.streams.values()]
    this.streams.clear()
    for (const stream of streams) stream.events.failed('The video streamer stopped.')
    if (window && !window.isDestroyed()) window.destroy()
  }

  /** STUN, and Cloudflare TURN when a key is set, its credentials made anew before they end. */
  private async iceServers(): Promise<IceServer[]> {
    const id = process.env.BAREBONE_TURN_KEY_ID?.trim()
    const token = process.env.BAREBONE_TURN_KEY_TOKEN?.trim()
    if (!id || !token) return [STUN]
    if (this.turn && this.turn.until > Date.now()) return this.turn.servers
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: TURN_TTL_S }),
          signal: AbortSignal.timeout(10_000)
        }
      )
      if (!response.ok) throw new Error(`Cloudflare answered ${response.status}`)
      const { iceServers } = (await response.json()) as { iceServers: IceServer[] }
      this.turn = { servers: iceServers, until: Date.now() + TURN_TTL_S * 1000 - TURN_RENEW_MS }
      return iceServers
    } catch (error) {
      console.error(`No TURN credentials, STUN only: ${(error as Error).message}`)
      return [STUN]
    }
  }
}
