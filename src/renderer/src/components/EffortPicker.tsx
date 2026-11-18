import { useEffect, useRef, useState } from 'react'
import { useLeaving } from '../lib/leaving'
import type { AgentOption } from '../../../shared/types'
import { useOverlay } from '../lib/overlays'
import { menuPlacement, placementProps, type MenuPlacement } from '../lib/menuPlacement'
import { ChevronDownIcon, GaugeIcon } from './icons'
import { Switch } from './SettingsRow'

/** The value agents use for the model's own effort; opencode lists it last, the harness first. */
const DEFAULT = 'default'

/** Keys that move the slider, and where each takes it from stop `i` of `last`. */
const STEP_KEYS: Record<string, (i: number, last: number) => number> = {
  ArrowRight: (i) => i + 1,
  ArrowUp: (i) => i + 1,
  PageUp: (i) => i + 1,
  ArrowLeft: (i) => i - 1,
  ArrowDown: (i) => i - 1,
  PageDown: (i) => i - 1,
  Home: () => 0,
  End: (_, last) => last
}

/**
 * The thinking effort as ChatGPT's slider: the level's name over a track with
 * a stop per level. Default (the model's own effort) is the first stop, then
 * the levels in the agent's order, which is lowest first.
 *
 * An invisible range input on top takes the pointer, keys and screen readers;
 * the track, fill and thumb under it are drawn, so they can glide between stops.
 *
 * The agent's on/off options for how the model works (Fast mode, Ultracode)
 * are switches under the slider. A switch moves once the agent has taken the
 * change, so one it refuses stays as it was.
 */
