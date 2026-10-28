import { useEffect, useRef } from 'react'

/** The bars, by how far each moves with the level: tallest in the middle. */
const BARS = [0.55, 0.85, 1, 0.75, 0.5]

/**
 * Bars that move with a sound's level (0 to 1), redrawn every frame from the
 * ref that keeps it, without re-rendering: the microphone while the user
 * dictates (lib/voice.ts), an agent's voice while it speaks (lib/speech.ts).
 * They take the text color.
 */
export function LevelMeter({ level }: { level: React.RefObject<number> }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let frame = requestAnimationFrame(function draw() {
      const bars = ref.current?.children
      if (bars) {
        for (let i = 0; i < bars.length; i++) {
          const height = 0.2 + 0.8 * Math.min(1, level.current * BARS[i] * 1.4)
          ;(bars[i] as HTMLElement).style.transform = `scaleY(${height})`
        }
      }
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [level])
  return (
    <span className="level-meter" ref={ref} aria-hidden="true">
      {BARS.map((_, i) => (
        <i key={i} />
      ))}
    </span>
  )
}
