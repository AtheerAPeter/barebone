import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import type { BrowserTab, RemoteBrowserView } from '../../../shared/types'
import {
  BackIcon,
  CloseIcon,
  ForwardIcon,
  GlobeIcon,
  KeyboardIcon,
  LockIcon,
  PlusIcon,
  ReloadIcon
} from '../components/icons'

/**
 * A chat's browser tab from the Mac, live, through the remote link
 * (main/remote/browser.ts). The page is a picture the Mac sends each time it
 * changes; a tap here is a click there, a drag a scroll, and the keyboard
 * button types into the page. On a phone it covers the screen, as the code
 * panel does.
 */

interface Props {
  chatId: string
  onClose: () => void
}

/** The page area, in CSS pixels, and pixels per CSS pixel the pictures need at most. */
function sizeOf(el: HTMLElement): { width: number; height: number; ratio: number } {
  const { width, height } = el.getBoundingClientRect()
  return { width: Math.round(width), height: Math.round(height), ratio: devicePixelRatio || 1 }
}

/** A finger that moves this far is scrolling, not tapping. */
const TAP_SLOP = 8
/** The page is laid out anew once the area stops changing size for this long. */
const RESIZE_MS = 250
/** Leaving the keyboard's field ends typing, unless something takes it back by then. */
const BLUR_MS = 300

interface Frame {
  url: string
  /** The page's viewport in CSS pixels. */
  width: number
  height: number
}

const api = (): typeof window.api.remoteBrowser => window.api.remoteBrowser

