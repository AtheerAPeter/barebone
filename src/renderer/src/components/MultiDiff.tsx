import { useEffect, useRef, useState } from 'react'
import type { CodeDoc, GitChange } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { CodeView } from './CodeView'
import { FileIcon } from './FileIcon'
import { ChevronIcon } from './icons'

/**
 * Several files' changes, one under another, as VS Code's multi-file diff
 * shows a commit or a whole group: each file folds, and reads its diff once
 * it scrolls into sight, so a large commit opens at once.
 */
export function MultiDiff({
  changes,
  load,
  version
}: {
  /** The files; undefined while they are read. */
  changes?: GitChange[]
  load: (change: GitChange) => Promise<CodeDoc>
  /** Changes when the files may have: the diffs in sight are read again. */
  version?: unknown
}): React.JSX.Element {
  if (!changes) return <div className="code-view multi" />
  if (!changes.length) return <div className="code-empty">No files changed.</div>
  return (
    <div className="code-view multi">
      {changes.map((change) => (
        <FileDiff
          key={`${change.oldPath ?? ''}:${change.path}`}
          change={change}
          load={load}
          version={version}
        />
      ))}
    </div>
  )
}

function FileDiff({
  change,
  load,
  version
}: {
  change: GitChange
  load: (change: GitChange) => Promise<CodeDoc>
  version?: unknown
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const [seen, setSeen] = useState(false)
  const [folded, setFolded] = useState(false)
  const [doc, setDoc] = useState<CodeDoc>()
  const [failed, setFailed] = useState<string>()

  useEffect(() => {
    const element = ref.current
    if (!element || seen) return
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setSeen(true),
      { rootMargin: '400px 0px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [seen])

  useEffect(() => {
    if (!seen) return
    let current = true
    load(change).then(
      (read) => current && setDoc(read),
      (e: unknown) => current && setFailed(errorMessage(e))
    )
    return () => {
      current = false
    }
  }, [seen, change, load, version])

  const at = change.path.lastIndexOf('/')
  return (
    <section className="multi-file" ref={ref}>
      <div className="multi-file-head" onClick={() => setFolded((f) => !f)} title={change.path}>
        <ChevronIcon width={12} height={12} className={`code-chevron${folded ? '' : ' open'}`} />
        <FileIcon path={change.path} />
        <span className={`scm-name ${change.kind}`}>{change.path.slice(at + 1)}</span>
        <span className="scm-dir">{at === -1 ? '' : change.path.slice(0, at)}</span>
      </div>
      {!folded &&
        (failed ? (
          <div className="code-empty">{failed}</div>
        ) : doc ? (
          <CodeView doc={doc} embedded />
        ) : (
          <div className="multi-file-wait" />
        ))}
    </section>
  )
}
