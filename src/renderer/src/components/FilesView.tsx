import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry, FilePreview, FolderListing } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { uploadInto } from '../lib/file-upload'
import { readPref, writePref } from '../lib/prefs'
import { PHONE, touchScreen, useMedia } from '../lib/touch'
import { CodeView } from './CodeView'
import { FileArt, FolderArt, FolderGlyph } from './finder-icons'
import { menuAtPoint } from '../lib/menus'
import { MenuPopover, type RowMenuItem } from './RowMenu'
import {
  BackIcon,
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  FolderPlusIcon,
  ForwardIcon,
  GridIcon,
  ListIcon,
  DotsIcon,
  SearchIcon,
  UploadIcon
} from './icons'

/**
 * The file manager, as Finder: favorites down the side, back and forward,
 * the folder's contents as icons or as a list, and the path along the bottom.
 * A file opens beside them (over them on a phone). On a Mac or a computer a
 * click selects and a double click opens, and a right click gives a menu; on
 * a touch screen a tap opens and a long press gives the menu.
 */

type Mode = 'icons' | 'list'

/** Asking for a name or a folder, in the bar above the contents. */
type Prompt =
  { kind: 'new-folder' } | { kind: 'rename'; entry: FileEntry } | { kind: 'move'; entry: FileEntry }

/** Folders in the home folder that are favorites when they are there, in this order. */
const FAVORITES = [
  'Desktop',
  'Documents',
  'Downloads',
  'Pictures',
  'Movies',
  'Music',
  'code',
  'projects',
  'Projects'
]
/** Held this long, a touch gives the menu rather than opening the item. */
const LONG_PRESS_MS = 500

const fm = (): typeof window.api.fileManager => window.api.fileManager

