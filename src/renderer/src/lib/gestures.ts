import { useEffect, useRef, type RefObject } from 'react'

/**
 * Native-feeling iOS touch gestures for the whole app:
 * - Interactive left drawer swipe (open from anywhere, close by swiping left)
 * - Interactive bottom-sheet swipe-down to dismiss with rubber-band resistance
 * - Interactive edge/view swipe-back for pushed panels and subviews
 * - Long-press with movement cancellation and click suppression
 *
 * Uses touch events rather than pointer events so vertical native scrolling
 * stays 120fps on iOS Safari; preventDefault() is called only after direction
 * locks onto the gesture axis and no scrollable ancestor wants the scroll.
 */

const LOCK_DISTANCE = 10
const AXIS_RATIO = 1.15
const SPRING_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'

/** Touch events claimed by an inner gesture so outer gestures (like the sidebar) yield. */
const claimedTouches = new WeakSet<Event>()

export function claimGesture(event: Event): void {
  claimedTouches.add(event)
}

export function isGestureClaimed(event: Event): boolean {
  return claimedTouches.has(event)
}

/** Light haptic tick on devices that support Vibration API (ignored silently on iOS Safari). */
export function hapticTick(ms = 10): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    // Ignore when blocked or unsupported.
  }
}

/** Standard iOS rubber-band damping past a boundary. */
export function rubberBand(offset: number, limit: number): number {
  const abs = Math.abs(offset)
  const damped = (abs * limit * 0.55) / (limit + 0.55 * abs)
  return offset < 0 ? -damped : damped
}

/** Whether any scrollable element between `target` and `stopAt` can scroll along `axis` in `delta`'s direction. */
export function canScrollInDirection(
  target: EventTarget | null,
  stopAt: Element | null,
  axis: 'x' | 'y',
  delta: number
): boolean {
  if (!(target instanceof Element)) return false
  // Range inputs / sliders own horizontal drags.
  if (
    axis === 'x' &&
    target.closest(
      'input[type="range"], .effort-slider, [data-no-swipe="x"], [data-no-swipe="all"]'
    )
  ) {
    return true
  }
  if (axis === 'y' && target.closest('[data-no-swipe="y"], [data-no-swipe="all"]')) {
    return true
  }
  for (let el: Element | null = target; el && el !== stopAt; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (axis === 'x') {
      const overflow = style.overflowX
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollWidth > el.clientWidth + 2) {
        // Finger moving right (delta > 0) scrolls content left (needs scrollLeft > 0).
        if (delta > 0 && el.scrollLeft > 1) return true
        // Finger moving left (delta < 0) scrolls content right (needs room to the right).
        if (delta < 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 2) return true
      }
    } else {
      const overflow = style.overflowY
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 2) {
        // Finger moving down (delta > 0) scrolls content up (needs scrollTop > 0).
        if (delta > 0 && el.scrollTop > 1) return true
        // Finger moving up (delta < 0) scrolls content down.
        if (delta < 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 2) return true
      }
    }
  }
  return false
}

/** Tracks recent touch positions to compute liftoff flick velocity in px/ms. */
class VelocityTracker {
  private samples: { pos: number; time: number }[] = []

  reset(pos: number, time: number): void {
    this.samples = [{ pos, time }]
  }

  add(pos: number, time: number): void {
    this.samples.push({ pos, time })
    const cutoff = time - 90
    while (this.samples.length > 2 && this.samples[0].time < cutoff) {
      this.samples.shift()
    }
  }

  /** Velocity in px/ms (positive = rightward or downward). */
  velocity(): number {
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const dt = last.time - first.time
    if (dt <= 0) return 0
    return (last.pos - first.pos) / dt
  }
}

/** Whether a blocking modal/sheet overlay is currently open over the page. */
function hasBlockingOverlay(): boolean {
  return Boolean(
    document.querySelector(
      '.palette-backdrop:not(.leaving), .image-viewer, .settings-sheet:not(.leaving), .menu.sheet:not(.leaving), .picker-menu:not(.leaving), .settings-dialog-backdrop'
    )
  )
}

/**
 * Interactive left-drawer swipe + swipe-left action (e.g. open Browser) for mobile:
 * - Closed: swipe right from anywhere (or left edge when `edgeOnly`) drags the sidebar in 1:1.
 * - Closed: swipe left from anywhere drags a Liquid Glass peek pill from the right edge and triggers `onSwipeLeft`.
 * - Open: swipe left anywhere on the sidebar or scrim drags it closed 1:1.
 * Also supports Mac trackpad two-finger horizontal swipe and mouse edge drag for desktop previews.
 */
