import { app, systemPreferences } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Voice input: what the composer records is written out by Whisper on Groq
 * (whisper-large-v3-turbo), which detects the language spoken, Arabic,
 * English, German and many more. It takes the user's own Groq API key, free
 * from console.groq.com, kept as the Exa key is (exa-key.ts): in its own file,
 * readable only by the user, and never sent to the window, which only sees its
 * last characters.
 */

const keyPath = join(app.getPath('userData'), 'data', 'voice.json')

const GROQ_URL = 'https://api.groq.com/openai/v1'
const MODEL = 'whisper-large-v3-turbo'
/** A recording of a minute or two uploads in seconds; this is for a stalled connection. */
const TIMEOUT_MS = 60_000

let key = load()

function load(): string | undefined {
  if (!existsSync(keyPath)) return undefined
  try {
    const { apiKey } = JSON.parse(readFileSync(keyPath, 'utf8')) as { apiKey?: unknown }
    return typeof apiKey === 'string' && apiKey ? apiKey : undefined
  } catch (error) {
    console.error(`${keyPath} could not be read:`, (error as Error).message)
    return undefined
  }
}

/** The saved key's last four characters, for telling keys apart; null when none is saved. */
export function voiceKeyHint(): string | null {
  return key ? key.slice(-4) : null
}

/** Save a key, or remove the saved one (null). Returns the new hint. */
export function setVoiceKey(value: string | null): string | null {
  const trimmed = value?.trim()
  if (value !== null && !trimmed) throw new Error('Enter a Groq API key.')
  if (trimmed) {
    mkdirSync(dirname(keyPath), { recursive: true })
    writeFileSync(keyPath, JSON.stringify({ apiKey: trimmed }), { mode: 0o600 })
  } else {
    rmSync(keyPath, { force: true })
  }
  key = trimmed
  return voiceKeyHint()
}

/**
 * Whether the app may use the microphone. macOS asks the user the first time,
 * and answers with that choice after; elsewhere the system does not ask apps.
 */
export async function microphoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  return systemPreferences.askForMediaAccess('microphone')
}

/** The text spoken in a recording, in the language it was spoken in. */
export async function transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
  if (!key) throw new Error('Add a Groq API key under Voice input in Settings (⌘,).')
  const { default: Client, APIError, toFile } = await import('openai')
  const client = new Client({
    apiKey: key,
    // Left unset, these are read from the environment and sent to Groq (see wire.ts).
    adminAPIKey: null,
    organization: null,
    project: null,
    baseURL: GROQ_URL,
    timeout: TIMEOUT_MS
  })
  // Groq tells the format by the file's extension: "audio/webm;codecs=opus" is a .webm.
  const extension = mimeType.split(';')[0].split('/')[1] || 'webm'
  try {
    const { text } = await client.audio.transcriptions.create({
      file: await toFile(audio, `speech.${extension}`, { type: mimeType }),
      model: MODEL
    })
    return text.trim()
  } catch (error) {
    if (error instanceof APIError && error.status === 401) {
      throw new Error('Groq did not accept the key. Check it under Voice input in Settings (⌘,).')
    }
    throw new Error(`Groq could not write out the recording: ${(error as Error).message}`)
  }
}
