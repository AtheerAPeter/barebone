import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from '../lib/overlays'
import type { MenuAt, MenuEntries } from '../lib/menus'
import { menusAsSheets } from '../lib/touch'

/** Space kept between a menu and the window's edge. */
const EDGE = 8

/**
 * A menu over everything, as VS Code's context and ⋯ menus: at the pointer or
 * under its button, kept inside the window. Arrow keys move through it,
 * Escape and a click elsewhere close it. On a phone it is a sheet along the
 * bottom (remote/remote.css).
 */
export function PopupMenu({
  at,
  entries,
  onClose
}: {
  at: MenuAt
  entries: MenuEntries
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const sheet = menusAsSheets()
  const [style, setStyle] = useState<React.CSSProperties>({
    // Measured at the window's corner, where nothing squeezes it, then placed.
    visibility: 'hidden',
    left: 0,
    top: 0
  })
  useOverlay(ref, true)

  // Placed once its size is known: flipped or shifted to stay in the window.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu || sheet) return setStyle({})
    // Its layout size: it scales in, so its box on screen is smaller at first.
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    let x: number
    let y: number
    if ('below' in at) {
      const rect = at.below.getBoundingClientRect()
      x = at.align === 'right' ? rect.right - width : rect.left
      y = rect.bottom + 4
      if (y + height > window.innerHeight - EDGE) y = Math.max(EDGE, rect.top - 4 - height)
    } else {
      x = at.x
      y = at.y
      if (y + height > window.innerHeight - EDGE) y = Math.max(EDGE, y - height)
    }
    x = Math.min(Math.max(EDGE, x), window.innerWidth - width - EDGE)
    setStyle({ left: x, top: y, maxHeight: window.innerHeight - y - EDGE })
  }, [at, sheet])

  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      // The button that opened it toggles it shut itself.
      if ('below' in at && at.below.contains(target)) return
      onClose()
    }
    // Capture phase, and handled: closing a menu must not also stop the agent.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const items = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:enabled') ?? [])
        ]
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        const step = event.key === 'ArrowDown' ? 1 : -1
        items[(at + step + items.length) % items.length]?.focus()
      }
    }
    const onBlur = (): void => onClose()
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [at, onClose])

  return createPortal(
    <div
      className={`menu popup-menu${sheet ? ' sheet' : ''}`}
      role="menu"
      style={style}
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) =>
        entry ? (
          <button
            key={entry.name}
            role="menuitem"
            className={entry.danger ? 'danger' : undefined}
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.onSelect()
            }}
          >
            {entry.icon && <span className="popup-menu-icon">{entry.icon}</span>}
            {entry.name}
          </button>
        ) : (
          <hr key={`line-${i}`} />
        )
      )}
    </div>,
    document.body
  )
}