export function useDrawerSwipe({
  enabled,
  open,
  blocked,
  edgeOnly = false,
  sidebarRef,
  scrimRef,
  peekRef,
  onOpen,
  onClose,
  onSwipeLeft
}: {
  enabled: boolean
  open: boolean
  blocked: boolean
  edgeOnly?: boolean
  sidebarRef: RefObject<HTMLElement | null>
  scrimRef: RefObject<HTMLElement | null>
  /** Optional right-edge Liquid Glass peek indicator shown while swiping left. */
  peekRef?: RefObject<HTMLElement | null>
  onOpen: () => void
  onClose: () => void
  onSwipeLeft?: () => void
}): void {
  const latest = useRef({ open, blocked, edgeOnly, onOpen, onClose, onSwipeLeft })
  useEffect(() => {
    latest.current = { open, blocked, edgeOnly, onOpen, onClose, onSwipeLeft }
  })

  useEffect(() => {
    if (!enabled) return

    let mode: 'idle' | 'pending' | 'open-drag' | 'close-drag' | 'left-action' | 'ignored' = 'idle'
    let startX = 0
    let startY = 0
    let lastDx = 0
    let drawerWidth = 320
    let leftReady = false
    let target: EventTarget | null = null
    const tracker = new VelocityTracker()
    const LEFT_THRESHOLD = 76

    const clearInline = (): void => {
      const sidebar = sidebarRef.current
      const scrim = scrimRef.current
      const peek = peekRef?.current
      if (sidebar) {
        delete sidebar.dataset.dragging
        sidebar.style.translate = ''
        sidebar.style.visibility = ''
      }
      if (scrim) {
        delete scrim.dataset.dragging
        scrim.style.opacity = ''
        scrim.style.pointerEvents = ''
      }
      if (peek) {
        delete peek.dataset.dragging
        delete peek.dataset.ready
        peek.style.opacity = ''
        peek.style.transform = ''
      }
      leftReady = false
      document.documentElement.classList.remove('swiping')
    }

    const updateLeftPeek = (dx: number): void => {
      const peek = peekRef?.current
      const dist = Math.max(0, -dx)
      const nowReady = dist >= LEFT_THRESHOLD
      if (nowReady && !leftReady) hapticTick(10)
      leftReady = nowReady
      if (!peek) return
      const progress = Math.min(1, dist / LEFT_THRESHOLD)
      const shift = Math.min(28, rubberBand(dist, 36))
      peek.dataset.dragging = 'true'
      if (nowReady) peek.dataset.ready = 'true'
      else delete peek.dataset.ready
      peek.style.opacity = String(progress)
      peek.style.transform = `translate3d(${16 - shift}px, -50%, 0) scale(${0.88 + 0.12 * progress})`
    }

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || isGestureClaimed(e)) return
      const { open: isOpen, blocked: isBlocked, edgeOnly: isEdgeOnly } = latest.current
      if (isBlocked || hasBlockingOverlay()) return

      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      lastDx = 0
      leftReady = false
      target = e.target
      tracker.reset(startX, e.timeStamp)

      if (!isOpen && isEdgeOnly && startX > 34) {
        mode = 'ignored'
        return
      }
      mode = 'pending'
    }

    const onMove = (e: TouchEvent): void => {
      if (mode === 'idle' || mode === 'ignored' || e.touches.length !== 1) return
      if (isGestureClaimed(e)) {
        if (mode === 'open-drag' || mode === 'close-drag' || mode === 'left-action') clearInline()
        mode = 'ignored'
        return
      }
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      tracker.add(touch.clientX, e.timeStamp)

      if (mode === 'pending') {
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)
        if (absX < LOCK_DISTANCE && absY < LOCK_DISTANCE) return
        if (absY * AXIS_RATIO > absX) {
          mode = 'ignored'
          return
        }
        const { open: isOpen, onSwipeLeft: leftCb } = latest.current
        // Respect horizontal scrollers unless starting right on an edge.
        if (
          startX > 28 &&
          startX < window.innerWidth - 28 &&
          canScrollInDirection(target, document.body, 'x', dx)
        ) {
          mode = 'ignored'
          return
        }
        if (!isOpen && dx < 0) {
          if (!leftCb) {
            mode = 'ignored'
            return
          }
          mode = 'left-action'
          document.documentElement.classList.add('swiping')
        } else if (isOpen && dx >= 0) {
          mode = 'ignored'
          return
        } else {
          const sidebar = sidebarRef.current
          if (!sidebar) {
            mode = 'ignored'
            return
          }
          drawerWidth = sidebar.offsetWidth || Math.min(336, window.innerWidth * 0.86)
          mode = isOpen ? 'close-drag' : 'open-drag'
          sidebar.dataset.dragging = 'true'
          sidebar.style.visibility = 'visible'
          const scrim = scrimRef.current
          if (scrim) {
            scrim.dataset.dragging = 'true'
            scrim.style.pointerEvents = 'auto'
          }
          document.documentElement.classList.add('swiping')
        }
      }

      if (mode === 'left-action') {
        e.preventDefault()
        lastDx = dx
        updateLeftPeek(dx)
        return
      }

      if (mode === 'open-drag' || mode === 'close-drag') {
        e.preventDefault()
        lastDx = dx
        const sidebar = sidebarRef.current
        const scrim = scrimRef.current
        if (!sidebar) return

        if (mode === 'open-drag') {
          const clamped = dx <= drawerWidth ? dx : drawerWidth + rubberBand(dx - drawerWidth, 36)
          const progress = Math.max(0, Math.min(1, dx / drawerWidth))
          sidebar.style.translate = `${clamped - drawerWidth}px 0`
          if (scrim) scrim.style.opacity = String(progress)
        } else {
          const clamped = dx >= 0 ? rubberBand(dx, 28) : Math.max(-drawerWidth, dx)
          const progress = Math.max(0, Math.min(1, 1 + dx / drawerWidth))
          sidebar.style.translate = `${clamped}px 0`
          if (scrim) scrim.style.opacity = String(progress)
        }
      }
    }

    const onEnd = (): void => {
      if (mode === 'left-action') {
        const vx = tracker.velocity()
        const trigger = lastDx <= -LEFT_THRESHOLD || (lastDx < -28 && vx < -0.4)
        mode = 'idle'
        clearInline()
        if (trigger) {
          hapticTick(10)
          latest.current.onSwipeLeft?.()
        }
        return
      }
      if (mode !== 'open-drag' && mode !== 'close-drag') {
        mode = 'idle'
        return
      }
      const vx = tracker.velocity()
      const wasOpening = mode === 'open-drag'
      mode = 'idle'
      clearInline()

      if (wasOpening) {
        if (lastDx > drawerWidth * 0.3 || vx > 0.35) {
          hapticTick(8)
          latest.current.onOpen()
        }
      } else {
        if (lastDx < -drawerWidth * 0.28 || vx < -0.35) {
          hapticTick(8)
          latest.current.onClose()
        }
      }
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })

    // Also support Mac trackpad two-finger horizontal swipe and mouse edge/drawer drag
    // so desktop preview & narrow-window users get the same gesture feel.
    let wheelAccum = 0
    let wheelTimer: ReturnType<typeof setTimeout> | undefined
    let wheelCooldown = 0
    const onWheel = (e: WheelEvent): void => {
      const {
        open: isOpen,
        blocked: isBlocked,
        onOpen: openCb,
        onClose: closeCb,
        onSwipeLeft: leftCb
      } = latest.current
      if (isBlocked || hasBlockingOverlay()) return
      if (e.timeStamp < wheelCooldown) return
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.4 || Math.abs(e.deltaX) < 4) return
      // Natural trackpad swipe right gives negative deltaX; swipe left gives positive deltaX.
      const swipeDir = -e.deltaX
      if (canScrollInDirection(e.target, document.body, 'x', swipeDir)) return
      if (!isOpen && swipeDir > 0) {
        wheelAccum = Math.max(0, wheelAccum) + swipeDir
        clearTimeout(wheelTimer)
        wheelTimer = setTimeout(() => (wheelAccum = 0), 180)
        if (wheelAccum > 55) {
          wheelAccum = 0
          wheelCooldown = e.timeStamp + 450
          openCb()
        }
      } else if (!isOpen && swipeDir < 0 && leftCb) {
        wheelAccum = Math.min(0, wheelAccum) + swipeDir
        clearTimeout(wheelTimer)
        wheelTimer = setTimeout(() => (wheelAccum = 0), 180)
        if (wheelAccum < -55) {
          wheelAccum = 0
          wheelCooldown = e.timeStamp + 450
          leftCb()
        }
      } else if (isOpen && swipeDir < 0) {
        wheelAccum = Math.min(0, wheelAccum) + swipeDir
        clearTimeout(wheelTimer)
        wheelTimer = setTimeout(() => (wheelAccum = 0), 180)
        if (wheelAccum < -55) {
          wheelAccum = 0
          wheelCooldown = e.timeStamp + 450
          closeCb()
        }
      }
    }

    let mouseMode: 'idle' | 'pending' | 'open-drag' | 'close-drag' | 'left-action' = 'idle'
    let mouseStartX = 0
    let mouseStartY = 0
    let mouseLastDx = 0
    let mouseWidth = 320
    const mouseTracker = new VelocityTracker()

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      const { open: isOpen, blocked: isBlocked, onSwipeLeft: leftCb } = latest.current
      if (isBlocked || hasBlockingOverlay()) return
      if (e.target instanceof Element && e.target.closest('input, textarea, select, button, a')) {
        return
      }
      // Closed: drag right from left 56px edge, or drag left from right 56px edge (keeps chat text selection intact).
      // Open: drag left from anywhere on the sidebar or scrim.
      const nearLeft = e.clientX <= 56
      const nearRight = Boolean(leftCb) && e.clientX >= window.innerWidth - 56
      if (!isOpen && !nearLeft && !nearRight) return
      mouseStartX = e.clientX
      mouseStartY = e.clientY
      mouseLastDx = 0
      mouseTracker.reset(mouseStartX, e.timeStamp)
      mouseMode = 'pending'
    }

    const onMouseMove = (e: MouseEvent): void => {
      if (mouseMode === 'idle') return
      const dx = e.clientX - mouseStartX
      const dy = e.clientY - mouseStartY
      mouseTracker.add(e.clientX, e.timeStamp)

      if (mouseMode === 'pending') {
        if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) return
        if (Math.abs(dy) * AXIS_RATIO > Math.abs(dx)) {
          mouseMode = 'idle'
          return
        }
        const { open: isOpen, onSwipeLeft: leftCb } = latest.current
        if (!isOpen && dx < 0 && leftCb && mouseStartX >= window.innerWidth - 56) {
          mouseMode = 'left-action'
          document.documentElement.classList.add('swiping')
        } else if ((!isOpen && dx <= 0) || (isOpen && dx >= 0)) {
          mouseMode = 'idle'
          return
        } else {
          const sidebar = sidebarRef.current
          if (!sidebar) {
            mouseMode = 'idle'
            return
          }
          mouseWidth = sidebar.offsetWidth || Math.min(336, window.innerWidth * 0.86)
          mouseMode = isOpen ? 'close-drag' : 'open-drag'
          sidebar.dataset.dragging = 'true'
          sidebar.style.visibility = 'visible'
          const scrim = scrimRef.current
          if (scrim) {
            scrim.dataset.dragging = 'true'
            scrim.style.pointerEvents = 'auto'
          }
          document.documentElement.classList.add('swiping')
        }
      }

      if (mouseMode === 'left-action') {
        mouseLastDx = dx
        updateLeftPeek(dx)
        return
      }

      if (mouseMode === 'open-drag' || mouseMode === 'close-drag') {
        mouseLastDx = dx
        const sidebar = sidebarRef.current
        const scrim = scrimRef.current
        if (!sidebar) return
        if (mouseMode === 'open-drag') {
          const clamped = dx <= mouseWidth ? dx : mouseWidth + rubberBand(dx - mouseWidth, 36)
          sidebar.style.translate = `${clamped - mouseWidth}px 0`
          if (scrim) scrim.style.opacity = String(Math.max(0, Math.min(1, dx / mouseWidth)))
        } else {
          const clamped = dx >= 0 ? rubberBand(dx, 28) : Math.max(-mouseWidth, dx)
          sidebar.style.translate = `${clamped}px 0`
          if (scrim) scrim.style.opacity = String(Math.max(0, Math.min(1, 1 + dx / mouseWidth)))
        }
      }
    }

    const onMouseUp = (): void => {
      if (mouseMode === 'left-action') {
        const vx = mouseTracker.velocity()
        const trigger = mouseLastDx <= -LEFT_THRESHOLD || (mouseLastDx < -28 && vx < -0.4)
        mouseMode = 'idle'
        clearInline()
        if (trigger) latest.current.onSwipeLeft?.()
        return
      }
      if (mouseMode !== 'open-drag' && mouseMode !== 'close-drag') {
        mouseMode = 'idle'
        return
      }
      const vx = mouseTracker.velocity()
      const wasOpening = mouseMode === 'open-drag'
      mouseMode = 'idle'
      clearInline()
      if (wasOpening) {
        if (mouseLastDx > mouseWidth * 0.3 || vx > 0.35) latest.current.onOpen()
      } else {
        if (mouseLastDx < -mouseWidth * 0.28 || vx < -0.35) latest.current.onClose()
      }
    }

    document.addEventListener('wheel', onWheel, { passive: true })
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      clearTimeout(wheelTimer)
      clearInline()
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
      document.removeEventListener('wheel', onWheel)
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [enabled, sidebarRef, scrimRef, peekRef])
}

