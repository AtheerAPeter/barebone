import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry, FilePreview, FolderListing } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { uploadInto } from '../lib/file-upload'
import { CodeView } from './CodeView'
import { RowMenu, type RowMenuItem } from './RowMenu'
import {
  BackIcon,
  CloseIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  UploadIcon
} from './icons'

/**
 * The file manager: this computer's folders, from the home folder, in the
 * window and through the remote link. A folder opens in place; a file opens
 * beside the list, or over it on a phone. Each row's ⋮ menu renames, moves,
 * downloads or deletes it.
 */

/** Asking for a name or a folder, in the bar above the list. */
type Prompt =
  { kind: 'new-folder' } | { kind: 'rename'; entry: FileEntry } | { kind: 'move'; entry: FileEntry }

const fm = (): typeof window.api.fileManager => window.api.fileManager

export function FilesView(): React.JSX.Element {
  const [listing, setListing] = useState<FolderListing>()
  const [error, setError] = useState<string>()
  const [hidden, setHidden] = useState(false)
  const [opened, setOpened] = useState<{ path: string; preview?: FilePreview; error?: string }>()
  const [prompt, setPrompt] = useState<Prompt>()
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  const go = useCallback(async (path: string) => {
    try {
      setListing(await fm().list(path))
      setError(undefined)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void fm().home().then(go)
  }, [go])

  const folder = listing?.path
  const refresh = (): Promise<void> => (folder ? go(folder) : Promise.resolve())

  /** Run a change, then show the folder as it is now; a failure is shown above the list. */
  const change = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await work()
      setError(undefined)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const open = (entry: FileEntry): void => {
    if (!folder) return
    const path = join(folder, entry.name)
    if (entry.folder) {
      setOpened(undefined)
      void go(path)
      return
    }
    setOpened({ path })
    fm()
      .preview(path)
      .then(
        (preview) => setOpened((o) => (o?.path === path ? { path, preview } : o)),
        (e) => setOpened((o) => (o?.path === path ? { path, error: errorMessage(e) } : o))
      )
  }

  const upload = (files: File[]): void => {
    if (folder && files.length) void change(() => uploadInto(files, folder))
  }

  const remove = (entry: FileEntry): void => {
    if (!folder) return
    const where = window.api.remote ? 'It is deleted for good.' : 'It goes to the Trash.'
    if (!confirm(`Delete ${entry.name}? ${where}`)) return
    const path = join(folder, entry.name)
    if (opened?.path === path) setOpened(undefined)
    void change(() => fm().remove([path]))
  }

  const menu = (entry: FileEntry): RowMenuItem[] => {
    const path = join(folder ?? '/', entry.name)
    return [
      { name: 'Rename', onSelect: () => setPrompt({ kind: 'rename', entry }) },
      { name: 'Move to…', onSelect: () => setPrompt({ kind: 'move', entry }) },
      ...(entry.folder
        ? []
        : window.api.remote
          ? [{ name: 'Download', onSelect: () => download(path) }]
          : [{ name: 'Show in Finder', onSelect: () => void fm().reveal(path) }]),
      { name: 'Delete', danger: true, onSelect: () => remove(entry) }
    ]
  }

  const entries = listing?.entries.filter((e) => hidden || !e.name.startsWith('.')) ?? []

  return (
    <div className={`files-view${opened ? ' has-preview' : ''}`}>
      <div className="view-toolbar">
        <button
          className="icon-btn"
          title="Enclosing folder"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && go(listing.parent)}
        >
          <BackIcon />
        </button>
        <Crumbs path={folder} onGo={(path) => void go(path)} />
        <button
          className={`icon-btn${hidden ? ' on' : ''}`}
          title={hidden ? 'Hide hidden files' : 'Show hidden files'}
          aria-pressed={hidden}
          onClick={() => setHidden((h) => !h)}
        >
          <EyeIcon />
        </button>
        <button
          className="icon-btn"
          title="New folder"
          disabled={!folder}
          onClick={() => setPrompt({ kind: 'new-folder' })}
        >
          <FolderPlusIcon />
        </button>
        <button
          className="icon-btn"
          title="Upload files here"
          disabled={!folder || busy}
          onClick={() => uploadRef.current?.click()}
        >
          <UploadIcon />
        </button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            upload(Array.from(e.currentTarget.files ?? []))
            e.currentTarget.value = ''
          }}
        />
      </div>

      {prompt && folder && (
        <PromptBar
          prompt={prompt}
          folder={folder}
          onCancel={() => setPrompt(undefined)}
          onDone={(work) => {
            setPrompt(undefined)
            void change(work)
          }}
        />
      )}
      {error && <div className="files-error">{error}</div>}

      <div className="files-body">
        <div
          className={`files-list${dropping ? ' dropping' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDropping(false)
            upload(Array.from(e.dataTransfer.files))
          }}
        >
          {listing && entries.length === 0 && (
            <p className="files-empty">
              {listing.entries.length ? 'Only hidden files here.' : 'This folder is empty.'}
            </p>
          )}
          {entries.map((entry) => {
            const path = join(folder ?? '/', entry.name)
            return (
              <div
                key={entry.name}
                role="button"
                tabIndex={0}
                className={`file-row${opened?.path === path ? ' active' : ''}`}
                onClick={() => open(entry)}
                onKeyDown={(e) => e.key === 'Enter' && open(entry)}
              >
                <span className={`file-icon${entry.folder ? ' folder' : ''}`}>
                  {entry.folder ? <FolderIcon /> : <FileIcon />}
                </span>
                <span className="file-name">{entry.name}</span>
                <span className="file-meta">
                  {entry.folder ? '' : size(entry.size)}
                  <span className="file-date">{date(entry.modified)}</span>
                </span>
                <span className="file-menu" onClick={(e) => e.stopPropagation()}>
                  <RowMenu label={`${entry.name} options`} items={menu(entry)} />
                </span>
              </div>
            )
          })}
        </div>

        {opened && (
          <div className="files-preview">
            <div className="view-toolbar">
              <span className="files-preview-name">{opened.path.split('/').pop()}</span>
              {window.api.remote ? (
                <button className="icon-btn" title="Download" onClick={() => download(opened.path)}>
                  <DownloadIcon />
                </button>
              ) : null}
              <button className="icon-btn" title="Close" onClick={() => setOpened(undefined)}>
                <CloseIcon />
              </button>
            </div>
            <div className="files-preview-body">
              {opened.error ? (
                <p className="files-empty">{opened.error}</p>
              ) : !opened.preview ? (
                <p className="files-empty">
                  <span className="spinner" />
                </p>
              ) : opened.preview.kind === 'image' ? (
                <img className="files-image" src={opened.preview.url} alt="" />
              ) : opened.preview.kind === 'text' ? (
                <>
                  <CodeView doc={{ kind: 'file', path: opened.path, text: opened.preview.text }} />
                  {opened.preview.cut && (
                    <p className="files-empty">Only the first megabyte is shown.</p>
                  )}
                </>
              ) : (
                <p className="files-empty">
                  {size(opened.preview.size)}. This kind of file cannot be shown here.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** The folder's path as buttons, one per folder up to it. */
function Crumbs({
  path,
  onGo
}: {
  path?: string
  onGo: (path: string) => void
}): React.JSX.Element {
  const parts = path ? path.split('/').filter(Boolean) : []
  const scroller = useRef<HTMLDivElement>(null)
  // The folder shown is the last part: kept in sight in a long path.
  useEffect(() => {
    scroller.current?.scrollTo({ left: scroller.current.scrollWidth })
  }, [path])
  return (
    <div className="crumbs" ref={scroller}>
      <button className="crumb-btn" onClick={() => onGo('/')}>
        /
      </button>
      {parts.map((part, i) => (
        <button
          key={i}
          className={`crumb-btn${i === parts.length - 1 ? ' current' : ''}`}
          onClick={() => onGo('/' + parts.slice(0, i + 1).join('/'))}
        >
          {part}
        </button>
      ))}
    </div>
  )
}

/** A new folder's name, a new name, or a folder to move into; Enter does it. */
function PromptBar({
  prompt,
  folder,
  onCancel,
  onDone
}: {
  prompt: Prompt
  folder: string
  onCancel: () => void
  onDone: (work: () => Promise<unknown>) => void
}): React.JSX.Element {
  const [value, setValue] = useState(
    prompt.kind === 'rename' ? prompt.entry.name : prompt.kind === 'move' ? folder : ''
  )
  const label =
    prompt.kind === 'new-folder'
      ? 'New folder'
      : prompt.kind === 'rename'
        ? `Rename ${prompt.entry.name}`
        : `Move ${prompt.entry.name} to`
  const submit = (): void => {
    const text = value.trim()
    if (!text) return
    if (prompt.kind === 'new-folder') onDone(() => fm().makeFolder(folder, text))
    else if (prompt.kind === 'rename') {
      onDone(() => fm().rename(join(folder, prompt.entry.name), text))
    } else {
      // A folder named from here, like "old/" or "../shared", or a full path.
      const to = text.startsWith('/') ? text : join(folder, text)
      onDone(() => fm().move([join(folder, prompt.entry.name)], to))
    }
  }
  return (
    <form
      className="files-prompt"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <span className="files-prompt-label">{label}</span>
      <input
        autoFocus
        value={value}
        placeholder={prompt.kind === 'move' ? '/path/to/folder' : 'Name'}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), onCancel())}
        onFocus={(e) => {
          // A rename starts with the name selected up to its extension, as Finder does.
          if (prompt.kind !== 'rename') return
          const dot = e.currentTarget.value.lastIndexOf('.')
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length)
        }}
      />
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className="btn primary" disabled={!value.trim()}>
        {prompt.kind === 'new-folder' ? 'Create' : prompt.kind === 'rename' ? 'Rename' : 'Move'}
      </button>
    </form>
  )
}

/** Save a file on this device, through the remote link (main/remote/server.ts). */
function download(path: string): void {
  const link = document.createElement('a')
  link.href = `/api/download?path=${encodeURIComponent(path)}`
  link.download = path.split('/').pop() ?? 'file'
  link.click()
}

function join(folder: string, name: string): string {
  return folder.endsWith('/') ? folder + name : `${folder}/${name}`
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`
}

function date(ms: number): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}
