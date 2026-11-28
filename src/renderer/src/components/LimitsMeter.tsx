import { useEffect, useRef, useState } from 'react'
import { useLeaving } from '../lib/leaving'
import type { AgentId, LimitWindow, UsageLimits } from '../../../shared/types'
import { useOverlay } from '../lib/overlays'
import { menusAsSheets } from '../lib/touch'
import { useSheetSwipe } from '../lib/gestures'
import { menuPlacement, placementProps, type MenuPlacement } from '../lib/menuPlacement'

/** From this share of a window on, the meter shows the plan is running out. */
const NEARLY_USED = 80
/** How often limits are read again while the chat is open, for windows that start over. */
const REFRESH_MS = 5 * 60_000
/** Windows that start over sooner than this say how long is left rather than when. */
const SOON_MS = 24 * 60 * 60_000

/**
 * What the account the chat runs on has used and has left (main/limits.ts):
 * a ring for each of its plan's windows and the fullest one's share, or its
 * balance. Clicked, a popover lists every window with when it starts over.
 * Nothing for an agent or provider that reports no limits.
 */
export function LimitsMeter({
  chatId,
  agent,
  source
}: {
  chatId: string
  agent: AgentId
  /** The harness source that bills the chat, when the agent has several. */
  source: string | undefined
}): React.JSX.Element | null {
  // Kept with the account it was read for, so another agent's limits never show while the new ones load.
  const account = `${agent}:${source ?? ''}`
  const [read, setRead] = useState<{ account: string; limits: UsageLimits | null }>()
  const [open, setOpen] = useState(false)
  /** The popover stays while it sinks away as a phone's sheet. */
  const menu = useLeaving(open)
  const [placement, setPlacement] = useState<MenuPlacement>()
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useOverlay(menuRef, open)
  const asSheet = menusAsSheets()
  useSheetSwipe(menuRef, { enabled: open && asSheet, onDismiss: () => setOpen(false) })

  useEffect(() => {
    let current = true
    const load = (): void => {
      window.api
        .limits(chatId)
        .then((limits) => {
          if (current) setRead({ account, limits })
        })
        .catch(() => {})
    }
    load()
    const off = window.api.onLimitsChanged(load)
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      current = false
      off()
      clearInterval(timer)
    }
  }, [chatId, account])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  const limits = read?.account === account ? read.limits : null
  if (!limits) return null
  const fullest = limits.windows.reduce<LimitWindow | undefined>(
    (most, w) => (!most || w.usedPercent > most.usedPercent ? w : most),
    undefined
  )

  function toggle(): void {
    if (!open && rootRef.current) setPlacement(menuPlacement(rootRef.current))
    setOpen(!open)
  }

  return (
    <div
      className="limits"
      ref={rootRef}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          // Handled: closing the popover must not also stop the agent.
          event.preventDefault()
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        className={`picker-button limits-meter${fullest && nearlyUsed(fullest) ? ' full' : ''}`}
        aria-expanded={open}
        title={`${limits.account}: usage`}
        onClick={toggle}
      >
        {fullest ? (
          <>
            {limits.windows.map((w) => (
              <Ring key={w.name} window={w} />
            ))}
            <span className="limits-label">
              {fullest.name} {Math.round(fullest.usedPercent)}%
            </span>
          </>
        ) : (
          limits.balance
        )}
      </button>
      {menu.shown && (
        <div
          className={`picker-menu limits-menu${menu.leaving ? ' leaving' : ''}`}
          role="dialog"
          aria-label={`${limits.account} usage`}
          ref={menuRef}
          {...(placement && placementProps(placement))}
        >
          {asSheet && <div className="sheet-grabber" aria-hidden="true" />}
          <div className="limits-account">{limits.account}</div>
          {limits.windows.map((w) => (
            <div key={w.name} className={`limits-window${nearlyUsed(w) ? ' full' : ''}`}>
              <div className="limits-row">
                <span>{w.name}</span>
                <span className="limits-used">{Math.round(w.usedPercent)}% used</span>
              </div>
              <div className="limits-bar">
                <span style={{ width: `${clamped(w.usedPercent)}%` }} />
              </div>
              {w.resetsAt && <small>Resets {resetTime(w.resetsAt)}</small>}
            </div>
          ))}
          {limits.balance && <div className="limits-balance">{limits.balance}</div>}
        </div>
      )}
    </div>
  )
}

/** One window's share, as a ring on the meter. */
function Ring({ window: w }: { window: LimitWindow }): React.JSX.Element {
  const radius = 6
  const round = 2 * Math.PI * radius
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={nearlyUsed(w) ? 'full' : undefined}
    >
      <circle cx="8" cy="8" r={radius} className="limits-track" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        className="limits-fill"
        strokeDasharray={`${(clamped(w.usedPercent) / 100) * round} ${round}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

const nearlyUsed = (w: LimitWindow): boolean => w.usedPercent >= NEARLY_USED

const clamped = (percent: number): number => Math.min(100, Math.max(0, percent))

/** "in 3 h 20 min" within a day, else "Nov 20, 2:00 AM". */
function resetTime(ms: number): string {
  const left = ms - Date.now()
  if (left <= 0) return 'now'
  if (left < SOON_MS) {
    const minutes = Math.ceil(left / 60_000)
    const hours = Math.floor(minutes / 60)
    return hours > 0 ? `in ${hours} h ${minutes % 60} min` : `in ${minutes} min`
  }
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
