/**
 * The computer the UI is used on: the app's own window, or the browser of a
 * device on the remote link. Shortcuts are held with ⌘ on a Mac, iPhone or
 * iPad, and with Ctrl everywhere else; the menu's (main/menu.ts, CmdOrCtrl)
 * already are.
 */
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

/** The shortcut key is held: ⌘ on a Mac, Ctrl elsewhere. */
export function shortcutHeld(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}

/** A shortcut as this computer writes it: "⌘B" or "Ctrl+B", "⇧⌘B" or "Ctrl+Shift+B". */
export function shortcut(key: string, shift = false): string {
  if (isMac) return `${shift ? '⇧' : ''}⌘${key}`
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

/** The key held alone for push to talk in the app's window (main/index.ts, TALK_KEY). */
export const TALK_KEY = isMac ? 'right ⌘' : 'right Ctrl'
