import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'

/**
 * A touch screen: focusing a field there opens the on-screen keyboard over
 * half the page, so search fields wait for a tap instead of taking focus as
 * a menu opens.
 */
export const touchScreen = window.matchMedia('(pointer: coarse)').matches

/** A phone's width, through the remote link: the layout of remote/remote.css. */
export const PHONE = '(max-width: 700px)'

/** Whether a media query matches, kept up to date as the window changes. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const changed = (): void => setMatches(list.matches)
    list.addEventListener('change', changed)
    return () => list.removeEventListener('change', changed)
  }, [query])
  return matches
}

/** Whether an element is narrower than a width, kept up to date as it resizes. */
export function useNarrower(ref: RefObject<HTMLElement | null>, width: number): boolean {
  const [narrower, setNarrower] = useState(false)
  // Measured before the first paint, so nothing is drawn in the wrong place first.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => setNarrower(element.clientWidth < width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, width])
  return narrower
}

/**
 * Whether a menu opens as a sheet along the bottom of the screen, where a
 * thumb reaches it, rather than next to its button: on a phone through the
 * remote link.
 */
export function menusAsSheets(): boolean {
  return window.api.remote && window.matchMedia(PHONE).matches
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
 * leaves the page its full height and draws the keyboard over it; a sheet
 * is fitted above it so what is typed into stays in sight.
 */
export function useKeyboardArea(on: boolean): { height: number; top: number } | undefined {
  const area = useSyncExternalStore(onViewportChange, viewportArea)
  if (!on || !area) return undefined
  const [height, top] = area.split(',').map(Number)
  return { height, top }
}
