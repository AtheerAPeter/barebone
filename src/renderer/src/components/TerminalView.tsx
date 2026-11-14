import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '../../../shared/types'
import { touchScreen, useKeyboardArea } from '../lib/touch'
import { CloseIcon, KeyboardIcon, PlusIcon } from './icons'

/**
 * Terminals (main/terminals.ts), as tabs. The shells run in the app, so they
 * keep running while this view is closed, and every view of them, here or on
 * another device, shows the same ones: opening it shows what each printed
 * lately. On a touch screen a row of keys the phone's keyboard lacks sits
 * above it: Esc, Tab, Ctrl and the arrows.
 */

interface Shown {
  term: Terminal
  fit: FitAddon
}

const api = (): typeof window.api.terminal => window.api.terminal

export function TerminalView(): React.JSX.Element {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([])
  /** The tab the user picked; the last one shows when it is gone. */
  const [picked, setPicked] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  /** Ctrl from the key row: held for the next key typed. */
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  /** Each terminal's screen here, made as its element is. */
  const shown = useRef(new Map<string, Shown>())
  /** What a terminal printed before its screen was made. */
  const backlogs = useRef(new Map<string, string>())
  const viewRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  // Above the phone's keyboard, so the line typed into stays in sight.
  const keyboard = useKeyboardArea(touchScreen)
  const active = terminals.some((t) => t.id === picked) ? picked : terminals.at(-1)?.id

  const holdCtrl = (on: boolean): void => {
    ctrlRef.current = on
    setCtrl(on)
  }

  /** Make the terminal's screen in its element, the first time it is there. */
  const attach = useCallback((id: string, element: HTMLDivElement | null) => {
    if (!element || shown.current.has(id)) return
    const term = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: themeFromPage()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    term.write(backlogs.current.get(id) ?? '')
    backlogs.current.delete(id)
    term.onData((data) => {
      if (ctrlRef.current) {
        data = withCtrl(data)
        holdCtrl(false)
      }
      api().write(id, data)
    })
    shown.current.set(id, { term, fit })
  }, [])

  const openTerminal = async (): Promise<void> => {
    const size = (active && shown.current.get(active)?.fit.proposeDimensions()) || {
      cols: 80,
      rows: 24
    }
    const info = await api().open(size.cols, size.rows)
    setPicked(info.id)
  }

  // Shown here while open: each terminal with what it printed lately, or a new one.
  useEffect(() => {
    let current = true
    const screens = shown.current
    const waiting = backlogs.current
    const write = (id: string, data: string): void => {
      const screen = screens.get(id)
      if (screen) screen.term.write(data)
      else waiting.set(id, (waiting.get(id) ?? '') + data)
    }
    void api()
      .watch(true)
      .then(async (list) => {
        if (!current) return
        for (const t of list) write(t.id, t.backlog)
        setTerminals(list.map(({ id, title }) => ({ id, title })))
        setLoaded(true)
        if (!list.length) {
          const info = await api().open(80, 24)
          if (current) setPicked(info.id)
        }
      })
    const offData = api().onData(write)
    const offList = api().onList(setTerminals)
    const offExit = api().onExit((id) => {
      screens.get(id)?.term.dispose()
      screens.delete(id)
    })
    return () => {
      current = false
      offData()
      offList()
      offExit()
      void api().watch(false)
      for (const { term } of screens.values()) term.dispose()
      screens.clear()
      waiting.clear()
    }
  }, [])

  // The active one fills the view, at the size it has here.
  useEffect(() => {
    const host = hostRef.current
    const screen = active ? shown.current.get(active) : undefined
    if (!host || !active || !screen) return
    const fitNow = (): void => {
      if (!host.clientWidth || !host.clientHeight) return
      const before = `${screen.term.cols}x${screen.term.rows}`
      screen.fit.fit()
      if (`${screen.term.cols}x${screen.term.rows}` !== before) {
        api().resize(active, screen.term.cols, screen.term.rows)
      }
    }
    fitNow()
    // The shell takes this view's size, even if another device set another.
    api().resize(active, screen.term.cols, screen.term.rows)
    if (!touchScreen) screen.term.focus()
    const observer = new ResizeObserver(fitNow)
    observer.observe(host)
    return () => observer.disconnect()
  }, [active, terminals])

  // On a phone, the view ends where its keyboard starts.
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.style.height = keyboard
      ? `${keyboard.top + keyboard.height - view.getBoundingClientRect().top}px`
      : ''
  }, [keyboard])

  // The page's colors, again when its theme changes.
  useEffect(() => {
    const apply = (): void => {
      const theme = themeFromPage()
      for (const { term } of shown.current.values()) term.options.theme = theme
    }
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', apply)
    }
  }, [])

  /** A key from the row: sent as the keyboard's own would be. */
  const press = (key: keyof typeof KEYS): void => {
    if (!active) return
    const application = shown.current.get(active)?.term.modes.applicationCursorKeysMode
    const sequence = KEYS[key]
    api().write(active, application ? sequence.replace('\x1b[', '\x1bO') : sequence)
  }

  return (
    <div className="terminal-view" ref={viewRef}>
      <div className="panel-tabs terminal-tabs" role="tablist">
        {terminals.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            className={`panel-tab${t.id === active ? ' active' : ''}`}
            onClick={() => setPicked(t.id)}
          >
            <span className="panel-tab-title">{t.title}</span>
            <button
              className="panel-tab-close"
              title="Close terminal"
              onClick={(e) => {
                e.stopPropagation()
                void api().close(t.id)
              }}
            >
              <CloseIcon width={10} height={10} />
            </button>
          </div>
        ))}
        <button
          className="icon-btn small panel-new-tab"
          title="New terminal"
          onClick={() => void openTerminal()}
        >
          <PlusIcon width={14} height={14} />
        </button>
      </div>
      <div className="terminal-host" ref={hostRef}>
        {terminals.map((t) => (
          <div
            key={t.id}
            className="terminal-screen"
            hidden={t.id !== active}
            ref={(element) => attach(t.id, element)}
          />
        ))}
        {loaded && terminals.length === 0 && (
          <div className="terminal-empty">
            <button className="btn primary" onClick={() => void openTerminal()}>
              New terminal
            </button>
          </div>
        )}
      </div>
      {touchScreen && (
        // Pressing a key leaves the focus in the terminal, so the phone's keyboard stays up.
        <div className="terminal-keys" onPointerDown={(e) => e.preventDefault()}>
          <button className="btn" onClick={() => press('esc')}>
            Esc
          </button>
          <button className="btn" onClick={() => press('tab')}>
            Tab
          </button>
          <button
            className={`btn${ctrl ? ' primary' : ''}`}
            aria-pressed={ctrl}
            onClick={() => holdCtrl(!ctrl)}
          >
            Ctrl
          </button>
          <button className="btn" title="Left" onClick={() => press('left')}>
            ←
          </button>
          <button className="btn" title="Up" onClick={() => press('up')}>
            ↑
          </button>
          <button className="btn" title="Down" onClick={() => press('down')}>
            ↓
          </button>
          <button className="btn" title="Right" onClick={() => press('right')}>
            →
          </button>
          <button
            className="icon-btn"
            title="Keyboard"
            onClick={() => active && shown.current.get(active)?.term.focus()}
          >
            <KeyboardIcon />
          </button>
        </div>
      )}
    </div>
  )
}

const KEYS = {
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D'
}

/** A key typed with Ctrl held: a letter, or one of @ [ \ ] ^ _, as a control character. */
function withCtrl(data: string): string {
  if (data.length !== 1) return data
  const code = data.toUpperCase().charCodeAt(0)
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data
}

/** The terminal's colors from the page's: its text on a clear background, so the glass shows. */
function themeFromPage(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const color = (name: string): string => style.getPropertyValue(name).trim()
  return {
    background: '#00000000',
    foreground: color('--text'),
    cursor: color('--text'),
    cursorAccent: color('--panel-main'),
    selectionBackground: color('--selection') || 'rgba(128, 128, 128, 0.35)'
  }
}
