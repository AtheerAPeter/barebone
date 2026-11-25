import { useEffect, useRef, useState } from 'react'

/**
 * Switching chats from the keyboard, as Windows switches apps with Alt+Tab,
 * in the sidebar itself: Ctrl down shows the sidebar at once (springing out
 * over the chat if it is hidden) with the open chat highlighted. Tab moves
 * the highlight to the chat open before, and each Tab after walks the
 * sidebar's rows one by one (Shift+Tab up); letting go of Ctrl opens the one
 * highlighted, so a quick Ctrl+Tab goes back and forth between the last two.
 * Escape, or another key with Ctrl (a shortcut of its own), calls it off.
 *
 * Rows are named `chat:<chat id>` or `bot:<project id>`, as the sidebar marks
 * them (data-chat, data-bot), and only rows the sidebar shows are switched to.
 */

/** The rows the sidebar shows, top to bottom; a chat listed twice counts where it is first. */
function shownRows(): string[] {
  const rows = document.querySelectorAll<HTMLElement>('.sidebar [data-chat], .sidebar [data-bot]')
  const keys: string[] = []
  for (const row of rows) {
    // In a folded section or the lowered Settled sheet: not shown, so not switched to.
    if (row.offsetHeight === 0 || row.closest('.collapse:not(.open), .settled-sheet:not(.open)')) {
      continue
    }
    const key = row.dataset.bot ? `bot:${row.dataset.bot}` : `chat:${row.dataset.chat}`
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

function revealRow(key: string): void {
  const [kind, id] = key.split(':')
  const selector =
    kind === 'bot' ? `[data-bot="${CSS.escape(id)}"]` : `[data-chat="${CSS.escape(id)}"]`
  const row = [...document.querySelectorAll<HTMLElement>(`.sidebar ${selector}`)].find(
    (r) => r.offsetHeight > 0
  )
  row?.scrollIntoView({ block: 'nearest' })
}

export function useChatSwitch({
  current,
  onPick
}: {
  /** The row of what is open now. */
  current?: string
  onPick: (key: string) => void
}): {
  /** The row highlighted while Ctrl is held for a switch; undefined otherwise. */
  picked?: string
} {
  const [picked, setPicked] = useState<string>()
  /** Rows by when they were last open, the latest first: the first Tab goes to the second. */
  const recent = useRef<string[]>([])
  const latest = useRef({ current, onPick, picked })
  useEffect(() => {
    latest.current = { current, onPick, picked }
  })

  // What opens goes to the front of the order, however it was opened.
  useEffect(() => {
    if (current) recent.current = [current, ...recent.current.filter((k) => k !== current)]
  }, [current])

  useEffect(() => {
    // Kept here at once as well, so keys pressed before the next render step from it.
    const choose = (key: string | undefined): void => {
      latest.current.picked = key
      setPicked(key)
    }
    const switching = (): boolean => latest.current.picked !== undefined
    /** Tabs pressed in this switch. */
    let steps = 0
    /** Ctrl went down: the sidebar shows at once, the open chat's row highlighted. */
    const start = (): void => {
      if (switching()) return
      steps = 0
      choose(latest.current.current ?? '')
    }
    /**
     * The first Tab goes to the chat open before this one, so a quick Ctrl+Tab
     * goes back and forth between the last two; every step after walks the
     * sidebar's rows one by one, as they are listed, Shift+Tab up.
     */
    const step = (by: number): void => {
      start()
      const rows = shownRows()
      if (!rows.length) return
      const { picked, current } = latest.current
      const before = recent.current.find((k) => k !== current && rows.includes(k))
      if (steps++ === 0 && by > 0 && before) return choose(before)
      const at = picked ? rows.indexOf(picked) : -1
      const next = at === -1 ? (by > 0 ? 0 : rows.length - 1) : at + by
      choose(rows[(next + rows.length) % rows.length])
    }
    const pick = (): void => {
      const { picked, current, onPick } = latest.current
      choose(undefined)
      if (picked && picked !== current) onPick(picked)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Control') {
        if (!event.repeat) start()
        return
      }
      if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) {
        step(event.shiftKey ? -1 : 1)
      } else if (switching() && event.key === 'Enter') {
        pick()
      } else if (switching() && event.key === 'Escape') {
        choose(undefined)
      } else {
        // Another key with Ctrl is a shortcut of its own (Ctrl+C in a terminal): no switch.
        if (switching()) choose(undefined)
        return
      }
      // The switch's keys are its own: not the composer's, a terminal's, or Escape's elsewhere.
      event.preventDefault()
      event.stopPropagation()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Control' && switching()) pick()
    }
    // A click while Ctrl is held (Ctrl+click) is not a switch, unless it is on the sidebar.
    const onPointerDown = (event: PointerEvent): void => {
      if (switching() && !(event.target as Element | null)?.closest?.('.sidebar')) {
        choose(undefined)
      }
    }
    // Ctrl let go in another app never comes back here: the switch is called off.
    const onBlur = (): void => choose(undefined)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    // Ctrl+Tab in a browser page, passed on by main/index.ts.
    const offStep = window.api.onSwitcherStep(step)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
      offStep()
    }
  }, [])

  // The highlighted row stays in view as it moves.
  useEffect(() => {
    if (picked) revealRow(picked)
  }, [picked])

  return { picked }
}