export function BrowserSheet({ chatId, onClose }: Props): React.JSX.Element {
  const pageRef = useRef<HTMLDivElement>(null)
  const keysRef = useRef<HTMLInputElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [view, setView] = useState<RemoteBrowserView>()
  const [frame, setFrame] = useState<Frame>()
  /** Why the page cannot show: it failed to open, or another device has it. */
  const [problem, setProblem] = useState<string>()
  const [elsewhere, setElsewhere] = useState(false)
  /** Bumped to open the tab here again. */
  const [opening, setOpening] = useState(0)
  const [mode, setMode] = useState<'page' | 'tabs' | 'address'>('page')
  /** While the keyboard types into the page: the field's label, '' for one with none, null for none. */
  const [typing, setTyping] = useState<{ field: string | null }>()
  const [notice, setNotice] = useState<string>()
  const keyboard = useKeyboardArea(typing !== undefined)

  // Show the tab here, and again when the connection to the Mac comes back.
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    let current = true
    setProblem(undefined)
    setElsewhere(false)
    api()
      .open(chatId, sizeOf(el))
      .then(
        (opened) => current && setView(opened),
        (error: Error) => current && setProblem(error.message)
      )
    return () => {
      current = false
      void api()
        .close()
        .catch(() => undefined)
    }
  }, [chatId, opening])

  useEffect(() => {
    const offState = api().onState((next) => {
      if (next.chatId === chatId) setView(next)
    })
    const offFrame = api().onFrame((header, jpeg) => {
      if (header.chatId !== chatId) return
      const url = URL.createObjectURL(
        new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
      )
      setFrame({ url, width: header.width, height: header.height })
    })
    const offClosed = api().onClosed((closed, reason) => {
      if (closed !== chatId) return
      setView(undefined)
      setFrame(undefined)
      if (reason === 'elsewhere') setElsewhere(true)
      else setProblem('The browser was turned off for the remote link on your Mac.')
    })
    const offReconnected = api().onReconnected(() => setOpening((n) => n + 1))
    return () => {
      offState()
      offFrame()
      offClosed()
      offReconnected()
    }
  }, [chatId])

  // The picture shown, kept until the next one shows, then let go.
  const shown = useRef<string>(undefined)
  useEffect(
    () => () => {
      if (shown.current) URL.revokeObjectURL(shown.current)
    },
    []
  )
  const pictureShown = (url: string): void => {
    if (shown.current && shown.current !== url) URL.revokeObjectURL(shown.current)
    shown.current = url
    // The Mac sends the next picture once this one shows.
    api().ack()
  }

  // The page is laid out at the area's size, anew when it changes (a turned phone, the keyboard).
  const opened = view !== undefined
  useEffect(() => {
    const el = pageRef.current
    if (!el || !opened) return
    let last = sizeOf(el)
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const size = sizeOf(el)
        if (size.width === last.width && size.height === last.height) return
        last = size
        void api()
          .resize(size)
          .catch(() => undefined)
      }, RESIZE_MS)
    })
    observer.observe(el)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [opened])

  /** Where a point of the screen is on the page, in its CSS pixels; the picture sits top centre. */
  const pagePoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number; scale: number } | undefined => {
      const el = pageRef.current
      if (!el || !frame) return undefined
      const r = el.getBoundingClientRect()
      const scale = Math.min(r.width / frame.width, r.height / frame.height)
      const left = r.left + (r.width - frame.width * scale) / 2
      const x = (clientX - left) / scale
      const y = (clientY - r.top) / scale
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return undefined
      return { x: Math.round(x), y: Math.round(y), scale }
    },
    [frame]
  )

  const fail = (error: Error): void => setNotice(error.message)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  // A tap is a click; a drag scrolls, sent a step at a time as each one lands.
  const gesture = useRef<{ x: number; y: number; lastX: number; lastY: number; moved: boolean }>(
    undefined
  )
  const scrolling = useRef({ dx: 0, dy: 0, at: { x: 0, y: 0 }, busy: false })
  const sendScroll = (): void => {
    const s = scrolling.current
    if (s.busy || (!s.dx && !s.dy)) return
    const { dx, dy, at } = s
    s.dx = 0
    s.dy = 0
    s.busy = true
    api()
      .scroll(at.x, at.y, Math.round(dx), Math.round(dy))
      .catch(() => undefined)
      .finally(() => {
        s.busy = false
        sendScroll()
      })
  }

  const typed = useRef(Promise.resolve())
  /** Keys and text go to the page in the order they were typed. */
  const queue = (work: () => Promise<unknown>): void => {
    typed.current = typed.current.then(work).then(
      () => undefined,
      (error: Error) => fail(error)
    )
  }

  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** Open the phone's keyboard, in the tap, for the field that has focus on the page. */
  const startTyping = (): void => {
    clearTimeout(blurTimer.current)
    keysRef.current?.focus()
    setTyping((t) => t ?? { field: null })
    api()
      .focused()
      .then((field) => setTyping((t) => t && { field }))
      .catch(() => undefined)
  }
  const stopTyping = (): void => {
    clearTimeout(blurTimer.current)
    keysRef.current?.blur()
    setTyping(undefined)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = {
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false
    }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (!g) return
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < TAP_SLOP) return
    const start = pagePoint(g.x, g.y)
    if (!start) return
    g.moved = true
    const s = scrolling.current
    // A finger moving up scrolls the page down.
    s.dx -= (e.clientX - g.lastX) / start.scale
    s.dy -= (e.clientY - g.lastY) / start.scale
    s.at = start
    g.lastX = e.clientX
    g.lastY = e.clientY
    sendScroll()
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const g = gesture.current
    gesture.current = undefined
    if (!g || g.moved) return
    const point = pagePoint(e.clientX, e.clientY)
    if (!point) return
    // Still in the tap: the keyboard stays open for the field tapped next.
    if (typing) keysRef.current?.focus()
    const wasTyping = typing !== undefined
    queue(async () => {
      await api().tap(point.x, point.y)
      if (!wasTyping) return
      const field = await api().focused()
      setTyping((t) => t && { field })
    })
  }

  /** Edit the address, starting from the page's, or from nothing for a new tab. */
  const openAddress = (start = view?.url ?? ''): void => {
    flushSync(() => setMode('address'))
    const field = addressRef.current
    if (!field) return
    field.value = start
    // In the tap, so the phone opens its keyboard.
    field.focus()
    field.select()
  }

  const active = view?.tabs.find((t) => t.id === view.activeTab)
  /** The tab is here to use: to go elsewhere in, also from a page that shows only on the Mac. */
  const usable = view && !elsewhere && !problem
  /** Its page shows here, and takes taps and keys. */
  const showing = usable && !view.local

  return (
    <aside
      className={`side-panel remote-browser${typing ? ' typing' : ''}`}
      style={keyboard ? { height: keyboard.height, top: keyboard.top, bottom: 'auto' } : undefined}
    >
      <div className="rb-top">
        {mode === 'address' ? (
          <form
            className="rb-address editing"
            onSubmit={(e) => {
              e.preventDefault()
              const input = addressRef.current?.value.trim()
              setMode('page')
              if (input) api().navigate(input).catch(fail)
            }}
          >
            <input
              ref={addressRef}
              placeholder="Search or enter address"
              enterKeyHint="go"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onBlur={() => setMode((m) => (m === 'address' ? 'page' : m))}
            />
            <button
              type="button"
              className="label-btn"
              // Before the field's blur closes it, so the tap lands.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setMode('page')}
            >
              Cancel
            </button>
          </form>
        ) : mode === 'tabs' ? (
          <>
            <b className="rb-heading">Tabs</b>
            <button
              className="icon-btn"
              title="New tab"
              onClick={() => {
                api().newTab().catch(fail)
                openAddress('')
              }}
            >
              <PlusIcon />
            </button>
            <button className="label-btn rb-done" onClick={() => setMode('page')}>
              Done
            </button>
          </>
        ) : (
          <>
            <button className="icon-btn" title="Close the browser" onClick={onClose}>
              <CloseIcon />
            </button>
            <button className="rb-address" disabled={!usable} onClick={() => openAddress()}>
              {view?.url.startsWith('https:') && <LockIcon width={13} height={13} />}
              <span>{view?.url ? hostOf(view.url) : 'Search or enter address'}</span>
            </button>
          </>
        )}
      </div>
      {mode === 'page' && showing && view.minimized && (
        <div className="rb-agent rb-warn">
          Barebone is minimized on your Mac, so the page may not show. Open its window there.
        </div>
      )}
      {mode === 'page' && showing && active?.controlled && (
        <div className="rb-agent">
          <span className="rb-agent-dot" />
          The agent is using this tab
        </div>
      )}
      <div
        className="rb-page"
        ref={pageRef}
        onPointerDown={showing ? onPointerDown : undefined}
        onPointerMove={showing ? onPointerMove : undefined}
        onPointerUp={showing ? onPointerUp : undefined}
        onPointerCancel={() => (gesture.current = undefined)}
      >
        {showing && frame && (
          <img
            key={frame.url}
            src={frame.url}
            alt=""
            draggable={false}
            onLoad={() => pictureShown(frame.url)}
            onError={() => pictureShown(frame.url)}
          />
        )}
        {problem ? (
          <p className="rb-message">{problem}</p>
        ) : elsewhere ? (
          <div className="rb-message">
            <p>This browser is open on another device.</p>
            <button className="btn primary" onClick={() => setOpening((n) => n + 1)}>
              Show it here
            </button>
          </div>
        ) : view?.local ? (
          <p className="rb-message">This page is a file on your Mac, so it shows only there.</p>
        ) : (
          !frame && (
            <p className="rb-message">
              <span className="spinner" />
            </p>
          )
        )}
        {showing && view.dialog && (
          <div className="rb-dialog" onPointerDown={(e) => e.stopPropagation()}>
            <b>{view.dialog.site} says</b>
            <p>{view.dialog.message}</p>
            {view.dialog.answerable ? (
              <div className="rb-dialog-buttons">
                {view.dialog.type === 'confirm' && (
                  <button className="btn" onClick={() => api().answer(false).catch(fail)}>
                    Cancel
                  </button>
                )}
                <button className="btn primary" onClick={() => api().answer(true).catch(fail)}>
                  OK
                </button>
              </div>
            ) : (
              <p className="rb-dialog-note">Answer it on your Mac.</p>
            )}
          </div>
        )}
        {mode === 'tabs' && view && (
          <TabGrid
            tabs={view.tabs}
            activeTab={view.activeTab}
            frame={frame}
            onPick={(tabId) => {
              setMode('page')
              api().selectTab(tabId).catch(fail)
            }}
            onClose={(tabId) => api().closeTab(tabId).catch(fail)}
          />
        )}
      </div>
      {notice && <div className="rb-notice">{notice}</div>}
      {typing ? (
        <div className="rb-typebar">
          <KeyboardIcon width={14} height={14} />
          <span className="rb-typing">
            {typing.field === null ? (
              'Tap a field in the page to type into it'
            ) : (
              <>
                Typing into <b>{typing.field || 'a field'}</b>
              </>
            )}
          </span>
          <button
            className="label-btn rb-done"
            onPointerDown={(e) => e.preventDefault()}
            onClick={stopTyping}
          >
            Done
          </button>
        </div>
      ) : (
        mode === 'page' && (
          <div className="rb-bottom">
            <button
              className="icon-btn"
              title="Back"
              disabled={!usable || !view.canGoBack}
              onClick={() => api().back().catch(fail)}
            >
              <BackIcon />
            </button>
            <button
              className="icon-btn"
              title="Forward"
              disabled={!usable || !view.canGoForward}
              onClick={() => api().forward().catch(fail)}
            >
              <ForwardIcon />
            </button>
            <button
              className="icon-btn"
              title="Reload"
              disabled={!usable}
              onClick={() => api().reload().catch(fail)}
            >
              <ReloadIcon className={view?.loading ? 'spin' : undefined} />
            </button>
            <button
              className="icon-btn"
              title="Type into the page"
              disabled={!showing}
              onClick={startTyping}
            >
              <KeyboardIcon />
            </button>
            <button
              className="icon-btn rb-tabs"
              title="Tabs"
              disabled={!usable}
              onClick={() => setMode('tabs')}
            >
              <span>{view?.tabs.length ?? ''}</span>
            </button>
          </div>
        )
      )}
      {/* The phone's keyboard types here; each key goes on to the page. */}
      <input
        ref={keysRef}
        className="rb-keys"
        aria-label="Type into the page"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="enter"
        onKeyDown={(e) => {
          const key = e.key
          const empty = !e.currentTarget.value
          if (key === 'Enter' || key === 'Tab' || (key === 'Backspace' && empty)) {
            e.preventDefault()
            queue(() => api().key(key))
          }
        }}
        onInput={(e) => {
          const text = e.currentTarget.value
          e.currentTarget.value = ''
          if (text) queue(() => api().type(text))
        }}
        onFocus={() => clearTimeout(blurTimer.current)}
        onBlur={() => {
          clearTimeout(blurTimer.current)
          blurTimer.current = setTimeout(() => setTyping(undefined), BLUR_MS)
        }}
      />
    </aside>
  )
}

