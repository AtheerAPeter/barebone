import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  AGENTS,
  formDefaults,
  modelOptions,
  type AgentOption,
  type Attachment,
  type Chat,
  type ChatItem,
  type FormAnswers,
  type TelegramStatus
} from '../../shared/types'
import type { TurnEnd } from '../agents'
import { formContent } from '../forms'
import { chatImagePath } from '../images'
import type { Recorded } from '../recording'
import * as store from '../store'
import { transcribe } from '../voice'
import {
  BotApi,
  TelegramError,
  type InlineButton,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser
} from './api'
import { telegramConfig, telegramTokenHint, updateTelegramConfig } from './config'
import {
  attribute,
  escapeHtml,
  markdownMessages,
  plainMessages,
  stepsMessage,
  workerCard,
  type CardState,
  type OutText,
  type Progress
} from './format'

/**
 * Control from Telegram: a bot the user made with @BotFather carries one of
 * their chats, the linked one, to their phone. What they write to the bot goes
 * to that chat; its answers come back, each run of its tool calls as one
 * message that keeps up with them. The chats it starts (`@chats`) get a card
 * each, edited in place: what they do now, their subagents, their last steps.
 * Questions any of them ask (permissions, forms) come as buttons, and their
 * screenshots and videos as media.
 *
 * The bot reads its messages with getUpdates (long polling), so nothing on the
 * Mac listens for connections. It answers only the Telegram user who paired
 * with it, by opening the link Settings shows, which sends it a secret.
 */

/** A message that reaches the bot this much after it was sent waits for the user's go. */
const LATE_S = 60

/** The least time between two calls that send to the chat: Telegram allows about one a second. */
const CALL_GAP_MS = 1000

/** How often a card or a steps message is edited, at most. */
const EDIT_EVERY_MS = 2500

/** How often a streamed answer's draft is updated. */
const DRAFT_EVERY_MS = 1000

/** Telegram's limits for what bots download and send. */
const MAX_DOWNLOAD = 20 * 1024 * 1024
const MAX_PHOTO = 10 * 1024 * 1024
const MAX_UPLOAD = 50 * 1024 * 1024

/** Callback tokens kept for buttons, oldest dropped past this. */
const MAX_ACTIONS = 2000

const NOT_LINKED =
  'No chat is linked. On the Mac, open a chat’s menu in the sidebar and choose Control from Telegram.'

/** What Barebone does for the bridge, as the window's buttons do. */
export interface BridgeHost {
  send(chatId: string, text: string, attachments: Attachment[]): Promise<void>
  cancel(chatId: string): Promise<void>
  resolvePermission(chatId: string, permissionId: string, optionId: string): void
  answerForm(chatId: string, formId: string, answers: FormAnswers | null): void
  turnEnd(chatId: string): TurnEnd | undefined
  statusChanged(status: TelegramStatus): void
}

/** What a button does, kept here so its callback data is a short token. */
type Action =
  | { kind: 'permission'; chatId: string; permissionId: string; optionId: string }
  | { kind: 'message' | 'stop'; chatId: string }
  | { kind: 'late'; send: boolean; messageId: number }
  | { kind: 'pick'; form: string; field: string; value: string }
  | { kind: 'ask'; form: string; field: string }
  | { kind: 'formSend' | 'formDecline' | 'formOpen'; form: string }

/** A message the user is asked to reply to, and where the reply goes. */
type ReplyTarget =
  { kind: 'message'; chatId: string } | { kind: 'field'; form: string; field: string }

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type PermissionItem = Extract<ChatItem, { kind: 'permission' }>
type FormItem = Extract<ChatItem, { kind: 'form' }>

/** A run of the linked chat's tool calls between two of its messages, shown as one message. */
interface Steps {
  ids: string[]
  startedAt: number
  endedAt?: number
  messageId?: number
  shown?: string
}

/** The card of a chat the linked chat started. */
interface Card {
  title: string
  messageId?: number
  shown?: string
  /** What it showed last, kept for when the chat is gone. */
  last?: Progress
}

/** A form being answered in Telegram, by `${chatId}:${formId}`. */
interface FormState {
  chatId: string
  formId: string
  answers: FormAnswers
  messageId?: number
}

export class TelegramBridge {
  private api?: BotApi
  private abort?: AbortController
  private bot?: string
  private code?: string
  /** Why the bot cannot be used, until the token is saved again. */
  private fatal?: string
  /** A passing trouble, such as Telegram out of reach. */
  private trouble?: string
  private commandsSet = false

  /** Bumped when the bot stops or the linked chat changes: queued sends for before are dropped. */
  private generation = 0
  private queue: Promise<void> = Promise.resolve()
  private lastCall = 0
  /** Sends coalesced by key: one waits while it is queued, and sends what is true when it runs. */
  private readonly due = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  private readonly actions = new Map<string, Action>()
  private readonly tokens = new Map<string, string>()
  private nextToken = 0
  private readonly replies = new Map<number, ReplyTarget>()
  private readonly late = new Map<number, TelegramMessage>()

  // The linked chat.
  private running = false
  /** Its items shown so far: only a new one ends the answer being written, not a change to an old one. */
  private readonly seen = new Set<string>()
  private readonly posted = new Set<string>()
  private readonly asked = new Map<string, number>()
  private turnSteps: Steps[] = []
  private openSteps?: Steps
  private readonly stepsOf = new Map<string, Steps>()
  private text?: { id: string; draftId: number }
  private nextDraft = 1
  /** Set when Telegram refuses drafts: answers then come only once written. */
  private noDrafts = false