export function EffortPicker({
  option,
  switches,
  onChange,
  showLevel = false
}: {
  option?: AgentOption
  switches: AgentOption[]
  onChange: (optionId: string, value: string) => void
  /** The button names the level ("High") rather than "Thinking effort": where a row already says what it is. */
  showLevel?: boolean
}): React.JSX.Element {
  const stops = option
    ? [
        ...option.values.filter((v) => v.value === DEFAULT),
        ...option.values.filter((v) => v.value !== DEFAULT)
      ]
    : []
  const last = stops.length - 1
  const currentIndex = Math.max(
    0,
    stops.findIndex((v) => v.value === option?.currentValue)
  )
  const [placement, setPlacement] = useState<MenuPlacement>()
  /** Where the menu is, kept while it sinks away as a phone's sheet. */
  const menu = useLeaving(placement)
  /** The stop shown while the menu is open; the agent's answer to a change comes later. */
  const [index, setIndex] = useState(currentIndex)
  /** Where the thumb is while it is dragged, between stops; it settles on the nearest at release. */
  const [drag, setDrag] = useState<number | null>(null)
  /** Whether the pointer is pressed on the slider: only then do its changes count as a drag. */
  const pressed = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const open = placement !== undefined
  useOverlay(menuRef, open)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setPlacement(undefined)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  function toggle(): void {
    if (open || !rootRef.current) return setPlacement(undefined)
    setIndex(currentIndex)
    setDrag(null)
    setPlacement(menuPlacement(rootRef.current))
  }

  function choose(next: number): void {
    const clamped = Math.min(last, Math.max(0, next))
    if (!option || clamped === index) return
    setIndex(clamped)
    onChange(option.id, stops[clamped].value)
  }

  function press(): void {
    pressed.current = true
    // A drag can end anywhere in the window, not only over the slider.
    const release = (): void => {
      pressed.current = false
      setDrag(null)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== 'Enter') return
    // Handled: closing the menu must not also stop the agent.
    event.preventDefault()
    setPlacement(undefined)
  }

  /** The levels besides Default, which the signal's bars stand for. */
  const levels = stops.filter((v) => v.value !== DEFAULT).length
  /** How many of them the current one lights: Default, first when there, lights none. */
  const lit = currentIndex + (stops[0]?.value === DEFAULT ? 0 : 1)
  const position = drag ?? index
  const on = switches.filter((s) => s.currentValue === 'true').map((s) => s.name)
  const label = option
    ? showLevel
      ? (stops[currentIndex]?.name ?? option.currentValue)
      : 'Thinking effort'
    : switches.map((s) => s.name).join(', ')

  return (
    <div className="picker" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <button
        type="button"
        className="picker-button"
        title={[
          ...(option
            ? [`Thinking effort: ${stops[currentIndex]?.name ?? option.currentValue}`]
            : []),
          ...on.map((name) => `${name}: on`)
        ].join('\n')}
        onClick={toggle}
      >
        <span className="picker-icon">
          {option ? (
            // Default is the model's own effort: no level of ours lit.
            <LevelBars lit={lit} of={levels} />
          ) : (
            <GaugeIcon width={15} height={15} />
          )}
        </span>
        <span className="picker-label">{label}</span>
        <ChevronDownIcon width={12} height={12} className="picker-chevron" />
      </button>
      {menu.shown && (
        <div
          className={`picker-menu effort-menu${menu.leaving ? ' leaving' : ''}`}
          ref={menuRef}
          {...placementProps(menu.shown)}
        >
          {option && (
            <>
              <div className="effort-name">{stops[index]?.name}</div>
              <div
                className={`effort-slider${drag !== null ? ' dragging' : ''}`}
                style={{ '--effort': last > 0 ? position / last : 0 } as React.CSSProperties}
              >
                <span className="effort-fill" />
                {stops.map((stop, i) => (
                  <span
                    key={stop.value}
                    className={`effort-stop${i <= position ? ' passed' : ''}`}
                    style={{ '--at': last > 0 ? i / last : 0 } as React.CSSProperties}
                  />
                ))}
                <span className="effort-thumb" />
                <input
                  type="range"
                  aria-label="Thinking effort"
                  aria-valuetext={stops[index]?.name}
                  autoFocus
                  min={0}
                  max={last}
                  step="any"
                  value={position}
                  onPointerDown={press}
                  onChange={(e) => {
                    const at = Number(e.target.value)
                    if (pressed.current) setDrag(at)
                    choose(Math.round(at))
                  }}
                  onKeyDown={(e) => {
                    const step = STEP_KEYS[e.key]
                    if (!step) return
                    // One stop per key: a free range would move a hundredth of the track.
                    e.preventDefault()
                    choose(step(index, last))
                  }}
                />
              </div>
            </>
          )}
          {switches.map((s) => (
            <div className="effort-switch" key={s.id}>
              <span className="effort-switch-text">
                <span>{s.name}</span>
                {s.description && <span className="effort-switch-note">{s.description}</span>}
              </span>
              <Switch
                label={s.name}
                on={s.currentValue === 'true'}
                onChange={(next) => onChange(s.id, String(next))}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** An effort option's current level as its signal, for a button that names something else (the model). */
export function EffortLevel({ option }: { option: AgentOption }): React.JSX.Element {
  const levels = option.values.filter((v) => v.value !== DEFAULT)
  const at = levels.findIndex((v) => v.value === option.currentValue)
  return <LevelBars lit={at + 1} of={levels.length} />
}

/**
 * The thinking level as a signal: a bar for each level, rising and rounded,
 * lit up to the current one. Default (the model's own effort) lights none.
 */
function LevelBars({ lit, of }: { lit: number; of: number }): React.JSX.Element {
  const width = 3
  const gap = 2
  const height = 14
  return (
    <svg
      className="level-bars"
      width={of * width + (of - 1) * gap}
      height={height}
      viewBox={`0 0 ${of * width + (of - 1) * gap} ${height}`}
      aria-hidden="true"
    >
      {Array.from({ length: of }, (_, i) => {
        const h = Math.round(height * ((i + 1) / of) * 0.75 + height * 0.25)
        return (
          <rect
            key={i}
            x={i * (width + gap)}
            y={height - h}
            width={width}
            height={h}
            rx={width / 2}
            fill="currentColor"
            opacity={i < lit ? 1 : 0.28}
          />
        )
      })}
    </svg>
  )
}