/** The chat's tabs, as cards; the one shown has the latest picture of its page. */
function TabGrid({
  tabs,
  activeTab,
  frame,
  onPick,
  onClose
}: {
  tabs: BrowserTab[]
  activeTab?: string
  frame?: Frame
  onPick: (tabId: string) => void
  onClose: (tabId: string) => void
}): React.JSX.Element {
  return (
    <div className="rb-tabs-grid" onPointerDown={(e) => e.stopPropagation()}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="button"
          className={`rb-tab${tab.id === activeTab ? ' on' : ''}`}
          onClick={() => onPick(tab.id)}
        >
          <div className="rb-tab-head">
            <span className="rb-tab-icon">
              <GlobeIcon width={13} height={13} />
              {tab.controlled && <span className="rb-agent-dot" />}
            </span>
            <span className="rb-tab-title">{tab.title || hostOf(tab.url) || 'New tab'}</span>
            <button
              className="icon-btn small"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
            >
              <CloseIcon width={12} height={12} />
            </button>
          </div>
          <div className="rb-tab-preview">
            {tab.id === activeTab && frame ? (
              <img src={frame.url} alt="" draggable={false} />
            ) : (
              <span>{hostOf(tab.url) || 'New tab'}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    const { host, pathname } = new URL(url)
    return host + (pathname === '/' ? '' : pathname)
  } catch {
    return url
  }
}

/** The visual viewport's height and top, as one string: a snapshot that compares by value. */
function viewportArea(): string {
  const viewport = window.visualViewport
  return viewport ? `${viewport.height},${viewport.offsetTop}` : ''
}

function onViewportChange(listener: () => void): () => void {
  const viewport = window.visualViewport
  viewport?.addEventListener('resize', listener)
  viewport?.addEventListener('scroll', listener)
  return () => {
    viewport?.removeEventListener('resize', listener)
    viewport?.removeEventListener('scroll', listener)
  }
}

/**
 * The part of the screen above the phone's keyboard, while `on`. A phone
 * leaves the page its full height and draws the keyboard over it; the sheet
 * is fitted above it so what is typed into stays in sight.
 */
function useKeyboardArea(on: boolean): { height: number; top: number } | undefined {
  const area = useSyncExternalStore(onViewportChange, viewportArea)
  if (!on || !area) return undefined
  const [height, top] = area.split(',').map(Number)
  return { height, top }
}
