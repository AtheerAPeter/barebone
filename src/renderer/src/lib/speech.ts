import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpeechStop, SpokenAudio } from '../../../shared/types'

/** What is being said now: by which chat (none for a sample from Settings), and the words. */
export interface Speaking {
  chatId?: string
  text: string
}

/** What one chat says, as a stream to record (lib/recording.ts); silent between messages. */
export interface VoiceTap {
  stream: MediaStream
  close(): void
}

/** A piece of a message: a sentence or a few. */
interface Sound {
  id: string
  /** The message's first piece: the message begins when it does. */
  first: boolean
  /** Its last: the message ends when it does. */
  last: boolean
  buffer: AudioBuffer
  speaking: Speaking
}

/** A piece scheduled to play at `startAt`. */
interface Piece extends Sound {
  source: AudioBufferSourceNode
  startAt: number
  /** A first piece's cue: main is told its message begins. */
  cue?: ReturnType<typeof setTimeout>
}

/** Between the pieces of a message, as the engine makes them, so playback has started before the next is done. */
const LEAD_S = 0.05
/** Silence between two messages, as a person pauses between things they say. */
const PAUSE_S = 0.8
/**
 * How long before a message's voice main is told it begins: what is shown with
 * it (a tutorial step) appears a moment before the voice talks about it.
 */
const CUE_S = 0.4
/** The loudness range the level spans, as for the microphone (lib/voice.ts). */
const QUIET_DB = -50
const LOUD_DB = -10

/**
 * Plays what agents say (main/speech): each piece of a message right after the
 * one before, so a message plays as one, with a pause between messages. Tells
 * main when a message is about to begin and when it ended, for what is shown
 * with it. `speaking` is what plays now or next; `level` holds how loud it is,
 * 0 to 1, for visuals that redraw every frame. `tap` gives what a chat says as
 * a stream, for a video it records.
 */
export function useSpeechPlayer(): {
  speaking?: Speaking
  level: React.RefObject<number>
  tap: (chatId: string) => VoiceTap
} {
  const [speaking, setSpeaking] = useState<Speaking>()
  const level = useRef(0)
  const tapper = useRef<(chatId: string) => VoiceTap>(undefined)

  useEffect(() => {
    /** Made with the first piece, or tap: the analyser measures what plays on its way out. */
    let output: { context: AudioContext; analyser: AnalyserNode } | undefined
    const ensureOutput = (): NonNullable<typeof output> => {
      if (!output) {
        const context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.connect(context.destination)
        output = { context, analyser }
      }
      return output
    }
    /** Where each chat's voice is recorded too, by chat id. */
    const taps = new Map<string, Set<MediaStreamAudioDestinationNode>>()
    /** Pieces scheduled and not yet ended, in order; the first plays now or is about to. */
    let queue: Piece[] = []
    /** Messages with a piece here already, until their last piece. */
    const arrived = new Set<string>()
    /** When the last piece scheduled ends, on the context's clock; it may have ended already. */
    let lastEnd = -Infinity
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

    /** A piece is at the head of the queue: it plays now, or after a pause. */
    const begin = (piece: Piece): void => setSpeaking(piece.speaking)

    const quiet = (): void => {
      setSpeaking(undefined)
      cancelAnimationFrame(frame)
      level.current = 0
    }

    /** When a piece can start: right after the one before it, or a pause after it for a new message. */
    const startFor = (context: AudioContext, first: boolean): number =>
      first
        ? Math.max(context.currentTime + CUE_S, lastEnd + PAUSE_S)
        : Math.max(context.currentTime + LEAD_S, lastEnd)

    const schedule = (
      { context, analyser }: NonNullable<typeof output>,
      sound: Sound,
      at: number
    ): Piece => {
      const source = context.createBufferSource()
      source.buffer = sound.buffer
      source.connect(analyser)
      const chatId = sound.speaking.chatId
      if (chatId) for (const tap of taps.get(chatId) ?? []) source.connect(tap)
      const piece: Piece = { ...sound, source, startAt: at }
      if (sound.first) {
        const notice = Math.max(0, (at - CUE_S - context.currentTime) * 1000)
        piece.cue = setTimeout(() => window.api.speech.begun(sound.id), notice)
      }
      lastEnd = at + sound.buffer.duration
      source.onended = () => {
        if (piece.last) window.api.speech.ended(piece.id)
        const head = queue[0] === piece
        queue = queue.filter((p) => p !== piece)
        // The next piece starts as this one ends.
        if (!queue[0]) quiet()
        else if (head) begin(queue[0])
      }
      source.start(at)
      return piece
    }

    /** Silence a piece without it counting as having played to its end. */
    const silence = (piece: Piece): void => {
      clearTimeout(piece.cue)
      piece.source.onended = null
      piece.source.stop()
    }

    tapper.current = (chatId) => {
      const { context } = ensureOutput()
      const tap = context.createMediaStreamDestination()
      const chatTaps = taps.get(chatId) ?? new Set()
      taps.set(chatId, chatTaps.add(tap))
      // What the chat is saying already is in it from here on.
      for (const piece of queue) if (piece.speaking.chatId === chatId) piece.source.connect(tap)
      return {
        stream: tap.stream,
        close: () => {
          chatTaps.delete(tap)
          if (!chatTaps.size) taps.delete(chatId)
          for (const piece of queue) {
            if (piece.speaking.chatId === chatId) piece.source.disconnect(tap)
          }
        }
      }
    }

    const offAudio = window.api.speech.onAudio((audio: SpokenAudio) => {
      const playing = ensureOutput()
      const { context } = playing
      const buffer = context.createBuffer(1, audio.samples.length, audio.sampleRate)
      buffer.copyToChannel(new Float32Array(audio.samples), 0)
      const sound = {
        id: audio.id,
        first: !arrived.has(audio.id),
        last: audio.last,
        buffer,
        speaking: { ...(audio.chatId ? { chatId: audio.chatId } : {}), text: audio.text }
      }
      if (audio.last) arrived.delete(audio.id)
      else arrived.add(audio.id)
      const piece = schedule(playing, sound, startFor(context, sound.first))
      queue.push(piece)
      if (queue.length === 1) {
        begin(piece)
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(measure)
      }
    })

    const offStop = window.api.speech.onStop((which: SpeechStop) => {
      if (!output) return
      const playing = output
      const { context } = playing
      const stops = (piece: Piece): boolean =>
        which.id !== undefined
          ? piece.id === which.id
          : which.chatId === undefined || piece.speaking.chatId === which.chatId
      const head = queue[0]
      const stopping = queue.filter(stops)
      if (!stopping.length) return
      for (const piece of stopping) silence(piece)
      const kept = queue.filter((piece) => !stops(piece))
      // What was to play after the stopped pieces moves up, to right after what plays now.
      queue = []
      lastEnd = context.currentTime
      for (const piece of kept) {
        const at = startFor(context, piece.first)
        if (piece.startAt <= at) {
          queue.push(piece)
          lastEnd = piece.startAt + piece.buffer.duration
        } else {
          silence(piece)
          queue.push(schedule(playing, piece, at))
        }
      }
      if (!queue[0]) quiet()
      else if (queue[0] !== head) begin(queue[0])
    })

    return () => {
      tapper.current = undefined
      offAudio()
      offStop()
      for (const piece of queue) clearTimeout(piece.cue)
      cancelAnimationFrame(frame)
      void output?.context.close()
    }
  }, [])

  const tap = useCallback((chatId: string) => {
    if (!tapper.current) throw new Error('The voice player is not running.')
    return tapper.current(chatId)
  }, [])

  return { speaking, level, tap }
}
