import { app } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  AGENTS,
  formDefaults,
  modelOptions,
  startedChats,
  waitingOn,
  type AgentId,
  type AgentModels,
  type AgentOption,
  type AgentStatus,
  type Attachment,
  type Chat,
  type ChatItem,
  type FormAnswers,
  type ModelSource,
  type OpenChatResult,
  type TelegramStatus
} from '../../shared/types'
import type { TurnEnd } from '../agents'
import { formatDuration } from '../chats-mcp'
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
  cut,
  escapeHtml,
  plainMessages,
  turnFinal,
  turnFinalPlain,
  turnLive,
  turnLivePlain,
  workerCard,
  type CardState,
  type OutText,
  type Progress,
  type TurnView
} from './format'

/**
 * Control from Telegram: a bot the user made with @BotFather carries their
 * chats to their phone, each in a topic of its own (the bot's Threaded Mode).
 * What they write in a topic goes to its chat. A turn shows live as a draft
 * with a Stop button, and stays as one message: how it went with its steps
 * folded, then its answer. The chats a chat starts (`@chats`) get a card each
 * in its topic, edited in place. Questions (permissions, forms) come as
 * buttons, screenshots and videos as media. A pinned message lists the chats
 * that work or need the user, as the sidebar does, and opens their topics.
 *
 * The bot reads its messages with getUpdates (long polling), so nothing on the
 * Mac listens for connections. It answers only the Telegram user who paired
 * with it, by opening the link Settings shows, which sends it a secret.
 */

/** A message that reaches the bot this much after it was sent waits for the user's go. */
const LATE_S = 60

/** The least time between two calls that send to the chat: Telegram allows about one a second. */
const CALL_GAP_MS = 1000

/** How often a card, the list of chats or a topic's name is edited, at most. */
const EDIT_EVERY_MS = 2500

/** How often a turn's draft is updated while it changes. */
const DRAFT_EVERY_MS = 1000

/** A draft shows for 30 seconds: it is sent again before then while its turn works. */
const DRAFT_KEEP_MS = 20_000

/** Telegram's limits for what bots download and send. */
const MAX_DOWNLOAD = 20 * 1024 * 1024
const MAX_PHOTO = 10 * 1024 * 1024
const MAX_UPLOAD = 50 * 1024 * 1024
const MAX_CAPTION = 1000

/** Files sent as photos and as videos; anything else goes as a file. */
const PHOTOS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEOS = new Set(['.mp4', '.mov'])

/** Callback tokens kept for buttons, oldest dropped past this. */
const MAX_ACTIONS = 2000

/** The user's messages followed for their reactions, oldest dropped past this. */
const MAX_FOLLOWED = 200

/** A project's chats the picker lists, newest first; older ones are picked on the Mac. */
const PICK_CHATS = 8

/** Models shown per page of the model picker, and found at most by a search. */
const PICK_MODELS = 10

/** The most text the list of chats (/chats) takes; chats past it are counted, not listed. */
const SIDEBAR_TEXT = 3600

/** A topic's longest name. */
const TOPIC_NAME = 128

/** Indents a chat another chat started under it, as Telegram drops leading spaces. */
const NESTED = '    ↳ '

/** The thread Telegram puts messages outside every topic in; sending to it is refused. */
const GENERAL_THREAD = 1

/** Sends that wait go in this order: what asks the user first, then answers, then updates. */
const ASK = 0
const ANSWER = 1
const UPDATE = 2
type Priority = typeof ASK | typeof ANSWER | typeof UPDATE

/** A message sent without a sound: only questions, answers and failures buzz. */
const SILENT = { disable_notification: true }

/** How the user's messages are marked, with the few emoji bots may react with. */
const MARK_WAITING = '🫡'
const MARK_STARTED = '👀'
const MARK_END: Record<TurnEnd['outcome'], string> = { done: '👌', failed: '💔', stopped: '🤷' }

const TOPICS_OFF =
  'Turn on topics for this bot first: in @BotFather, open the bot’s settings and turn on <b>Threaded Mode</b>. Each chat then gets a topic of its own here. Send me anything once it is on.'

const NO_CHAT_HERE =
  'Write in a chat’s topic to talk to it. /new starts a chat, /projects opens another, /chats lists the ones working.'

const MODELS_OUT_OF_DATE = 'This list is out of date. Send /model again.'

/** What Barebone does for the bridge, as the window's buttons do. */
export interface BridgeHost {
  /** Send a message to a chat; `id` is the ID of the item it becomes, whenever it joins a turn. */
  send(chatId: string, text: string, attachments: Attachment[], id: string): Promise<void>
  /** A new chat in a project, with the agent, model and permissions of `like`. */
  createChat(projectId: string, like: Chat): Chat
  renameChat(chatId: string, title: string): void
  /** The chat's session options (its model, ...), its session opened for them. */
  openChat(chatId: string): Promise<OpenChatResult>
  agentStatus(agent: AgentId): Promise<AgentStatus>
  agentModels(agent: AgentId, projectId: string): Promise<AgentModels>
  setOption(chatId: string, optionId: string, value: string): Promise<void>
  changeAgent(chatId: string, agent: AgentId, settings: Record<string, string>): Promise<void>
  cancel(chatId: string): Promise<void>
  resolvePermission(chatId: string, permissionId: string, optionId: string): void
  answerForm(chatId: string, formId: string, answers: FormAnswers | null): void
  turnEnd(chatId: string): TurnEnd | undefined
  statusChanged(status: TelegramStatus): void
}

/** What a button does, kept here so its callback data is a short token. */
type Action =
  | { kind: 'permission'; chatId: string; permissionId: string; optionId: string }
  | { kind: 'message' | 'stop' | 'open'; chatId: string }
  | { kind: 'late'; send: boolean; messageId: number }
  | { kind: 'pick'; form: string; field: string; value: string }
  | { kind: 'ask'; form: string; field: string }
  | { kind: 'formSend' | 'formDecline' | 'formOpen'; form: string }
  | { kind: 'projects' }
  | { kind: 'project'; projectId: string }
  | { kind: 'newChat'; projectId: string; thread?: number }
  | { kind: 'sources' }
  | { kind: 'source'; key: string; page: number }
  | { kind: 'model'; key: string; value: string }
  | { kind: 'thinking'; chatId: string; optionId: string; value: string; name: string }

/** A message the user is asked to reply to, and what the reply does. */
type ReplyTarget =
  { kind: 'message' | 'rename'; chatId: string } | { kind: 'field'; form: string; field: string }

/** A message of buttons to pick from, edited in place as the user goes through it. */
interface Picker {
  html: string
  rows: InlineButton[][]
}

/**
 * Where a list of models comes from, as the window's model picker has them:
 * an agent, or one of its providers when it has several (Cline, Custom providers).
 */
interface Source {
  key: string
  agent: AgentId
  setting?: ModelSource['setting']
  option: AgentOption
}

/** The models a chat can switch to, read when /model is sent in its topic. */
interface Catalog {
  chatId: string
  /** The key of the source the chat is on. */
  current: string
  options: AgentOption[]
  sources: Source[]
}

type TextItem = Extract<ChatItem, { kind: 'text' }>
type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type PermissionItem = Extract<ChatItem, { kind: 'permission' }>
type FormItem = Extract<ChatItem, { kind: 'form' }>

/** A chat followed in a topic of its own, and what was shown of it there. */
interface TopicView {
  chatId: string
  thread: number
  /** The topic's name as last set, so it is edited only when that changes. */
  name?: string
  /** Its items shown so far: only a new one joins the turn, not a change to an old one. */
  readonly seen: Set<string>
  readonly posted: Set<string>
  /** Permission prompts sent, by item ID, edited once answered: its own and its chats'. */
  readonly asked: Map<string, number>
  turn?: LiveTurn
  /** The chats it started, each as a card. */
  readonly cards: Map<string, Card>
}

/** A turn under way: its texts and calls, shown as a draft until it ends. */
interface LiveTurn {
  ids: string[]
  startedAt: number
  draftId: number
  /** Sends the draft again before it fades. */
  keep: ReturnType<typeof setInterval>
}

/** The card of a chat a topic's chat started. */
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

/** A topic the user made that is no chat yet: its name, and the message first written in it. */
interface Unclaimed {
  name?: string
  message?: TelegramMessage
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
  /** Whether the bot's topics are on, once getMe told. */
  private topicsOn?: boolean

  /** Bumped when the bot stops: what is queued for before is dropped. */
  private generation = 0
  private readonly pending: {
    priority: Priority
    generation: number
    task: () => Promise<unknown>
  }[] = []
  private pumping = false
  private lastCall = 0
  /** Photos, videos and files go on their own, so a big one holds up no question. */
  private media: Promise<unknown> = Promise.resolve()
  private lastMedia = 0
  /** Sends coalesced by key: one waits while it is due, and sends what is true when it runs. */
  private readonly due = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  /** Starts every button's token, so a button sent before a restart matches no action of this one. */
  private readonly launch = randomBytes(2).toString('hex')
  private readonly actions = new Map<string, Action>()
  private readonly tokens = new Map<string, string>()
  private nextToken = 0
  private readonly replies = new Map<number, ReplyTarget>()
  private readonly late = new Map<number, TelegramMessage>()
  private readonly unclaimed = new Map<number, Unclaimed>()

