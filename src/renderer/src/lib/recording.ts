import { useEffect } from 'react'
import type { RecordingRequest } from '../../../shared/types'
import { errorMessage } from './errors'
import type { VoiceTap } from './speech'

/** H.264 video with AAC sound, in an MP4 file every player opens. */
const MIME_TYPE = 'video/mp4;codecs=avc1,mp4a.40.2'
const FRAME_RATE = 30
/** Video bits per pixel and frame: text stays sharp, as pages change little between frames. */
const BITS_PER_PIXEL = 0.08
/** How often a piece of the file goes to main, which writes it as it comes. */
const SLICE_MS = 1000

/** H.264 takes even sizes. */
const even = (pixels: number): number => Math.max(2, Math.round(pixels / 2) * 2)

/**
 * Chromium's constraints for capturing a tab, which the standard types leave
 * out. A minimum equal to the maximum keeps the size: when the panel is
 * resized, the page is scaled and letterboxed into it.
 */
interface TabCapture {
  mandatory: {
    chromeMediaSource: 'tab'
    chromeMediaSourceId: string
    minWidth: number
    maxWidth: number
    minHeight: number
    maxHeight: number
    maxFrameRate: number
  }
}

/** The page of a tab, at its size now in device pixels. */
function captureTab(request: RecordingRequest): Promise<MediaStream> {
  const width = even(request.width * devicePixelRatio)
  const height = even(request.height * devicePixelRatio)
  const video: TabCapture = {
    mandatory: {
      chromeMediaSource: 'tab',
      chromeMediaSourceId: request.sourceId,
      minWidth: width,
      maxWidth: width,
      minHeight: height,
      maxHeight: height,
      maxFrameRate: FRAME_RATE
    }
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: video as MediaTrackConstraints
  })
}

/** The music's loudness while the voice talks, and between its words. */
const MUSIC_UNDER_VOICE = 0.07
const MUSIC_ALONE = 0.2
/** The voice's level above which it counts as talking, as the music ducks under it. */
const VOICE_TALKING = 0.01
/** How fast the music ducks and comes back, in seconds; how long it fades in and out. */
const DUCK_S = 0.12
const FADE_S = 0.8

/** The video's sound: the voice, with music under it. */
interface Mix {
  stream: MediaStream
  /** The music stops where it is while the recording pauses, and goes on from there. */
  pause(): void
  resume(): void
  /** Fade the music out; resolves once it has. */
  fadeOut(): Promise<void>
  close(): void
}

/**
 * The voice with music on a loop under it, quieter while the voice talks (so
 * the words stay clear), fading in at the start and out at the end.
 */
async function mixMusic(voice: MediaStream, music: Uint8Array): Promise<Mix> {
  const context = new AudioContext()
  const out = context.createMediaStreamDestination()
  const spoken = context.createMediaStreamSource(voice)
  spoken.connect(out)
  const meter = context.createAnalyser()
  meter.fftSize = 1024
  spoken.connect(meter)
  const buffer = await context.decodeAudioData(music.slice().buffer).catch(() => {
    void context.close()
    throw new Error('The music could not be read: give a WAV, MP3, M4A or OGG file.')
  })
  const gain = context.createGain()
  gain.gain.value = 0
  gain.connect(out)
  let source: AudioBufferSourceNode | undefined
  /** Where in the music it is, while it is stopped; when it began, while it plays. */
  let offset = 0
  let startedAt = 0
  const play = (): void => {
    source = context.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.connect(gain)
    source.start(0, offset % buffer.duration)
    startedAt = context.currentTime - offset
  }
  play()
  gain.gain.setTargetAtTime(MUSIC_ALONE, context.currentTime, FADE_S / 3)
  // Under the voice while it talks: its level, read a few times a second.
  const levels = new Float32Array(meter.fftSize)
  let talking = false
  const duck = setInterval(() => {
    meter.getFloatTimeDomainData(levels)
    let sum = 0
    for (const v of levels) sum += v * v
    const now = Math.sqrt(sum / levels.length) > VOICE_TALKING
    if (now === talking || !source) return
    talking = now
    gain.gain.setTargetAtTime(now ? MUSIC_UNDER_VOICE : MUSIC_ALONE, context.currentTime, DUCK_S)
  }, 50)
  return {
    stream: out.stream,
    pause() {
      if (!source) return
      offset = context.currentTime - startedAt
      source.stop()
      source = undefined
    },
    resume() {
      if (!source) play()
    },
    async fadeOut() {
      if (!source) return
      // The voice no longer moves it: the fade goes all the way.
      clearInterval(duck)
      gain.gain.cancelScheduledValues(context.currentTime)
      gain.gain.setValueAtTime(gain.gain.value, context.currentTime)
      gain.gain.linearRampToValueAtTime(0, context.currentTime + FADE_S)
      await new Promise((resolve) => setTimeout(resolve, FADE_S * 1000))
    },
    close() {
      clearInterval(duck)
      source?.stop()
      void context.close()
    }
  }
}