/**
 * Interactive swipe-down to dismiss for any bottom sheet, menu sheet, or dialog.
 * Tracks the finger 1:1 when pulled down from the grabber/header or when the
 * sheet's inner scroller is at its top, adds iOS rubber-band pull-up, and
 * passes `--sheet-from` so the exit animation continues smoothly from release.
 */
export function useSheetSwipe(
  ref: RefObject<HTMLElement | null>,
  {
    enabled,
    onDismiss,
    scrimRef
  }: {
    enabled: boolean
    onDismiss: () => void
    scrimRef?: RefObject<HTMLElement | null>
  }
): void {
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  })

  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    // Nested pickers rendered inline inside Chat settings defer swipe-down to the parent sheet.
    if (!el.classList.contains('settings-sheet') && el.closest('.settings-sheet')) return

    let mode: 'idle' | 'pending' | 'dragging' | 'ignored' = 'idle'
    let startX = 0
    let startY = 0
    let lastDy = 0
    let target: EventTarget | null = null
    const tracker = new VelocityTracker()

    const resetStyles = (): void => {
      el.style.transition = ''
      el.style.transform = ''
      el.style.animation = ''
      delete el.dataset.dragging
      const scrim = scrimRef?.current
      if (scrim) {
        scrim.style.transition = ''
        scrim.style.opacity = ''
      }
    }

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      lastDy = 0
      target = e.target
      tracker.reset(startY, e.timeStamp)
      mode = 'pending'
    }

    const onMove = (e: TouchEvent): void => {
      if (mode === 'idle' || mode === 'ignored' || e.touches.length !== 1) return
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      tracker.add(touch.clientY, e.timeStamp)

      if (mode === 'pending') {
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)
        if (absX < LOCK_DISTANCE && absY < LOCK_DISTANCE) return
        if (absX * AXIS_RATIO > absY) {
          mode = 'ignored'
          return
        }
        // Dragging down: yield if an inner list is scrolled down.
        if (dy > 0 && canScrollInDirection(target, el, 'y', dy)) {
          mode = 'ignored'
          return
        }
        // Dragging up: only rubber-band if not scrolling content down.
        if (dy < 0 && canScrollInDirection(target, el, 'y', dy)) {
          mode = 'ignored'
          return
        }
        mode = 'dragging'
        claimGesture(e)
        el.dataset.dragging = 'true'
        el.style.animation = 'none'
        el.style.transition = 'none'
        const scrim = scrimRef?.current
        if (scrim) scrim.style.transition = 'none'
      }

      if (mode === 'dragging') {
        claimGesture(e)
        e.preventDefault()
        lastDy = dy
        const offset = dy >= 0 ? dy : rubberBand(dy, 36)
        el.style.transform = `translateY(${offset}px)`
        const scrim = scrimRef?.current
        if (scrim && dy >= 0) {
          const height = el.offsetHeight || 360
          scrim.style.opacity = String(Math.max(0, 1 - dy / height))
        }
      }
    }

    const onEnd = (): void => {
      if (mode !== 'dragging') {
        mode = 'idle'
        return
      }
      mode = 'idle'
      const vy = tracker.velocity()
      const height = el.offsetHeight || 360
      const shouldDismiss = lastDy > Math.min(110, height * 0.28) || (lastDy > 24 && vy > 0.45)

      if (shouldDismiss) {
        hapticTick(8)
        // Store the exact release point so `.leaving` keyframes continue seamlessly from here.
        el.style.setProperty('--sheet-from', `${Math.max(0, lastDy)}px`)
        el.style.transition = ''
        el.style.transform = ''
        el.style.animation = ''
        delete el.dataset.dragging
        const scrim = scrimRef?.current
        if (scrim) {
          scrim.style.transition = ''
          scrim.style.opacity = ''
        }
        onDismissRef.current()
      } else {
        el.style.transition = `transform 320ms ${SPRING_EASE}`
        el.style.transform = 'translateY(0)'
        const scrim = scrimRef?.current
        if (scrim) {
          scrim.style.transition = `opacity 320ms ${SPRING_EASE}`
          scrim.style.opacity = '1'
        }
        const cleanup = (): void => {
          resetStyles()
        }
        el.addEventListener('transitionend', cleanup, { once: true })
        setTimeout(cleanup, 360)
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [ref, enabled, scrimRef])
}

