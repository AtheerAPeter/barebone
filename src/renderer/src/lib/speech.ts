import { useEffect, useRef, useState } from 'react'
import type { SpokenAudio } from '../../../shared/types'

/** What is being said now: by which chat (none for a sample from Settings), and the words. */
export interface Speaking {
  chatId?: string
  text: string
}

/** Between the pieces of a message, as the engine makes them, so playback has started before the next is done. */
const LEAD_S = 0.05
/** The loudness range the level spans, as for the microphone (lib/voice.ts). */
const QUIET_DB = -50
const LOUD_DB = -10

/**
 * Plays what agents say (main/speech): each piece of a message right after the
 * one before, so a message plays as one. `speaking` is what plays now;
 * `level` holds how loud it is, 0 to 1, for visuals that redraw every frame.
 */
export function useSpeechPlayer(): { speaking?: Speaking; level: React.RefObject<number> } {
  const [speaking, setSpeaking] = useState<Speaking>()
  const level = useRef(0)

  useEffect(() => {
    /** Made with the first piece: the analyser measures what plays on its way out. */
    let output: { context: AudioContext; analyser: AnalyserNode } | undefined
    /** Pieces scheduled and not yet ended, in order. */
    let playing: { source: AudioBufferSourceNode; speaking: Speaking }[] = []
    let endsAt = 0
    let frame = 0

    const measure = (): void => {
      if (!output) return
      const { analyser } = output
      const samples = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(samples)
      let power = 0
      for (const sample of samples) power += sample * sample
      const db = 10 * Math.log10(power / samples.length || 1e-10)
      level.current = Math.min(1, Math.max(0, (db - QUIET_DB) / (LOUD_DB - QUIET_DB)))
      frame = requestAnimationFrame(measure)
    }

    const offAudio = window.api.speech.onAudio((audio: SpokenAudio) => {
      if (!output) {
        const context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.connect(context.destination)
        output = { context, analyser }
      }
      const { context, analyser } = output
      const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate)
      buffer.copyToChannel(new Float32Array(audio.samples), 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(analyser)
      const startAt = Math.max(context.currentTime + LEAD_S, endsAt)
      source.start(startAt)
      endsAt = startAt + buffer.duration
      const piece = {
        source,
        speaking: { ...(audio.chatId ? { chatId: audio.chatId } : {}), text: audio.text }
      }
      playing.push(piece)
      if (playing.length === 1) {
        setSpeaking(piece.speaking)
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(measure)
      }
      source.onended = () => {
        playing = playing.filter((p) => p !== piece)
        if (playing[0]) {
          setSpeaking(playing[0].speaking)
        } else {
          setSpeaking(undefined)
          cancelAnimationFrame(frame)
          level.current = 0
        }
      }
    })

    const offStop = window.api.speech.onStop((chatId) => {
      const stopping = playing.filter((p) => chatId === null || p.speaking.chatId === chatId)
      // What plays after the stopped pieces moves up to now.
      for (const piece of stopping) piece.source.stop()
      if (stopping.length === playing.length) endsAt = 0
    })

    return () => {
      offAudio()
      offStop()
      cancelAnimationFrame(frame)
      void output?.context.close()
    }
  }, [])

  return { speaking, level }
}
