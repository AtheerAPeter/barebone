import { PROBE_CODEC } from '../../../shared/video'
import type { FrameHeader } from '../../../shared/wire'

/**
 * The browser tab as video on a device (shared/video.ts): H.264 decoded with
 * WebCodecs, in hardware on a phone, and drawn onto a canvas as each picture
 * comes. A decoder starts at a keyframe; one that has none to start from, or
 * fails, asks for one.
 */

let support: Promise<boolean> | undefined

/** Whether this browser decodes the video (Safari 16.4 and later, Chrome, Firefox 130 and later). */
export function decodesVideo(): Promise<boolean> {
  support ??= (async () => {
    if (typeof VideoDecoder === 'undefined') return false
    try {
      const { supported } = await VideoDecoder.isConfigSupported({
        codec: PROBE_CODEC,
        optimizeForLatency: true
      })
      return supported === true
    } catch {
      return false
    }
  })()
  return support
}

export class VideoPlayer {
  private decoder?: VideoDecoder
  private codec?: string
  /** The headers of the pictures being decoded, oldest first: each comes out in turn. */
  private headers: FrameHeader[] = []
  private timestamp = 0
  /** A keyframe was asked for and has not come yet. */
  private asked = false

  constructor(
    private readonly canvas: () => HTMLCanvasElement | null,
    /** A picture was drawn: what it shows of the page. */
    private readonly onShown: (header: FrameHeader) => void,
    /** Ask for a picture to start decoding from. */
    private readonly askKeyframe: () => void
  ) {}

  push(header: FrameHeader, data: Uint8Array): void {
    if (!header.video) return
    const { codec, key } = header.video
    if (key) {
      this.asked = false
      if (codec !== this.codec || this.decoder?.state !== 'configured') this.start(codec)
    }
    if (this.decoder?.state !== 'configured') return this.ask()
    this.headers.push(header)
    this.decoder.decode(
      new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.timestamp++, data })
    )
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = undefined
    this.codec = undefined
    this.headers = []
  }

  private start(codec: string): void {
    this.close()
    const decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: () => {
        // The next keyframe starts a new decoder.
        if (this.decoder === decoder) this.close()
        this.ask()
      }
    })
    // Each picture as soon as it is decoded, not held to order the ones after.
    decoder.configure({ codec, optimizeForLatency: true })
    this.decoder = decoder
    this.codec = codec
  }

  private draw(frame: VideoFrame): void {
    const header = this.headers.shift()
    const canvas = this.canvas()
    try {
      if (!canvas || !header) return
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight
      canvas.getContext('2d')?.drawImage(frame, 0, 0)
      this.onShown(header)
    } finally {
      frame.close()
    }
  }

  private ask(): void {
    if (this.asked) return
    this.asked = true
    this.askKeyframe()
  }
}
