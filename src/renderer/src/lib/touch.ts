/**
 * A touch screen: focusing a field there opens the on-screen keyboard over
 * half the page, so search fields wait for a tap instead of taking focus as
 * a menu opens.
 */
export const touchScreen = window.matchMedia('(pointer: coarse)').matches

/** A phone's width, through the remote link: the layout of remote/remote.css. */
export const PHONE = '(max-width: 700px)'

/**
 * Whether a menu opens as a sheet along the bottom of the screen, where a
 * thumb reaches it, rather than next to its button: on a phone through the
 * remote link.
 */
export function menusAsSheets(): boolean {
  return window.api.remote && window.matchMedia(PHONE).matches
}
