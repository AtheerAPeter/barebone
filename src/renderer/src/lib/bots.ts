import { createContext } from 'react'
import type { Chat, Project } from '../../../shared/types'

export { botColor } from '../../../shared/colors'

/** The bots, for the card a chat shows when it has made one, and the greeting of a bot's chat. */
export const BotsContext = createContext<{
  projects: Project[]
  openBot: (projectId: string) => void
}>({ projects: [], openBot: () => undefined })

/** How a bot's face looks: what its chat is doing, or how its last turn went. */
export type BotMood = 'idle' | 'working' | 'waiting' | 'worried' | 'asleep'

/** A bot whose conversation saw nothing for this long has gone to sleep. */
export const SLEEP_AFTER_MS = 12 * 60 * 60 * 1000

/**
 * The mood of a bot's chat at `now`; what needs the user comes first. A bot
 * whose turn failed stays worried, not asleep, until a turn goes through.
 */
export function botMood(chat: Chat | undefined, now: number): BotMood {
  if (!chat) return 'idle'
  if (chat.waiting) return 'waiting'
  if (chat.running) return 'working'
  if (chat.lastTurnFailed) return 'worried'
  if (now - chat.updatedAt >= SLEEP_AFTER_MS) return 'asleep'
  return 'idle'
}

/**
 * What a bot's chat is doing now, said as a person would: waiting for the
 * user, its current call, or thinking between calls. Undefined while it is
 * not at work, so the caller shows the last message or the bot's job.
 */
export function botStatus(chat: Chat | undefined): string | undefined {
  if (chat?.waiting) return 'Waiting for your OK'
  if (chat?.running) return chat.activity ?? 'Thinking'
  return undefined
}

/**
 * When a bot's next routine runs, as its top bar says it: "today 8:00",
 * "tomorrow 8:00", "Fri 8:00", or "14 Nov 8:00" beyond a week. Undefined when
 * it has none.
 */
export function nextRoutine(project: Project, now: number): string | undefined {
  const routines = project.bot?.routines ?? []
  if (routines.length === 0) return undefined
  const at = new Date(Math.min(...routines.map((r) => r.nextAt)))
  const midnight = (d: Date): number => new Date(d).setHours(0, 0, 0, 0)
  // Rounded, as a day across a change to or from summer time is not 24 hours.
  const days = Math.round((midnight(at) - midnight(new Date(now))) / (24 * 60 * 60 * 1000))
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day =
    days <= 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : days < 7
          ? at.toLocaleDateString([], { weekday: 'short' })
          : at.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return `${day} ${time}`
}