export function FilesView(): React.JSX.Element {
  const [home, setHome] = useState<string>()
  const [favorites, setFavorites] = useState<string[]>([])
  const [listing, setListing] = useState<FolderListing>()
  const [trail, setTrail] = useState<{ back: string[]; forward: string[] }>({
    back: [],
    forward: []
  })
  const [mode, setMode] = useState<Mode>(() => readPref('filesMode', 'icons'))
  const [hidden, setHidden] = useState(false)
  /** The search field's text; undefined while it is closed. */
  const [query, setQuery] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [opened, setOpened] = useState<{ path: string; preview?: FilePreview; error?: string }>()
  const [prompt, setPrompt] = useState<Prompt>()
  const [menu, setMenu] = useState<{ at: React.CSSProperties; items: RowMenuItem[] }>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** A long press gave the menu: the click that ends it opens nothing. */
  const longPressed = useRef(false)
  const phone = useMedia(PHONE)

  useEffect(() => writePref('filesMode', mode), [mode])

  /** Show a folder; false when it cannot be read. */
  const load = useCallback(async (path: string): Promise<boolean> => {
    try {
      setListing(await fm().list(path))
      setError(undefined)
      setSelected(undefined)
      setQuery(undefined)
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    }
  }, [])

  useEffect(() => {
    void fm()
      .home()
      .then(async (path) => {
        setHome(path)
        await load(path)
        const { entries } = await fm().list(path)
        const here = new Set(entries.filter((e) => e.folder).map((e) => e.name))
        setFavorites(FAVORITES.filter((name) => here.has(name)).map((name) => join(path, name)))
      })
  }, [load])

  const folder = listing?.path

  /** Go to a folder, as a new step back can return from. */
  const go = (path: string): void => {
    if (path === folder) return
    void load(path).then((ok) => {
      if (ok && folder) setTrail((t) => ({ back: [...t.back, folder], forward: [] }))
    })
  }
  const back = (): void => {
    const to = trail.back.at(-1)
    if (!to || !folder) return
    void load(to).then((ok) => {
      if (ok) setTrail((t) => ({ back: t.back.slice(0, -1), forward: [folder, ...t.forward] }))
    })
  }
  const forward = (): void => {
    const to = trail.forward[0]
    if (!to || !folder) return
    void load(to).then((ok) => {
      if (ok) setTrail((t) => ({ back: [...t.back, folder], forward: t.forward.slice(1) }))
    })
  }

  /** Run a change, then show the folder as it is now; a failure shows above the contents. */
  const change = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await work()
      setError(undefined)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      if (folder)
        setListing(
          await fm()
            .list(folder)
            .catch(() => listing)
        )
    }
  }

  const open = (entry: FileEntry): void => {
    if (!folder) return
    const path = join(folder, entry.name)
    if (entry.folder) {
      setOpened(undefined)
      go(path)
      return
    }
    setSelected(entry.name)
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

  /** What can be done with an item: its menu. */
  const itemMenu = (entry: FileEntry): RowMenuItem[] => {
    const path = join(folder ?? '/', entry.name)
    return [
      { name: 'Open', onSelect: () => open(entry) },
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

  /** What can be done in the folder itself: its menu, and the toolbar's ⋯. */
  const folderMenu = (): RowMenuItem[] => [
    { name: 'New Folder', onSelect: () => setPrompt({ kind: 'new-folder' }) },
    { name: 'Upload Files…', onSelect: () => uploadRef.current?.click() },
    ...(phone
      ? [
          { name: mode === 'icons' ? 'View as List' : 'View as Icons', onSelect: toggleMode },
          ...favoritesMenu()
        ]
      : []),
    {
      name: hidden ? 'Hide Hidden Files' : 'Show Hidden Files',
      onSelect: () => setHidden((h) => !h)
    }
  ]

  /** On a phone, where the favorites have no sidebar, they are in the ⋯ menu. */
  const favoritesMenu = (): RowMenuItem[] =>
    [home, ...favorites, '/']
      .filter((path): path is string => Boolean(path) && path !== folder)
      .map((path) => ({ name: `Go to ${placeName(path, home)}`, onSelect: () => go(path) }))

  const toggleMode = (): void => setMode((m) => (m === 'icons' ? 'list' : 'icons'))

  const showMenu = (event: { clientX: number; clientY: number }, items: RowMenuItem[]): void =>
    setMenu({ at: menuAtPoint(event.clientX, event.clientY), items })

  /** A press on an item: a click selects it (a tap opens it), a long touch gives its menu. */
  const itemHandlers = (entry: FileEntry): React.HTMLAttributes<HTMLDivElement> => ({
    onClick: () => {
      if (longPressed.current) {
        longPressed.current = false
        return
      }
      if (touchScreen) open(entry)
      else setSelected(entry.name)
    },
    onDoubleClick: () => !touchScreen && open(entry),
    onContextMenu: (e) => {
      e.preventDefault()
      e.stopPropagation()
      setSelected(entry.name)
      showMenu(e, itemMenu(entry))
    },
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return
      const { clientX, clientY } = e
      clearTimeout(pressTimer.current)
      pressTimer.current = setTimeout(() => {
        longPressed.current = true
        setSelected(entry.name)
        showMenu({ clientX, clientY }, itemMenu(entry))
      }, LONG_PRESS_MS)
    },
    onPointerUp: () => clearTimeout(pressTimer.current),
    onPointerCancel: () => clearTimeout(pressTimer.current),
    onPointerMove: (e) => {
      // Scrolling, not holding.
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 4) clearTimeout(pressTimer.current)
    }
  })

  const search = query?.trim().toLowerCase()
  const entries =
    listing?.entries.filter(
      (e) =>
        (hidden || !e.name.startsWith('.')) && (!search || e.name.toLowerCase().includes(search))
    ) ?? []
  const selectedEntry = entries.find((e) => e.name === selected)
  const title = folder ? placeName(folder, home) : ''

  return (
    <div className={`finder${opened ? ' has-preview' : ''}`}>
      {!phone && (
        <aside className="finder-sidebar">
          <div className="finder-section">Favorites</div>
          {home && <Place path={home} home={home} current={folder} onGo={go} />}
          {favorites.map((path) => (
            <Place key={path} path={path} home={home} current={folder} onGo={go} />
          ))}
          <div className="finder-section">Locations</div>
          <Place path="/" home={home} current={folder} onGo={go} />
        </aside>
      )}

      <section className="finder-main">
        <div className="finder-toolbar">
          <div className="glass-group">
            <button className="icon-btn" title="Back" disabled={!trail.back.length} onClick={back}>
              <BackIcon />
            </button>
            {!phone && (
              <button
                className="icon-btn"
                title="Forward"
                disabled={!trail.forward.length}
                onClick={forward}
              >
                <ForwardIcon />
              </button>
            )}
          </div>
          {query === undefined || !phone ? <h2 className="finder-title">{title}</h2> : null}
          <div className="finder-spacer" />
          {!phone && (
            <div className="glass-group segmented" role="radiogroup" aria-label="View">
              <button
                className={`icon-btn${mode === 'icons' ? ' on' : ''}`}
                title="View as Icons"
                role="radio"
                aria-checked={mode === 'icons'}
                onClick={() => setMode('icons')}
              >
                <GridIcon />
              </button>
              <button
                className={`icon-btn${mode === 'list' ? ' on' : ''}`}
                title="View as List"
                role="radio"
                aria-checked={mode === 'list'}
                onClick={() => setMode('list')}
              >
                <ListIcon />
              </button>
            </div>
          )}
          {!phone && (
            <div className="glass-group">
              <button
                className="icon-btn"
                title="New Folder"
                disabled={!folder}
                onClick={() => setPrompt({ kind: 'new-folder' })}
              >
                <FolderPlusIcon />
              </button>
              <button
                className="icon-btn"
                title="Upload Files"
                disabled={!folder || busy}
                onClick={() => uploadRef.current?.click()}
              >
                <UploadIcon />
              </button>
              {selectedEntry && !selectedEntry.folder && window.api.remote && (
                <button
                  className="icon-btn"
                  title={`Download ${selectedEntry.name}`}
                  onClick={() => folder && download(join(folder, selectedEntry.name))}
                >
                  <DownloadIcon />
                </button>
              )}
            </div>
          )}
          <button
            className="icon-btn glass-round"
            title="More"
            onClick={(e) => showMenu(e, folderMenu())}
          >
            <DotsIcon />
          </button>
          {query === undefined ? (
            <button className="icon-btn glass-round" title="Search" onClick={() => setQuery('')}>
              <SearchIcon />
            </button>
          ) : (
            <label className="finder-search">
              <SearchIcon width={15} height={15} />
              <input
                autoFocus
                value={query}
                placeholder={`Search ${title}`}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setQuery(undefined)
                  }
                }}
              />
              <button
                className="icon-btn small"
                title="Close search"
                onClick={() => setQuery(undefined)}
              >
                <CloseIcon width={12} height={12} />
              </button>
            </label>
          )}
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

        <div className="finder-body">
          <div
            className={`finder-content ${mode}${dropping ? ' dropping' : ''}`}
            tabIndex={0}
            onClick={(e) => e.target === e.currentTarget && setSelected(undefined)}
            onContextMenu={(e) => {
              e.preventDefault()
              setSelected(undefined)
              showMenu(e, folderMenu())
            }}
            onKeyDown={(e) => {
              if (!selectedEntry) return
              if (e.key === 'Enter') open(selectedEntry)
              else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) remove(selectedEntry)
            }}
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
            {mode === 'list' && entries.length > 0 && (
              <div className="finder-list-head">
                <span>Name</span>
                <span>Date Modified</span>
                <span>Size</span>
              </div>
            )}
            {listing && entries.length === 0 && (
              <p className="files-empty">
                {search
                  ? `Nothing here is named like “${query?.trim()}”.`
                  : listing.entries.length
                    ? 'Only hidden files here.'
                    : 'This folder is empty.'}
              </p>
            )}
            {entries.map((entry) => {
              const on = entry.name === selected
              const art = entry.folder ? (
                <FolderArt name={entry.name} size={mode === 'icons' ? 64 : 20} />
              ) : (
                <FileArt name={entry.name} size={mode === 'icons' ? 64 : 20} />
              )
              return mode === 'icons' ? (
                <div
                  key={entry.name}
                  role="button"
                  tabIndex={-1}
                  className={`finder-item${on ? ' on' : ''}`}
                  title={entry.name}
                  {...itemHandlers(entry)}
                >
                  <span className="finder-art">{art}</span>
                  <span className="finder-name">{entry.name}</span>
                </div>
              ) : (
                <div
                  key={entry.name}
                  role="button"
                  tabIndex={-1}
                  className={`finder-row${on ? ' on' : ''}`}
                  {...itemHandlers(entry)}
                >
                  <span className="finder-row-name">
                    {art}
                    <span>{entry.name}</span>
                  </span>
                  <span>{date(entry.modified)}</span>
                  <span>{entry.folder ? '--' : size(entry.size)}</span>
                </div>
              )
            })}
          </div>

          {opened && (
            <div className="files-preview">
              <div className="finder-toolbar preview-bar">
                <span className="files-preview-name">{opened.path.split('/').pop()}</span>
                {window.api.remote && (
                  <button
                    className="icon-btn"
                    title="Download"
                    onClick={() => download(opened.path)}
                  >
                    <DownloadIcon />
                  </button>
                )}
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
                    <CodeView
                      doc={{ kind: 'file', path: opened.path, text: opened.preview.text }}
                    />
                    {opened.preview.cut && (
                      <p className="files-empty">Only the first megabyte is shown.</p>
                    )}
                  </>
                ) : (
                  <div className="files-other">
                    <FileArt name={opened.path} size={96} />
                    <p>{size(opened.preview.size)}. This kind of file cannot be shown here.</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <PathBar path={folder} home={home} onGo={go} />
      </section>

      {menu && <MenuPopover items={menu.items} at={menu.at} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

/** A favorite in the sidebar: its glyph and its name. */
function Place({
  path,
  home,
  current,
  onGo
}: {
  path: string
  home?: string
  current?: string
  onGo: (path: string) => void
}): React.JSX.Element {
  const name = placeName(path, home)
  return (
    <button className={`finder-place${path === current ? ' on' : ''}`} onClick={() => onGo(path)}>
      <span className="finder-place-icon">
        {path === '/' ? (
          <ComputerGlyph />
        ) : (
          <FolderGlyph
            name={path.split('/').pop() ?? ''}
            home={path === home}
            size={18}
            stroke={1.7}
            fallback={<FolderIcon width={18} height={18} />}
          />
        )}
      </span>
      {name}
    </button>
  )
}

function ComputerGlyph(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  )
}

/** The folder's path, as Finder's path bar: each folder up to it opens it. */
function PathBar({
  path,
  home,
  onGo
}: {
  path?: string
  home?: string
  onGo: (path: string) => void
}): React.JSX.Element {
  const parts = path ? path.split('/').filter(Boolean) : []
  const scroller = useRef<HTMLDivElement>(null)
  // The folder shown is the last part: kept in sight in a long path.
  useEffect(() => {
    scroller.current?.scrollTo({ left: scroller.current.scrollWidth })
  }, [path])
  return (
    <div className="finder-pathbar" ref={scroller}>
      <button className="crumb-btn" onClick={() => onGo('/')}>
        <ComputerGlyph />
        {placeName('/', home)}
      </button>
      {parts.map((part, i) => {
        const to = '/' + parts.slice(0, i + 1).join('/')
        return (
          <button
            key={to}
            className={`crumb-btn${i === parts.length - 1 ? ' current' : ''}`}
            onClick={() => onGo(to)}
          >
            <FolderArt name={part} size={16} home={to === home} />
            {part}
          </button>
        )
      })}
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
    prompt.kind === 'rename'
      ? prompt.entry.name
      : prompt.kind === 'move'
        ? folder
        : 'untitled folder'
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
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          onCancel()
        }}
        onFocus={(e) => {
          // A name starts selected up to its extension, as in Finder.
          if (prompt.kind === 'move') return
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

/** A folder's name as Finder shows it: Home for the home folder, Computer for the top. */
function placeName(path: string, home?: string): string {
  if (path === '/') return 'Computer'
  if (path === home) return 'Home'
  return path.split('/').pop() || path
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
  if (bytes < 1000) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1000
  let unit = 0
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000
    unit++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`
}

function date(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return `Today at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  }
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
}
