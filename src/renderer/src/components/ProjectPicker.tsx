import { Fragment, useEffect, useRef, useState } from 'react'
import type { FolderSuggestions, Project } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { useOverlay } from '../lib/overlays'
import { shortcut, shortcutHeld } from '../lib/platform'
import { touchScreen } from '../lib/touch'
import { ProjectIcon, ProjectStyle } from './ProjectIcon'
import { FolderIcon, FolderPlusIcon, PencilIcon, SearchIcon, TrashIcon } from './icons'

/** A query that is a folder's path, on the computer Barebone runs on: "/srv/app", "~/projects/". */
const isPath = (query: string): boolean => /^[~/]/.test(query.trim())

/**
 * Where a new chat starts: pick its project, by search, arrows and Enter, or
 * ⌘1–9 (Ctrl+1–9 off the Mac). The last entry opens a folder as a new project and starts the chat there.
 * Each project's row also sets its icon and color, or removes it.
 *
 * Typing a path (starting with / or ~) lists folders instead, and opens the
 * chosen one as a project: no folder dialog needed, so it works from a browser
 * through the remote link too.
 */
export function ProjectPicker({
  projects,
  onPick,
  onClose
}: {
  projects: Project[]
  onPick: (projectId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  /** The project whose icon and color are being chosen. */
  const [styling, setStyling] = useState<string>()
  /** The folders the typed path could mean, for the query they were listed for. */
  const [suggested, setSuggested] = useState<{ query: string } & FolderSuggestions>()
  const [error, setError] = useState<string>()
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(ref, true)

  const pathMode = isPath(query)
  useEffect(() => {
    if (!isPath(query)) return
    let current = true
    window.api.folders(query).then((found) => current && setSuggested({ query, ...found }))
    return () => {
      current = false
    }
  }, [query])
  const folders =
    pathMode && suggested?.query === query
      ? [...(suggested.folder ? [suggested.folder] : []), ...suggested.folders]
      : []

  const q = query.trim().toLowerCase()
  const shown = projects.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
  )
  // One more entry after the projects: opening a folder, which needs the Mac's folder picker.
  const canOpen = !window.api.remote
  const entries = pathMode ? folders.length : shown.length + (canOpen ? 1 : 0)
  const index = Math.min(active, entries - 1)

  /** Open a folder as a project (or its project, if it has one) and start the chat there. */
  async function openFolder(path: string): Promise<void> {
    setError(undefined)
    try {
      onPick((await window.api.addProjectAt(path)).id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function choose(i: number): Promise<void> {
    if (pathMode) return openFolder(i < 0 ? query : folders[i])
    if (i < 0) return
    if (i < shown.length) return onPick(shown[i].id)
    const added = await window.api.addProject()
    if (added) onPick(added.id)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.defaultPrevented) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (entries === 0) return
      const step = e.key === 'ArrowDown' ? 1 : entries - 1
      setActive((index + step) % entries)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(index)
    } else if (e.key === 'Tab' && pathMode && folders[index]) {
      // Into the folder: what is in it is listed next.
      e.preventDefault()
      setQuery(`${folders[index]}/`)
      setActive(0)
    } else if (e.key === 'Escape') {
      // Handled: closing the picker must not also stop the agent.
      e.preventDefault()
      onClose()
    } else if (shortcutHeld(e) && /^[1-9]$/.test(e.key) && Number(e.key) <= shown.length) {
      e.preventDefault()
      choose(Number(e.key) - 1)
    }
  }

  return (
    <div
      className="palette-backdrop"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-label="New chat in" ref={ref}>
        <label className="palette-search">
          <SearchIcon width={15} height={15} />
          <input
            autoFocus={!touchScreen}
            placeholder="New chat in… or a folder's path"
            value={query}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              setError(undefined)
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        {pathMode ? (
          <div className="palette-list">
            <div className="palette-label">Folders</div>
            {folders.map((folder, i) => (
              <div
                key={folder}
                className={`palette-row${i === index ? ' active' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <FolderIcon width={28} height={28} className="project-icon" />
                <div className="palette-text">
                  <span className="palette-name">
                    {folder === suggested?.folder ? `Open ${folder}` : folder}
                  </span>
                </div>
              </div>
            ))}
            {error && <div className="msg-error">{error}</div>}
          </div>
        ) : (
          <div className="palette-list">
            <div className="palette-label">Projects</div>
            {shown.map((project, i) => (
              <Fragment key={project.id}>
                <div
                  className={`palette-row${i === index ? ' active' : ''}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(i)}
                >
                  <ProjectIcon project={project} size={28} />
                  <div className="palette-text">
                    <span className="palette-name">{project.name}</span>
                    <span className="palette-path">{project.path}</span>
                  </div>
                  <span className="palette-actions">
                    <button
                      className="label-btn"
                      title="Icon and color"
                      onClick={(e) => {
                        e.stopPropagation()
                        setStyling(styling === project.id ? undefined : project.id)
                      }}
                    >
                      <PencilIcon width={12} height={12} />
                      <span className="label-btn-text">Edit</span>
                    </button>
                    <button
                      className="label-btn danger"
                      title="Remove project"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (
                          confirm(
                            `Remove "${project.name}" and its chats from Barebone? Files on disk are not touched.`
                          )
                        ) {
                          window.api.removeProject(project.id)
                        }
                      }}
                    >
                      <TrashIcon width={12} height={12} />
                      <span className="label-btn-text">Remove</span>
                    </button>
                  </span>
                  {i < 9 && <kbd>{shortcut(String(i + 1))}</kbd>}
                </div>
                {styling === project.id && (
                  <ProjectStyle project={project} onClose={() => setStyling(undefined)} />
                )}
              </Fragment>
            ))}
            {canOpen && (
              <div
                className={`palette-row${index === shown.length ? ' active' : ''}`}
                onMouseMove={() => setActive(shown.length)}
                onClick={() => choose(shown.length)}
              >
                <FolderPlusIcon width={28} height={28} strokeWidth={2.2} className="project-icon" />
                <div className="palette-text">
                  <span className="palette-name">Open a folder…</span>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>Enter</kbd> Select
          </span>
          {pathMode ? (
            <span>
              <kbd>Tab</kbd> Into folder
            </span>
          ) : (
            <span>
              <kbd>{shortcut('1–9')}</kbd> Jump
            </span>
          )}
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  )
}