  /** The chats followed in topics, by chat ID. */
  private readonly views = new Map<string, TopicView>()
  /** Topics being made, so a second tap waits for the first. */
  private readonly opening = new Map<string, Promise<TopicView>>()
  private readonly forms = new Map<string, FormState>()
  private readonly sentImages = new Set<string>()
  private readonly chatOptions = new Map<string, AgentOption[]>()
  /** The models read for the last /model, which its buttons pick from. */
  private catalog?: Catalog
  private nextDraft = 1
  /** Set when Telegram refuses rich messages: turns then come in plainer HTML. */
  private noRich = false
  private richFailures = 0
  /** Set when Telegram refuses drafts: turns then show only once they end. */
  private noDrafts = false
  /** The user's messages sent to chats, by the ID of the item each becomes; their reactions tell how they go. */
  private readonly followed = new Map<
    string,
    { chatId: string; messageId: number; started: boolean }
  >()
  /** "Needs you" messages for chats that have no topic, by chat ID; undefined while being sent. */
  private readonly alerts = new Map<string, number | undefined>()
  /** What the list of chats (/chats) shows now, so it is edited only when that changes. */
  private sidebarShown?: string

  constructor(private readonly host: BridgeHost) {}

  // --- Status and setup --------------------------------------------------------

  status(): TelegramStatus {
    const { token, owner } = telegramConfig()
    if (!token) return { state: 'off' }
    const base = {
      bot: this.bot,
      topicChatIds: [...this.views.keys()],
      ...(owner && this.topicsOn === false ? { topicsOff: true } : {})
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
    // A new bot starts over: it pairs again, and the old bot's topics and list aren't its own.
    updateTelegramConfig({
      token,
      owner: undefined,
      topics: undefined,
      linkedChatId: undefined,
      offset: undefined,
      sidebarMessageId: undefined
    })
    this.bot = me?.username
    this.start()
    return telegramTokenHint()
  }

  /** Start reading the bot's messages, when a token is saved. */
  start(): void {
    const { token, owner, topics } = telegramConfig()
    this.fatal = undefined
    this.trouble = undefined
    this.topicsOn = undefined
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
    for (const [chatId, thread] of Object.entries(topics ?? {})) {
      const chat = this.chat(chatId)
      if (!chat) continue
      // Named after the chat when it was made, and renamed with it since.
      const view = newView(chatId, thread)
      view.name = this.topicName(chat)
      this.views.set(chatId, view)
    }
    this.sidebarShown = undefined
    this.publish()
    void this.poll(this.api, this.abort.signal)
  }

  /** Stop reading and sending; nothing queued goes out. */
  stop(): void {
    this.abort?.abort()
    this.abort = undefined
    this.api = undefined
    this.commandsSet = false
    this.generation++
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.due.clear()
    this.pending.length = 0
    for (const view of this.views.values()) if (view.turn) clearInterval(view.turn.keep)
    this.views.clear()
    this.opening.clear()
    this.forms.clear()
    this.replies.clear()
    this.late.clear()
    this.unclaimed.clear()
    this.alerts.clear()
    this.followed.clear()
    this.sentImages.clear()
    this.catalog = undefined
  }

  private publish(): void {
    this.host.statusChanged(this.status())
  }

  // --- Topics --------------------------------------------------------------------

  /** Follow a chat in Telegram, from the sidebar's menu: it gets a topic, or keeps its own. */
  async openTopic(chatId: string): Promise<void> {
    await this.topicFor(chatId)
  }

  /** Stop following a chat in Telegram: its topic goes, with its messages. */
  closeTopic(chatId: string): void {
    this.removeTopic(chatId, true)
  }

  /**
   * The topic of a chat, made when it has none; a chat another chat started
   * is shown in its lead's. `thread` is a topic the user made, to use for it.
   */
  private topicFor(chatId: string, thread?: number): Promise<TopicView> {
    if (!this.api || !telegramConfig().owner) {
      return Promise.reject(new Error('Pair with the bot first, in Settings.'))
    }
    if (this.topicsOn === false) {
      return Promise.reject(new Error('Turn on Threaded Mode for the bot in @BotFather first.'))
    }
    const asked = this.chat(chatId)
    const chat = asked?.startedBy ? this.chat(asked.startedBy) : asked
    if (!chat) return Promise.reject(new Error('That chat is gone.'))
    const view = this.views.get(chat.id)
    if (view) return Promise.resolve(view)
    let opening = this.opening.get(chat.id)
    if (!opening) {
      opening = this.makeTopic(chat, thread).finally(() => this.opening.delete(chat.id))
      this.opening.set(chat.id, opening)
    }
    return opening
  }

  private async makeTopic(chat: Chat, thread?: number): Promise<TopicView> {
    const api = this.api!
    let name: string | undefined
    if (thread === undefined) {
      name = this.topicName(chat)
      const topic = await api.call<{ message_thread_id: number }>('createForumTopic', {
        chat_id: telegramConfig().owner!.chatId,
        name
      })
      thread = topic.message_thread_id
    }
    if (api !== this.api) throw new Error('The Telegram bot stopped.')
    const view = newView(chat.id, thread)
    // A topic the user made keeps their name until the chat is renamed.
    view.name = name ?? this.topicName(chat)
    this.views.set(chat.id, view)
    updateTelegramConfig({ topics: { ...telegramConfig().topics, [chat.id]: thread } })
    this.publish()
    this.introduce(view)
    this.stateChanged()
    return view
  }

  /** The first message of a topic, then what its chat is doing and asking now. */
  private introduce(view: TopicView): void {
    const chat = this.chat(view.chatId)
    if (!chat) return
    const project = store.getState().projects.find((p) => p.id === chat.projectId)?.name
    const about = [project, modelLabel(chat.agent, this.chatOptions.get(chat.id) ?? [])]
    this.say(
      `<b>${escapeHtml(chat.title)}</b>\n<i>${escapeHtml(about.filter(Boolean).join(' · '))}</i>\nWhat you write in this topic goes to this chat. /status tells how it is doing.`,
      view.thread,
      SILENT
    )
    const items = taskItems(chat.id)
    for (const item of items) {
      view.seen.add(item.id)
      if (item.kind === 'permission') this.showPermission(view, chat.id, item)
      if (item.kind === 'form') this.showForm(chat.id, item)
    }
    if (chat.running) {
      const turn = this.startTurn(view, lastUser(chat.id)?.sentAt)
      turn.ids.push(...items.filter((i) => i.kind === 'text' || isTopTool(i)).map((i) => i.id))
    }
  }

  /** Forget a chat's topic, and delete it too unless the user did. */
  private removeTopic(chatId: string, deleteTopic: boolean): void {
    const view = this.views.get(chatId)
    const thread = view?.thread ?? telegramConfig().topics?.[chatId]
    if (view?.turn) clearInterval(view.turn.keep)
    this.views.delete(chatId)
    const topics = { ...telegramConfig().topics }
    delete topics[chatId]
    updateTelegramConfig({ topics })
    for (const [key, form] of this.forms) {
      if (form.chatId === chatId || this.chat(form.chatId)?.startedBy === chatId) {
        this.forms.delete(key)
      }
    }
    this.publish()
    if (deleteTopic && thread !== undefined) this.deleteTopic(thread)
  }

  /** Delete a topic in Telegram, with its messages. */
  private deleteTopic(thread: number): void {
    const owner = telegramConfig().owner
    if (!this.api || !owner) return
    this.enqueue(
      () =>
        this.api!.call('deleteForumTopic', {
          chat_id: owner.chatId,
          message_thread_id: thread
        }).catch((error) => console.error('Telegram: could not delete a topic:', error)),
      UPDATE
    )
  }

  /** The topic was deleted in Telegram: the chat is no longer followed. */
  private lostTopic(thread: number): void {
    const view = this.viewOf(thread)
    if (view) this.removeTopic(view.chatId, false)
  }

  private viewOf(thread: number | undefined): TopicView | undefined {
    if (thread === undefined) return undefined
    for (const view of this.views.values()) if (view.thread === thread) return view
    return undefined
  }

  /** The topic a chat's messages go to: its own, or that of the chat that started it. */
  private threadFor(chatId: string): number | undefined {
    const chat = this.chat(chatId)
    if (!chat) return undefined
    return (
      this.views.get(chat.id)?.thread ??
      (chat.startedBy ? this.views.get(chat.startedBy)?.thread : undefined)
    )
  }

  /**
   * A topic's name: its chat's title. It carries no status, as Telegram posts
   * a line in the topic each time its name changes.
   */
  private topicName(chat: Chat): string {
    return cut(chat.title, TOPIC_NAME)
  }

  private showTopicName(view: TopicView): void {
    this.later(`name:${view.chatId}`, EDIT_EVERY_MS, async () => {
      const chat = this.chat(view.chatId)
      if (!chat || this.views.get(chat.id) !== view) return
      const name = this.topicName(chat)
      if (name === view.name) return
      try {
        await this.api!.call('editForumTopic', {
          chat_id: telegramConfig().owner!.chatId,
          message_thread_id: view.thread,
          name
        })
      } catch (error) {
        if (!(error instanceof TelegramError) || !/not.?modified/i.test(error.message)) throw error
      }
      view.name = name
    })
  }

  /** Whether the bot's topics are on, asked again: the user may have just turned them on. */
  private async checkTopics(api: BotApi, signal?: AbortSignal): Promise<boolean> {
    const me = await api.call<TelegramUser>('getMe', {}, signal)
    this.bot = me.username
    const on = me.has_topics_enabled === true
    const was = this.topicsOn
    this.topicsOn = on
    if (on !== was) this.publish()
    if (on && !was) this.moveLinkedChat()
    return on
  }

  /** The chat the bot controlled before chats had topics gets one. */
  private moveLinkedChat(): void {
    const { linkedChatId } = telegramConfig()
    if (!linkedChatId) return
    updateTelegramConfig({ linkedChatId: undefined })
    if (!this.chat(linkedChatId)) return
    this.topicFor(linkedChatId).catch((error) =>
      console.error('Telegram: could not give the linked chat a topic:', error)
    )
  }

  // --- Reading updates ---------------------------------------------------------

  private async poll(api: BotApi, signal: AbortSignal): Promise<void> {
    let backoff = 1000
    while (!signal.aborted) {
      try {
        if (this.topicsOn === undefined) {
          await this.checkTopics(api, signal)
          // Topics of chats deleted while Barebone was closed go, and the rest show how their chats are.
          this.stateChanged()
        }
        if (!this.commandsSet) {
          await api.call(
            'setMyCommands',
            {
              commands: [
                { command: 'status', description: 'How this topic’s chat is doing' },
                { command: 'stop', description: 'Stop this chat and the chats it started' },
                { command: 'new', description: 'Start a new chat in this project' },
                { command: 'projects', description: 'Open another chat or project' },
                { command: 'chats', description: 'See which chats are working or need you' },
                { command: 'model', description: 'Switch the model or provider' },
                { command: 'thinking', description: 'Change the thinking level' },
                { command: 'rename', description: 'Rename this chat' }
              ]
            },
            signal
          )
          this.commandsSet = true
        }
        const updates = await api.call<TelegramUpdate[]>(
          'getUpdates',
          {
            offset: telegramConfig().offset,
            timeout: 50,
            allowed_updates: ['message', 'callback_query', 'stopped_message_generation']
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
    const stopped = update.stopped_message_generation
    if (stopped) {
      const view =
        owner?.chatId === stopped.chat.id ? this.viewOf(stopped.message_thread_id) : undefined
      if (view) await this.stopChat(view.chatId)
      return
    }
    const query = update.callback_query
    if (query) {
      if (query.from.id !== owner?.userId) return
      await this.onButton(query.id, query.data, query.message?.message_id, threadOf(query.message))
      return
    }
    const message = update.message
    if (!message || message.chat.type !== 'private' || !message.from) return
    if (!owner) {
      await this.pair(message)
      return
    }
    if (message.from.id !== owner.userId) return
    if (!this.topicsOn && !(await this.checkTopics(this.api!))) {
      this.say(TOPICS_OFF)
      return
    }
    const thread = threadOf(message)
    if (message.forum_topic_created) {
      // A topic the user made. Telegram makes it with its first message, which comes next
      // and decides what it becomes (see onMessage).
      if (thread !== undefined && !this.viewOf(thread)) {
        this.unclaimed.set(thread, { name: message.forum_topic_created.name })
      }
      return
    }
    if (Date.now() / 1000 - message.date > LATE_S) {
      this.late.set(message.message_id, message)
      this.say('Barebone was offline when you sent this. Send it now?', thread, {
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        reply_markup: this.keyboard([
          [
            this.button(
              'Send now',
              { kind: 'late', send: true, messageId: message.message_id },
              'success'
            ),
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
      this.topicsOn
        ? 'Paired with Barebone. Send /projects to open a chat or start a new one: each chat gets a topic of its own here.'
        : `Paired with Barebone. ${TOPICS_OFF}`
    )
  }

  private async onMessage(message: TelegramMessage): Promise<void> {
    let thread = threadOf(message)
    const text = (message.text ?? message.caption ?? '').trim()
    const target = message.reply_to_message && this.replies.get(message.reply_to_message.message_id)
    if (target && text) {
      this.replies.delete(message.reply_to_message!.message_id)
      if (target.kind === 'field') this.answerField(target.form, target.field, text)
      else if (target.kind === 'rename') this.rename(target.chatId, text, thread)
      else void this.sendTo(target.chatId, text, [], message)
      return
    }
    const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/)
    const arg = command?.[2]?.trim() ?? ''
    const chatId = this.viewOf(thread)?.chatId
    if (thread !== undefined && !chatId) {
      if (command) {
        // With topics on, Telegram has nowhere to write outside them: a message there
        // makes a topic. A command isn't meant as one, so it is answered outside every
        // topic, and the topic it made goes.
        this.dropTopic(thread)
        thread = undefined
      } else {
        // A topic that is no chat: one the user made, or whose chat is gone. What they
        // first wrote goes to the chat they start for it.
        const unclaimed = this.unclaimed.get(thread)
        if (unclaimed?.message) {
          this.say('Pick the project above first, then write again.', thread)
          return
        }
        this.unclaimed.set(thread, { ...unclaimed, message })
        this.offerChat(thread)
        return
      }
    }
    switch (command?.[1]) {
      case 'start':
        this.say(
          chatId
            ? `Paired. This topic is <b>${escapeHtml(this.chat(chatId)!.title)}</b>.`
            : NO_CHAT_HERE,
          thread
        )
        return
      case 'projects':
        this.showPicker(this.projectsView(), thread)
        return
      case 'chats':
        this.openSidebar()
        return
      case 'new': {
        const chat = chatId ? this.chat(chatId) : undefined
        // Outside a chat's topic, the project is picked first.
        if (!chat) {
          this.showPicker(this.projectsView(), thread)
          return
        }
        const note = await this.startChat(chat.projectId, { like: chat })
        if (note) this.say(escapeHtml(note), thread)
        return
      }
      case 'status':
        this.say(chatId ? this.statusText(chatId) : this.sidebarView().html, thread)
        return
    }
    if (!chatId) {
      this.say(NO_CHAT_HERE)
      return
    }
    switch (command?.[1]) {
      case 'stop':
        if (!(await this.stopChat(chatId))) this.say('It isn’t working.', thread)
        return
      case 'rename':
        if (arg) this.rename(chatId, arg, thread)
        else {
          const title = escapeHtml(this.chat(chatId)!.title)
          this.ask(`New name for <b>${title}</b>:`, { kind: 'rename', chatId }, thread)
        }
        return
      case 'model':
        // Read in the background: the agents can take a few seconds to list their models.
        this.showModels(chatId, arg.toLowerCase(), thread).catch((error) =>
          this.say(escapeHtml(`Couldn’t read the models: ${(error as Error).message}`), thread)
        )
        return
      case 'thinking':
        this.showThinking(chatId, thread).catch((error) =>
          this.say(
            escapeHtml(`Couldn’t read the thinking levels: ${(error as Error).message}`),
            thread
          )
        )
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
          this.say('Nothing was heard in that voice note.', thread)
          return
        }
        this.say(`🎙 <i>${escapeHtml(heard)}</i>`, thread, {
          ...SILENT,
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
        const path = await this.saveFile(chatId, name, await this.download(file))
        attachments.push({ name, path, ...(file.mime_type ? { mimeType: file.mime_type } : {}) })
      }
    } catch (error) {
      this.say(escapeHtml((error as Error).message), thread)
      return
    }
    if (!prompt && attachments.length === 0) {
      this.say('Barebone takes text, photos, files and voice notes.', thread)
      return
    }
    void this.sendTo(chatId, prompt, attachments, message)
  }

  /**
   * Send the user's message to a chat. It starts with "Remote:", so the chat
   * (and the user, on the Mac) can tell it came from Telegram, and its agent
   * is pointed to the remote skill (see agents.ts). A slash command is sent as
   * typed, as the agent reads it only at the start of a message. The message
   * in Telegram is marked as it goes: waiting, started, then how it ended.
   */
  private async sendTo(
    chatId: string,
    text: string,
    attachments: Attachment[],
    from: TelegramMessage
  ): Promise<void> {
    const chat = this.chat(chatId)
    if (!chat) {
      this.say('That chat is gone.', threadOf(from))
      return
    }
    const id = randomUUID()
    this.followed.set(id, { chatId, messageId: from.message_id, started: false })
    if (this.followed.size > MAX_FOLLOWED) {
      const [oldest] = this.followed.keys()
      this.followed.delete(oldest)
    }
    // It waits for the turn under way, or joins it at its next step.
    if (chat.running) this.react(from.message_id, MARK_WAITING)
    const marked = text.startsWith('/') ? text : `Remote: ${text}`.trimEnd()
    await this.host.send(chatId, marked, attachments, id).catch((error) => {
      this.followed.delete(id)
      this.react(from.message_id, MARK_END.failed)
      this.say(escapeHtml((error as Error).message), threadOf(from))
    })
  }

  /** Stop a chat and the chats it started; false when none of them worked. */
  private async stopChat(chatId: string): Promise<boolean> {
    const stopping = store
      .getState()
      .chats.filter((c) => (c.id === chatId || c.startedBy === chatId) && c.running)
    await Promise.all(stopping.map((c) => this.host.cancel(c.id)))
    return stopping.length > 0
  }

  private rename(chatId: string, title: string, thread?: number): void {
    if (!this.chat(chatId)) {
      this.say('That chat is gone.', thread)
      return
    }
    this.host.renameChat(chatId, title)
    this.say(`Renamed to <b>${escapeHtml(title.trim())}</b>.`, thread, SILENT)
  }

  private react(messageId: number, emoji: string): void {
    this.enqueue(
      () =>
        this.api!.call('setMessageReaction', {
          chat_id: telegramConfig().owner!.chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji }]
        }),
      UPDATE
    )
  }

  /** A chat's status, for /status in its topic. */
  private statusText(chatId: string): string {
    const chat = this.chat(chatId)!
    const { projects, chats } = store.getState()
    const { startedWorking, mark } = activity(chats)
    const options = this.chatOptions.get(chatId) ?? []
    const thinking = options.find((o) => o.category === 'thought_level')
    const level = thinking?.values.find((v) => v.value === thinking.currentValue)?.name
    const end = this.host.turnEnd(chatId)
    const sentAt = lastUser(chatId)?.sentAt
    const state = chat.waiting
      ? '🟡 Waiting for you'
      : chat.running
        ? `🟢 Working${sentAt ? ` for ${formatDuration(Date.now() - sentAt)}` : ''}`
        : end
          ? { done: '✅ Done', failed: '🔴 Failed', stopped: '⏹ Stopped' }[end.outcome]
          : '⚪ Idle'
    const lines = [
      `<b>${escapeHtml(chat.title)}</b>`,
      `<i>${escapeHtml(projects.find((p) => p.id === chat.projectId)?.name ?? '')}</i>`,
      state,
      `Runs on ${escapeHtml(modelLabel(chat.agent, options))}${level ? ` · thinking ${escapeHtml(level)}` : ''}`
    ]
    if (end?.outcome === 'failed' && !chat.running) {
      lines.push(`Error: ${escapeHtml(cut(end.error.split('\n')[0], 200))}`)
    }
    const queued = chat.waitingMessages?.length ?? 0
    if (queued) lines.push(`${queued} message${queued === 1 ? '' : 's'} waiting to join it`)
    const also = waitingOn(chat, startedWorking(chat))
    if (also) lines.push(escapeHtml(also))
    const led = startedChats(chats).get(chatId) ?? []
    if (led.length) {
      lines.push('', '<b>Chats it started</b>')
      for (const c of led) lines.push(`${mark(c)} ${escapeHtml(cut(c.title, 60))}`)
    }
    return lines.join('\n')
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
  private button(text: string, action: Action, style?: InlineButton['style']): InlineButton {
    const key = JSON.stringify(action)
    let token = this.tokens.get(key)
    if (!token) {
      token = `${this.launch}${(this.nextToken++).toString(36)}`
      this.tokens.set(key, token)
      this.actions.set(token, action)
      if (this.actions.size > MAX_ACTIONS) {
        const [oldest] = this.actions.keys()
        this.tokens.delete(JSON.stringify(this.actions.get(oldest)))
        this.actions.delete(oldest)
      }
    }
    return { text, callback_data: token, ...(style ? { style } : {}) }
  }

  private keyboard(rows: InlineButton[][]): { inline_keyboard: InlineButton[][] } {
    return { inline_keyboard: rows.filter((row) => row.length > 0) }
  }

  private async onButton(
    queryId: string,
    data?: string,
    messageId?: number,
    thread?: number
  ): Promise<void> {
    const action = data ? this.actions.get(data) : undefined
    let note: string | undefined = action ? undefined : 'This button is out of date.'
    if (action) note = await this.act(action, messageId, thread)
    await this.api
      ?.call('answerCallbackQuery', { callback_query_id: queryId, ...(note ? { text: note } : {}) })
      .catch(() => undefined)
  }

  /** Do what a button says; returns a short note to show, if any. */
  private async act(
    action: Action,
    messageId?: number,
    thread?: number
  ): Promise<string | undefined> {
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
        this.ask(
          `Message for <b>${escapeHtml(chat.title)}</b>:`,
          { kind: 'message', chatId: chat.id },
          thread
        )
        return undefined
      }
      case 'open': {
        const had = this.threadFor(action.chatId) !== undefined
        let view: TopicView
        try {
          view = await this.topicFor(action.chatId)
        } catch (error) {
          return (error as Error).message
        }
        // A picker goes once used; the list of chats stays, and a "needs you" goes once answered.
        if (
          messageId !== telegramConfig().sidebarMessageId &&
          ![...this.alerts.values()].includes(messageId)
        ) {
          this.removeMessage(messageId)
        }
        const title = cut(this.chat(view.chatId)?.title ?? '', 60)
        return had ? `It’s in the “${title}” topic.` : `Opened the “${title}” topic.`
      }
      case 'late': {
        const message = this.late.get(action.messageId)
        this.late.delete(action.messageId)
        if (messageId) {
          this.enqueue(() => this.edit(messageId, action.send ? 'Sent.' : 'Dropped.', []), ASK)
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
        return this.formAction(action, thread)
      case 'projects':
        this.showPicker(this.projectsView(), thread, messageId)
        return undefined
      case 'project': {
        const view = this.projectView(action.projectId)
        if (!view) return 'That project is gone.'
        this.showPicker(view, thread, messageId)
        return undefined
      }
      case 'newChat': {
        const name =
          action.thread !== undefined ? this.unclaimed.get(action.thread)?.name : undefined
        const note = await this.startChat(action.projectId, { thread: action.thread, name })
        if (!note) this.removeMessage(messageId)
        return note
      }
      case 'sources': {
        const catalog = this.liveCatalog()
        if (!catalog) return MODELS_OUT_OF_DATE
        this.showPicker(this.sourcesView(catalog), thread, messageId)
        return undefined
      }
      case 'source': {
        const catalog = this.liveCatalog()
        const view = catalog && this.modelsView(catalog, action.key, action.page)
        if (!view) return MODELS_OUT_OF_DATE
        this.showPicker(view, thread, messageId)
        return undefined
      }
      case 'model':
        return this.pickModel(action.key, action.value, messageId, thread)
      case 'thinking': {
        if (!this.chat(action.chatId)) return 'That chat is gone.'
        try {
          await this.host.setOption(action.chatId, action.optionId, action.value)
        } catch (error) {
          this.say(escapeHtml((error as Error).message), thread)
          return undefined
        }
        const done = `Thinking level: <b>${escapeHtml(action.name)}</b>.`
        if (messageId) this.enqueue(() => this.edit(messageId, done, []), ASK)
        return undefined
      }
    }
  }

  // --- Picking a chat ----------------------------------------------------------

  /**
   * The projects, as the sidebar lists them. In a topic the user made, picking
   * one starts a chat there; elsewhere it lists the project's chats.
   */
  private projectsView(thread?: number): Picker {
    const { projects } = store.getState()
    if (projects.length === 0) return { html: 'No projects yet. Add one on the Mac.', rows: [] }
    const buttons = projects.map((p) =>
      this.button(
        p.name,
        thread !== undefined
          ? { kind: 'newChat', projectId: p.id, thread }
          : { kind: 'project', projectId: p.id }
      )
    )
    const rows: InlineButton[][] = []
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2))
    return {
      html:
        thread !== undefined
          ? 'This topic isn’t a chat yet. Pick the project to start one in:'
          : 'Pick a project:',
      rows
    }
  }

  /** A project's latest chats the user started, newest first, and a button for a new one. */
  private projectView(projectId: string): Picker | undefined {
    const { projects, chats } = store.getState()
    const project = projects.find((p) => p.id === projectId)
    if (!project) return undefined
    const own = chats
      .filter((c) => c.projectId === projectId && !c.startedBy)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PICK_CHATS)
    const rows = own.map((c) => [
      this.button(
        `${this.views.has(c.id) ? '💬 ' : ''}${c.title}${c.running ? ' · working' : ''}`,
        { kind: 'open', chatId: c.id }
      )
    ])
    rows.push([
      this.button('+ New chat', { kind: 'newChat', projectId }, 'primary'),
      this.button('‹ Projects', { kind: 'projects' })
    ])
    const lead = own.length ? 'Open a chat in its topic, or start a new one:' : 'No chats yet.'
    return { html: `<b>${escapeHtml(project.name)}</b>\n${lead}`, rows }
  }

  /** Show a picker, in place of the one tapped when there is one. */
  private showPicker(view: Picker, thread?: number, messageId?: number): void {
    this.enqueue(async () => {
      if (messageId) {
        await this.edit(messageId, view.html, view.rows)
      } else {
        await this.sendText({ html: view.html, plain: view.html.replace(/<[^>]+>/g, '') }, thread, {
          ...SILENT,
          reply_markup: this.keyboard(view.rows)
        })
      }
    }, ASK)
  }

  /** Remove a message once it served: a picker once used, a "needs you" once answered. */
  private removeMessage(messageId?: number): void {
    if (!messageId) return
    this.enqueue(
      () =>
        this.api!.call('deleteMessage', {
          chat_id: telegramConfig().owner!.chatId,
          message_id: messageId
        }),
      UPDATE
    )
  }

  /**
   * Start a new chat in a project and give it a topic: `thread`, a topic the
   * user made, or a new one. It takes the agent, model and permissions of
   * `like`, or else of the latest chat the user started: what the window picks
   * for new chats is kept in the window. Returns why it could not, if it could not.
   */
  private async startChat(
    projectId: string,
    { like, thread, name }: { like?: Chat; thread?: number; name?: string } = {}
  ): Promise<string | undefined> {
    const { projects, chats } = store.getState()
    if (!projects.some((p) => p.id === projectId)) return 'That project is gone.'
    const latest = (list: Chat[]): Chat | undefined =>
      list
        .filter((c) => !c.startedBy)
        .reduce<Chat | undefined>((a, c) => (!a || c.updatedAt > a.updatedAt ? c : a), undefined)
    const template = like ?? latest(chats.filter((c) => c.projectId === projectId)) ?? latest(chats)
    if (!template) return 'Start a chat on the Mac first: new chats here take its agent and model.'
    const chat = this.host.createChat(projectId, template)
    if (name) this.host.renameChat(chat.id, name)
    try {
      await this.topicFor(chat.id, thread)
    } catch (error) {
      return (error as Error).message
    }
    const first = thread !== undefined ? this.unclaimed.get(thread)?.message : undefined
    if (thread !== undefined) this.unclaimed.delete(thread)
    if (first) await this.onMessage(first)
    return undefined
  }

  /** Delete a topic that is no chat, made by a command written outside every topic. */
  private dropTopic(thread: number): void {
    this.unclaimed.delete(thread)
    this.deleteTopic(thread)
  }

  /** Offer to start a chat in a topic that is no chat. */
  private offerChat(thread: number): void {
    this.showPicker(this.projectsView(thread), thread)
  }

  // --- The list of chats -------------------------------------------------------

  /**
   * Send the list of chats that work or need the user, and pin it, so it
   * stays at the top as the sidebar does. It is edited as chats change; the
   * one sent before goes.
   */
  private openSidebar(): void {
    const before = telegramConfig().sidebarMessageId
    updateTelegramConfig({ sidebarMessageId: undefined })
    this.sidebarShown = undefined
    this.enqueue(async () => {
      if (before) await this.retireSidebar(before)
      const view = this.sidebarView()
      const id = await this.sendText(
        { html: view.html, plain: view.html.replace(/<[^>]+>/g, '') },
        undefined,
        { ...SILENT, reply_markup: this.keyboard(view.rows) }
      )
      if (!id) return
      this.sidebarShown = `${view.html}${JSON.stringify(view.rows)}`
      updateTelegramConfig({ sidebarMessageId: id })
      await this.api!.call('pinChatMessage', {
        chat_id: telegramConfig().owner!.chatId,
        message_id: id,
        disable_notification: true
      }).catch((error) => console.error('Telegram: could not pin the list of chats:', error))
    }, ASK)
  }

  /**
   * Remove a list of chats a newer one replaces. Telegram lets bots delete
   * only messages under 48 hours old, so an older one is unpinned and says
   * it is out of date instead.
   */
  private async retireSidebar(messageId: number): Promise<void> {
    const chatId = telegramConfig().owner!.chatId
    try {
      await this.api!.call('deleteMessage', { chat_id: chatId, message_id: messageId })
      return
    } catch {
      // Too old to delete, or deleted already: the edit below tells.
    }
    if (
      (await this.edit(
        messageId,
        '<i>An older list of chats. Send /chats for a new one.</i>',
        []
      )) === 'gone'
    )
      return
    await this.api!.call('unpinChatMessage', { chat_id: chatId, message_id: messageId }).catch(
      () => undefined
    )
  }

  /** Bring the list of chats up to date, at most once per EDIT_EVERY_MS. */
  private showSidebar(): void {
    if (!this.api || !telegramConfig().sidebarMessageId) return
    this.later('sidebar', EDIT_EVERY_MS, async () => {
      const messageId = telegramConfig().sidebarMessageId
      if (!messageId) return
      const view = this.sidebarView()
      const shown = `${view.html}${JSON.stringify(view.rows)}`
      if (shown === this.sidebarShown) return
      if ((await this.edit(messageId, view.html, view.rows)) === 'gone') {
        // The user deleted it: /chats sends a new one.
        updateTelegramConfig({ sidebarMessageId: undefined })
        return
      }
      this.sidebarShown = shown
    })
  }

  /**
   * The chats that need the user, then those working, in every project, as
   * the sidebar lists them by status: a chat working because a chat it started
   * works counts as working, and a chat whose lead works is listed under it.
   * The first line sums them up, as it is all the pinned bar shows. Each chat
   * has a button that opens its topic (a chat another chat started, its lead's).
   */
  private sidebarView(): Picker {
    const { projects, chats } = store.getState()
    const names = new Map(projects.map((p) => [p.id, p.name]))
    const { started, startedWorking, working, leadWorking, mark } = activity(chats)
    const newest = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
    const waiting = newest.filter((c) => c.waiting)
    const busy = newest.filter((c) => working(c) && !c.waiting && !leadWorking(c))

    const entry = (chat: Chat): string => {
      const latest = chat.waiting
        ? 'Waiting for approval'
        : (!chat.running && waitingOn(chat, startedWorking(chat))) || chat.preview
      const about = [names.get(chat.projectId), latest].filter(Boolean).join(' · ')
      const lines = [`${mark(chat)} <b>${escapeHtml(cut(chat.title, 60))}</b>`]
      if (about) lines.push(`<i>${escapeHtml(cut(about, 120))}</i>`)
      if (!chat.waiting) {
        for (const led of started.get(chat.id) ?? []) {
          if (working(led) && !led.waiting) {
            lines.push(`${NESTED}${mark(led)} ${escapeHtml(cut(led.title, 60))}`)
          }
        }
      }
      return lines.join('\n')
    }

    const counts = [
      waiting.length ? `${waiting.length} need${waiting.length === 1 ? 's' : ''} you` : '',
      busy.length ? `${busy.length} working` : ''
    ].filter(Boolean)
    if (counts.length === 0) {
      return {
        html: '<b>Nothing is working</b>\nChats show here while they work or need you.',
        rows: []
      }
    }
    const parts = [`<b>${counts.join(' · ')}</b>`]
    let length = parts[0].length
    let left = 0
    const listed: Chat[] = []
    for (const [label, list] of [
      ['Needs you', waiting],
      ['Working', busy]
    ] as const) {
      let head = list.length ? `\n<b>${label}</b>` : ''
      for (const chat of list) {
        const text = `${head}\n${entry(chat)}`
        // Once one doesn't fit, the rest are counted: a shorter one after it would break the order.
        if (left || length + text.length + 1 > SIDEBAR_TEXT) {
          left++
          continue
        }
        parts.push(text)
        length += text.length + 1
        head = ''
        listed.push(chat)
      }
    }
    if (left) parts.push(`\n<i>${left} more on the Mac.</i>`)
    const rows = listed.map((c) => [
      this.button(`${mark(c)} ${c.title}`, { kind: 'open', chatId: c.id })
    ])
    if (rows.length) parts.push('\n<i>Tap a chat to open its topic.</i>')
    return { html: parts.join('\n'), rows }
  }

  /**
   * A chat that needs the user and isn't in any topic gets one message that
   * buzzes, with a button that opens its topic; it goes once the chat is
   * answered or opened.
   */
  private showAlerts(): void {
    const { chats, projects } = store.getState()
    const followed = (chat: Chat): boolean => this.threadFor(chat.id) !== undefined
    for (const chat of chats) {
      if (!chat.waiting || followed(chat) || this.alerts.has(chat.id)) continue
      this.alerts.set(chat.id, undefined)
      const project = projects.find((p) => p.id === chat.projectId)?.name
      const html = `🟡 <b>${escapeHtml(cut(chat.title, 60))}</b> needs you${project ? `\n<i>${escapeHtml(project)}</i>` : ''}`
      this.enqueue(async () => {
        if (!this.alerts.has(chat.id)) return
        const id = await this.sendText({ html, plain: html.replace(/<[^>]+>/g, '') }, undefined, {
          reply_markup: this.keyboard([
            [this.button('Open', { kind: 'open', chatId: chat.id }, 'primary')]
          ])
        })
        if (this.alerts.has(chat.id)) this.alerts.set(chat.id, id)
        else this.removeMessage(id)
      }, ASK)
    }
    for (const [chatId, messageId] of this.alerts) {
      const chat = this.chat(chatId)
      if (chat?.waiting && !followed(chat)) continue
      this.alerts.delete(chatId)
      this.removeMessage(messageId)
    }
  }

  // --- Picking a model and thinking level --------------------------------------

  /** Read the models a chat can switch to, then show them, or the ones `query` finds. */
  private async showModels(chatId: string, query: string, thread?: number): Promise<void> {
    const chat = this.chat(chatId)
    if (!chat) return
    this.typing(thread)
    const catalog = await this.readModels(chat)
    this.catalog = catalog
    this.showPicker(query ? this.searchView(catalog, query) : this.sourcesView(catalog), thread)
  }

  /** Every installed agent's models, as the window's model picker reads them when it opens. */
  private async readModels(chat: Chat): Promise<Catalog> {
    const [{ options }, lists] = await Promise.all([
      this.host.openChat(chat.id),
      Promise.all(
        AGENTS.map(async ({ id }) =>
          (await this.host.agentStatus(id)).available
            ? { agent: id, models: await this.host.agentModels(id, chat.projectId) }
            : undefined
        )
      )
    ])
    const live = modelOptions(options)
    const current = sourceKey(chat.agent, live.source?.currentValue)
    const sources: Source[] = []
    for (const list of lists) {
      if (!list) continue
      for (const { setting, option } of list.models.sources) {
        const key = sourceKey(list.agent, setting?.value)
        // The chat's own list is the live one: it knows the current model.
        sources.push({
          key,
          agent: list.agent,
          setting,
          option: key === current && live.model ? live.model : option
        })
      }
    }
    return { chatId: chat.id, current, options, sources }
  }

  /** The models read last, while their chat is still there. */
  private liveCatalog(): Catalog | undefined {
    const catalog = this.catalog
    return catalog && this.chat(catalog.chatId) ? catalog : undefined
  }

  /** Every agent and provider with models, the chat's own ticked. */
  private sourcesView(catalog: Catalog): Picker {
    const chat = this.chat(catalog.chatId)
    const now = chat
      ? `<b>${escapeHtml(chat.title)}</b> is on <b>${escapeHtml(modelLabel(chat.agent, catalog.options))}</b>.\n`
      : ''
    if (catalog.sources.length === 0) return { html: `${now}No agent listed its models.`, rows: [] }
    const buttons = catalog.sources.map((s) =>
      this.button(`${s.key === catalog.current ? '✓ ' : ''}${sourceName(s)}`, {
        kind: 'source',
        key: s.key,
        page: 0
      })
    )
    const rows: InlineButton[][] = []
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2))
    return { html: `${now}Pick an agent or provider:`, rows }
  }

  /** A page of one agent's or provider's models. */
  private modelsView(catalog: Catalog, key: string, page: number): Picker | undefined {
    const source = catalog.sources.find((s) => s.key === key)
    if (!source) return undefined
    const { values, currentValue } = source.option
    const pages = Math.max(1, Math.ceil(values.length / PICK_MODELS))
    const at = Math.min(Math.max(page, 0), pages - 1)
    const rows = values.slice(at * PICK_MODELS, (at + 1) * PICK_MODELS).map((v) => [
      this.button(`${key === catalog.current && v.value === currentValue ? '✓ ' : ''}${v.name}`, {
        kind: 'model',
        key,
        value: v.value
      })
    ])
    rows.push([
      ...(at > 0 ? [this.button('‹ Prev', { kind: 'source', key, page: at - 1 })] : []),
      ...(at < pages - 1 ? [this.button('Next ›', { kind: 'source', key, page: at + 1 })] : []),
      this.button('‹ Providers', { kind: 'sources' })
    ])
    const counted = pages > 1 ? `, page ${at + 1} of ${pages}` : ''
    const lead = values.length ? 'Pick a model:' : 'It lists no models.'
    return { html: `<b>${escapeHtml(sourceName(source))}</b>${counted}\n${lead}`, rows }
  }

  /** The models of every agent and provider whose name or id has `query` in it. */
  private searchView(catalog: Catalog, query: string): Picker {
    const found = catalog.sources.flatMap((source) =>
      source.option.values
        .filter((v) => [v.name, v.value].some((text) => text.toLowerCase().includes(query)))
        .map((v) => ({ source, v }))
    )
    const back = [this.button('All providers', { kind: 'sources' })]
    if (found.length === 0) {
      return { html: `No model matches “${escapeHtml(query)}”.`, rows: [back] }
    }
    const rows = found.slice(0, PICK_MODELS).map(({ source, v }) => [
      this.button(`${v.name} · ${sourceName(source)}`, {
        kind: 'model',
        key: source.key,
        value: v.value
      })
    ])
    rows.push(back)
    const more =
      found.length > PICK_MODELS
        ? ` The first ${PICK_MODELS} of ${found.length}; add to the search to narrow it.`
        : ''
    return { html: `Models matching “${escapeHtml(query)}”:${more}`, rows }
  }

  /**
   * Put the chat on a model, as the window's model picker does: on its own
   * agent by setting the provider, then the model; on another agent by
   * switching to it, which the agent refuses while the chat works.
   */
  private async pickModel(
    key: string,
    value: string,
    messageId?: number,
    thread?: number
  ): Promise<string | undefined> {
    const catalog = this.liveCatalog()
    const chat = catalog && this.chat(catalog.chatId)
    const source = catalog?.sources.find((s) => s.key === key)
    const picked = source?.option.values.find((v) => v.value === value)
    if (!catalog || !chat || !source || !picked) return MODELS_OUT_OF_DATE
    if (key === catalog.current && value === source.option.currentValue) return 'Already on it.'
    const settings: [string, string][] = source.setting
      ? [[source.setting.optionId, source.setting.value]]
      : []
    settings.push([source.option.id, value])
    try {
      if (source.agent !== chat.agent) {
        await this.host.changeAgent(chat.id, source.agent, Object.fromEntries(settings))
      } else {
        // In order: the model list depends on the provider set before it.
        for (const [optionId, v] of settings) {
          const now = catalog.options.find((o) => o.id === optionId)?.currentValue
          if (now !== v) await this.host.setOption(chat.id, optionId, v)
        }
      }
    } catch (error) {
      this.say(escapeHtml((error as Error).message), thread)
      return undefined
    }
    this.catalog = undefined
    const done = `Now on <b>${escapeHtml(`${sourceName(source)} · ${picked.name}`)}</b>.`
    if (messageId) this.enqueue(() => this.edit(messageId, done, []), ASK)
    else this.say(done, thread)
    return undefined
  }

  /** The thinking levels the chat's model offers, read from its session. */
  private async showThinking(chatId: string, thread?: number): Promise<void> {
    const chat = this.chat(chatId)
    if (!chat) return
    this.typing(thread)
    const { options, error } = await this.host.openChat(chatId)
    if (error) {
      this.say(escapeHtml(`Couldn’t open the chat: ${error}`), thread)
      return
    }
    const on = modelLabel(chat.agent, options)
    const thinking = options.find((o) => o.category === 'thought_level')
    if (!thinking) {
      this.say(`<b>${escapeHtml(on)}</b> has no thinking levels to pick.`, thread)
      return
    }
    const buttons = thinking.values.map((v) =>
      this.button(`${v.value === thinking.currentValue ? '✓ ' : ''}${v.name}`, {
        kind: 'thinking',
        chatId,
        optionId: thinking.id,
        value: v.value,
        name: v.name
      })
    )
    const rows: InlineButton[][] = []
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3))
    this.showPicker({ html: `Thinking level for <b>${escapeHtml(on)}</b>:`, rows }, thread)
  }

  /** Show "typing…" while something slow is read for the user. */
  private typing(thread?: number): void {
    const chatId = telegramConfig().owner?.chatId
    if (!this.api || chatId === undefined) return
    this.api
      .call('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
        ...(thread !== undefined ? { message_thread_id: thread } : {})
      })
      .catch(() => undefined)
  }

