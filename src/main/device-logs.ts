/**
 * What the devices and Metro print, kept for the logs tool (devices-mcp.ts):
 * each line gets the next number, so an agent reads what is new since the
 * number it saw last, whichever chat it is.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export interface LogLine {
  seq: number
  /** ms since the epoch */
  time: number
  /** The device's name, or "metro". */
  source: string
  level: LogLevel
  /** The process (iOS) or the log tag (Android) or the stream (Metro) it came from. */
  tag: string
  text: string
  /** The process ID it came from, for finding an app's own lines. */
  pid?: number
  /** Printed by the app's JavaScript (console.log, errors React Native caught). */
  js?: boolean
  /** An app crashed. */
  crash?: boolean
  /** Logged by the system (SpringBoard, locationd…), not by an app. */
  system?: boolean
}

/** How many lines are kept, from all sources together; older ones are dropped. */
const KEEP = 20_000
/** Longer lines are cut, so one stack trace does not fill a reply. */
const LINE_CHARS = 1_000

export class DeviceLogs {
  private lines: LogLine[] = []
  private next = 1

  add(line: Omit<LogLine, 'seq'>): void {
    this.lines.push({ ...line, text: line.text.slice(0, LINE_CHARS), seq: this.next++ })
    if (this.lines.length > KEEP + KEEP / 10) this.lines = this.lines.slice(-KEEP)
  }

  /** The number the next line will get: lines from now on have this one or higher. */
  get cursor(): number {
    return this.next
  }

  /** Lines numbered `since` or higher that pass the filter, oldest first. */
  query(filter: {
    since?: number
    sources?: string[]
    level?: LogLevel
    match?: (line: LogLine) => boolean
  }): LogLine[] {
    const lowest = LEVELS.indexOf(filter.level ?? 'debug')
    return this.lines.filter(
      (line) =>
        line.seq >= (filter.since ?? 0) &&
        (!filter.sources || filter.sources.includes(line.source)) &&
        LEVELS.indexOf(line.level) >= lowest &&
        (!filter.match || filter.match(line))
    )
  }
}

/** A line as the logs tool shows it. */
export function formatLine(line: LogLine): string {
  const time = new Date(line.time).toTimeString().slice(0, 8)
  const level = line.crash ? 'CRASH' : line.level.toUpperCase()
  return `#${line.seq} ${time} [${line.source}] ${level} ${line.tag}: ${line.text}`
}

/**
 * Split a stream of text into lines, handing on each finished one; the
 * returned function takes the next chunk.
 */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let rest = ''
  return (chunk) => {
    const lines = (rest + chunk.toString()).split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) onLine(line.replace(/\r$/, ''))
  }
}
