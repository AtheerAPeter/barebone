import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon, KeyboardIcon } from '../components/icons'

/**
 * The server's desktop (main/remote/desktop.ts), over the whole page. It
 * opens here rather than in a tab of its own: a page added to an iPhone's
 * Home Screen opens links in Safari, which is not paired, and has no back
 * button to return from one.
 */

/** Selkies' hidden field that the phone's keyboard types into (selkies-web-core/lib/virtual-keyboard.ts). */
const KEYBOARD_FIELD = 'keyboard-input-assist'

export function DesktopSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)

  /**
   * Selkies' own keyboard button raises the keyboard from a message, after
   * the tap has ended, and iOS opens it only for a field focused in a tap.
   * Its field is focused here, in the tap, then Selkies is asked as its
   * button asks, to do the rest.
   */
  const showKeyboard = (): void => {
    const desktop = frameRef.current?.contentWindow
    if (!desktop) return
    desktop.document.getElementById(KEYBOARD_FIELD)?.focus({ preventScroll: true })
    desktop.postMessage({ type: 'showVirtualKeyboard' }, location.origin)
  }

  return createPortal(
    <div className="desktop-sheet">
      <div className="rb-top">
        <button className="icon-btn" title="Close the desktop" onClick={onClose}>
          <CloseIcon />
        </button>
        <b className="rb-heading">Desktop</b>
        <button className="icon-btn" title="Type on the desktop" onClick={showKeyboard}>
          <KeyboardIcon />
        </button>
      </div>
      <iframe
        ref={frameRef}
        src="/desktop/"
        title="Desktop"
        allow="autoplay; clipboard-read; clipboard-write; fullscreen; microphone"
      />
    </div>,
    document.body
  )
}
