/** The narrowest the chat gets by dragging a side panel's divider. */
export const CHAT_MIN_WIDTH = 340
/** A side panel's own narrowest. */
export const PANEL_MIN_WIDTH = 320

/**
 * Drag the divider left of a side panel (the browser, the code panel): the
 * panel takes the width the chat gives up, down to the chat's narrowest.
 * With `onFold`, dragging well past that calls it and ends the drag.
 */
export function dragDivider(
  event: React.PointerEvent,
  chat: HTMLElement | null,
  onResize: (width: number) => void,
  { onEnd, onFold }: { onEnd?: () => void; onFold?: () => void } = {}
): void {
  event.preventDefault()
  const chatLeft = chat?.getBoundingClientRect().left ?? 0
  const stop = (): void => {
    onEnd?.()
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', stop)
  }
  const onMove = (e: PointerEvent): void => {
    if (onFold && e.clientX - chatLeft < CHAT_MIN_WIDTH / 2) {
      stop()
      onFold()
      return
    }
    const next = window.innerWidth - Math.max(e.clientX, chatLeft + CHAT_MIN_WIDTH)
    onResize(Math.max(next, PANEL_MIN_WIDTH))
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', stop)
}
