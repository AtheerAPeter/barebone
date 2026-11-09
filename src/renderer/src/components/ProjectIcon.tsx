import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  PROJECT_COLORS,
  PROJECT_ICONS,
  type Project,
  type ProjectIconName
} from '../../../shared/types'
import { COLOR_VALUES, colorValue } from '../lib/project-colors'
import { CloseIcon, PlusIcon } from './icons'
import { BotAvatar } from './BotAvatar'
import {
  SolidBookIcon,
  SolidChatIcon,
  SolidFolderIcon,
  SolidGaugeIcon,
  SolidGlobeIcon,
  SolidLockIcon,
  SolidPencilIcon,
  SolidShieldIcon,
  SolidTerminalIcon,
  SolidWrenchIcon
} from './project-glyphs'

/** Project icons are solid, so they read at a glance in the project's color. */
const GLYPHS: Record<ProjectIconName, typeof SolidFolderIcon> = {
  folder: SolidFolderIcon,
  globe: SolidGlobeIcon,
  terminal: SolidTerminalIcon,
  book: SolidBookIcon,
  chat: SolidChatIcon,
  wrench: SolidWrenchIcon,
  shield: SolidShieldIcon,
  gauge: SolidGaugeIcon,
  pencil: SolidPencilIcon,
  lock: SolidLockIcon
}

/** Each project's own icon, asked for once per launch, and replaced when the user chooses one. */
const images = new Map<string, string | null>()
const asked = new Set<string>()
const listeners = new Set<() => void>()

function setImage(projectId: string, image: string | null): void {
  images.set(projectId, image)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function useProjectImage(projectId: string): string | null {
  useEffect(() => {
    if (asked.has(projectId)) return
    asked.add(projectId)
    window.api.projectIcon(projectId).then((image) => setImage(projectId, image))
  }, [projectId])
  return useSyncExternalStore(subscribe, () => images.get(projectId) ?? null)
}

/** The icon the user chose, else the project's own icon, else a folder; in the project's color. A bot shows its character. */
export function ProjectIcon({
  project,
  size
}: {
  project: Project
  size: number
}): React.JSX.Element {
  const image = useProjectImage(project.id)
  // A bot is its character, wherever its project shows.
  if (project.bot) return <BotAvatar project={project} size={size} />
  if (!project.icon && image) {
    return <img className="project-icon image" src={image} width={size} height={size} alt="" />
  }
  const Glyph = GLYPHS[project.icon ?? 'folder']
  return (
    <Glyph
      width={size}
      height={size}
      className="project-icon"
      style={project.color ? { color: colorValue(project.color) } : undefined}
    />
  )
}

/** Choose a project's icon and color; each pick applies at once. Escape or a click outside closes it. */
export function ProjectStyle({
  project,
  onClose
}: {
  project: Project
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const image = useProjectImage(project.id)
  const set = (style: Partial<Pick<Project, 'color' | 'icon'>>): void => {
    window.api.setProjectStyle(project.id, style)
  }

  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    // Capture phase, and handled: closing the picker must not also stop the agent.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div className="project-style" ref={ref}>
      <div className="style-grid">
        {image && (
          <button
            className={!project.icon ? 'on' : ''}
            title="The project's own icon"
            onClick={() => set({ icon: undefined })}
          >
            <img src={image} width={14} height={14} alt="" />
          </button>
        )}
        {/* The image is chosen with the Mac's file picker. */}
        {!window.api.remote && (
          <button
            title="Choose an image (PNG, SVG or JPG), saved in the project as .barebone/icon"
            onClick={async () => {
              const chosen = await window.api.chooseProjectIcon(project.id)
              if (chosen !== undefined) setImage(project.id, chosen)
            }}
          >
            <PlusIcon width={14} height={14} />
          </button>
        )}
        {PROJECT_ICONS.map((name) => {
          const Glyph = GLYPHS[name]
          const on = project.icon === name || (!project.icon && !image && name === 'folder')
          return (
            <button
              key={name}
              className={on ? 'on' : ''}
              title={name}
              onClick={() => set({ icon: name })}
            >
              <Glyph width={14} height={14} />
            </button>
          )
        })}
      </div>
      <div className="style-grid">
        <button
          className={!project.color ? 'on' : ''}
          title="No color"
          onClick={() => set({ color: undefined })}
        >
          <CloseIcon width={12} height={12} />
        </button>
        {PROJECT_COLORS.map((color) => (
          <button
            key={color}
            className={project.color === color ? 'on' : ''}
            title={color}
            onClick={() => set({ color })}
          >
            <span className="swatch" style={{ background: COLOR_VALUES[color] }} />
          </button>
        ))}
        <label
          className={`custom-color${project.color?.startsWith('#') ? ' on' : ''}`}
          title="Custom color"
        >
          <input
            type="color"
            value={project.color?.startsWith('#') ? project.color : '#888888'}
            onChange={(e) => set({ color: e.target.value as `#${string}` })}
          />
        </label>
      </div>
    </div>
  )
}
