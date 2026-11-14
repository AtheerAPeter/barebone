/** What the code panel's menus (components/PopupMenu.tsx) hold, and where they open. */

export interface MenuItem {
  name: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** A menu's items; null draws a line between two runs of them. */
export type MenuEntries = (MenuItem | null)[]

/** Where a menu opens: at a point (a right click), or under a button. */
export type MenuAt = { x: number; y: number } | { below: HTMLElement; align?: 'left' | 'right' }

/**
 * A menu's entries with the ones left out (false or undefined) taken away, and no line at
 * either end or two together.
 */
export function tidy(entries: (MenuItem | null | false | undefined)[]): MenuEntries {
  const kept: MenuEntries = []
  for (const entry of entries) {
    if (entry === false || entry === undefined) continue
    if (entry === null && (kept.length === 0 || kept[kept.length - 1] === null)) continue
    kept.push(entry)
  }
  if (kept[kept.length - 1] === null) kept.pop()
  return kept
}
