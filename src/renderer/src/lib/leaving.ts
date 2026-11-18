import { useEffect, useState } from 'react'
import { menusAsSheets } from './touch'

/** How long a sheet takes to sink away: --sheet-time in remote/remote.css. */
const SHEET_EXIT_MS = 420

/** Whether closing sheets sink away: on a phone through the link, unless less motion is asked for. */
function sheetsSink(): boolean {
  return menusAsSheets() && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * What a sheet shows, kept for the sheet to sink away once it is gone. On a
 * phone through the link the menus are sheets from the bottom, and a sheet
 * that is closed leaves the page at once; this keeps the last value it had
 * (true, a position, a menu's entries) while it slides down, marked as
 * leaving, and lets it go after. Elsewhere, or with less motion asked for,
 * it goes at once, as a desktop's menus do.
 */
export function useLeaving<T>(value: T | null | undefined | false): {
  shown: T | undefined
  leaving: boolean
} {
  const current = value === null || value === false ? undefined : value
  const [kept, setKept] = useState<T>()
  // The latest value, remembered as it renders, for when it is gone.
  if (current !== undefined && current !== kept) setKept(current)

  const sinking = current === undefined && kept !== undefined && sheetsSink()
  useEffect(() => {
    if (current !== undefined || kept === undefined) return
    const timer = setTimeout(() => setKept(undefined), sheetsSink() ? SHEET_EXIT_MS : 0)
    return () => clearTimeout(timer)
  }, [current, kept])

  return { shown: current ?? (sinking ? kept : undefined), leaving: sinking }
}
