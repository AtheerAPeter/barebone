/**
 * Liquid Glass lights up from under the pointer when pressed, and the glow
 * spreads from there (styles.css, "Liquid Glass under a press"). This marks
 * where a press lands: on the element pressed and each element around it, as
 * --press-x and --press-y from its own corner, so whichever of them lights up
 * starts its glow at the pointer.
 */
export function trackGlassPresses(): void {
  document.addEventListener(
    'pointerdown',
    (event) => {
      const pressed: HTMLElement[] = []
      for (
        let el = event.target as Element | null;
        el instanceof HTMLElement;
        el = el.parentElement
      ) {
        pressed.push(el)
      }
      // Every box is measured before any is marked, so the page lays out once.
      const boxes = pressed.map((el) => el.getBoundingClientRect())
      pressed.forEach((el, i) => {
        el.style.setProperty('--press-x', `${event.clientX - boxes[i].left}px`)
        el.style.setProperty('--press-y', `${event.clientY - boxes[i].top}px`)
      })
    },
    { capture: true, passive: true }
  )
}
