import {
  h264Codec,
  type EncodedPicture,
  type EncoderReply,
  type EncoderRequest
} from '../../../shared/video'

/**
 * The hidden page that encodes the browser tab as H.264 for the remote link
 * (shared/video.ts): WebCodecs is a web API, which the main process lacks.
 * One encoder for each device watching, and each device's pictures encoded
 * one after the other, in the order they came.
 */

interface Encoder {
  encoder: VideoEncoder
  width: number
  height: number
  codec: string
  /** What the encoder gave and said, as it calls back. */
  result: {
    /** What the picture being encoded came out as. */
    out: EncodedPicture[]
    error?: string
  }
}

const encoders = new Map<number, Encoder>()
/** Each device's work so far, so its next picture waits for the one before. */
const queues = new Map<number, Promise<void>>()

/**
 * Bits a second, by the picture's size: text stays sharp while a page
 * scrolls. Only while the page changes; a still page sends nothing.
 */
function bitrate(width: number, height: number): number {
  return Math.round(Math.min(12_000_000, Math.max(2_000_000, width * height * 3)))
}

function open(width: number, height: number): Encoder {
  const codec = h264Codec(width, height)
  const result: Encoder['result'] = { out: [] }
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      result.out.push({ data, key: chunk.type === 'key' })
    },
    error: (error) => (result.error = error.message)
  })
  encoder.configure({
    codec,
    width,
    height,
    bitrate: bitrate(width, height),
    framerate: 30,
    // As soon as each picture comes, not held to plan the ones after.
    latencyMode: 'realtime',
    // Parameters in every keyframe, so a device can start at any keyframe.
    avc: { format: 'annexb' }
  })
  return { encoder, width, height, codec, result }
}

async function encode(
  request: Extract<EncoderRequest, { t: 'frame' }>
): Promise<{ codec: string; chunks: EncodedPicture[] }> {
  const { id, width, height, pixels } = request
  let key = request.key
  let entry = encoders.get(id)
  if (!entry || entry.width !== width || entry.height !== height || entry.result.error) {
    if (entry && entry.encoder.state !== 'closed') entry.encoder.close()
    entry = open(width, height)
    encoders.set(id, entry)
    key = true
  }
  const frame = new VideoFrame(pixels, {
    format: 'BGRA',
    codedWidth: width,
    codedHeight: height,
    timestamp: Math.round(performance.now() * 1000)
  })
  entry.result.out = []
  try {
    entry.encoder.encode(frame, { keyFrame: key })
  } finally {
    frame.close()
  }
  await entry.encoder.flush()
  if (entry.result.error) throw new Error(entry.result.error)
  return { codec: entry.codec, chunks: entry.result.out }
}

function close(id: number): void {
  const entry = encoders.get(id)
  encoders.delete(id)
  if (entry && entry.encoder.state !== 'closed') entry.encoder.close()
}

function serve(port: MessagePort): void {
  // Copied, not transferred: a message to the main process that transfers an
  // ArrayBuffer never arrives (Electron's MessagePortMain takes ports only).
  // What is copied is a few kilobytes a picture.
  const reply = (message: EncoderReply): void => port.postMessage(message)
  port.onmessage = (event: MessageEvent<EncoderRequest>) => {
    const request = event.data
    const before = queues.get(request.id) ?? Promise.resolve()
    const next = before.then(async () => {
      if (request.t === 'close') return close(request.id)
      try {
        const { codec, chunks } = await encode(request)
        reply({ t: 'encoded', id: request.id, seq: request.seq, codec, chunks })
      } catch (error) {
        close(request.id)
        reply({ t: 'failed', id: request.id, seq: request.seq, message: String(error) })
      }
    })
    queues.set(request.id, next)
    // The queue of a device that has left is let go once its last request is done.
    void next.then(() => {
      if (queues.get(request.id) === next && !encoders.has(request.id)) queues.delete(request.id)
    })
  }
  reply({ t: 'ready' })
}

// The preload hands over the port the main process talks on (preload/encoder.ts).
window.addEventListener('message', (event) => {
  if (event.data === 'encoder:port' && event.ports[0]) serve(event.ports[0])
})