/**
 * Interactive swipe-right to pop / close a pushed view or full-screen panel
 * (like iOS UINavigationController's interactive pop gesture).
 * Claims the touch so the global sidebar drawer doesn't open simultaneously.
 */
export function useSwipeBack(
  ref: RefObject<HTMLElement | null>,
  {
    enabled,
    onBack,
    edgeWidth = Infinity,
    slide = true
  }: {
    enabled: boolean
    onBack: () => void
    /** Limit gesture start to within this many px from the left edge (default: anywhere). */
    edgeWidth?: number
    /** Visually slide the element rightward 1:1 with the finger (default: true). */
    slide?: boolean
  }
): void {
  const latest = useRef({ onBack, edgeWidth, slide })
  useEffect(() => {
    latest.current = { onBack, edgeWidth, slide }
  })

  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return

    let mode: 'idle' | 'pending' | 'dragging' | 'ignored' = 'idle'
    let startX = 0
    let startY = 0
    let lastDx = 0
    let target: EventTarget | null = null
    const tracker = new VelocityTracker()

    const resetStyles = (): void => {
      el.style.transition = ''
      el.style.transform = ''
      el.style.boxShadow = ''
      delete el.dataset.swipingBack
    }

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || isGestureClaimed(e)) return
      const touch = e.touches[0]
      if (touch.clientX > latest.current.edgeWidth) {
        mode = 'ignored'
        return
      }
      startX = touch.clientX
      startY = touch.clientY
      lastDx = 0
      target = e.target
      tracker.reset(startX, e.timeStamp)
      mode = 'pending'
    }

    const onMove = (e: TouchEvent): void => {
      if (mode === 'idle' || mode === 'ignored' || e.touches.length !== 1) return
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      tracker.add(touch.clientX, e.timeStamp)

      if (mode === 'pending') {
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)
        if (absX < LOCK_DISTANCE && absY < LOCK_DISTANCE) return
        if (absY * AXIS_RATIO > absX || dx <= 0) {
          mode = 'ignored'
          return
        }
        if (startX > 28 && canScrollInDirection(target, el, 'x', dx)) {
          mode = 'ignored'
          return
        }
        mode = 'dragging'
        claimGesture(e)
        if (latest.current.slide) {
          el.dataset.swipingBack = 'true'
          el.style.transition = 'none'
          el.style.boxShadow = '-16px 0 40px -8px rgba(0, 0, 0, 0.35)'
        }
      }

      if (mode === 'dragging') {
        claimGesture(e)
        e.preventDefault()
        lastDx = Math.max(0, dx)
        if (latest.current.slide) {
          el.style.transform = `translateX(${lastDx}px)`
        }
      }
    }

    const onEnd = (): void => {
      if (mode !== 'dragging') {
        mode = 'idle'
        return
      }
      mode = 'idle'
      const vx = tracker.velocity()
      const width = el.offsetWidth || window.innerWidth
      const shouldPop = lastDx > Math.min(110, width * 0.3) || (lastDx > 24 && vx > 0.4)

      if (shouldPop) {
        hapticTick(8)
        if (latest.current.slide) {
          el.style.transition = `transform 220ms ${SPRING_EASE}`
          el.style.transform = `translateX(${width}px)`
          let done = false
          const finish = (): void => {
            if (done) return
            done = true
            resetStyles()
            latest.current.onBack()
          }
          el.addEventListener('transitionend', finish, { once: true })
          setTimeout(finish, 240)
        } else {
          latest.current.onBack()
        }
      } else if (latest.current.slide) {
        el.style.transition = `transform 300ms ${SPRING_EASE}`
        el.style.transform = 'translateX(0)'
        el.addEventListener('transitionend', resetStyles, { once: true })
        setTimeout(resetStyles, 320)
      }
    }

    // Two-finger trackpad swipe right also steps back / closes pushed views on desktop previews.
    let wheelBack = 0
    let wheelTimer: ReturnType<typeof setTimeout> | undefined
    let wheelCooldown = 0
    const onWheel = (e: WheelEvent): void => {
      if (e.timeStamp < wheelCooldown) return
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.4 || Math.abs(e.deltaX) < 4) return
      const swipeDir = -e.deltaX
      if (swipeDir <= 0 || canScrollInDirection(e.target, el, 'x', swipeDir)) return
      wheelBack += swipeDir
      clearTimeout(wheelTimer)
      wheelTimer = setTimeout(() => (wheelBack = 0), 180)
      if (wheelBack > 60) {
        wheelBack = 0
        wheelCooldown = e.timeStamp + 450
        latest.current.onBack()
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      clearTimeout(wheelTimer)
      resetStyles()
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      el.removeEventListener('wheel', onWheel)
    }
  }, [ref, enabled])
}

