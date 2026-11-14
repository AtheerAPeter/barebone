import { Fragment } from 'react'
import type { CodeDoc, DiffLine } from '../../../shared/types'
import { lineTokens, useHighlight, type Token } from '../lib/highlight'

/**
 * A file, or a file's changes as VS Code shows them inline: deleted lines in
 * red, added ones in green, and the unchanged lines around them. Long lines
 * wrap, so the narrow panel needs no sideways scrolling.
 */
export function CodeView({
  doc,
  embedded = false
}: {
  doc: CodeDoc
  /** Part of a longer view that scrolls, as one file of several: it does not scroll itself. */
  embedded?: boolean
}): React.JSX.Element {
  return doc.kind === 'file' ? <FileView doc={doc} /> : <DiffView doc={doc} embedded={embedded} />
}

function FileView({ doc }: { doc: Extract<CodeDoc, { kind: 'file' }> }): React.JSX.Element {
  const lines = useHighlight(doc.text, doc.path)
  const count = lineCount(doc.text)
  if (doc.binary)
    return <div className="code-empty">A binary file: there are no lines to show.</div>
  if (!count) return <div className="code-empty">This file is empty.</div>
  return (
    <div className="code-view">
      {lines.slice(0, count).map((tokens, i) => (
        <CodeRow key={i} numbers={[i + 1]} tokens={tokens} />
      ))}
    </div>
  )
}

function DiffView({
  doc,
  embedded
}: {
  doc: Extract<CodeDoc, { kind: 'diff' }>
  embedded: boolean
}): React.JSX.Element {
  const oldLines = useHighlight(doc.old, doc.path)
  const newLines = useHighlight(doc.new, doc.path)
  if (doc.binary) {
    return <div className="code-empty">A binary file: there are no lines to show.</div>
  }
  if (!doc.hunks.length) return <div className="code-empty">No lines changed.</div>
  return (
    <div className={`code-view diff${embedded ? ' embedded' : ''}`}>
      {doc.hunks.map((hunk, h) => (
        <Fragment key={h}>
          {hunk.skipped > 0 && (
            <div className="code-skip">
              {hunk.skipped} unchanged line{hunk.skipped === 1 ? '' : 's'}
            </div>
          )}
          {hunk.lines.map((line, i) => (
            <CodeRow
              key={i}
              numbers={[line.old, line.new]}
              change={line.type}
              tokens={lineTokens(line, oldLines, newLines)}
            />
          ))}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * A line of code: its numbers, a + or − for a change, and its colored text,
 * or `children` in its place; `after` follows the text, as the walkthrough's notes.
 */
export function CodeRow({
  numbers,
  change,
  tokens,
  className,
  children,
  after,
  ...data
}: {
  numbers: (number | undefined)[]
  change?: DiffLine['type']
  tokens: Token[]
  className?: string
  children?: React.ReactNode
  after?: React.ReactNode
} & Record<`data-${string}`, string | number | undefined>): React.JSX.Element {
  return (
    <div
      className={`code-row${change ? ` ${change}` : ''}${className ? ` ${className}` : ''}`}
      {...data}
    >
      {numbers.map((n, i) => (
        <span key={i} className="code-number">
          {n ?? ''}
        </span>
      ))}
      {change && (
        <span className="code-sign">{change === 'add' ? '+' : change === 'del' ? '−' : ''}</span>
      )}
      <code className="code-text">
        {children ??
          tokens.map((t, i) => (
            <span key={i} style={t.style}>
              {t.content}
            </span>
          ))}
      </code>
      {after}
    </div>
  )
}

function lineCount(text: string): number {
  if (!text) return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}