  // The chats it started.
  private readonly cards = new Map<string, Card>()
  private readonly forms = new Map<string, FormState>()
  private readonly sentImages = new Set<string>()
  private readonly chatOptions = new Map<string, AgentOption[]>()
  private linkedTitle?: string

  constructor(private readonly host: BridgeHost) {}

  // --- Status and setup --------------------------------------------------------

  status(): TelegramStatus {
    const { token, owner, linkedChatId } = telegramConfig()
    if (!token) return { state: 'off' }
    const base = {
      bot: this.bot,
      linkedChatId,
      linkedTitle: linkedChatId ? this.linkedTitle : undefined
    }
    if (this.fatal) return { ...base, state: 'error', error: this.fatal }
    return owner
      ? { ...base, state: 'ready', error: this.trouble }
      : { ...base, state: 'pairing', code: this.code, error: this.trouble }
  }

  tokenHint(): string | null {
    return telegramTokenHint()
  }

  /** Save a bot token, checked with Telegram first, or remove it (null). Returns the new hint. */
  async setToken(value: string | null): Promise<string | null> {
    const token = value?.trim()
    if (value !== null && !token) throw new Error('Enter the bot token from @BotFather.')
    let me: TelegramUser | undefined
    if (token) {
      try {
        me = await new BotApi(token).call<TelegramUser>('getMe')
      } catch (error) {
        throw new Error(
          error instanceof TelegramError && (error.code === 401 || error.code === 404)
            ? 'Telegram didn’t accept this token. Copy it again from @BotFather.'
            : `Couldn’t reach Telegram: ${(error as Error).message}`
        )
      }
    }
    this.stop()
    // A new bot starts over: it pairs again, and links no chat.
    updateTelegramConfig({ token, owner: undefined, linkedChatId: undefined, offset: undefined })
    this.bot = me?.username
    this.start()
    return telegramTokenHint()
  }

  /** Start reading the bot's messages, when a token is saved. */
  start(): void {
    const { token, owner, linkedChatId } = telegramConfig()
    this.fatal = undefined
    this.trouble = undefined
    if (!token) {
      this.publish()
      return
    }
    this.api = new BotApi(token)
    this.abort = new AbortController()
    this.generation++
    // Anyone who finds the bot can message it, and pairing gives control of the chats, so the
    // secret is too long to guess: 128 bits, in the characters a /start deep link takes.
    this.code = owner ? undefined : randomBytes(16).toString('base64url')
    this.linkedTitle = linkedChatId ? this.chat(linkedChatId)?.title : undefined
    this.running = linkedChatId ? this.chat(linkedChatId)?.running === true : false
    this.publish()
    void this.poll(this.api, this.abort.signal)
  }

  /** Stop reading and sending; nothing queued goes out. */
  stop(): void {
    this.abort?.abort()
    this.abort = undefined
    this.api = undefined
    this.commandsSet = false
    this.forgetChats()
  }

  /** Make a chat the one the bot controls, or none (null). */
  link(chatId: string | null): void {
    const { owner, linkedChatId } = telegramConfig()
    if (!owner) throw new Error('Pair with the bot first, in Settings.')
    if (chatId === linkedChatId) return
    const chat = chatId ? store.getChat(chatId) : undefined
    if (chat?.startedBy) {
      throw new Error(
        'A chat another chat started can’t be linked, as it can’t start chats itself.'
      )
    }
    const before = this.linkedTitle
    updateTelegramConfig({ linkedChatId: chatId ?? undefined })
    this.forgetChats()
    this.linkedTitle = chat?.title
    this.running = chat?.running === true
    this.publish()
    if (chat) {
      const project = store.getState().projects.find((p) => p.id === chat.projectId)
      this.say(
        `Now controlling <b>${escapeHtml(chat.title)}</b>${project ? ` in ${escapeHtml(project.name)}` : ''}. What you send here goes to that chat. Write <code>@chats</code> to have it split the work into new chats.`
      )
    } else if (before) {
      this.say(`Stopped controlling <b>${escapeHtml(before)}</b>.`)
    }
  }

  private publish(): void {
    this.host.statusChanged(this.status())
  }

  /** Forget what was shown of the linked chat and its chats, and drop what is queued. */
  private forgetChats(): void {
    this.generation++
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.due.clear()
    this.seen.clear()
    this.posted.clear()
    this.asked.clear()
    this.turnSteps = []
    this.openSteps = undefined
    this.stepsOf.clear()
    this.text = undefined
    this.cards.clear()
    this.forms.clear()
    this.sentImages.clear()
    this.replies.clear()
  }

  // --- Reading updates ---------------------------------------------------------

