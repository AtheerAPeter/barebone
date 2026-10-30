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

/**
 * Records browser tabs as main asks (main/recording.ts), with what the chat
 * says (`tap`) as the sound, and sends the file to main as it is made.
 */
export function usePageRecorder(tap: (chatId: string) => VoiceTap): void {
  useEffect(() => {
    const recorders = new Map<string, MediaRecorder>()
    /** Starting, and of those, the ones asked to stop meanwhile. */
    const starting = new Set<string>()
    const stopped = new Set<string>()

    const offStart = window.api.recording.onStart(async (request) => {
      let page: MediaStream | undefined
      let voice: VoiceTap | undefined
      starting.add(request.id)
      try {
        if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
          throw new Error('This version of Barebone cannot record MP4 video.')
        }
        page = await captureTab(request)
        voice = tap(request.chatId)
        const [track] = page.getVideoTracks()
        const { width = 0, height = 0 } = track.getSettings()
        const recorder = new MediaRecorder(
          new MediaStream([track, ...voice.stream.getAudioTracks()]),
          {
            mimeType: MIME_TYPE,
            videoBitsPerSecond: Math.round(width * height * FRAME_RATE * BITS_PER_PIXEL)
          }
        )
        const tracks = page.getTracks()
        const tapped = voice
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
          for (const t of tracks) t.stop()
          tapped.close()
          void sending.then(() => window.api.recording.ended(request.id, failure))
        }
        // A tab that closes ends its track, and the recording with it.
        track.onended = () => {
          if (recorder.state !== 'inactive') recorder.stop()
        }
        recorder.start(SLICE_MS)
        recorders.set(request.id, recorder)
        window.api.recording.started(request.id)
        if (stopped.has(request.id)) recorder.stop()
      } catch (error) {
        for (const t of page?.getTracks() ?? []) t.stop()
        voice?.close()
        window.api.recording.failed(request.id, errorMessage(error))
      } finally {
        starting.delete(request.id)
        stopped.delete(request.id)
      }
    })

    const offStop = window.api.recording.onStop((id) => {
      const recorder = recorders.get(id)
      if (recorder?.state === 'recording') recorder.stop()
      else if (starting.has(id)) stopped.add(id)
    })

    return () => {
      offStart()
      offStop()
      for (const recorder of recorders.values()) recorder.stop()
    }
  }, [tap])
}
