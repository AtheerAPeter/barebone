/** "12s", then "1m 05s", then "1h 02m 05s", like Codex's status line. */
export function elapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${seconds}s`
}
