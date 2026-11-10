import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

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
