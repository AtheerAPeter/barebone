import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OrbCorner, OrbLine, OrbState } from '../../../shared/types'
import { ChatIcon, SendIcon, StopIcon } from '../components/icons'

/**
 * The agent orb, over the browser page while the chat is folded away (see
 * main/orb.ts): a round icon, with what the agent says and does next to it
 * like subtitles, newest nearest the orb. Hovering the orb opens an input to
 * steer or stop the agent; clicking the orb or a subtitle unfolds the chat.
 * The orb can be dragged to another corner of the page.
 */

const CORNERS: OrbCorner[] = ['bottom-left', 'bottom-right', 'top-left', 'top-right']
const CORNER_KEY = 'orbCorner'
/** What the orb and the room around it take beside the subtitles (see orb.css). */
const ORB_ROOM = 44 + 10 + 2 * 12
/** A press on the orb that moves this far is a drag, not a click. */
const DRAG_PX = 4
/** The input stays open this long after the pointer leaves, so reaching for it does not close it. */
const LEAVE_MS = 400

function savedCorner(): OrbCorner {
  try {
    const saved = localStorage.getItem(CORNER_KEY) as OrbCorner | null
    if (saved && CORNERS.includes(saved)) return saved
  } catch {
    // Storage unavailable: the default corner.
  }
  return 'bottom-left'
}

export function Orb(): React.JSX.Element | null {
  const [state, setState] = useState<OrbState | null>(null)
  const [maxWidth, setMaxWidth] = useState(520)
  const [corner, setCorner] = useState(savedCorner)
  const [hovered, setHovered] = useState(false)
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const orbRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const press = useRef<{ x: number; y: number; moved: boolean }>(undefined)

  useEffect(
    () =>
      window.orb.onState((next, width) => {
        setState(next)
        setMaxWidth(width)
      }),
    []
  )
  useEffect(
    () =>
      window.orb.onCorner((next) => {
        setCorner(next)
        try {
          localStorage.setItem(CORNER_KEY, next)
        } catch {
          // Kept for this session only.
        }
      }),
    []
  )

  // While the user dictates, the ring around the orb grows with their voice.
  useEffect(
    () =>
      window.orb.onLevel((level) => orbRef.current?.style.setProperty('--level', String(level))),
    []
  )
  // What they said lands in the input, to check and send.
  useEffect(
    () =>
      window.orb.onDraft((spoken) => {
        setText((current) => (current.trim() ? `${current.trimEnd()} ${spoken}` : spoken))
        requestAnimationFrame(() => inputRef.current?.focus())
      }),
    []
  )

  // The view is sized to what shows, in its corner of the page.
  const shown = state !== null
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const report = (): void =>
      window.orb.size({ width: el.offsetWidth, height: el.offsetHeight }, corner)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [corner, shown])

  if (!state) return null
  const open = !dragging && (hovered || focused || text !== '')
  const running = state.status !== 'idle'

  function enter(): void {
    clearTimeout(leaveTimer.current)
    setHovered(true)
  }
  function leave(): void {
    leaveTimer.current = setTimeout(() => setHovered(false), LEAVE_MS)
  }

  function submit(): void {
    const message = text.trim()
    if (!message || !state) return
    window.orb.send(state.chatId, message)
    setText('')
  }

  return (
    <div
      ref={rootRef}
      className={`orb-root ${corner}`}
      style={{ maxWidth }}
      onMouseEnter={() => hovered && enter()}
      onMouseLeave={leave}
    >
      <button
        ref={orbRef}
        className={`orb ${state.voice === 'recording' ? 'listening' : state.status}`}
        title="Open the chat (drag to move)"
        onMouseEnter={enter}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          press.current = { x: e.screenX, y: e.screenY, moved: false }
        }}
        onPointerMove={(e) => {
          const start = press.current
          if (!start) return
          if (!start.moved && Math.hypot(e.screenX - start.x, e.screenY - start.y) < DRAG_PX) return
          start.moved = true
          setDragging(true)
          window.orb.drag(e.screenX, e.screenY)
        }}
        onPointerUp={() => {
          const start = press.current
          press.current = undefined
          if (!start) return
          if (start.moved) {
            setDragging(false)
            window.orb.drop()
          } else {
            window.orb.unfold()
          }
        }}
      >
        <ChatIcon width={19} height={19} />
      </button>
      {!dragging && (
        <div className="orb-column" style={{ maxWidth: maxWidth - ORB_ROOM }}>
          {state.lines.map((line, index) => (
            <Subtitle
              key={line.id}
              line={line}
              age={state.lines.length - 1 - index + (state.voice ? 1 : 0)}
            />
          ))}
          {state.voice && (
            <div className="sub voice">
              {state.voice === 'recording' ? (
                <>
                  <span className="voice-dot" />
                  <span>Listening…</span>
                </>
              ) : (
                <span className="shimmer">Writing out what you said…</span>
              )}
            </div>
          )}
          {open && (
            <form
              className="orb-input"
              onSubmit={(e) => {
                e.preventDefault()
                submit()
              }}
            >
              {/* Not focused on hover: that would take the keyboard from the page. */}
              <input
                ref={inputRef}
                value={text}
                placeholder={running ? 'Steer the agent…' : 'Message the agent…'}
                onChange={(e) => setText(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  setText('')
                  setHovered(false)
                  e.currentTarget.blur()
                }}
              />
              <button
                type="button"
                className="orb-icon-btn"
                title="Open the chat"
                onClick={() => window.orb.unfold()}
              >
                <ChatIcon width={15} height={15} />
              </button>
              {running && !text.trim() ? (
                <button
                  type="button"
                  className="orb-send stop"
                  title="Stop"
                  onClick={() => window.orb.stop(state.chatId)}
                >
                  <StopIcon width={14} height={14} />
                </button>
              ) : (
                <button type="submit" className="orb-send" title="Send" disabled={!text.trim()}>
                  <SendIcon width={15} height={15} />
                </button>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  )
}

/** One subtitle. Older ones dim, so the newest reads first; a click unfolds the chat. */
function Subtitle({ line, age }: { line: OrbLine; age: number }): React.JSX.Element {
  return (
    <button
      className={`sub ${line.kind}${age === 1 ? ' old' : age >= 2 ? ' older' : ''}`}
      title="Open the chat"
      onClick={() => window.orb.unfold()}
    >
      {line.kind === 'call' ? (
        <>
          {line.live && <span className="sub-spinner" />}
          <span className={`sub-verb${line.live ? ' shimmer' : ''}`}>{line.verb}</span>
          <span className="sub-target">{line.text}</span>
        </>
      ) : line.kind === 'thought' ? (
        <>
          <span className="sub-label">Thinking</span>
          <span>{line.text}</span>
        </>
      ) : line.kind === 'ask' ? (
        <>
          <span className="sub-label">Needs you</span>
          <span>{line.text}</span>
        </>
      ) : (
        <span>{line.text}</span>
      )}
    </button>
  )
}
