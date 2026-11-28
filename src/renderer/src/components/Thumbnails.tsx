import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { imageUrl } from '../../../shared/types'
import { ChatImages } from '../lib/chat-images'
import { useOverlay } from '../lib/overlays'
import { hapticTick, rubberBand } from '../lib/gestures'
import { BackIcon, CloseIcon, ForwardIcon } from './icons'

/** A chat's saved images as pictures; one opens full size on click, with the chat's others a step away. */
export function Thumbnails({
  chatId,
  files
}: {
  chatId: string
  /** Names of the chat's saved images (see main/images.ts). */
  files: string[]
}): React.JSX.Element {
  const chatImages = useContext(ChatImages)
  const [open, setOpen] = useState<string>()
  const gallery = open && chatImages.includes(open) ? chatImages : files
  return (
    <div className="thumbs">
      {/* By position: two attachments with the same contents are one saved file. */}
      {files.map((file, index) => (
        <button
          type="button"
          key={index}
          className="thumb"
          title="View full size"
          onClick={(e) => {
            // Inside a call's row, the click must not also fold the row.
            e.stopPropagation()
            setOpen(file)
          }}
        >
          <img
            src={imageUrl(chatId, file, window.api.remote)}
            alt=""
            loading="lazy"
            draggable={false}
          />
        </button>
      ))}
      {open && (
        <ImageViewer
          chatId={chatId}
          files={gallery}
          start={gallery.indexOf(open)}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  )
}

/** How far in an image can be zoomed. */
const MAX_SCALE = 8

/** Zoom and pan of the image shown: its scale, and how far its center moved, in CSS pixels. */
interface View {
  scale: number
  x: number
  y: number
}

const FITTED: View = { scale: 1, x: 0, y: 0 }

/** The view zoomed to `scale` about a point (from the window's center), the point staying put. */
function zoomAbout(view: View, scale: number, px: number, py: number): View {
  const next = Math.min(MAX_SCALE, Math.max(1, scale))
  if (next === 1) return FITTED
  const ratio = next / view.scale
  return { scale: next, x: px - ratio * (px - view.x), y: py - ratio * (py - view.y) }
}

/**
 * The chat's images over the window, edge to edge, from the one opened: the
 * arrows or the arrow keys step through them. Pinching (a trackpad's or two
 * fingers) zooms, dragging moves a zoomed image, and a double click zooms in
 * or back. The cross, Escape, or a click beside the image closes it.
 */
function ImageViewer({
  chatId,
  files,
  start,
  onClose
}: {
  chatId: string
  files: string[]
  start: number
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(Math.max(0, start))
  const [view, setView] = useState<View>(FITTED)
  /** Active swipe offset at 1x zoom: vertical dismisses, horizontal steps between gallery images. */
  const [swipe, setSwipe] = useState<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false
  })
  /** Fingers or the mouse button down on the viewer, where each is. */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  /** Single-finger 1x gesture state: tracks start, locked axis, and tap timing for double-tap zoom. */
  const singleGesture = useRef<{
    startX: number
    startY: number
    startTime: number
    axis: 'none' | 'x' | 'y'
  }>(undefined)
  const lastTap = useRef<{ time: number; x: number; y: number }>(undefined)
  /** The pointer moved the image since it went down: its click must not close the viewer. */
  const dragged = useRef(false)
  useOverlay(ref, true)

  const step = (by: number): void => {
    const next = index + by
    if (next < 0 || next >= files.length) return
    setIndex(next)
    setView(FITTED)
  }

  useEffect(() => {
    // Capture phase, and handled: closing the image must not also stop the agent.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') step(-1)
      else if (event.key === 'ArrowRight') step(1)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // A trackpad's pinch comes as a wheel turn with Control held; without it, a
  // zoomed image moves with two fingers. Not passive, so the page does not zoom.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const px = event.clientX - window.innerWidth / 2
      const py = event.clientY - window.innerHeight / 2
      if (event.ctrlKey) {
        setView((v) => zoomAbout(v, v.scale * Math.exp(-event.deltaY / 100), px, py))
      } else {
        setView((v) => (v.scale > 1 ? { ...v, x: v.x - event.deltaX, y: v.y - event.deltaY } : v))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  function onPointerDown(event: React.PointerEvent): void {
    if ((event.target as HTMLElement).closest('button')) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 1) {
      dragged.current = false
      singleGesture.current = {
        startX: event.clientX,
        startY: event.clientY,
        startTime: event.timeStamp,
        axis: 'none'
      }
    } else {
      singleGesture.current = undefined
      setSwipe({ x: 0, y: 0, active: false })
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: React.PointerEvent): void {
    const last = pointers.current.get(event.pointerId)
    if (!last) return
    const others = [...pointers.current.entries()].filter(([id]) => id !== event.pointerId)
    const now = { x: event.clientX, y: event.clientY }
    if (Math.hypot(now.x - last.x, now.y - last.y) > 2) dragged.current = true
    if (others.length === 1) {
      // Two fingers: zoom by how far apart they moved, about the point between them.
      const other = others[0][1]
      const before = Math.hypot(last.x - other.x, last.y - other.y)
      const after = Math.hypot(now.x - other.x, now.y - other.y)
      const px = (now.x + other.x) / 2 - window.innerWidth / 2
      const py = (now.y + other.y) / 2 - window.innerHeight / 2
      if (before > 0) setView((v) => zoomAbout(v, (v.scale * after) / before, px, py))
    } else if (others.length === 0) {
      if (view.scale > 1) {
        setView((v) => ({ ...v, x: v.x + now.x - last.x, y: v.y + now.y - last.y }))
      } else if (singleGesture.current) {
        // At 1x: swipe vertically to dismiss, or horizontally to step between gallery photos.
        const g = singleGesture.current
        const dx = now.x - g.startX
        const dy = now.y - g.startY
        if (g.axis === 'none' && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
          g.axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x'
        }
        if (g.axis === 'y') {
          setSwipe({ x: 0, y: dy, active: true })
        } else if (g.axis === 'x') {
          const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === files.length - 1)
          setSwipe({ x: atEdge ? rubberBand(dx, 90) : dx, y: 0, active: true })
        }
      }
    }
    pointers.current.set(event.pointerId, now)
  }

  function onPointerUp(event: React.PointerEvent): void {
    pointers.current.delete(event.pointerId)
    const g = singleGesture.current
    singleGesture.current = undefined

    // Double-tap on touch screens zooms in/out at the tap point, as in iOS Photos.
    if (event.pointerType === 'touch' && !dragged.current && pointers.current.size === 0) {
      const now = event.timeStamp
      const prev = lastTap.current
      if (
        prev &&
        now - prev.time < 300 &&
        Math.hypot(event.clientX - prev.x, event.clientY - prev.y) < 36
      ) {
        lastTap.current = undefined
        const px = event.clientX - window.innerWidth / 2
        const py = event.clientY - window.innerHeight / 2
        setView((v) => (v.scale > 1 ? FITTED : zoomAbout(v, 2.5, px, py)))
        return
      }
      lastTap.current = { time: now, x: event.clientX, y: event.clientY }
    }

    if (!g || g.axis === 'none') return
    const dt = Math.max(1, event.timeStamp - g.startTime)
    const dx = event.clientX - g.startX
    const dy = event.clientY - g.startY
    setSwipe({ x: 0, y: 0, active: false })

    if (g.axis === 'y') {
      if (Math.abs(dy) > 95 || Math.abs(dy) / dt > 0.55) {
        hapticTick(8)
        onClose()
      }
    } else if (g.axis === 'x') {
      if ((dx < -64 || dx / dt < -0.45) && index < files.length - 1) {
        hapticTick(6)
        step(1)
      } else if ((dx > 64 || dx / dt > 0.45) && index > 0) {
        hapticTick(6)
        step(-1)
      }
    }
  }

  const file = files[index]
  const dismissFade = swipe.active && swipe.y !== 0 ? Math.max(0.2, 1 - Math.abs(swipe.y) / 360) : 1
  const dismissScale =
    swipe.active && swipe.y !== 0 ? Math.max(0.82, 1 - Math.abs(swipe.y) / 1400) : 1
  // On the body: a chat block rises in with a transform, which would hold a
  // fixed element inside it while the block moves.
  return createPortal(
    <div
      className="image-viewer"
      ref={ref}
      role="dialog"
      aria-label="Image"
      style={
        swipe.active && swipe.y !== 0
          ? { background: `rgba(0, 0, 0, ${(0.88 * dismissFade).toFixed(3)})` }
          : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => {
        // Beside the image closes it, unless that was the end of a drag.
        if (e.target === e.currentTarget && !dragged.current) onClose()
      }}
    >
      <img
        key={file}
        src={imageUrl(chatId, file, window.api.remote)}
        alt=""
        draggable={false}
        className={view.scale > 1 ? 'zoomed' : undefined}
        style={{
          transform: `translate(${view.x + swipe.x}px, ${view.y + swipe.y}px) scale(${view.scale * dismissScale})`,
          transition: swipe.active ? 'none' : undefined
        }}
        onDoubleClick={(e) => {
          const px = e.clientX - window.innerWidth / 2
          const py = e.clientY - window.innerHeight / 2
          setView((v) => (v.scale > 1 ? FITTED : zoomAbout(v, 2.5, px, py)))
        }}
      />
      <button
        type="button"
        className="image-viewer-btn image-viewer-close"
        aria-label="Close"
        onClick={onClose}
      >
        <CloseIcon />
      </button>
      {files.length > 1 && (
        <>
          <span className="image-viewer-count">
            {index + 1} / {files.length}
          </span>
          <button
            type="button"
            className="image-viewer-btn image-viewer-prev"
            aria-label="Previous image"
            disabled={index === 0}
            onClick={() => step(-1)}
          >
            <BackIcon />
          </button>
          <button
            type="button"
            className="image-viewer-btn image-viewer-next"
            aria-label="Next image"
            disabled={index === files.length - 1}
            onClick={() => step(1)}
          >
            <ForwardIcon />
          </button>
        </>
      )}
    </div>,
    document.body
  )
}
