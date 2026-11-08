import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * The few parts of the Telegram Bot API (core.telegram.org/bots/api) the
 * bridge uses, over fetch. Telegram answers every method with
 * `{ ok, result }` or `{ ok: false, error_code, description }`; a 429 says
 * how long to wait (`parameters.retry_after`), and the call is made again then.
 */

const API = 'https://api.telegram.org'

/** The longest a 429 is waited out; past that the call fails. */
const MAX_RETRY_AFTER_S = 60

export class TelegramError extends Error {
  constructor(
    message: string,
    /** Telegram's error_code, or the HTTP status when the answer was not Telegram's. */
    readonly code: number
  ) {
    super(message)
  }
}

export interface TelegramUser {
  id: number
  username?: string
  first_name: string
  /** Whether topics are on in the bot's private chats (BotFather's Threaded Mode); getMe only. */
  has_topics_enabled?: boolean
}

export interface TelegramMessage {
  message_id: number
  /** When it was sent, in seconds since the epoch. */
  date: number
  chat: { id: number; type: string }
  /** The topic it is in, in a private chat with topics on. */
  message_thread_id?: number
  /** Set on the message that tells a topic was made: the user made it, or the bot. */
  forum_topic_created?: { name: string }
  from?: TelegramUser
  text?: string
  caption?: string
  photo?: { file_id: string; file_size?: number; width: number; height: number }[]
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  voice?: { file_id: string; mime_type?: string; file_size?: number }
  audio?: { file_id: string; mime_type?: string; file_size?: number; file_name?: string }
  reply_to_message?: { message_id: number }
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: {
    id: string
    from: TelegramUser
    data?: string
    message?: { message_id: number; chat: { id: number }; message_thread_id?: number }
  }
  /** The user pressed Stop on a draft the bot was streaming. */
  stopped_message_generation?: {
    chat: { id: number }
    message_thread_id?: number
    draft_id: number
  }
}

/** A button under a message: `data` comes back in a callback query when it is tapped. */
export interface InlineButton {
  text: string
  callback_data: string
  /** Its color: green, red or blue. */
  style?: 'success' | 'danger' | 'primary'
}

type Answer<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } }

export class BotApi {
  constructor(private readonly token: string) {}

  /** Call a method with JSON parameters. */
  call<T>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
    return this.request<T>(
      method,
      () => ({
        body: JSON.stringify(params),
        headers: { 'content-type': 'application/json' }
      }),
      signal
    )
  }

  /** Call a method that sends a file, as multipart form data. */
  upload<T>(method: string, field: string, path: string, params: object = {}): Promise<T> {
    return this.request<T>(method, async () => {
      const form = new FormData()
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
        }
      }
      form.append(field, await openAsBlob(path), basename(path))
      return { body: form }
    })
  }

  /** A file a message carries (a photo, a voice note), by its file_id; getFile serves up to 20 MB. */
  async download(fileId: string): Promise<Buffer> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new TelegramError('Telegram gave no path for the file.', 0)
    const response = await fetch(`${API}/file/bot${this.token}/${file.file_path}`)
    if (!response.ok) {
      throw new TelegramError(`The file could not be downloaded (HTTP ${response.status}).`, 0)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  private async request<T>(
    method: string,
    body: () => Promise<RequestInit> | RequestInit,
    signal?: AbortSignal
  ): Promise<T> {
    for (;;) {
      const response = await fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        ...(await body()),
        signal
      })
      let answer: Answer<T>
      try {
        answer = (await response.json()) as Answer<T>
      } catch {
        throw new TelegramError(`Telegram answered HTTP ${response.status}.`, response.status)
      }
      if (answer.ok) return answer.result
      const wait = answer.parameters?.retry_after
      if (answer.error_code === 429 && wait !== undefined && wait <= MAX_RETRY_AFTER_S) {
        await sleep(wait * 1000, undefined, { signal })
        continue
      }
      throw new TelegramError(answer.description, answer.error_code)
    }
  }
}