/**
 * Records browser tabs as main asks (main/recording.ts), with what the chat
 * says (`tap`) as the sound, and music under it when main gives some, and
 * sends the file to main as it is made.
 */
export function usePageRecorder(tap: (chatId: string) => VoiceTap): void {
  useEffect(() => {
    const recorders = new Map<string, MediaRecorder>()
    /** The music under a recording's voice, when it has some. */
    const mixes = new Map<string, Mix>()
    /** Starting, and of those, the ones asked to stop meanwhile. */
    const starting = new Set<string>()
    const stopped = new Set<string>()

    const offStart = window.api.recording.onStart(async (request) => {
      let page: MediaStream | undefined
      let voice: VoiceTap | undefined
      let mix: Mix | undefined
      starting.add(request.id)
      try {
        if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
          throw new Error('This version of Barebone cannot record MP4 video.')
        }
        page = await captureTab(request)
        voice = tap(request.chatId)
        if (request.music) mix = await mixMusic(voice.stream, request.music)
        const sound = mix?.stream ?? voice.stream
        const [track] = page.getVideoTracks()
        const { width = 0, height = 0 } = track.getSettings()
        const recorder = new MediaRecorder(new MediaStream([track, ...sound.getAudioTracks()]), {
          mimeType: MIME_TYPE,
          videoBitsPerSecond: Math.round(width * height * FRAME_RATE * BITS_PER_PIXEL)
        })
        const tracks = page.getTracks()
        const tapped = voice
        const mixed = mix
        // In order: reading a piece is asynchronous, and the next may be read first.
        let sending = Promise.resolve()
        let failure: string | undefined
        recorder.ondataavailable = ({ data }) => {
          sending = sending.then(async () =>
            window.api.recording.data(request.id, new Uint8Array(await data.arrayBuffer()))
          )
        }
        recorder.onerror = (event) => {
          failure = errorMessage((event as ErrorEvent).error ?? event)
        }
        recorder.onstop = () => {
          recorders.delete(request.id)
          mixes.delete(request.id)
          for (const t of tracks) t.stop()
          mixed?.close()
          tapped.close()
          void sending.then(() => window.api.recording.ended(request.id, failure))
        }
        // A tab that closes ends its track, and the recording with it.
        track.onended = () => {
          if (recorder.state !== 'inactive') recorder.stop()
        }
        recorder.start(SLICE_MS)
        recorders.set(request.id, recorder)
        if (mix) mixes.set(request.id, mix)
        window.api.recording.started(request.id)
        if (stopped.has(request.id)) recorder.stop()
      } catch (error) {
        for (const t of page?.getTracks() ?? []) t.stop()
        mix?.close()
        voice?.close()
        window.api.recording.failed(request.id, errorMessage(error))
      } finally {
        starting.delete(request.id)
        stopped.delete(request.id)
      }
    })

    const offStop = window.api.recording.onStop(async (id) => {
      const recorder = recorders.get(id)
      if (recorder?.state === 'recording') {
        // The music fades out rather than stopping mid-note.
        await mixes.get(id)?.fadeOut()
        // It may have ended meanwhile: its tab closed.
        if ((recorder.state as RecordingState) !== 'inactive') recorder.stop()
      } else if (recorder?.state === 'paused') recorder.stop()
      else if (starting.has(id)) stopped.add(id)
    })

    // A paused recording leaves the time out of the video: it goes on where it paused.
    const offPause = window.api.recording.onPause((id) => {
      const recorder = recorders.get(id)
      if (recorder?.state === 'recording') {
        recorder.pause()
        mixes.get(id)?.pause()
      }
    })
    const offResume = window.api.recording.onResume((id) => {
      const recorder = recorders.get(id)
      if (recorder?.state === 'paused') {
        mixes.get(id)?.resume()
        recorder.resume()
      }
    })

    return () => {
      offStart()
      offStop()
      offPause()
      offResume()
      for (const recorder of recorders.values()) recorder.stop()
    }
  }, [tap])
}
