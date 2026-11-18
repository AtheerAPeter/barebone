import { BrowserWindow, MessageChannelMain, type MessagePortMain } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { EncodedPicture, EncoderReply, EncoderRequest } from '../../shared/video'

/**
 * Encodes pictures of browser tabs as H.264 for the remote link
 * (shared/video.ts), in a hidden page (renderer/encoder.html): WebCodecs is
 * a web API, which this process lacks. The page opens with the first device
 * that watches, and closes a while after the last one stops.
 */

/** How long the page stays open with no device watching. */
const IDLE_MS = 60_000
/** How long the page may take to open. */
const OPEN_TIMEOUT_MS = 15_000

export interface Encoded {
  codec: string
  chunks: EncodedPicture[]
}

interface Waiting {
  resolve: (encoded: Encoded) => void
  reject: (error: Error) => void
}

export class VideoEncoders {
  private window?: BrowserWindow
  private port?: Promise<MessagePortMain>
  private waiting = new Map<string, Waiting>()
  /** The devices' encoders that are open. */
  private open = new Set<number>()
  private idle?: NodeJS.Timeout
  private nextId = 1
  private nextSeq = 1

  /** A new encoder, for one device watching one tab. */
  add(): number {
    const id = this.nextId++
    this.open.add(id)
    clearTimeout(this.idle)
    return id
  }

  /** The device stopped watching. */
  remove(id: number): void {
    if (!this.open.delete(id)) return
    void this.port?.then((port) => port.postMessage({ t: 'close', id } satisfies EncoderRequest))
    if (!this.open.size) {
      clearTimeout(this.idle)
      this.idle = setTimeout(() => this.shut(), IDLE_MS)
    }
  }

  /** Encode a picture of the page; `key` asks for a picture a device can start from. */
  async encode(id: number, image: Electron.NativeImage, key: boolean): Promise<Encoded> {
    const { pixels, width, height } = evenPixels(image)
    const port = await this.connect()
    const seq = this.nextSeq++
    return new Promise<Encoded>((resolve, reject) => {
      this.waiting.set(`${id}:${seq}`, { resolve, reject })
      port.postMessage({ t: 'frame', id, seq, width, height, key, pixels } satisfies EncoderRequest)
    })
  }

  private connect(): Promise<MessagePortMain> {
    this.port ??= new Promise<MessagePortMain>((resolve, reject) => {
      const window = new BrowserWindow({
        show: false,
        width: 64,
        height: 64,
        skipTaskbar: true,
        webPreferences: {
          preload: join(import.meta.dirname, '../preload/encoder.cjs'),
          sandbox: true,
          contextIsolation: true,
          // Hidden, it would otherwise be slowed down as a page in the background.
          backgroundThrottling: false
        }
      })
      this.window = window
      const { port1, port2 } = new MessageChannelMain()
      const timer = setTimeout(() => {
        reject(new Error('The video encoder did not start.'))
        this.shut()
      }, OPEN_TIMEOUT_MS)
      port1.on('message', ({ data }) => {
        const reply = data as EncoderReply
        if (reply.t === 'ready') {
          clearTimeout(timer)
          return resolve(port1)
        }
        const waiting = this.waiting.get(`${reply.id}:${reply.seq}`)
        this.waiting.delete(`${reply.id}:${reply.seq}`)
        if (reply.t === 'encoded') waiting?.resolve({ codec: reply.codec, chunks: reply.chunks })
        else waiting?.reject(new Error(reply.message))
      })
      port1.start()
      window.webContents.once('did-finish-load', () =>
        window.webContents.postMessage('encoder:port', null, [port2])
      )
      window.webContents.on('render-process-gone', () => {
        clearTimeout(timer)
        reject(new Error('The video encoder stopped.'))
        this.shut()
      })
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/encoder.html`)
      } else {
        void window.loadFile(join(import.meta.dirname, '../renderer/encoder.html'))
      }
    })
    return this.port
  }

  /** Close the page; what it was encoding fails, and the next picture opens it again. */
  private shut(): void {
    clearTimeout(this.idle)
    const window = this.window
    this.window = undefined
    this.port = undefined
    for (const waiting of this.waiting.values()) {
      waiting.reject(new Error('The video encoder stopped.'))
    }
    this.waiting.clear()
    if (window && !window.isDestroyed()) window.destroy()
  }
}

/**
 * The picture's pixels at its sharpest, as BGRA, cut to an even width and
 * height (H.264 pictures have them even). toBitmap gives Skia's own order,
 * which is BGRA on the little-endian Macs and Linux machines the app runs on.
 */
function evenPixels(image: Electron.NativeImage): {
  pixels: Uint8Array
  width: number
  height: number
} {
  const scale = Math.max(...image.getScaleFactors(), 1)
  const size = image.getSize(scale)
  const bitmap = image.toBitmap({ scaleFactor: scale })
  const stride = bitmap.length / size.height
  if (!Number.isInteger(stride) || stride < size.width * 4) {
    throw new Error('The picture of the page is not a size it says it is.')
  }
  const width = size.width & ~1
  const height = size.height & ~1
  if (stride === width * 4 && height === size.height) {
    return { pixels: bitmap, width, height }
  }
  const pixels = new Uint8Array(width * height * 4)
  for (let row = 0; row < height; row++) {
    pixels.set(bitmap.subarray(row * stride, row * stride + width * 4), row * width * 4)
  }
  return { pixels, width, height }
}