  private async poll(api: BotApi, signal: AbortSignal): Promise<void> {
    let backoff = 1000
    while (!signal.aborted) {
      try {
        if (!this.bot) {
          this.bot = (await api.call<TelegramUser>('getMe', {}, signal)).username
          this.publish()
        }
        if (!this.commandsSet) {
          await api.call(
            'setMyCommands',
            { commands: [{ command: 'stop', description: 'Stop the linked chat' }] },
            signal
          )
          this.commandsSet = true
        }
        const updates = await api.call<TelegramUpdate[]>(
          'getUpdates',
          {
            offset: telegramConfig().offset,
            timeout: 50,
            allowed_updates: ['message', 'callback_query']
          },
          signal
        )
        backoff = 1000
        if (this.trouble) {
          this.trouble = undefined
          this.publish()
        }
        for (const update of updates) {
          if (signal.aborted) return
          // Confirmed before it is handled: a message that fails is not run twice.
          updateTelegramConfig({ offset: update.update_id + 1 })
          await this.handle(update).catch((error) =>
            console.error('Telegram: could not handle an update:', (error as Error).message)
          )
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof TelegramError && (error.code === 401 || error.code === 409)) {
          this.fatal =
            error.code === 401
              ? 'Telegram no longer accepts this bot token. Save a new one from @BotFather.'
              : 'Something else reads this bot’s messages: another Barebone, or a webhook. Close it, then save the token again.'
          this.publish()
          return
        }
        this.trouble = `Can’t reach Telegram (${(error as Error).message}). Trying again.`
        this.publish()
        await sleep(backoff, undefined, { signal }).catch(() => undefined)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const { owner } = telegramConfig()
    const query = update.callback_query
    if (query) {
      if (query.from.id !== owner?.userId) return
      await this.onButton(query.id, query.data, query.message?.message_id)
      return
    }
    const message = update.message
    if (!message || message.chat.type !== 'private' || !message.from) return
    if (!owner) {
      await this.pair(message)
      return
    }
    if (message.from.id !== owner.userId) return
    if (Date.now() / 1000 - message.date > LATE_S) {
      this.late.set(message.message_id, message)
      this.say('Barebone was offline when you sent this. Send it now?', {
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        reply_markup: this.keyboard([
          [
            this.button('Send now', { kind: 'late', send: true, messageId: message.message_id }),
            this.button('Drop', { kind: 'late', send: false, messageId: message.message_id })
          ]
        ])
      })
      return
    }
    await this.onMessage(message)
  }

  private async pair(message: TelegramMessage): Promise<void> {
    const sent = message.text?.trim().match(/^\/start\s+([\w-]+)$/)?.[1]
    if (!this.code || sent !== this.code) return
    updateTelegramConfig({ owner: { userId: message.from!.id, chatId: message.chat.id } })
    this.code = undefined
    this.publish()
    this.say(
      `Paired with Barebone. Now link a chat: on the Mac, open a chat’s menu in the sidebar and choose <b>Control from Telegram</b>.`
    )
  }

  private async onMessage(message: TelegramMessage): Promise<void> {
    const text = (message.text ?? message.caption ?? '').trim()
    const target = message.reply_to_message && this.replies.get(message.reply_to_message.message_id)
    if (target && text) {
      this.replies.delete(message.reply_to_message!.message_id)
      if (target.kind === 'message') void this.sendTo(target.chatId, text, [])
      else this.answerField(target.form, target.field, text)
      return
    }
    if (/^\/start(@\w+)?$/.test(text)) {
      const linked = this.linkedTitle
      this.say(linked ? `Paired. Controlling <b>${escapeHtml(linked)}</b>.` : NOT_LINKED)
      return
    }
    const linkedChatId = telegramConfig().linkedChatId
    if (!linkedChatId) {
      this.say(NOT_LINKED)
      return
    }
    if (/^\/stop(@\w+)?$/.test(text)) {
      await this.host.cancel(linkedChatId)
      return
    }
    const attachments: Attachment[] = []
    let prompt = text
    try {
      if (message.voice) {
        const heard = await transcribe(
          await this.download(message.voice),
          message.voice.mime_type ?? 'audio/ogg'
        )
        if (!heard) {
          this.say('Nothing was heard in that voice note.')
          return
        }
        this.say(`🎙 <i>${escapeHtml(heard)}</i>`, {
          reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true }
        })
        prompt = prompt ? `${prompt}\n\n${heard}` : heard
      }
      if (message.photo?.length) {
        const photo = message.photo[message.photo.length - 1]
        const data = await this.download(photo)
        attachments.push({
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          data: data.toString('base64')
        })
      }
      const file = message.document ?? message.audio
      if (file) {
        const name = basename(
          ('file_name' in file && file.file_name) || message.document?.file_name || 'file'
        )
        const path = await this.saveFile(linkedChatId, name, await this.download(file))
        attachments.push({ name, path, ...(file.mime_type ? { mimeType: file.mime_type } : {}) })
      }
    } catch (error) {
      this.say(escapeHtml((error as Error).message))
      return
    }
    if (!prompt && attachments.length === 0) {
      this.say('Barebone takes text, photos, files and voice notes.')
      return
    }
    void this.sendTo(linkedChatId, prompt, attachments)
  }

  /**
   * Send the user's message to a chat. It starts with "Remote:", so the chat
   * (and the user, on the Mac) can tell it came from Telegram, and its agent
   * is pointed to the remote skill (see agents.ts). A slash command is sent as
   * typed, as the agent reads it only at the start of a message.
   */
  private async sendTo(chatId: string, text: string, attachments: Attachment[]): Promise<void> {
    if (!this.chat(chatId)) {
      this.say('That chat is gone.')
      return
    }
    const marked = text.startsWith('/') ? text : `Remote: ${text}`.trimEnd()
    await this.host
      .send(chatId, marked, attachments)
      .catch((error) => this.say(escapeHtml((error as Error).message)))
  }

  private async download(file: { file_id: string; file_size?: number }): Promise<Buffer> {
    if (file.file_size && file.file_size > MAX_DOWNLOAD) {
      throw new Error(
        `Telegram lets bots fetch files up to 20 MB, and this one is ${(file.file_size / 1e6).toFixed(1)} MB.`
      )
    }
    return this.api!.download(file.file_id)
  }

  /** A file sent to the bot, kept for the chat it is attached in. */
  private async saveFile(chatId: string, name: string, data: Buffer): Promise<string> {
    const dir = join(app.getPath('userData'), 'telegram-files', chatId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${Date.now()}-${name}`)
    await writeFile(path, data)
    return path
  }

  // --- Buttons -----------------------------------------------------------------

  /** A button for an action; the same action keeps the same token, so edits keep their buttons. */
  private button(text: string, action: Action): InlineButton {
    const key = JSON.stringify(action)
    let token = this.tokens.get(key)
    if (!token) {
      token = (this.nextToken++).toString(36)
      this.tokens.set(key, token)
      this.actions.set(token, action)
      if (this.actions.size > MAX_ACTIONS) {
        const [oldest] = this.actions.keys()
        this.tokens.delete(JSON.stringify(this.actions.get(oldest)))
        this.actions.delete(oldest)
      }
    }
    return { text, callback_data: token }
  }

  private keyboard(rows: InlineButton[][]): { inline_keyboard: InlineButton[][] } {
    return { inline_keyboard: rows.filter((row) => row.length > 0) }
  }

  private async onButton(queryId: string, data?: string, messageId?: number): Promise<void> {
    const action = data ? this.actions.get(data) : undefined
    let note: string | undefined = action ? undefined : 'This button is out of date.'
    if (action) note = await this.act(action, messageId)
    await this.api
      ?.call('answerCallbackQuery', { callback_query_id: queryId, ...(note ? { text: note } : {}) })
      .catch(() => undefined)
  }

  /** Do what a button says; returns a short note to show, if any. */
  private async act(action: Action, messageId?: number): Promise<string | undefined> {
    switch (action.kind) {
      case 'permission':
        this.host.resolvePermission(action.chatId, action.permissionId, action.optionId)
        return undefined
      case 'stop':
        await this.host.cancel(action.chatId)
        return 'Stopping'
      case 'message': {
        const chat = this.chat(action.chatId)
        if (!chat) return 'That chat is gone.'
        this.ask(`Message for <b>${escapeHtml(chat.title)}</b>:`, {
          kind: 'message',
          chatId: chat.id
        })
        return undefined
      }
      case 'late': {
        const message = this.late.get(action.messageId)
        this.late.delete(action.messageId)
        if (messageId) {
          this.enqueue(() => this.edit(messageId, action.send ? 'Sent.' : 'Dropped.', []))
        }
        if (!message) return 'Already handled.'
        if (action.send) await this.onMessage(message)
        return undefined
      }
      case 'pick':
      case 'ask':
      case 'formSend':
      case 'formDecline':
      case 'formOpen':
        return this.formAction(action)
    }
  }

  /** Ask the user to reply to a message; the reply goes where `target` says. */
  private ask(html: string, target: ReplyTarget): void {
    this.enqueue(async () => {
      const id = await this.sendText(
        { html, plain: html.replace(/<[^>]+>/g, '') },
        { reply_markup: { force_reply: true, input_field_placeholder: 'Reply here' } }
      )
      if (id) this.replies.set(id, target)
    })
  }

  // --- Events from the chats ---------------------------------------------------

  /** An item of a chat was added or changed. */
  item(chatId: string, item: ChatItem): void {
    const { owner, linkedChatId } = telegramConfig()
    if (!this.api || !owner || !linkedChatId) return
    if (chatId === linkedChatId) {
      this.linkedItem(chatId, item)
    } else {
      const chat = this.chat(chatId)
      if (chat?.startedBy !== linkedChatId) return
      this.workerItem(chat, item)
    }
    if ((item.kind === 'text' || item.kind === 'tool') && item.images?.length) {
      this.sendImages(chatId, item.images)
    }
  }

  options(chatId: string, options: AgentOption[]): void {
    this.chatOptions.set(chatId, options)
  }

  /** Chats were added, changed or removed, or a turn began or ended. */
  stateChanged(): void {
    const { owner, linkedChatId } = telegramConfig()
    if (!this.api || !owner || !linkedChatId) return
    const linked = this.chat(linkedChatId)
    if (!linked) {
      const title = this.linkedTitle
      updateTelegramConfig({ linkedChatId: undefined })
      this.forgetChats()
      this.linkedTitle = undefined
      this.publish()
      this.say(
        `<b>${escapeHtml(title ?? 'The linked chat')}</b> was deleted, so no chat is linked now.`
      )
      return
    }
    if (linked.title !== this.linkedTitle) {
      this.linkedTitle = linked.title
      this.publish()
    }
    if (this.running && !linked.running) this.turnEnded(linked.id)
    this.running = linked.running
    for (const chat of store.getState().chats) {
      if (chat.startedBy === linked.id && chat.running && !this.cards.has(chat.id)) {
        this.cards.set(chat.id, { title: chat.title })
      }
    }
    for (const chatId of this.cards.keys()) this.showCard(chatId)
  }

  /** A video an agent recorded was saved. */
  video(chatId: string, video: Recorded): void {
    const { owner, linkedChatId } = telegramConfig()
    if (!this.api || !owner || !linkedChatId) return
    const chat = this.chat(chatId)
    if (!chat || (chat.id !== linkedChatId && chat.startedBy !== linkedChatId)) return
    const caption = chat.id === linkedChatId ? undefined : chat.title
    if (video.bytes > MAX_UPLOAD) {
      this.say(
        `${caption ? `<b>${escapeHtml(caption)}</b>: ` : ''}a ${(video.bytes / 1e6).toFixed(1)} MB video is over Telegram’s 50 MB limit for bots. It is on the Mac at <code>${escapeHtml(video.path)}</code>.`
      )
      return
    }
    this.enqueue(() =>
      this.api!.upload('sendVideo', 'video', video.path, {
        chat_id: owner.chatId,
        supports_streaming: 'true',
        ...(caption ? { caption } : {})
      }).then(() => undefined)
    )
  }

  // --- The linked chat ---------------------------------------------------------

  private linkedItem(chatId: string, item: ChatItem): void {
    const fresh = !this.seen.has(item.id)
    this.seen.add(item.id)
    switch (item.kind) {
      case 'text':
        // An answer already sent that changes again (it gained an image) stays as sent.
        if (!fresh && this.text?.id !== item.id) return
        if (fresh) {
          this.openSteps = undefined
          this.endText(chatId)
          this.text = { id: item.id, draftId: this.nextDraft++ }
        }
        this.later(`draft:${item.id}`, DRAFT_EVERY_MS, () => this.draft(chatId, item.id))
        return
      case 'tool': {
        if (item.parentId) return
        if (fresh) this.endText(chatId)
        let steps = this.stepsOf.get(item.id)
        if (!steps) {
          steps = this.openSteps
          if (!steps) {
            steps = { ids: [], startedAt: Date.now() }
            this.openSteps = steps
            this.turnSteps.push(steps)
          }
          steps.ids.push(item.id)
          this.stepsOf.set(item.id, steps)
        }
        this.showSteps(chatId, steps)
        return
      }
      case 'permission':
        if (fresh) this.endText(chatId)
        this.showPermission(chatId, item)
        return
      case 'form':
        if (fresh) this.endText(chatId)
        this.showForm(chatId, item)
        return
      case 'error':
      case 'notice':
        if (fresh) this.endText(chatId)
        if (this.posted.has(item.id)) return
        this.posted.add(item.id)
        for (const out of plainMessages(item.kind === 'error' ? `⚠️ ${item.text}` : item.text)) {
          this.enqueue(() => this.sendText(out))
        }
        return
      default:
        return
    }
  }

  /** The streamed answer is final: a later item came, or the turn ended. */
  private endText(chatId: string): void {
    if (this.text) this.postText(chatId, this.text.id)
    this.text = undefined
  }

  private postText(chatId: string, id: string): void {
    if (this.posted.has(id)) return
    this.posted.add(id)
    this.enqueue(async () => {
      const item = store.findItem(chatId, id)
      if (item?.kind !== 'text') return
      for (const out of markdownMessages(item.text)) await this.sendText(out)
    })
  }

  /** The answer so far, as a draft: Telegram shows it as it is written, until the message is sent. */
  private async draft(chatId: string, id: string): Promise<void> {
    const item = store.findItem(chatId, id)
    if (this.noDrafts) return
    if (item?.kind !== 'text' || this.posted.has(id) || this.text?.id !== id) return
    const text = item.text.length > 4000 ? `…${item.text.slice(-3999)}` : item.text
    if (!text.trim()) return
    try {
      await this.api!.call('sendMessageDraft', {
        chat_id: telegramConfig().owner!.chatId,
        draft_id: this.text.draftId,
        text
      })
    } catch (error) {
      // The answer still comes once it is written; it is only not shown as it grows.
      if (!(error instanceof TelegramError) || error.code !== 400) throw error
      this.noDrafts = true
      console.error('Telegram: drafts refused, answers come when written:', error.message)
    }
  }

  private turnEnded(chatId: string): void {
    this.endText(chatId)
    const now = Date.now()
    for (const steps of this.turnSteps) {
      steps.endedAt ??= now
      this.showSteps(chatId, steps)
    }
    this.turnSteps = []
    this.openSteps = undefined
  }

  private showSteps(chatId: string, steps: Steps): void {
    const key = `steps:${steps.startedAt}:${steps.ids[0]}`
    this.later(key, steps.messageId ? EDIT_EVERY_MS : 0, async () => {
      const items = steps.ids
        .map((id) => store.findItem(chatId, id))
        .filter((i): i is ToolItem => i?.kind === 'tool')
      const html = stepsMessage(
        { elapsedMs: (steps.endedAt ?? Date.now()) - steps.startedAt, calls: items },
        steps.endedAt !== undefined
      )
      if (html === steps.shown) return
      steps.shown = html
      if (steps.messageId) {
        if ((await this.edit(steps.messageId, html, [])) === 'gone') steps.messageId = undefined
      } else {
        steps.messageId = await this.sendText({ html, plain: html.replace(/<[^>]+>/g, '') })
      }
    })
  }

  private showPermission(chatId: string, item: PermissionItem, tag?: string): void {
    if (item.auto) return
    const asked = this.asked.get(item.id)
    if (item.resolved === undefined && asked === undefined && !this.posted.has(item.id)) {
      this.posted.add(item.id)
      this.enqueue(async () => {
        const now = store.findItem(chatId, item.id)
        if (now?.kind !== 'permission' || now.resolved !== undefined) return
        const id = await this.sendText(
          {
            html: permissionText(now, tag),
            plain: permissionText(now, tag).replace(/<[^>]+>/g, '')
          },
          { reply_markup: this.keyboard(this.permissionButtons(chatId, now)) }
        )
        if (!id) return
        this.asked.set(item.id, id)
        // Answered on the Mac while it was being sent.
        const after = store.findItem(chatId, item.id)
        if (after?.kind === 'permission' && after.resolved !== undefined)
          this.showPermission(chatId, after, tag)
      })
    } else if (item.resolved !== undefined && asked !== undefined) {
      this.asked.delete(item.id)
      this.enqueue(() => this.edit(asked, resolvedText(item, tag), []).then(() => undefined))
    }
  }

  private permissionButtons(chatId: string, item: PermissionItem): InlineButton[][] {
    const buttons = item.options.map((o) =>
      this.button(o.name, {
        kind: 'permission',
        chatId,
        permissionId: item.id,
        optionId: o.optionId
      })
    )
    const rows: InlineButton[][] = []
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3))
    return rows
  }

  // --- Forms -------------------------------------------------------------------

  private showForm(chatId: string, item: FormItem, tag?: string): void {
    const key = `${chatId}:${item.id}`
    let form = this.forms.get(key)
    if (item.resolved !== undefined) {
      if (!form) return
      this.forms.delete(key)
      const messageId = form.messageId
      if (messageId)
        this.enqueue(() => this.edit(messageId, formDone(item, tag), []).then(() => undefined))
      return
    }
    if (form) return
    form = { chatId, formId: item.id, answers: formDefaults(item.fields) }
    this.forms.set(key, form)
    this.renderForm(key, tag)
  }

  private renderForm(key: string, tag?: string): void {
    this.later(`form:${key}`, 0, async () => {
      const form = this.forms.get(key)
      const item = form && store.findItem(form.chatId, form.formId)
      if (!form || item?.kind !== 'form' || item.resolved !== undefined) return
      const html = formText(item, form.answers, tag)
      const rows = this.formButtons(key, item, form.answers)
      if (form.messageId) {
        await this.edit(form.messageId, html, rows)
      } else {
        form.messageId = await this.sendText(
          { html, plain: html.replace(/<[^>]+>/g, '') },
          { reply_markup: this.keyboard(rows) }
        )
      }
    })
  }

  private formButtons(key: string, item: FormItem, answers: FormAnswers): InlineButton[][] {
    if (item.url) {
      return [
        [
          this.button('Open on the Mac', { kind: 'formOpen', form: key }),
          this.button('Decline', { kind: 'formDecline', form: key })
        ]
      ]
    }
    const rows: InlineButton[][] = []
    for (const field of item.fields) {
      const value = answers[field.key]
      if (field.type === 'choice' || field.type === 'choices') {
        for (const option of field.options) {
          const on = Array.isArray(value) ? value.includes(option.value) : value === option.value
          rows.push([
            this.button(`${on ? '✓ ' : ''}${option.title}`, {
              kind: 'pick',
              form: key,
              field: field.key,
              value: option.value
            })
          ])
        }
      } else if (field.type === 'boolean') {
        rows.push(
          [true, false].map((v) =>
            this.button(`${value === v ? '✓ ' : ''}${v ? 'Yes' : 'No'}`, {
              kind: 'pick',
              form: key,
              field: field.key,
              value: String(v)
            })
          )
        )
      } else {
        rows.push([this.button(`✎ ${field.title}`, { kind: 'ask', form: key, field: field.key })])
      }
    }
    rows.push([
      this.button('Send', { kind: 'formSend', form: key }),
      this.button('Decline', { kind: 'formDecline', form: key })
    ])
    return rows
  }

  private formAction(
    action: Extract<Action, { kind: 'pick' | 'ask' | 'formSend' | 'formDecline' | 'formOpen' }>
  ): string | undefined {
    const form = this.forms.get(action.form)
    const item = form && store.findItem(form.chatId, form.formId)
    if (!form || item?.kind !== 'form' || item.resolved !== undefined) return 'Already answered.'
    switch (action.kind) {
      case 'pick': {
        const field = item.fields.find((f) => f.key === action.field)
        if (!field) return undefined
        if (field.type === 'choices') {
          const picked = Array.isArray(form.answers[field.key])
            ? (form.answers[field.key] as string[])
            : []
          form.answers[field.key] = picked.includes(action.value)
            ? picked.filter((v) => v !== action.value)
            : [...picked, action.value]
        } else if (field.type === 'boolean') {
          form.answers[field.key] = action.value === 'true'
        } else {
          form.answers[field.key] = action.value
        }
        this.renderForm(action.form, this.tagOf(form.chatId))
        return undefined
      }
      case 'ask': {
        const field = item.fields.find((f) => f.key === action.field)
        if (!field) return undefined
        this.ask(`Your answer to <b>${escapeHtml(field.title)}</b>:`, {
          kind: 'field',
          form: action.form,
          field: field.key
        })
        return undefined
      }
      case 'formSend':
        if (!formContent(item.fields, form.answers)) return 'Answer the questions it needs first.'
        this.host.answerForm(form.chatId, form.formId, form.answers)
        return undefined
      case 'formOpen':
        // Accepting a page form opens it on the Mac (see answerForm).
        this.host.answerForm(form.chatId, form.formId, {})
        return 'Opened on the Mac'
      case 'formDecline':
        this.host.answerForm(form.chatId, form.formId, null)
        return undefined
    }
  }

  private answerField(key: string, fieldKey: string, text: string): void {
    const form = this.forms.get(key)
    const item = form && store.findItem(form.chatId, form.formId)
    if (!form || item?.kind !== 'form' || item.resolved !== undefined) {
      this.say('That question was answered already.')
      return
    }
    const field = item.fields.find((f) => f.key === fieldKey)
    if (!field) return
    if (field.type === 'number' || field.type === 'integer') {
      const value = Number(text.replace(',', '.'))
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) {
        this.say(
          `<b>${escapeHtml(field.title)}</b> takes ${field.type === 'integer' ? 'a whole number' : 'a number'}.`
        )
        return
      }
      form.answers[field.key] = value
    } else {
      form.answers[field.key] = text
    }
    this.renderForm(key, this.tagOf(form.chatId))
  }

  /** How a chat's questions are labelled: chats it started by their title; the linked chat not at all. */
  private tagOf(chatId: string): string | undefined {
    return chatId === telegramConfig().linkedChatId ? undefined : this.chat(chatId)?.title
  }

  // --- The chats it started ----------------------------------------------------

  private workerItem(chat: Chat, item: ChatItem): void {
    if (!this.cards.has(chat.id)) this.cards.set(chat.id, { title: chat.title })
    // Forms need more room than a card has: they come as their own message.
    if (item.kind === 'form') this.showForm(chat.id, item, chat.title)
    this.showCard(chat.id)
  }

  private showCard(chatId: string): void {
    const card = this.cards.get(chatId)
    if (!card) return
    this.later(`card:${chatId}`, card.messageId ? EDIT_EVERY_MS : 500, async () => {
      const chat = this.chat(chatId)
      const view = chat ? this.cardView(chat, card) : undefined
      const html = view
        ? workerCard(view.card)
        : workerCard({
            title: card.title,
            runsOn: '',
            state: 'deleted',
            progress: card.last ?? { calls: [] }
          })
      const rows = view?.rows ?? []
      const shown = `${html}${JSON.stringify(rows)}`
      if (!chat) this.cards.delete(chatId)
      if (shown === card.shown) return
      card.shown = shown
      if (card.messageId) {
        if ((await this.edit(card.messageId, html, rows)) === 'gone') card.messageId = undefined
      } else if (chat) {
        card.messageId = await this.sendText(
          { html, plain: html.replace(/<[^>]+>/g, '') },
          { reply_markup: this.keyboard(rows) }
        )
      }
    })
  }

  private cardView(
    chat: Chat,
    card: Card
  ): { card: Parameters<typeof workerCard>[0]; rows: InlineButton[][] } {
    card.title = chat.title
    const items = taskItems(chat.id)
    const user = lastUser(chat.id)
    const elapsed = user?.sentAt
      ? chat.running
        ? Date.now() - user.sentAt
        : (user.workedMs ?? undefined)
      : undefined
    const progress: Progress = { elapsedMs: elapsed, calls: items.filter(isTopTool) }
    card.last = progress
    const end = this.host.turnEnd(chat.id)
    const permission = items.find(
      (i): i is PermissionItem => i.kind === 'permission' && i.resolved === undefined && !i.auto
    )
    const form = items.find((i): i is FormItem => i.kind === 'form' && i.resolved === undefined)
    const state: CardState = chat.running
      ? chat.waiting
        ? 'waiting'
        : 'working'
      : end?.outcome === 'failed'
        ? 'failed'
        : end?.outcome === 'stopped'
          ? 'stopped'
          : end?.outcome === 'done'
            ? 'done'
            : 'idle'
    const rows: InlineButton[][] = permission ? this.permissionButtons(chat.id, permission) : []
    rows.push([
      this.button('Message', { kind: 'message', chatId: chat.id }),
      ...(chat.running ? [this.button('Stop', { kind: 'stop', chatId: chat.id })] : [])
    ])
    return {
      card: {
        title: chat.title,
        runsOn: this.runsOn(chat),
        state,
        progress,
        waiting: permission ? (permission.question ?? permission.title) : form?.message,
        error: end?.outcome === 'failed' ? end.error.split('\n')[0] : undefined
      },
      rows
    }
  }

  /** "Claude Code · Haiku 4.5": the chat's agent, and its model once the agent said which. */
  private runsOn(chat: Chat): string {
    const agent = AGENTS.find((a) => a.id === chat.agent)?.label ?? chat.agent
    const { model } = modelOptions(this.chatOptions.get(chat.id) ?? [])
    const name = model?.values.find((v) => v.value === model.currentValue)?.name
    return name ? `${agent} · ${name}` : agent
  }

  private sendImages(chatId: string, files: string[]): void {
    const owner = telegramConfig().owner!
    const caption = this.tagOf(chatId)
    for (const file of files) {
      const key = `${chatId}/${file}`
      if (this.sentImages.has(key)) continue
      this.sentImages.add(key)
      this.enqueue(async () => {
        const path = await chatImagePath(chatId, file)
        const { size } = await stat(path)
        const photo = size <= MAX_PHOTO
        await this.api!.upload(
          photo ? 'sendPhoto' : 'sendDocument',
          photo ? 'photo' : 'document',
          path,
          {
            chat_id: owner.chatId,
            ...(caption ? { caption } : {})
          }
        )
      })
    }
  }

  // --- Sending -----------------------------------------------------------------

  /** Run a send once the one before is done and Telegram's pace allows; dropped if the link changed. */
  private enqueue(task: () => Promise<unknown>): void {
    const generation = this.generation
    this.queue = this.queue.then(async () => {
      if (generation !== this.generation || !this.api) return
      const wait = this.lastCall + CALL_GAP_MS - Date.now()
      if (wait > 0) await sleep(wait)
      if (generation !== this.generation || !this.api) return
      try {
        await task()
      } catch (error) {
        console.error('Telegram: could not send:', (error as Error).message)
      } finally {
        this.lastCall = Date.now()
      }
    })
  }

  /**
   * Send what is true when it runs, at most once per `delay`: calls while one
   * is due join it.
   */
  private later(key: string, delay: number, run: () => Promise<void>): void {
    if (this.due.has(key)) return
    this.due.add(key)
    const generation = this.generation
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (generation !== this.generation) return
      this.enqueue(async () => {
        this.due.delete(key)
        await run()
      })
    }, delay)
    this.timers.add(timer)
  }

  /** A message of the bridge's own, queued. */
  private say(html: string, extra: object = {}): void {
    this.enqueue(() => this.sendText({ html, plain: html.replace(/<[^>]+>/g, '') }, extra))
  }

  /** Send a message; when Telegram cannot read its HTML, as plain text. Returns its id. */
  private async sendText(out: OutText, extra: object = {}): Promise<number | undefined> {
    const chatId = telegramConfig().owner?.chatId
    if (!this.api || chatId === undefined) return undefined
    const params = { chat_id: chatId, link_preview_options: { is_disabled: true }, ...extra }
    try {
      const sent = await this.api.call<{ message_id: number }>('sendMessage', {
        ...params,
        text: out.html,
        parse_mode: 'HTML'
      })
      return sent.message_id
    } catch (error) {
      if (!unreadableHtml(error)) throw error
      const sent = await this.api.call<{ message_id: number }>('sendMessage', {
        ...params,
        text: out.plain
      })
      return sent.message_id
    }
  }

  /** Edit a message's text and buttons; 'gone' when the user deleted it. */
  private async edit(
    messageId: number,
    html: string,
    rows: InlineButton[][]
  ): Promise<'ok' | 'gone'> {
    const chatId = telegramConfig().owner?.chatId
    if (!this.api || chatId === undefined) return 'ok'
    const params = {
      chat_id: chatId,
      message_id: messageId,
      link_preview_options: { is_disabled: true },
      reply_markup: this.keyboard(rows)
    }
    try {
      await this.api.call('editMessageText', { ...params, text: html, parse_mode: 'HTML' })
    } catch (error) {
      if (!(error instanceof TelegramError)) throw error
      if (/not modified/i.test(error.message)) return 'ok'
      if (/not found|can't be edited/i.test(error.message)) return 'gone'
      if (!unreadableHtml(error)) throw error
      await this.api.call('editMessageText', { ...params, text: html.replace(/<[^>]+>/g, '') })
    }
    return 'ok'
  }

  private chat(chatId: string): Chat | undefined {
    return store.getState().chats.find((c) => c.id === chatId)
  }
}

function unreadableHtml(error: unknown): boolean {
  return (
    error instanceof TelegramError && error.code === 400 && /parse entities/i.test(error.message)
  )
}

function isTopTool(item: ChatItem): item is ToolItem {
  return item.kind === 'tool' && !item.parentId
}

function lastUser(chatId: string): Extract<ChatItem, { kind: 'user' }> | undefined {
  return store.getMessages(chatId).findLast((i) => i.kind === 'user') as
    Extract<ChatItem, { kind: 'user' }> | undefined
}

/** A chat's items since the last message it was sent: its current task. */
function taskItems(chatId: string): ChatItem[] {
  const items = store.getMessages(chatId)
  return items.slice(items.findLastIndex((i) => i.kind === 'user') + 1)
}

function permissionText(item: PermissionItem, tag?: string): string {
  const lead = tag ? `<b>${escapeHtml(tag)}</b>\n` : ''
  const ask = item.question ?? `Allow ${item.title}?`
  const outside = item.outside ? `\n<i>Outside the project: ${escapeHtml(item.outside)}</i>` : ''
  return `${lead}🔐 ${escapeHtml(ask)}${outside}`
}

function resolvedText(item: PermissionItem, tag?: string): string {
  const chosen =
    item.resolved === 'cancelled'
      ? 'Cancelled'
      : (item.options.find((o) => o.optionId === item.resolved)?.name ?? item.resolved)
  return `${permissionText(item, tag)}\n→ <b>${escapeHtml(chosen ?? '')}</b>`
}

function formText(item: FormItem, answers: FormAnswers, tag?: string): string {
  const lines = [tag ? `<b>${escapeHtml(tag)}</b>` : '', `❓ ${escapeHtml(item.message)}`]
  if (item.url) lines.push(`<a href="${attribute(item.url)}">${escapeHtml(item.url)}</a>`)
  for (const field of item.fields) {
    const value = answers[field.key]
    const shown = Array.isArray(value)
      ? value.join(', ')
      : value === undefined
        ? ''
        : typeof value === 'boolean'
          ? value
            ? 'Yes'
            : 'No'
          : String(value)
    lines.push(
      '',
      `<b>${escapeHtml(field.title)}</b>${field.required ? '' : ' <i>(optional)</i>'}`,
      ...(field.description ? [`<i>${escapeHtml(field.description)}</i>`] : []),
      ...(field.type === 'text' || field.type === 'number' || field.type === 'integer'
        ? [shown ? `→ ${escapeHtml(shown)}` : '→ <i>no answer yet</i>']
        : [])
    )
  }
  return lines.filter((l, i) => i > 0 || l).join('\n')
}

function formDone(item: FormItem, tag?: string): string {
  const head = [tag ? `<b>${escapeHtml(tag)}</b>` : '', `❓ ${escapeHtml(item.message)}`]
    .filter(Boolean)
    .join('\n')
  if (item.resolved !== 'accepted') {
    return `${head}\n→ <b>${item.resolved === 'declined' ? 'Declined' : 'Cancelled'}</b>`
  }
  const answers = (item.answers ?? []).map(
    (a) => `<b>${escapeHtml(a.title)}</b>: ${escapeHtml(a.answer)}`
  )
  return [head, ...(answers.length ? answers : ['→ <b>Accepted</b>'])].join('\n')
}
