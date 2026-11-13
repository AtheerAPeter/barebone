import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Package } from './downloads'

/**
 * ffmpeg, downloaded when the user asks for it in Settings, gives every video
 * an agent records a thumbnail: its best still frame, saved as a JPEG beside
 * it and put in as the video's first frame, so every player and site that
 * shows a video by its first frame shows that one.
 */

/**
 * ffmpeg 9.0.2, built by Martin Riedl (ffmpeg.martin-riedl.de): for Apple
 * Silicon (signed) on the Mac, for x64 on Linux.
 */
const FFMPEG =
  process.platform === 'linux'
    ? {
        url: 'https://ffmpeg.martin-riedl.de/download/linux/amd64/1789931100_9.0.2/ffmpeg.zip',
        path: 'ffmpeg.zip',
        size: 33326445,
        sha256: 'fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f',
        archive: { kind: 'zip' as const, unpacked: 'ffmpeg' }
      }
    : {
        url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip',
        path: 'ffmpeg.zip',
        size: 28395699,
        sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924',
        archive: { kind: 'zip' as const, unpacked: 'ffmpeg' }
      }

const run = promisify(execFile)

export class VideoTools {
  readonly ffmpeg: Package

  constructor(changed: () => void) {
    this.ffmpeg = new Package('downloads/ffmpeg-9.0.2', [FFMPEG], 'ffmpeg', changed)
  }

  /**
   * Give a video its thumbnail: the frame `at` milliseconds in, as a JPEG
   * beside it (its name with .jpg), and as its first frame, in place of the
   * one there so its length and sound stay as they were. Resolves with the
   * JPEG's path, or undefined when ffmpeg is not on this Mac.
   */
  async thumbnail(video: string, at: number): Promise<string | undefined> {
    if (!this.ffmpeg.ready()) return undefined
    const ffmpeg = join(this.ffmpeg.dir, 'ffmpeg')
    // Never over a file that is there already.
    const jpeg = [
      video.replace(/\.mp4$/i, '.jpg'),
      video.replace(/\.mp4$/i, '.thumbnail.jpg')
    ].find((path) => !existsSync(path))
    if (!jpeg) throw new Error(`${video.replace(/\.mp4$/i, '.jpg')} exists already`)
    const seconds = (Math.max(0, at) / 1000).toFixed(3)
    await run(ffmpeg, [
      '-v',
      'error',
      '-n',
      '-ss',
      seconds,
      '-i',
      video,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      jpeg
    ])
    // Made in a folder of its own beside it, then moved over it: no other file is touched.
    const work = await mkdtemp(join(dirname(video), '.thumbnail-'))
    const out = join(work, 'video.mp4')
    try {
      await run(ffmpeg, [
        '-v', 'error', '-y',
        '-i', video,
        '-i', jpeg,
        // The still over the first frame only, scaled to the video's size.
        '-filter_complex', "[1:v][0:v]scale2ref[still][video];[video][still]overlay=enable='eq(n,0)'[v]",
        '-map', '[v]', '-map', '0:a?',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        out
      ]) // prettier-ignore
      await rename(out, video)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
    return jpeg
  }
}