/**
 * Horizontal page/tab swipe (e.g. swiping between Settings sections).
 * Claims horizontal swipes only when `canSwipe(dir)` returns true, so swiping
 * right on the first section still falls through to open the Sidebar drawer!
 */
export function useHorizontalSwipe(
  ref: RefObject<HTMLElement | null>,
  {
    enabled,
    canSwipe,
    onSwipe
  }: {
    enabled: boolean
    /** dir: -1 = swipe left (next), +1 = swipe right (previous). */
    canSwipe: (dir: -1 | 1) => boolean
    onSwipe: (dir: -1 | 1) => void
  }
): void {
  const latest = useRef({ canSwipe, onSwipe })
  useEffect(() => {
    latest.current = { canSwipe, onSwipe }
  })

  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return

    let mode: 'idle' | 'pending' | 'dragging' | 'ignored' = 'idle'
    let startX = 0
    let startY = 0
    let lastDx = 0
    let dir: -1 | 1 = 1
    let target: EventTarget | null = null
    const tracker = new VelocityTracker()

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || isGestureClaimed(e)) return
      const touch = e.touches[0]
      // Leave the very left edge for the global sidebar drawer.
      if (touch.clientX <= 26) {
        mode = 'ignored'
        return
      }
      startX = touch.clientX
      startY = touch.clientY
      lastDx = 0
      target = e.target
      tracker.reset(startX, e.timeStamp)
      mode = 'pending'
    }

    const onMove = (e: TouchEvent): void => {
      if (mode === 'idle' || mode === 'ignored' || e.touches.length !== 1) return
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      tracker.add(touch.clientX, e.timeStamp)

      if (mode === 'pending') {
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)
        if (absX < LOCK_DISTANCE && absY < LOCK_DISTANCE) return
        if (absY * AXIS_RATIO > absX) {
          mode = 'ignored'
          return
        }
        dir = dx > 0 ? 1 : -1
        if (!latest.current.canSwipe(dir) || canScrollInDirection(target, el, 'x', dx)) {
          mode = 'ignored'
          return
        }
        mode = 'dragging'
        claimGesture(e)
      }

      if (mode === 'dragging') {
        claimGesture(e)
        e.preventDefault()
        lastDx = dx
      }
    }

    const onEnd = (): void => {
      if (mode !== 'dragging') {
        mode = 'idle'
        return
      }
      mode = 'idle'
      const vx = tracker.velocity()
      if (Math.abs(lastDx) > 56 || Math.abs(vx) > 0.4) {
        hapticTick(8)
        latest.current.onSwipe(dir)
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [ref, enabled])
}

