import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import type { WalkAt, WalkControl, Walkthrough } from '../../../shared/types'
import { lineTokens, useHighlight, type Token } from '../lib/highlight'
import { CodeRow } from './CodeView'
import { BackIcon, ForwardIcon, PauseIcon, PlayIcon } from './icons'

interface WalkthroughProps {
  walk: Walkthrough
  at: WalkAt
  /** The stop the walk moved from to get here. */
  from?: number
  onControl: (action: WalkControl, index?: number) => void
}

/** How long the link to a stop takes to draw (main/walkthrough.ts waits for it, LINK_MS). */
const LINK_DRAW_MS = 750
/** How long a card takes to open (the transition in styles.css). */
const CARD_OPEN_MS = 520

/**
 * An agent's walkthrough as it plays (main/walkthrough.ts): the route on top,
 * then one column of the code it passes through, a card per stretch of a
 * file. Cards ahead stay shut until the walk reaches them; the ones behind
 * stay open with their notes, so the user keeps where they came from. Links
 * in the margin show where the code goes from one stop to the next, and the
 * voice's sentence runs along the bottom.
 */
export function WalkthroughView({
  walk,
  at,
  from,
  onControl
}: WalkthroughProps): React.JSX.Element {
  const stop = walk.stops[at.index]
  const canvasRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const linksRef = useRef<SVGSVGElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const routeRef = useRef<HTMLElement>(null)

  const reached = new Set(walk.stops.slice(0, at.index + 1).map((s) => s.card))
  // The link into this stop draws in when the walk just came along it.
  const drawing = from === at.index - 1 && walk.stops[from]?.link ? from : undefined

  // The links, in the margin beside the code's own lines; they follow as cards open and the panel resizes.
  useLayoutEffect(() => {
    const column = columnRef.current
    const svg = linksRef.current
    const labels = labelsRef.current
    if (!column || !svg || !labels) return
    drawLinks(column, svg, labels, walk, at.index, drawing)
    const observer = new ResizeObserver(() => drawLinks(column, svg, labels, walk, at.index))
    observer.observe(column)
    return () => observer.disconnect()
  }, [walk, at.index, drawing])

  // Bring the stop's lines to the upper middle, once the link to them has drawn and their card has opened.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const opening = !walk.stops.slice(0, at.index).some((s) => s.card === stop.card)
    const wait = Math.max(
      drawing === undefined ? 60 : LINK_DRAW_MS * 0.6,
      opening ? CARD_OPEN_MS : 0
    )
    const timer = setTimeout(() => {
      const row = canvas.querySelector<HTMLElement>(
        `[data-card="${stop.card}"][data-line="${stop.from}"]`
      )
      if (!row) return
      const top =
        row.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop
      canvas.scrollTo({ top: top - canvas.clientHeight * 0.3, behavior: 'smooth' })
    }, wait)
    return () => clearTimeout(timer)
  }, [walk, at.index, stop, drawing])

  useEffect(() => {
    routeRef.current
      ?.querySelector('.walk-stop.now')
      ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [at.index])

  return (
    <div className={`walk${at.playing ? ' playing' : ''}`}>
      <header className="walk-route">
        <nav className="walk-stops" ref={routeRef}>
          {walk.stops.map((s, i) => {
            const file = walk.files[walk.cards[s.card].file]
            return (
              <Fragment key={i}>
                {i > 0 && <span className="walk-arrow">→</span>}
                <button
                  className={`walk-stop${i === at.index ? ' now' : i < at.index ? ' done' : ''}`}
                  title={`${file.name}, lines ${s.from}–${s.to}`}
                  onClick={() => onControl('goto', i)}
                >
                  <span className="walk-n">{i + 1}</span>
                  <b>{s.name}</b>
                  {baseName(file.name)}
                </button>
              </Fragment>
            )
          })}
        </nav>
        <button
          className="icon-btn"
          title="Back a stop"
          disabled={at.index === 0}
          onClick={() => onControl('prev')}
        >
          <BackIcon />
        </button>
        <button
          className="icon-btn"
          title={at.playing ? 'Pause' : 'Play'}
          onClick={() => onControl(at.playing ? 'pause' : 'play')}
        >
          {at.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          className="icon-btn"
          title="Next stop"
          disabled={at.index === walk.stops.length - 1}
          onClick={() => onControl('next')}
        >
          <ForwardIcon />
        </button>
      </header>
      <div className="walk-canvas" ref={canvasRef}>
        <div className="walk-column" ref={columnRef}>
          <svg className="walk-links" ref={linksRef}>
            <defs>
              <marker
                id="walk-head"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0 10 5 0 10z" />
              </marker>
            </defs>
          </svg>
          <div ref={labelsRef} />
          {walk.cards.map((_, c) => (
            <Card
              key={`${walk.id}:${c}`}
              walk={walk}
              index={c}
              at={at.index}
              state={c === stop.card ? 'now' : reached.has(c) ? 'past' : 'ahead'}
            />
          ))}
        </div>
      </div>
      <div className="walk-said">
        <span className="walk-orb" />
        <span className="walk-said-text" key={at.index}>
          {stop.say}
        </span>
        <span className="walk-count">
          {at.index + 1} of {walk.stops.length}
        </span>
      </div>
    </div>
  )
}

/** A stretch of a file the walk passes through: shut until reached, then open for good. */
function Card({
  walk,
  index,
  at,
  state
}: {
  walk: Walkthrough
  index: number
  /** The stop the walk is at. */
  at: number
  state: 'now' | 'past' | 'ahead'
}): React.JSX.Element {
  const card = walk.cards[index]
  const file = walk.files[card.file]
  const newLines = useHighlight(file.text, file.path)
  const oldLines = useHighlight(file.old ?? '', file.path)
  // This card's stops the walk has reached, with their place in the walk.
  const stops = walk.stops.map((s, i) => ({ ...s, i })).filter((s) => s.card === index && s.i <= at)
  const current = stops.find((s) => s.i === at)
  const firstName = walk.stops.find((s) => s.card === index)?.name
  const slash = file.name.lastIndexOf('/')

  return (
    <article className={`walk-card ${state}${current ? ' spot' : ''}`}>
      <div className="walk-card-head">
        <span className="walk-dir">{file.name.slice(0, slash + 1)}</span>
        <span className="walk-file">{file.name.slice(slash + 1)}</span>
        {firstName && <span className="walk-fn">{firstName}</span>}
        {file.changes && <span className="walk-changes">{file.changes} changes</span>}
        <span className="walk-lines">
          lines {card.from}–{card.to}
        </span>
      </div>
      <div className="walk-card-body">
        <div>
          <div className={`code-view walk-code${file.changes ? ' diff' : ''}`}>
            {card.rows.map((line, r) => {
              const position = line.new ?? line.before ?? 0
              const lit = Boolean(current && position >= current.from && position <= current.to)
              // The notes of the stops so far; the current stop's stand out.
              const notes =
                line.new === undefined
                  ? []
                  : stops.flatMap((s) =>
                      s.notes
                        .filter((n) => n.line === line.new)
                        .map((n) => ({ text: n.text, now: s.i === at }))
                    )
              // Where the code goes on from this line: the link coming next, the one just taken, older ones.
              const marks =
                line.new === undefined
                  ? []
                  : stops.flatMap((s) =>
                      s.link?.text && s.link.line === line.new
                        ? [
                            {
                              text: s.link.text,
                              className: s.i === at ? 'next' : s.i === at - 1 ? 'on' : 'past'
                            }
                          ]
                        : []
                    )
              return (
                <CodeRow
                  key={r}
                  numbers={file.changes ? [line.old, line.new] : [line.new]}
                  change={file.changes ? line.type : undefined}
                  tokens={[]}
                  className={lit ? 'lit' : undefined}
                  data-card={index}
                  data-line={line.new}
                  after={notes.map((n, k) => (
                    <span
                      key={k}
                      className={`walk-note${n.now ? ' now' : ''}`}
                      style={n.now ? { animationDelay: `${350 + k * 280}ms` } : undefined}
                    >
                      {n.text}
                    </span>
                  ))}
                >
                  {withMarks(lineTokens(line, oldLines, newLines), marks)}
                </CodeRow>
              )
            })}
          </div>
        </div>
      </div>
    </article>
  )
}

/** A line's colored runs, with each mark's text wrapped in one highlight, even across runs. */
function withMarks(tokens: Token[], marks: { text: string; className: string }[]): React.ReactNode {
  const text = tokens.map((t) => t.content).join('')
  const ranges: { start: number; end: number; className: string }[] = []
  for (const mark of marks) {
    const start = text.indexOf(mark.text)
    const end = start + mark.text.length
    if (start !== -1 && !ranges.some((r) => start < r.end && end > r.start)) {
      ranges.push({ start, end, className: mark.className })
    }
  }
  if (!ranges.length) {
    return tokens.map((t, i) => (
      <span key={i} style={t.style}>
        {t.content}
      </span>
    ))
  }
  ranges.sort((a, b) => a.start - b.start)
  const edges = ranges.flatMap((r) => [r.start, r.end])
  // Cut the runs where marks begin and end; then group the pieces each mark covers.
  const pieces: { content: string; style?: React.CSSProperties; mark: number }[] = []
  let offset = 0
  for (const token of tokens) {
    let start = 0
    while (start < token.content.length) {
      const at = offset + start
      const next = edges.find((edge) => edge > at) ?? Infinity
      const end = Math.min(token.content.length, next - offset)
      pieces.push({
        content: token.content.slice(start, end),
        style: token.style,
        mark: ranges.findIndex((r) => at >= r.start && at < r.end)
      })
      start = end
    }
    offset += token.content.length
  }
  const out: React.ReactNode[] = []
  for (let i = 0; i < pieces.length;) {
    const mark = pieces[i].mark
    let j = i
    while (j < pieces.length && pieces[j].mark === mark) j++
    const spans = pieces.slice(i, j).map((p, k) => (
      <span key={k} style={p.style}>
        {p.content}
      </span>
    ))
    out.push(
      mark === -1 ? (
        <Fragment key={i}>{spans}</Fragment>
      ) : (
        <mark key={i} className={`walk-mark ${ranges[mark].className}`}>
          {spans}
        </mark>
      )
    )
    i = j
  }
  return out
}

const SVG = 'http://www.w3.org/2000/svg'

/**
 * Draw the links the walk has taken so far, in the margin left of the code:
 * out of the line the code goes on from, along a rail, into the line it
 * arrives at, with a label beside the rail. Each link's path is kept between
 * draws, so one that is drawing in carries on as the layout moves; `animate`
 * is the stop whose link to the next starts drawing in now.
 */
function drawLinks(
  column: HTMLElement,
  svg: SVGSVGElement,
  labels: HTMLElement,
  walk: Walkthrough,
  at: number,
  animate?: number
): void {
  if (svg.dataset.walk !== String(walk.id)) {
    for (const path of svg.querySelectorAll('path.walk-link')) path.remove()
    svg.dataset.walk = String(walk.id)
  }
  labels.replaceChildren()
  const box = column.getBoundingClientRect()
  const taken: { top: number; bottom: number }[] = []
  walk.stops.forEach((stop, k) => {
    const link = stop.link
    let path = svg.querySelector<SVGPathElement>(`path[data-stop="${k}"]`)
    const fromRow = column.querySelector<HTMLElement>(
      `[data-card="${stop.card}"][data-line="${link?.line}"]`
    )
    const toRow = column.querySelector<HTMLElement>(
      `[data-card="${walk.stops[k + 1]?.card}"][data-line="${link?.to}"]`
    )
    if (!link || k >= at || !fromRow || !toRow) {
      path?.remove()
      return
    }
    const a = fromRow.getBoundingClientRect()
    const b = toRow.getBoundingClientRect()
    const edge = a.left - box.left
    // The middle of a line's first row of text, even when it wraps.
    const ay = a.top - box.top + Math.min(a.height, 21) / 2
    const by = b.top - box.top + Math.min(b.height, 21) / 2
    const rail = edge - 20 - (k % 3) * 12
    const turn = Math.min(10, Math.abs(by - ay) / 2)
    const dir = by >= ay ? 1 : -1
    if (!path) {
      path = document.createElementNS(SVG, 'path')
      path.dataset.stop = String(k)
      path.setAttribute('marker-end', 'url(#walk-head)')
      svg.append(path)
      if (k === animate) {
        // Drawn in from its start: its length as 1, so the dash animation needs no measuring.
        path.setAttribute('pathLength', '1')
        path.classList.add('drawing')
        path.addEventListener(
          'animationend',
          () => {
            path?.removeAttribute('pathLength')
            path?.classList.remove('drawing')
          },
          { once: true }
        )
      }
    }
    path.setAttribute(
      'd',
      `M ${edge - 2} ${ay} H ${rail + turn} Q ${rail} ${ay} ${rail} ${ay + turn * dir} V ${by - turn * dir} Q ${rail} ${by} ${rail + turn} ${by} H ${edge - 3}`
    )
    path.classList.add('walk-link')
    path.classList.toggle('back', link.back)
    path.classList.toggle('now', k === at - 1)

    // Its label, beside the rail, below any label that would cover it.
    const label = document.createElement('span')
    label.className = `walk-link-label${k === at - 1 ? ' now' : ''}`
    label.textContent = link.label
    labels.append(label)
    const height = label.offsetHeight
    let top = (ay + by) / 2 - height / 2
    for (const other of [...taken].sort((x, y) => x.top - y.top)) {
      if (top < other.bottom + 4 && top + height > other.top - 4) top = other.bottom + 4
    }
    taken.push({ top, bottom: top + height })
    label.style.top = `${top}px`
    label.style.left = `${rail - 8}px`
  })
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
