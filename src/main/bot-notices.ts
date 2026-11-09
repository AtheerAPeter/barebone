import { Notification, type BrowserWindow } from 'electron'
import { lastAnswer, type TurnEnd } from './agents'
import { botConversation } from './bots'
import * as store from './store'

/**
 * macOS notifications for bots that reach out by themselves: a turn in a
 * bot's conversation the user did not start (a routine, say) ended with an
 * answer, or the bot waits for the user's OK. Only while the user is not
 * looking at that conversation; clicking one opens it.
 */
export class BotNotices {
  /** The chat the window shows, as it tells (window:chat); undefined when it shows none. */
  private shown: string | undefined
  /** Bots' conversations waiting for the user, so each wait is told once. */
  private readonly waiting = new Set<string>()
  /** Notifications on screen. Kept, as one that is collected loses its click. */
  private readonly onScreen = new Set<Notification>()

  constructor(
    private readonly window: () => BrowserWindow | undefined,
    /** Bring the window forward with the chat open. */
    private readonly open: (chatId: string) => void
  ) {}

  /** The window shows this chat now, or none (another view, or no chat). */
  showing(chatId: string | undefined): void {
    this.shown = chatId
  }

  /** A turn ended: tell its answer when a bot started it on its own. */
  turnEnded(chatId: string, end: TurnEnd | undefined): void {
    if (end?.outcome !== 'done') return
    const bot = this.botOf(chatId)
    if (!bot) return
    // The turn's message: one the app sent (a routine, a timer) rather than the user.
    const started = store.getMessages(chatId).findLast((item) => item.kind === 'user')
    if (started?.kind !== 'user' || !started.from) return
    const line = firstLine(lastAnswer(chatId) ?? '')
    if (line) this.show(chatId, bot, line)
  }

  /** Chats changed: tell each bot that started waiting for the user. */
  stateChanged(): void {
    for (const chat of store.getState().chats) {
      if (!chat.waiting) {
        this.waiting.delete(chat.id)
        continue
      }
      if (this.waiting.has(chat.id)) continue
      const bot = this.botOf(chat.id)
      if (!bot) continue
      this.waiting.add(chat.id)
      this.show(chat.id, bot, 'Waiting for your OK')
    }
  }

  /** The bot's name when the chat is a bot's one conversation. */
  private botOf(chatId: string): string | undefined {
    const chat = store.getState().chats.find((c) => c.id === chatId)
    const project = chat && store.getState().projects.find((p) => p.id === chat.projectId)
    if (!project?.bot || botConversation(project.id)?.id !== chatId) return undefined
    return project.name
  }

  /** Whether the user is looking at the chat: the window in front, showing it. */
  private looking(chatId: string): boolean {
    const window = this.window()
    return Boolean(window?.isVisible() && window.isFocused() && this.shown === chatId)
  }

  private show(chatId: string, title: string, body: string): void {
    if (this.looking(chatId) || !Notification.isSupported()) return
    const notification = new Notification({ title, body })
    this.onScreen.add(notification)
    notification.on('click', () => {
      this.onScreen.delete(notification)
      this.open(chatId)
    })
    notification.on('close', () => this.onScreen.delete(notification))
    notification.show()
  }
}

/** The first line of an answer with text, without Markdown's marks. */
function firstLine(answer: string): string {
  const line = answer
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return (line ?? '')
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+)/, '')
    .replace(/(\*\*|__|`)/g, '')
    .trim()
}