/**
 * Tap vs long-press (and desktop right-click) handler for controls like the
 * New Chat button: tap runs `onTap`, hold (420ms) or right-click runs `onLongPress`.
 */
export function useLongPress(
  onTap: () => void,
  onLongPress: () => void,
  delayMs = 420
): {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
} {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const origin = useRef<{ x: number; y: number }>(undefined)
  const triggered = useRef(false)

  useEffect(() => () => clearTimeout(timer.current), [])

  const clear = (): void => {
    clearTimeout(timer.current)
    timer.current = undefined
  }

  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      triggered.current = false
      origin.current = { x: e.clientX, y: e.clientY }
      clear()
      timer.current = setTimeout(() => {
        triggered.current = true
        hapticTick(14)
        onLongPress()
      }, delayMs)
    },
    onPointerMove: (e) => {
      if (!timer.current || !origin.current) return
      if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 8) {
        clear()
      }
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onClick: (e) => {
      if (triggered.current) {
        e.preventDefault()
        e.stopPropagation()
        triggered.current = false
        return
      }
      onTap()
    },
    onContextMenu: (e) => {
      e.preventDefault()
      clear()
      triggered.current = false
      onLongPress()
    }
  }
}

/**
 * Overswipe up at the bottom of a scroll container (e.g. pull up at the end of
 * a chat to start a new chat immediately). Supports both touch pull-up with
 * rubber-band lift and trackpad overscroll at the bottom.
 */
