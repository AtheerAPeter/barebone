import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from '../lib/overlays'
import { CloseIcon, InfoIcon } from './icons'

/** Space kept between a popover and the window's edge. */
const EDGE = 8

/**
 * One line of Settings: its icon, the setting's name, what it is now and its
 * controls. What it does opens over the page from the info button by its name.
 */
export function SettingsRow({
  icon,
  name,
  info,
  status,
  warn = false,
  action,
  error
}: {
  icon: ReactNode
  name: string
  /** What the setting does, shown in the info button's popover. */
  info: ReactNode
  /** What the setting is now, in words, such as "Key saved"; a switch says it itself. */
  status?: string
  /** The setting is missing something it needs to work. */
  warn?: boolean
  /** The switch, and a button that opens the setting's fields. */
  action?: ReactNode
  /** What went wrong saving it. */
  error?: string
}): React.JSX.Element {
  return (
    <section className="setting">
      <div className="setting-line">
        <span className="setting-icon">{icon}</span>
        <span className="setting-name">{name}</span>
        <InfoButton name={name}>{info}</InfoButton>
        {(status || action) && (
          <span className="setting-ctl">
            {status && <span className={`setting-status${warn ? ' warn' : ''}`}>{status}</span>}
            {action}
          </span>
        )}
      </div>
      {error && <div className="msg-error setting-error">{error}</div>}
    </section>
  )
}

/** The info button by a setting's name, and the popover it opens with what the setting does. */
function InfoButton({ name, children }: { name: string; children: ReactNode }): React.JSX.Element {
  /** The button, while its popover is open. */
  const [anchor, setAnchor] = useState<HTMLElement>()
  return (
    <>
      <button
        type="button"
        className="setting-info"
        aria-label={`About ${name}`}
        aria-expanded={anchor !== undefined}
        onClick={(e) => setAnchor(anchor ? undefined : e.currentTarget)}
      >
        <InfoIcon />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(undefined)}>
          {children}
        </Popover>
      )}
    </>
  )
}

/** A card over everything under its button, kept in the window; a click elsewhere or Escape closes it. */
function Popover({
  anchor,
  onClose,
  children
}: {
  anchor: HTMLElement
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useOverlay(ref, true)

  useLayoutEffect(() => {
    const card = ref.current
    if (!card) return
    const rect = anchor.getBoundingClientRect()
    const x = Math.min(Math.max(EDGE, rect.left - 12), window.innerWidth - card.offsetWidth - EDGE)
    let y = rect.bottom + 6
    if (y + card.offsetHeight > window.innerHeight - EDGE) {
      y = Math.max(EDGE, rect.top - 6 - card.offsetHeight)
    }
    setStyle({ left: x, top: y })
  }, [anchor])

  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      // The button that opened it toggles it shut itself.
      if (ref.current?.contains(target) || anchor.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    // Scrolled away from its button, it would float over the wrong setting.
    const onScroll = (event: Event): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onClose)
    }
  }, [anchor, onClose])

  return createPortal(
    <div className="setting-popover" role="dialog" style={style} ref={ref}>
      {children}
    </div>,
    document.body
  )
}

/** A setting's fields, in a dialog over Settings; a click outside it or Escape closes it. */
export function SettingsDialog({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(ref, true)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div
      className="palette-backdrop settings-dialog-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="settings-dialog" role="dialog" aria-label={title} ref={ref}>
        <div className="settings-dialog-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="settings-dialog-body">{children}</div>
      </div>
    </div>,
    document.body
  )
}

/** An on/off switch, as macOS draws one. */
export function Switch({
  label,
  on,
  onChange
}: {
  label: string
  on: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  )
}
