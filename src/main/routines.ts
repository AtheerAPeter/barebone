import { WEEKDAYS, type BotRoutine, type Project, type Weekday } from '../shared/types'
import { botConversation } from './bots'
import * as store from './store'

/**
 * Bots' routines: regular work the user asked a bot for ("every weekday at 8,
 * look for new jobs"), which the bot sets with set_routine (chats-mcp.ts).
 * They are kept on the bot's project, so they outlast a restart, and a check
 * every half minute wakes the bot's conversation with each one that came due.
 */

/** How often due routines are looked for. */
const CHECK_MS = 30_000

const HOUR_MS = 60 * 60 * 1000

/** What a bot asks for: a note, and either a time on some days or every few hours. */
export interface NewRoutine {
  note: string
  time?: string
  days?: Weekday[]
  everyHours?: number
}

/**
 * When a routine runs next, after `after`. One that runs every few hours keeps
 * its beat: after runs it missed (the app closed, the Mac asleep) it is due
 * once, then at its next beat.
 */
export function nextRun(routine: NewRoutine & { nextAt?: number }, after: number): number {
  if (routine.everyHours) {
    const every = routine.everyHours * HOUR_MS
    if (routine.nextAt === undefined) return after + every
    return routine.nextAt + (Math.floor((after - routine.nextAt) / every) + 1) * every
  }
  const [hours, minutes] = (routine.time ?? '').split(':').map(Number)
  const day = new Date(after)
  // Within a week every day comes once; Date takes care of months and summer time.
  for (let ahead = 0; ahead <= 7; ahead++) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + ahead, hours, minutes)
    const weekday = WEEKDAYS[(at.getDay() + 6) % 7]
    if (at.getTime() > after && (!routine.days?.length || routine.days.includes(weekday))) {
      return at.getTime()
    }
  }
  throw new Error(`Routine has no next run: ${JSON.stringify(routine)}`)
}

/** "8:00" or "08:00" as "08:00"; undefined for anything else. */
function clockTime(time: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

/**
 * A routine from what was asked for, with its first run after `now`; throws,
 * in words for the bot, when it is not well formed.
 */
export function newRoutine(routine: NewRoutine, now = Date.now()): BotRoutine {
  const note = typeof routine.note === 'string' ? routine.note.trim() : ''
  if (!note) throw new Error('"note" is empty: say what to do each time it runs.')
  if ((routine.time === undefined) === (routine.everyHours === undefined)) {
    throw new Error('Give either "time" (with "days" if not every day) or "everyHours".')
  }
  if (routine.days && routine.time === undefined) {
    throw new Error('"days" goes with "time".')
  }
  const time = routine.time === undefined ? undefined : clockTime(String(routine.time))
  if (routine.time !== undefined && !time) {
    throw new Error(
      `"time" must be a local time as "HH:MM", such as "08:00", not "${routine.time}".`
    )
  }
  const { everyHours } = routine
  if (everyHours !== undefined && !(Number.isInteger(everyHours) && everyHours >= 1)) {
    throw new Error('"everyHours" must be a whole number of hours, at least 1.')
  }
  if (routine.days && !routine.days.every((day) => WEEKDAYS.includes(day))) {
    throw new Error(`"days" takes only ${WEEKDAYS.join(', ')}.`)
  }
  const days = routine.days?.length ? [...new Set(routine.days)] : undefined
  return {
    id: crypto.randomUUID().slice(0, 8),
    note,
    ...(time ? { time } : {}),
    ...(days ? { days } : {}),
    ...(everyHours ? { everyHours } : {}),
    nextAt: nextRun({ note, time, days, everyHours }, now)
  }
}

export class Routines {
  constructor(
    /** Wake a bot's conversation with a routine's note. */
    private readonly run: (chatId: string, note: string) => void,
    /** A bot's routines changed: the window shows the next one. */
    private readonly changed: () => void
  ) {}

  /** Look for due routines now, and every CHECK_MS from now on. */
  start(): void {
    this.check()
    setInterval(() => this.check(), CHECK_MS)
  }

  /** Set a routine for the bot whose conversation the caller is. */
  set(caller: string, routine: NewRoutine): BotRoutine {
    const bot = this.botOf(caller)
    const made = newRoutine(routine)
    this.save(bot, [...(bot.bot?.routines ?? []), made])
    return made
  }

  /** The routines of the bot whose conversation the caller is, the next one first. */
  list(caller: string): BotRoutine[] {
    return [...(this.botOf(caller).bot?.routines ?? [])].sort((a, b) => a.nextAt - b.nextAt)
  }

  /** End one of the caller's bot's routines; returns it. */
  cancel(caller: string, id: string): BotRoutine {
    const bot = this.botOf(caller)
    const routines = bot.bot?.routines ?? []
    const routine = routines.find((r) => r.id === id.trim())
    if (!routine) {
      throw new Error(`You have no routine "${id}". list_routines shows the ones you have.`)
    }
    this.save(
      bot,
      routines.filter((r) => r !== routine)
    )
    return routine
  }

  /** The bot whose one conversation the caller is; throws for any other chat. */
  private botOf(caller: string): Project {
    const chat = store.getChat(caller)
    const project = store.getProject(chat.projectId)
    if (!project.bot || botConversation(project.id)?.id !== chat.id) {
      throw new Error(
        "Routines are only for a bot's own conversation, and this chat is not one. Tell the user to ask a bot for regular work in its conversation."
      )
    }
    return project
  }

  private save(project: Project, routines: BotRoutine[]): void {
    if (!project.bot) return
    store.updateProject(project.id, {
      bot: { ...project.bot, routines: routines.length > 0 ? routines : undefined }
    })
    this.changed()
  }

  /**
   * Run every routine that came due, once, however many runs it missed, and
   * give it its next time. A bot whose conversation was deleted skips its run.
   */
  private check(): void {
    const now = Date.now()
    for (const project of store.getState().projects) {
      const routines = project.bot?.routines
      if (!routines?.some((r) => r.nextAt <= now)) continue
      const chat = botConversation(project.id)
      this.save(
        project,
        routines.map((routine) => {
          if (routine.nextAt > now) return routine
          if (chat) this.run(chat.id, routine.note)
          return { ...routine, nextAt: nextRun(routine, now) }
        })
      )
    }
  }
}