export function usePullUpAction({
  enabled,
  scrollRef,
  contentRef,
  indicatorRef,
  onTrigger
}: {
  enabled: boolean
  scrollRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
  indicatorRef: RefObject<HTMLElement | null>
  onTrigger: () => void
}): void {
  const onTriggerRef = useRef(onTrigger)
  useEffect(() => {
    onTriggerRef.current = onTrigger
  })

  useEffect(() => {
    const scroller = scrollRef.current
    if (!enabled || !scroller) return

    const THRESHOLD = 84
    let mode: 'idle' | 'pending' | 'pulling' | 'ignored' = 'idle'
    let startX = 0
    let startY = 0
    let pullDist = 0
    let ready = false
    const tracker = new VelocityTracker()

    const atBottom = (): boolean =>
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2

    const renderPull = (dist: number): void => {
      const content = contentRef.current
      const indicator = indicatorRef.current
      const clamped = Math.max(0, dist)
      const damped = rubberBand(clamped, 88)
      const progress = Math.min(1, clamped / THRESHOLD)
      const nowReady = clamped >= THRESHOLD
      if (nowReady && !ready) hapticTick(12)
      ready = nowReady

      if (content) {
        content.style.transition = 'none'
        content.style.transform = clamped > 0 ? `translate3d(0, ${-damped}px, 0)` : ''
      }
      if (indicator) {
        indicator.style.transition = 'none'
        indicator.style.opacity = String(progress)
        indicator.style.transform = `translate3d(-50%, ${14 - progress * 14}px, 0) scale(${0.86 + 0.14 * progress})`
        if (nowReady) indicator.dataset.ready = 'true'
        else delete indicator.dataset.ready
      }
    }

    const springBack = (): void => {
      const content = contentRef.current
      const indicator = indicatorRef.current
      ready = false
      pullDist = 0
      if (content) {
        content.style.transition = `transform 300ms ${SPRING_EASE}`
        content.style.transform = ''
        const cleanup = (): void => {
          content.style.transition = ''
        }
        content.addEventListener('transitionend', cleanup, { once: true })
        setTimeout(cleanup, 320)
      }
      if (indicator) {
        indicator.style.transition = `opacity 220ms ${SPRING_EASE}, transform 260ms ${SPRING_EASE}`
        indicator.style.opacity = '0'
        indicator.style.transform = 'translate3d(-50%, 14px, 0) scale(0.86)'
        delete indicator.dataset.ready
      }
    }

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || isGestureClaimed(e) || hasBlockingOverlay()) return
      if (!atBottom()) {
        mode = 'ignored'
        return
      }
      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      pullDist = 0
      ready = false
      tracker.reset(startY, e.timeStamp)
      mode = 'pending'
    }

    const onMove = (e: TouchEvent): void => {
      if (mode === 'idle' || mode === 'ignored' || e.touches.length !== 1) return
      if (isGestureClaimed(e)) {
        if (mode === 'pulling') springBack()
        mode = 'ignored'
        return
      }
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      tracker.add(touch.clientY, e.timeStamp)

      if (mode === 'pending') {
        const absX = Math.abs(dx)
        const absY = Math.abs(dy)
        if (absX < LOCK_DISTANCE && absY < LOCK_DISTANCE) return
        // Must be pulling UP (dy < 0) while already at the bottom.
        if (absX * AXIS_RATIO > absY || dy >= 0 || !atBottom()) {
          mode = 'ignored'
          return
        }
        mode = 'pulling'
        claimGesture(e)
      }

      if (mode === 'pulling') {
        claimGesture(e)
        e.preventDefault()
        pullDist = Math.max(0, -dy)
        renderPull(pullDist)
      }
    }

    const onEnd = (): void => {
      if (mode !== 'pulling') {
        mode = 'idle'
        return
      }
      mode = 'idle'
      const vy = tracker.velocity()
      const trigger = pullDist >= THRESHOLD || (pullDist > 36 && vy < -0.55)
      springBack()
      if (trigger) {
        hapticTick(12)
        onTriggerRef.current()
      }
    }

    // Trackpad overscroll at the bottom (two-finger swipe up gives positive deltaY on natural scroll).
    let wheelPull = 0
    let wheelReset: ReturnType<typeof setTimeout> | undefined
    let wheelCooldown = 0
    const onWheel = (e: WheelEvent): void => {
      if (hasBlockingOverlay() || e.timeStamp < wheelCooldown) return
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) * 1.3) return
      if (e.deltaY <= 0 || !atBottom()) {
        if (wheelPull > 0) {
          wheelPull = 0
          springBack()
        }
        return
      }
      wheelPull = Math.min(THRESHOLD * 1.4, wheelPull + e.deltaY * 0.45)
      renderPull(wheelPull)
      clearTimeout(wheelReset)
      if (wheelPull >= THRESHOLD) {
        wheelPull = 0
        wheelCooldown = e.timeStamp + 600
        springBack()
        onTriggerRef.current()
        return
      }
      wheelReset = setTimeout(() => {
        wheelPull = 0
        springBack()
      }, 220)
    }

    scroller.addEventListener('touchstart', onStart, { passive: true })
    scroller.addEventListener('touchmove', onMove, { passive: false })
    scroller.addEventListener('touchend', onEnd, { passive: true })
    scroller.addEventListener('touchcancel', onEnd, { passive: true })
    scroller.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      clearTimeout(wheelReset)
      scroller.removeEventListener('touchstart', onStart)
      scroller.removeEventListener('touchmove', onMove)
      scroller.removeEventListener('touchend', onEnd)
      scroller.removeEventListener('touchcancel', onEnd)
      scroller.removeEventListener('wheel', onWheel)
    }
  }, [enabled, scrollRef, contentRef, indicatorRef])
}
