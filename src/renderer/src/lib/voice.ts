import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { errorMessage } from './errors'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

/**
 * Held longer than this, the mic button records until it is let go; right ⌘
 * held alone this long starts recording, so ⌘ shortcuts do not.
 */
const HOLD_MS = 250
/** Shorter recordings are dropped: nothing was said, and Whisper makes up words for silence. */
const MIN_RECORDING_MS = 500

/**
 * Voice input for the composer, push to talk: hold the mic button or right ⌘
 * while speaking, and on letting go the text Whisper heard goes to `onText`.
 * A click on the button records until the next click instead. A recording
 * still going when the composer goes away (another chat opened) is dropped.
 */
export function useVoiceInput(onText: (text: string) => void): {
  state: VoiceState
  error?: string
  /** The mic button went down. */
  press: () => void
  /** The mic button came up. */
  release: () => void
} {
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string>()
  const recorder = useRef<MediaRecorder>(undefined)
  /** From a start until the recorder runs or the start fails. */
  const starting = useRef(false)
  /** Let go before the recorder ran, as during the first microphone prompt: nothing is recorded. */
  const cancelled = useRef(false)
  const disposed = useRef(false)
  /** When the button press that started the recording went down. */
  const pressedAt = useRef<number>(undefined)
  /** Right ⌘ is down, alone so far, and will start recording once held long enough. */
  const keyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** The recording runs while right ⌘ is held. */
  const keyHeld = useRef(false)
  // The text comes back after a while; it goes to the composer as it is then.
  const latestOnText = useRef(onText)
  useEffect(() => {
    latestOnText.current = onText
  })

  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
      const current = recorder.current
      recorder.current = undefined
      current?.stop()
    }
  }, [])

  async function start(): Promise<void> {
    setState('recording')
    setError(undefined)
    starting.current = true
    cancelled.current = false
    try {
      if (!(await window.api.voice.keyHint())) {
        throw new Error('Add a Groq API key under Voice input in Settings (⌘,).')
      }
      if (!(await window.api.voice.microphone())) {
        throw new Error(
          'Barebone may not use the microphone. Allow it in System Settings, Privacy & Security, Microphone.'
        )
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (disposed.current || cancelled.current) {
        stream.getTracks().forEach((track) => track.stop())
        if (!disposed.current) setState('idle')
        return
      }
      const started = new MediaRecorder(stream)
      let startedAt = 0
      const chunks: Blob[] = []
      started.onstart = (e) => (startedAt = e.timeStamp)
      started.ondataavailable = (e) => chunks.push(e.data)
      started.onstop = (e) => {
        stream.getTracks().forEach((track) => track.stop())
        // Dropped: the composer went away.
        if (recorder.current !== started) return
        recorder.current = undefined
        if (e.timeStamp - startedAt < MIN_RECORDING_MS) return setState('idle')
        write(new Blob(chunks, { type: started.mimeType }))
      }
      started.start()
      recorder.current = started
    } catch (e) {
      setError(errorMessage(e))
      setState('idle')
    } finally {
      starting.current = false
    }
  }

  function stop(): void {
    if (recorder.current) recorder.current.stop()
    else if (starting.current) cancelled.current = true
  }

  async function write(audio: Blob): Promise<void> {
    setState('transcribing')
    try {
      const bytes = new Uint8Array(await audio.arrayBuffer())
      const text = await window.api.voice.transcribe(bytes, audio.type)
      if (text && !disposed.current) latestOnText.current(text)
    } catch (e) {
      if (!disposed.current) setError(errorMessage(e))
    } finally {
      if (!disposed.current) setState('idle')
    }
  }

  function press(): void {
    // A second click ends a recording started by a click, or by right ⌘.
    if (state === 'recording') return stop()
    if (state !== 'idle') return
    pressedAt.current = Date.now()
    start()
  }

  function release(): void {
    const at = pressedAt.current
    pressedAt.current = undefined
    // A click records until the next one; a hold, until it ends.
    if (at !== undefined && Date.now() - at >= HOLD_MS) stop()
  }

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.code === 'MetaRight' && !e.repeat) {
      if (state !== 'idle') return
      keyTimer.current = setTimeout(() => {
        keyTimer.current = undefined
        keyHeld.current = true
        start()
      }, HOLD_MS)
    } else if (keyTimer.current) {
      // Right ⌘ with another key: a shortcut.
      clearTimeout(keyTimer.current)
      keyTimer.current = undefined
    }
  })

  /** Right ⌘ let go, or the window left while it was held (its keyup then never comes). */
  const onKeyRelease = useEffectEvent(() => {
    clearTimeout(keyTimer.current)
    keyTimer.current = undefined
    if (!keyHeld.current) return
    keyHeld.current = false
    stop()
  })

  useEffect(() => {
    const down = (e: KeyboardEvent): void => onKeyDown(e)
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'MetaRight') onKeyRelease()
    }
    const blur = (): void => onKeyRelease()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      clearTimeout(keyTimer.current)
    }
  }, [])

  return { state, error, press, release }
}
