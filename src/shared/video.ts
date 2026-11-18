/**
 * The browser tab as H.264 video over the remote link: the main process
 * pictures the page (main/page-driver.ts) and hands the pixels to a hidden
 * page that encodes them with WebCodecs (renderer/src/encoder,
 * main/remote/video-encoder.ts); a device decodes them with WebCodecs too
 * (renderer/src/remote/BrowserSheet.tsx). Video sends only what changed, so a
 * picture is a few kilobytes, where a JPEG of it is hundreds.
 */

/** To the encoder's page. */
export type EncoderRequest =
  /** Encode a picture: BGRA pixels, `width` by `height` (both even). */
  | {
      t: 'frame'
      id: number
      seq: number
      width: number
      height: number
      key: boolean
      pixels: Uint8Array
    }
  /** The device stopped watching: let its encoder go. */
  | { t: 'close'; id: number }

/** From the encoder's page. */
export type EncoderReply =
  | { t: 'ready' }
  /** What a picture was encoded to: none when the encoder dropped it. */
  | { t: 'encoded'; id: number; seq: number; codec: string; chunks: EncodedPicture[] }
  | { t: 'failed'; id: number; seq: number; message: string }

export interface EncodedPicture {
  /** Annex B: start codes before each part, and a keyframe carries its own parameters. */
  data: Uint8Array
  key: boolean
}

/** The H.264 levels, by the most macroblocks (16 by 16 pixels) a picture may have. */
const LEVELS: [maxMacroblocks: number, level: number][] = [
  [1620, 0x1e], // 3.0
  [3600, 0x1f], // 3.1
  [5120, 0x20], // 3.2
  [8192, 0x28], // 4.0
  [8704, 0x2a], // 4.2
  [22080, 0x32], // 5.0
  [36864, 0x33] // 5.1
]

/**
 * The codec for a picture of this size: Constrained Baseline, which every
 * phone decodes in hardware, at the lowest level that holds it.
 */
export function h264Codec(width: number, height: number): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  const level = (LEVELS.find(([max]) => macroblocks <= max) ?? LEVELS[LEVELS.length - 1])[1]
  return `avc1.42e0${level.toString(16).padStart(2, '0')}`
}

/** What a device asks to decode, to know whether it can: a phone-sized picture. */
export const PROBE_CODEC = h264Codec(1290, 2796)