  /** Ask the user to reply to a message; the reply goes where `target` says. */
  private ask(html: string, target: ReplyTarget, thread?: number): void {
    this.enqueue(async () => {
      const id = await this.sendText({ html, plain: html.replace(/<[^>]+>/g, '') }, thread, {
        reply_markup: { force_reply: true, input_field_placeholder: 'Reply here' }
      })
      if (id) this.replies.set(id, target)
    }, ASK)
  }

  // --- Events from the chats ---------------------------------------------------

  /** An item of a chat was added or changed. */
  item(chatId: string, item: ChatItem): void {
    if (!this.api || !telegramConfig().owner) return
    if (item.kind === 'user') this.markStarted(item.id)
    const chat = this.chat(chatId)
    if (!chat) return
    const own = this.views.get(chatId)
    if (own) {
      this.topicItem(own, item)
    } else {
      const lead = chat.startedBy ? this.views.get(chat.startedBy) : undefined
      if (!lead) return
      this.workerItem(lead, chat, item)
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
    const { owner, topics } = telegramConfig()
    if (!this.api || !owner) return
    this.showSidebar()
    if (this.topicsOn !== true) return
    // A chat deleted, on the Mac or while Barebone was closed, takes its topic with it.
    for (const chatId of Object.keys(topics ?? {})) {
      if (!this.chat(chatId)) this.removeTopic(chatId, true)
    }
    const { chats } = store.getState()
    for (const view of this.views.values()) {
      this.showTopicName(view)
      for (const chat of chats) {
        if (chat.startedBy === view.chatId && chat.running && !view.cards.has(chat.id)) {
          view.cards.set(chat.id, { title: chat.title })
        }
      }
      for (const chatId of view.cards.keys()) this.showCard(view, chatId)
    }
    this.showAlerts()
  }

  /**
   * A chat's turn ended, and how (undefined when it goes on in the next one):
   * the user's messages it took are marked, and its topic gets the turn's message.
   */
  turnEnded(chatId: string, end: TurnEnd | undefined): void {
    if (!end) return
    for (const [id, sent] of this.followed) {
      if (sent.chatId !== chatId || !sent.started) continue
      this.followed.delete(id)
      this.react(sent.messageId, MARK_END[end.outcome])
    }
    const view = this.views.get(chatId)
    const turn = view?.turn
    if (!view || !turn) return
    view.turn = undefined
    clearInterval(turn.keep)
    const shown: TurnView = {
      items: [],
      elapsedMs: Date.now() - turn.startedAt,
      end: { outcome: end.outcome }
    }
    this.enqueue(async () => {
      if (this.views.get(chatId) !== view) return
      shown.items = this.turnItems(chatId, turn)
      if (!this.noRich) {
        try {
          for (const html of turnFinal(shown)) await this.sendRich(html, view.thread)
          this.richFailures = 0
          return
        } catch (error) {
          if (!this.richRefused(error)) throw error
        }
      }
      for (const out of turnFinalPlain(shown)) await this.sendText(out, view.thread)
    }, ANSWER)
  }

  /** A video an agent recorded was saved. */
  video(chatId: string, video: Recorded): void {
    const thread = this.threadFor(chatId)
    if (!this.api || thread === undefined) return
    const caption = this.tagOf(chatId)
    if (video.bytes > MAX_UPLOAD) {
      this.say(
        `${caption ? `<b>${escapeHtml(caption)}</b>: ` : ''}a ${(video.bytes / 1e6).toFixed(1)} MB video is over Telegram’s 50 MB limit for bots. It is on the Mac at <code>${escapeHtml(video.path)}</code>.`,
        thread,
        SILENT
      )
      return
    }
    this.sendMedia('sendVideo', 'video', video.path, thread, caption).catch((error) =>
      this.say(escapeHtml(`Couldn’t send a video: ${(error as Error).message}`), thread, SILENT)
    )
  }

  /** Whether send_file can be offered: a user is paired, and topics are on. */
  sendsFiles(): boolean {
    return Boolean(this.api && telegramConfig().owner && this.topicsOn)
  }

  /** Send a file a chat's agent picked (send_file) to the chat's topic. */
  async sendFile(chatId: string, path: string, caption?: string): Promise<string> {
    const chat = this.chat(chatId)
    const thread = chat ? this.threadFor(chat.id) : undefined
    if (!chat || thread === undefined || !this.api) {
      throw new Error(
        'The user doesn’t follow this chat in Telegram, so there is nowhere to send it. Tell them where the file is instead.'
      )
    }
    const file = await realpath(path).catch(() => {
      throw new Error(`There is no file at ${path}.`)
    })
    const info = await stat(file)
    if (!info.isFile()) throw new Error(`${path} is not a file.`)
    if (chat.projectOnly) {
      const project = await realpath(store.getProject(chat.projectId).path)
      const inside = relative(project, file)
      if (inside.startsWith('..') || isAbsolute(inside)) {
        throw new Error('This chat works only inside its project, and the file is outside it.')
      }
    }
    if (info.size > MAX_UPLOAD) {
      throw new Error(
        `The file is ${(info.size / 1e6).toFixed(1)} MB, and Telegram takes up to 50 MB from bots.`
      )
    }
    const ext = extname(file).toLowerCase()
    const kind =
      PHOTOS.has(ext) && info.size <= MAX_PHOTO ? 'photo' : VIDEOS.has(ext) ? 'video' : 'document'
    const method = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument' }[kind]
    const label = [this.tagOf(chatId), caption].filter(Boolean).join(': ')
    await this.sendMedia(method, kind, file, thread, label || undefined)
    return `Sent ${basename(file)} to the user's phone, as a ${kind === 'document' ? 'file' : kind}.`
  }

  // --- A chat's topic ------------------------------------------------------------

  private topicItem(view: TopicView, item: ChatItem): void {
    const fresh = !view.seen.has(item.id)
    view.seen.add(item.id)
    switch (item.kind) {
      case 'user':
        if (!fresh) return
        this.startTurn(view, item.sentAt)
        // A message written on the Mac shows here too, so the answer that follows makes sense.
        if (!item.from && !this.followed.has(item.id) && !item.text.startsWith('Remote:')) {
          this.say(`🖥 <i>${escapeHtml(cut(item.text, 500))}</i>`, view.thread, SILENT, UPDATE)
        }
        return
      case 'text':
      case 'tool': {
        if (item.kind === 'tool' && item.parentId) return
        if (fresh) (view.turn ?? this.startTurn(view)).ids.push(item.id)
        this.showLive(view)
        return
      }
      case 'permission':
        this.showPermission(view, view.chatId, item)
        return
      case 'form':
        this.showForm(view.chatId, item)
        return
      case 'error':
      case 'notice':
        if (view.posted.has(item.id)) return
        view.posted.add(item.id)
        for (const out of plainMessages(item.kind === 'error' ? `⚠️ ${item.text}` : item.text)) {
          this.enqueue(
            () => this.sendText(out, view.thread, item.kind === 'error' ? {} : SILENT),
            ANSWER
          )
        }
        return
      default:
        return
    }
  }

  /** A turn begins (or goes on, when a message joined it): its draft shows at once. */
  private startTurn(view: TopicView, sentAt?: number): LiveTurn {
    if (view.turn) return view.turn
    const turn: LiveTurn = {
      ids: [],
      startedAt: sentAt ?? Date.now(),
      draftId: this.nextDraft++,
      keep: setInterval(() => this.showLive(view, 0), DRAFT_KEEP_MS)
    }
    view.turn = turn
    this.showLive(view, 0)
    return turn
  }

  private turnItems(chatId: string, turn: LiveTurn): (TextItem | ToolItem)[] {
    return turn.ids
      .map((id) => store.findItem(chatId, id))
      .filter((i): i is TextItem | ToolItem => i?.kind === 'text' || (!!i && isTopTool(i)))
  }

  /**
   * The turn as a draft: what it does, its steps and the text it writes, with
   * a Stop button. Telegram shows a draft for 30 seconds, and hides it once
   * the bot sends anything, so it is sent again then (see redraw).
   */
  private showLive(view: TopicView, delay = DRAFT_EVERY_MS): void {
    this.later(`live:${view.chatId}`, delay, async () => {
      const turn = view.turn
      if (!turn || this.views.get(view.chatId) !== view || this.noDrafts) return
      const shown: TurnView = {
        items: this.turnItems(view.chatId, turn),
        elapsedMs: Date.now() - turn.startedAt
      }
      const params = {
        chat_id: telegramConfig().owner!.chatId,
        message_thread_id: view.thread,
        draft_id: turn.draftId,
        can_stop: true
      }
      if (!this.noRich) {
        try {
          await this.api!.call('sendRichMessageDraft', {
            ...params,
            rich_message: { html: turnLive(shown) }
          })
          this.richFailures = 0
          return
        } catch (error) {
          if (!this.richRefused(error)) throw error
        }
      }
      try {
        await this.api!.call('sendMessageDraft', { ...params, text: turnLivePlain(shown) })
      } catch (error) {
        // The turn still comes once it ends; it is only not shown as it goes.
        if (!(error instanceof TelegramError) || error.code !== 400) throw error
        this.noDrafts = true
        console.error('Telegram: drafts refused, turns come when they end:', error.message)
      }
    })
  }

  /** Something was sent to a topic, which hides its draft: show it again. */
  private redraw(thread: number | undefined): void {
    const view = this.viewOf(thread)
    if (view?.turn) this.showLive(view)
  }

  /**
   * Whether a rich message failed on Telegram's side, so the plainer one goes
   * instead; after a few in a row, or when Telegram has no rich messages,
   * only plain ones are tried.
   */
  private richRefused(error: unknown): boolean {
    if (!(error instanceof TelegramError) || error.code === 429 || error.code >= 500) return false
    console.error('Telegram: a rich message was refused:', error.message)
    if (error.code === 404 || ++this.richFailures >= 3) this.noRich = true
    return true
  }

  private showPermission(
    view: TopicView,
    chatId: string,
    item: PermissionItem,
    tag?: string
  ): void {
    if (item.auto) return
    const asked = view.asked.get(item.id)
    if (item.resolved === undefined && asked === undefined && !view.posted.has(item.id)) {
      view.posted.add(item.id)
      this.enqueue(async () => {
        const now = store.findItem(chatId, item.id)
        if (now?.kind !== 'permission' || now.resolved !== undefined) return
        const html = permissionText(now, tag)
        const id = await this.sendText({ html, plain: html.replace(/<[^>]+>/g, '') }, view.thread, {
          reply_markup: this.keyboard(this.permissionButtons(chatId, now))
        })
        if (!id) return
        view.asked.set(item.id, id)
        // Answered on the Mac while it was being sent.
        const after = store.findItem(chatId, item.id)
        if (after?.kind === 'permission' && after.resolved !== undefined) {
          this.showPermission(view, chatId, after, tag)
        }
      }, ASK)
    } else if (item.resolved !== undefined && asked !== undefined) {
      view.asked.delete(item.id)
      this.enqueue(() => this.edit(asked, resolvedText(item, tag), []).then(() => undefined), ASK)
    }
  }

  /** A permission's options as buttons: allowing in green, refusing in red. */
  private permissionButtons(chatId: string, item: PermissionItem): InlineButton[][] {
    const buttons = item.options.map((o) =>
      this.button(
        o.name,
        { kind: 'permission', chatId, permissionId: item.id, optionId: o.optionId },
        o.kind.startsWith('allow') ? 'success' : o.kind.startsWith('reject') ? 'danger' : undefined
      )
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
      if (messageId) {
        this.enqueue(() => this.edit(messageId, formDone(item, tag), []).then(() => undefined), ASK)
      }
      return
    }
    if (form) return
    form = { chatId, formId: item.id, answers: formDefaults(item.fields) }
    this.forms.set(key, form)
    this.renderForm(key, tag)
  }

  private renderForm(key: string, tag?: string): void {
    this.later(
      `form:${key}`,
      0,
      async () => {
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
            this.threadFor(form.chatId),
            { reply_markup: this.keyboard(rows) }
          )
        }
      },
      ASK
    )
  }

  private formButtons(key: string, item: FormItem, answers: FormAnswers): InlineButton[][] {
    if (item.url) {
      return [
        [
          this.button('Open on the Mac', { kind: 'formOpen', form: key }, 'primary'),
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
      this.button('Send', { kind: 'formSend', form: key }, 'success'),
      this.button('Decline', { kind: 'formDecline', form: key })
    ])
    return rows
  }

  private formAction(
    action: Extract<Action, { kind: 'pick' | 'ask' | 'formSend' | 'formDecline' | 'formOpen' }>,
    thread?: number
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
        this.ask(
          `Your answer to <b>${escapeHtml(field.title)}</b>:`,
          { kind: 'field', form: action.form, field: field.key },
          thread
        )
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
    const thread = form && this.threadFor(form.chatId)
    if (!form || item?.kind !== 'form' || item.resolved !== undefined) {
      this.say('That question was answered already.', thread)
      return
    }
    const field = item.fields.find((f) => f.key === fieldKey)
    if (!field) return
    if (field.type === 'number' || field.type === 'integer') {
      const value = Number(text.replace(',', '.'))
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) {
        this.say(
          `<b>${escapeHtml(field.title)}</b> takes ${field.type === 'integer' ? 'a whole number' : 'a number'}.`,
          thread
        )
        return
      }
      form.answers[field.key] = value
    } else {
      form.answers[field.key] = text
    }
    this.renderForm(key, this.tagOf(form.chatId))
  }

  /** How a chat's messages are labelled: chats another chat started by their title; one in its own topic not at all. */
  private tagOf(chatId: string): string | undefined {
    return this.views.has(chatId) ? undefined : this.chat(chatId)?.title
  }

  // --- The chats a topic's chat started ----------------------------------------

  private workerItem(lead: TopicView, chat: Chat, item: ChatItem): void {
    if (!lead.cards.has(chat.id)) lead.cards.set(chat.id, { title: chat.title })
    // Questions come as messages of their own, which buzz; the card only says it asks.
    if (item.kind === 'form') this.showForm(chat.id, item, chat.title)
    if (item.kind === 'permission') this.showPermission(lead, chat.id, item, chat.title)
    this.showCard(lead, chat.id)
  }

  private showCard(view: TopicView, chatId: string): void {
    const card = view.cards.get(chatId)
    if (!card) return
    this.later(`card:${chatId}`, card.messageId ? EDIT_EVERY_MS : 500, async () => {
      if (this.views.get(view.chatId) !== view) return
      const chat = this.chat(chatId)
      const shownCard = chat ? this.cardView(chat, card) : undefined
      const html = shownCard
        ? workerCard(shownCard.card)
        : workerCard({
            title: card.title,
            runsOn: '',
            state: 'deleted',
            progress: card.last ?? { calls: [] }
          })
      const rows = shownCard?.rows ?? []
      const shown = `${html}${JSON.stringify(rows)}`
      if (!chat) view.cards.delete(chatId)
      if (shown === card.shown) return
      card.shown = shown
      if (card.messageId) {
        if ((await this.edit(card.messageId, html, rows)) === 'gone') card.messageId = undefined
      } else if (chat) {
        card.messageId = await this.sendText(
          { html, plain: html.replace(/<[^>]+>/g, '') },
          view.thread,
          { ...SILENT, reply_markup: this.keyboard(rows) }
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
    const rows: InlineButton[][] = [
      [
        this.button('Message', { kind: 'message', chatId: chat.id }),
        ...(chat.running ? [this.button('Stop', { kind: 'stop', chatId: chat.id }, 'danger')] : [])
      ]
    ]
    return {
      card: {
        title: chat.title,
        runsOn: modelLabel(chat.agent, this.chatOptions.get(chat.id) ?? []),
        state,
        progress,
        waiting: permission ? (permission.question ?? permission.title) : form?.message,
        error: end?.outcome === 'failed' ? end.error.split('\n')[0] : undefined
      },
      rows
    }
  }

  private sendImages(chatId: string, files: string[]): void {
    const thread = this.threadFor(chatId)
    if (thread === undefined) return
    const caption = this.tagOf(chatId)
    for (const file of files) {
      const key = `${chatId}/${file}`
      if (this.sentImages.has(key)) continue
      this.sentImages.add(key)
      void chatImagePath(chatId, file)
        .then(async (path) => {
          const photo = (await stat(path)).size <= MAX_PHOTO
          await this.sendMedia(
            photo ? 'sendPhoto' : 'sendDocument',
            photo ? 'photo' : 'document',
            path,
            thread,
            caption
          )
        })
        .catch((error) =>
          this.say(
            escapeHtml(`Couldn’t send an image: ${(error as Error).message}`),
            thread,
            SILENT
          )
        )
    }
  }

  // --- Sending -----------------------------------------------------------------

  /**
   * Run a send once the ones before it of the same or a higher priority are
   * done and Telegram's pace allows; dropped if the bot stopped since.
   */
  private enqueue(task: () => Promise<unknown>, priority: Priority = UPDATE): void {
    this.pending.push({ priority, generation: this.generation, task })
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.pending.length > 0) {
        // Picked once Telegram's pace allows, so a question queued meanwhile goes first.
        const wait = this.lastCall + CALL_GAP_MS - Date.now()
        if (wait > 0) await sleep(wait)
        let at = 0
        for (let i = 1; i < this.pending.length; i++) {
          if (this.pending[i].priority < this.pending[at].priority) at = i
        }
        const [next] = this.pending.splice(at, 1)
        if (next.generation !== this.generation || !this.api) continue
        try {
          await next.task()
        } catch (error) {
          console.error('Telegram: could not send:', (error as Error).message)
        } finally {
          this.lastCall = Date.now()
        }
      }
    } finally {
      this.pumping = false
    }
  }

  /**
   * Send what is true when it runs, at most once per `delay`: calls while one
   * is due join it.
   */
  private later(
    key: string,
    delay: number,
    run: () => Promise<void>,
    priority: Priority = UPDATE
  ): void {
    if (this.due.has(key)) return
    this.due.add(key)
    const generation = this.generation
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (generation !== this.generation) return
      this.enqueue(async () => {
        this.due.delete(key)
        await run()
      }, priority)
    }, delay)
    this.timers.add(timer)
  }

  /** A message of the bridge's own, queued: in a topic, or outside them all. */
  private say(html: string, thread?: number, extra: object = {}, priority: Priority = ASK): void {
    this.enqueue(
      () => this.sendText({ html, plain: html.replace(/<[^>]+>/g, '') }, thread, extra),
      priority
    )
  }

  /**
   * Send a photo, video or file to a topic, after the media sent before it;
   * resolves once Telegram has it.
   */
  private sendMedia(
    method: string,
    field: string,
    path: string,
    thread: number,
    caption?: string
  ): Promise<void> {
    const generation = this.generation
    const run = this.media.then(async () => {
      if (generation !== this.generation || !this.api) throw new Error('The Telegram bot stopped.')
      const wait = this.lastMedia + CALL_GAP_MS - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        await this.api.upload(method, field, path, {
          chat_id: telegramConfig().owner!.chatId,
          message_thread_id: thread,
          disable_notification: true,
          ...(method === 'sendVideo' ? { supports_streaming: true } : {}),
          ...(caption ? { caption: cut(caption, MAX_CAPTION) } : {})
        })
      } catch (error) {
        if (lostThread(error)) this.lostTopic(thread)
        throw error
      } finally {
        this.lastMedia = Date.now()
      }
      this.redraw(thread)
    })
    this.media = run.catch(() => undefined)
    return run
  }

  /** Send a message; when Telegram cannot read its HTML, as plain text. Returns its id. */
  private async sendText(
    out: OutText,
    thread?: number,
    extra: object = {}
  ): Promise<number | undefined> {
    const chatId = telegramConfig().owner?.chatId
    if (!this.api || chatId === undefined) return undefined
    const params = {
      chat_id: chatId,
      link_preview_options: { is_disabled: true },
      ...(thread !== undefined ? { message_thread_id: thread } : {}),
      ...extra
    }
    try {
      let sent: { message_id: number }
      try {
        sent = await this.api.call('sendMessage', { ...params, text: out.html, parse_mode: 'HTML' })
      } catch (error) {
        if (!unreadableHtml(error)) throw error
        sent = await this.api.call('sendMessage', { ...params, text: out.plain })
      }
      this.redraw(thread)
      return sent.message_id
    } catch (error) {
      if (thread === undefined || !lostThread(error)) throw error
      this.lostTopic(thread)
      return undefined
    }
  }

  /** Send a rich message to a topic (core.telegram.org/bots/api#sendrichmessage). */
  private async sendRich(html: string, thread: number): Promise<void> {
    try {
      await this.api!.call('sendRichMessage', {
        chat_id: telegramConfig().owner!.chatId,
        message_thread_id: thread,
        rich_message: { html }
      })
    } catch (error) {
      if (!lostThread(error)) throw error
      this.lostTopic(thread)
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

  /** A user's message became an item of the chat it was sent to: it started. */
  private markStarted(itemId: string): void {
    const sent = this.followed.get(itemId)
    if (!sent || sent.started) return
    sent.started = true
    this.react(sent.messageId, MARK_STARTED)
  }

  private chat(chatId: string): Chat | undefined {
    return store.getState().chats.find((c) => c.id === chatId)
  }
}

function newView(chatId: string, thread: number): TopicView {
  return {
    chatId,
    thread,
    seen: new Set(),
    posted: new Set(),
    asked: new Map(),
    cards: new Map()
  }
}

/** The topic a message is in; none for one outside every topic. */
function threadOf(message?: { message_thread_id?: number }): number | undefined {
  const thread = message?.message_thread_id
  return thread && thread !== GENERAL_THREAD ? thread : undefined
}

/**
 * How chats are doing, as the sidebar tells: a chat works while a chat it
 * started works.
 */
function activity(chats: Chat[]): {
  started: Map<string, Chat[]>
  startedWorking: (chat: Chat) => number
  working: (chat: Chat) => boolean
  leadWorking: (chat: Chat) => boolean
  mark: (chat: Chat) => string
} {
  const byId = new Map(chats.map((c) => [c.id, c]))
  const started = startedChats(chats)
  const startedWorking = (chat: Chat): number =>
    started.get(chat.id)?.filter((c) => c.running).length ?? 0
  const working = (chat: Chat): boolean =>
    chat.running || Boolean(chat.background) || startedWorking(chat) > 0
  const leadWorking = (chat: Chat): boolean => {
    const lead = chat.startedBy ? byId.get(chat.startedBy) : undefined
    return Boolean(lead && working(lead) && !lead.waiting)
  }
  const mark = (chat: Chat): string => (chat.waiting ? '🟡' : chat.running ? '🟢' : '⏳')
  return { started, startedWorking, working, leadWorking, mark }
}

const agentLabel = (agent: AgentId): string => AGENTS.find((a) => a.id === agent)?.label ?? agent

/** A source's key: its agent, and its provider when the agent has several. */
const sourceKey = (agent: AgentId, provider?: string): string => `${agent}:${provider ?? ''}`

/** "Cline · OpenRouter": the agent, and the provider when it has several. */
function sourceName(source: Source): string {
  return [agentLabel(source.agent), source.setting?.name].filter(Boolean).join(' · ')
}

/**
 * "Claude Code · Haiku 4.5": the agent, its provider when it has several, and
 * its model once the agent said which.
 */
function modelLabel(agent: AgentId, options: AgentOption[]): string {
  const { model, source } = modelOptions(options)
  const chosen = (o?: AgentOption): string | undefined =>
    o?.values.find((v) => v.value === o.currentValue)?.name
  return [agentLabel(agent), chosen(source), chosen(model)].filter(Boolean).join(' · ')
}

function unreadableHtml(error: unknown): boolean {
  return (
    error instanceof TelegramError && error.code === 400 && /parse entities/i.test(error.message)
  )
}

/** Telegram refused a send because its topic is gone: the user deleted it. */
function lostThread(error: unknown): boolean {
  return (
    error instanceof TelegramError && error.code === 400 && /thread not found/i.test(error.message)
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
