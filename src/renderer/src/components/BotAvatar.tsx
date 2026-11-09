import { useEffect, useState } from 'react'
import type { BotShape, Chat, Project } from '../../../shared/types'
import { botColor, botMood, SLEEP_AFTER_MS, type BotMood } from '../lib/bots'

const INK = '#1a1a1a'

/** Lines drawn on the face: closed eyes, brows and mouths. */
const STROKE = {
  stroke: INK,
  strokeWidth: 1.6,
  fill: 'none',
  strokeLinecap: 'round'
} as const

/**
 * A face centered on x 20: two eyes at height `y`, and a mouth at `mouth`
 * where the mood needs one. Idle eyes look a little to the right; working
 * ones glance aside (styles.css); waiting ones open wide and look at you;
 * worried ones get raised brows and a frown; asleep ones are closed.
 * `smile` is a shape's own mouth, kept unless the bot is worried.
 */
function Face({
  mood,
  y,
  mouth,
  gap = 6,
  r = 3.2,
  smile = false
}: {
  mood: BotMood
  y: number
  mouth: number
  gap?: number
  r?: number
  smile?: boolean
}): React.JSX.Element {
  const sides = [20 - gap, 20 + gap]
  const wide = mood === 'waiting'
  const white = wide ? r * 1.18 : r
  return (
    <>
      {mood === 'asleep' ? (
        sides.map((x) => (
          <path key={x} d={`M${x - r} ${y}q${r} ${r * 0.75} ${r * 2} 0`} {...STROKE} />
        ))
      ) : (
        <g className="bot-eyes">
          {sides.map((x) => (
            <circle key={x} cx={x} cy={y} r={white} fill="#fff" />
          ))}
          <g className="bot-pupils">
            {sides.map((x) => (
              <circle
                key={x}
                cx={wide ? x : x + 0.8}
                cy={wide ? y : y + 0.6}
                r={white * 0.5}
                fill={INK}
              />
            ))}
          </g>
        </g>
      )}
      {/* Brows raised at the middle. */}
      {mood === 'worried' &&
        sides.map((x, side) => {
          const inward = side === 0 ? 1 : -1
          return (
            <path
              key={x}
              d={`M${x - inward * (r + 0.4)} ${y - r - 1.6}L${x + inward * r * 0.7} ${y - r - 3.2}`}
              {...STROKE}
            />
          )
        })}
      {mood === 'worried' ? (
        <path d={`M16.5 ${mouth + 1}q3.5 -2.4 7 0`} {...STROKE} />
      ) : (
        smile && <path d={`M15 ${mouth}q5 3.5 10 0`} {...STROKE} strokeWidth={1.8} />
      )}
    </>
  )
}

/** The light along the top of a body, so it reads as a shape rather than a flat mark. */
const SHINE = { fill: '#fff', opacity: 0.2 }

/** Each character's body and face, on a 40 grid. The shapes tell bots apart at sidebar size. */
const BODIES: Record<BotShape, (color: string, mood: BotMood) => React.JSX.Element> = {
  box: (color, mood) => (
    <>
      <rect x="5" y="6" width="30" height="28" rx="9" fill={color} />
      <rect x="5" y="6" width="30" height="14" rx="9" {...SHINE} />
      <Face mood={mood} y={18} mouth={25.5} smile />
    </>
  ),
  round: (color, mood) => (
    <>
      <line
        x1="20"
        y1="9"
        x2="20"
        y2="3.5"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="20" cy="3.5" r="2.6" fill={color} />
      <circle cx="20" cy="23" r="15" fill={color} />
      <ellipse cx="20" cy="15" rx="10" ry="5" {...SHINE} />
      <Face mood={mood} y={22} mouth={29} />
    </>
  ),
  ghost: (color, mood) => (
    <>
      <path
        d="M6 20a14 14 0 0 1 28 0v16l-4.7 -3l-4.6 3l-4.7 -3l-4.7 3l-4.6 -3l-4.7 3z"
        fill={color}
      />
      <path d="M8 16a12 11 0 0 1 24 0z" {...SHINE} />
      <Face mood={mood} y={19} mouth={26.5} gap={5.5} r={3.6} />
    </>
  ),
  house: (color, mood) => (
    <>
      <path d="M20 4l16 13v15a4 4 0 0 1 -4 4h-24a4 4 0 0 1 -4 -4v-15z" fill={color} />
      <path d="M20 4l16 13h-32z" {...SHINE} />
      <rect x="17" y="28" width="6" height="8" rx="2" fill={INK} opacity="0.35" />
      <Face mood={mood} y={22} mouth={25.4} r={3} />
    </>
  ),
  cat: (color, mood) => (
    <>
      <path
        d="M7 15l2 -11l8 6.5q3 -0.8 6 0l8 -6.5l2 11q3 6 0 13q-5 8 -13 8q-8 0 -13 -8q-3 -7 0 -13z"
        fill={color}
      />
      <path d="M9 13q11 -7 22 0q-11 -2 -22 0z" {...SHINE} />
      <path d="M18.5 27l1.5 1.4l1.5 -1.4z" fill={INK} opacity="0.6" />
      <Face mood={mood} y={21} mouth={30.5} />
    </>
  ),
  cloud: (color, mood) => (
    <>
      <path
        d="M11 34a7.5 7.5 0 0 1 -1.2 -14.9a9.5 9.5 0 0 1 17.6 -4.6a7.5 7.5 0 0 1 8.8 7.8a6 6 0 0 1 -1.7 11.7z"
        fill={color}
      />
      <ellipse cx="19" cy="15" rx="7" ry="3.5" {...SHINE} />
      <Face mood={mood} y={24} mouth={30} />
    </>
  )
}

/**
 * Where in its float and blink a bot starts, from its ID, so bots side by
 * side do not move as one.
 */
function phase(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return `-${(Math.abs(hash) % 5000) / 1000}s`
}

/**
 * The bot's mood from its chat. A bot left alone falls asleep after a while,
 * so it is shown anew at that moment, not only when the chat changes.
 */
function useMood(chat: Chat | undefined): BotMood {
  const [now, setNow] = useState(Date.now)
  const mood = botMood(chat, now)
  const sleepsAt = chat && mood === 'idle' ? chat.updatedAt + SLEEP_AFTER_MS : undefined
  useEffect(() => {
    if (sleepsAt === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), sleepsAt - Date.now())
    return () => clearTimeout(timer)
  }, [sleepsAt])
  return mood
}

/**
 * A bot's character, in its color. It floats and blinks, and its face shows
 * its mood from `chat`, the chat it speaks for: it hops while it works, perks
 * up while it waits for the user, looks worried after a turn failed, and
 * sleeps when nothing happened for a long time (styles.css).
 */
export function BotAvatar({
  project,
  size,
  chat
}: {
  project: Project
  size: number
  chat?: Chat
}): React.JSX.Element | null {
  const mood = useMood(chat)
  if (!project.bot) return null
  const color = botColor(project)
  return (
    <svg
      className={`bot-avatar bot-${mood}`}
      style={{ '--bot-phase': phase(project.id) } as React.CSSProperties}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden
    >
      <g className="bot-figure">{(BODIES[project.bot.shape] ?? BODIES.round)(color, mood)}</g>
      {mood === 'asleep' && (
        <text className="bot-z" x="33" y="7">
          z
        </text>
      )}
    </svg>
  )
}
