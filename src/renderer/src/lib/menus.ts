/** Room a menu needs below a point to open downward. */
const MENU_ROOM = 240
/** About as wide as a menu is, to open one leftward near the right edge. */
const MENU_WIDTH = 220

/** Where a menu opened at a point (a right click) goes: there, or above or left of it near an edge. */
export function menuAtPoint(x: number, y: number): React.CSSProperties {
  const below = window.innerHeight - y > MENU_ROOM
  const right = window.innerWidth - x > MENU_WIDTH
  return {
    ...(below ? { top: y + 2 } : { bottom: window.innerHeight - y + 2 }),
    ...(right ? { left: x + 2 } : { right: window.innerWidth - x + 2 })
  }
}
