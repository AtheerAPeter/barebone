import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useOverlay } from '../lib/overlays'
import { menusAsSheets } from '../lib/touch'
import { MoreIcon } from './icons'

export interface RowMenuItem {
  name: string
  danger?: boolean
  onSelect: () => void
}

/**
 * A row's ⋮ button and its menu. The menu is fixed to the window, so the
 * scrolling sidebar cannot clip it; near the bottom it opens upward. It sits
 * on the body, not in the row: a row is a stacking context of its own (its
 * glass under a press, styles.css), in which the menu would go under the rows
 * after it.
 */
export function RowMenu({
  label,
  items
}: {
  label: string
  items: RowMenuItem[]
}): React.JSX.Element {
  const [at, setAt] = useState<React.CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)

  function toggle(button: HTMLElement): void {
    if (at) return setAt(undefined)
    // On a phone it is a sheet along the bottom (remote/remote.css), not by the button.
    if (menusAsSheets()) return setAt({})
    const rect = button.getBoundingClientRect()
    const right = window.innerWidth - rect.right
    const roomBelow = window.innerHeight - rect.bottom
    setAt(
      roomBelow > MENU_ROOM
        ? { top: rect.bottom + 4, right }
        : { bottom: window.innerHeight - rect.top + 4, right }
    )
  }

  return (
    <div
      className={`row-menu${at ? ' open' : ''}`}
      ref={rootRef}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="icon-btn small"
        title={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={(e) => toggle(e.currentTarget)}
      >
        <MoreIcon width={14} height={14} />
      </button>
      {at && <MenuPopover items={items} at={at} onClose={() => setAt(undefined)} owner={rootRef} />}
    </div>
  )
}

/**
 * A menu of items, fixed to the window where `at` puts it, or a sheet along
 * the bottom on a phone. A press outside it, or Escape, closes it; a press on
 * `owner` (the button that opened it) is left to that button.
 */
export function MenuPopover({
  items,
  at,
  onClose,
  owner
}: {
  items: RowMenuItem[]
  at: React.CSSProperties
  onClose: () => void
  owner?: RefObject<HTMLElement | null>
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  useOverlay(menuRef, true)

  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!owner?.current?.contains(target) && !menuRef.current?.contains(target)) onClose()
    }
    // Capture phase, and handled: closing the menu must not also stop the agent.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, owner])

  const sheet = menusAsSheets()
  return createPortal(
    <div
      className={`menu${sheet ? ' sheet' : ''}`}
      role="menu"
      style={sheet ? undefined : at}
      ref={menuRef}
    >
      {items.map((item) => (
        <button
          key={item.name}
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          autoFocus={item === items[0] && !sheet}
          onClick={() => {
            // Gone before the item runs: one that asks first (confirm) stops the page.
            flushSync(onClose)
            item.onSelect()
          }}
        >
          {item.name}
        </button>
      ))}
    </div>,
    document.body
  )
}

/** Space a row menu needs below its button to open downward. */
const MENU_ROOM = 120
