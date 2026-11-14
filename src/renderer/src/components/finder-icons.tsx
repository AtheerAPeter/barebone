import { useId, type ComponentType } from 'react'
import {
  IconApps,
  IconDeviceDesktop,
  IconDownload,
  IconFileText,
  IconHome,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconUsers
} from '@tabler/icons-react'

/**
 * The file manager's icons, in Finder's manner (drawn here): a folder is a
 * blue folder, a well-known one with its glyph pressed into it, and a file is
 * a page with a folded corner that shows its extension.
 */

type Glyph = ComponentType<{ size?: number; stroke?: number; color?: string }>

/** Folders whose glyph shows on them, by name, as in a home folder. */
const FOLDER_GLYPHS: Record<string, Glyph> = {
  Desktop: IconDeviceDesktop,
  Documents: IconFileText,
  Downloads: IconDownload,
  Pictures: IconPhoto,
  Movies: IconMovie,
  Videos: IconMovie,
  Music: IconMusic,
  Applications: IconApps,
  Public: IconUsers
}

/** A well-known folder's glyph (the home folder's for home), or `fallback` for any other. */
export function FolderGlyph({
  name,
  home = false,
  size,
  stroke,
  color,
  fallback = null
}: {
  name: string
  home?: boolean
  size: number
  stroke: number
  color?: string
  fallback?: React.ReactNode
}): React.ReactNode {
  const Glyph = home ? IconHome : FOLDER_GLYPHS[name]
  return Glyph ? <Glyph size={size} stroke={stroke} color={color} /> : fallback
}

export function FolderArt({
  name,
  size,
  home = false
}: {
  name: string
  size: number
  home?: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <svg className="folder-art" width={size} height={size * 0.8} viewBox="0 0 64 51" aria-hidden>
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--folder-light)" />
          <stop offset="1" stopColor="var(--folder)" />
        </linearGradient>
      </defs>
      {/* The back, with its tab. */}
      <path
        d="M3 6.5A4.5 4.5 0 0 1 7.5 2h14.2a4 4 0 0 1 2.9 1.2L28 7h28.5A4.5 4.5 0 0 1 61 11.5V45a4.5 4.5 0 0 1-4.5 4.5h-49A4.5 4.5 0 0 1 3 45z"
        fill="var(--folder-back)"
      />
      {/* The front, a little lower, catching the light along its top edge. */}
      <rect x="3" y="12" width="58" height="37.5" rx="4.5" fill={`url(#${id}f)`} />
      <rect x="3.5" y="12.5" width="57" height="1.2" rx="0.6" fill="#fff" opacity="0.45" />
      {(home || name in FOLDER_GLYPHS) && (
        <foreignObject x="21" y="20" width="22" height="22">
          <span className="folder-glyph">
            <FolderGlyph
              name={name}
              home={home}
              size={22}
              stroke={1.6}
              color="var(--folder-glyph)"
            />
          </span>
        </foreignObject>
      )}
    </svg>
  )
}

/** Kinds of file whose extension label takes a color of its own. */
const EXTENSION_TONES: [RegExp, string][] = [
  [/^(png|jpe?g|gif|webp|avif|heic|bmp|svg|ico)$/, '#34a853'],
  [/^(mp4|mov|webm|mkv|avi|mp3|wav|m4a|flac|ogg)$/, '#a855f7'],
  [/^(zip|gz|tgz|tar|bz2|xz|7z|rar|dmg|deb)$/, '#d97706'],
  [
    /^(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|swift|kt|java|c|h|cpp|sh|json|ya?ml|toml|html|css)$/,
    '#2f6fed'
  ],
  [/^(pem|key|crt|cer|p12)$/, '#d92d20']
]

export function FileArt({ name, size }: { name: string; size: number }): React.JSX.Element {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const tone = EXTENSION_TONES.find(([kind]) => kind.test(extension))?.[1] ?? '#6b7280'
  return (
    <svg className="file-art" width={size} height={size * 0.8} viewBox="0 0 64 51" aria-hidden>
      <g transform="translate(13 0)">
        <path
          d="M2 3a3 3 0 0 1 3-3h20.5L38 12.5V48a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z"
          fill="var(--page)"
          stroke="var(--page-edge)"
          strokeWidth="0.8"
        />
        <path d="M25.5 0v9.5a3 3 0 0 0 3 3H38z" fill="var(--page-fold)" />
        {extension && extension.length <= 5 && (
          <text
            x="20"
            y="41"
            textAnchor="middle"
            fontSize="8.5"
            fontWeight="700"
            letterSpacing="0.3"
            fill={tone}
            fontFamily="-apple-system, system-ui, sans-serif"
          >
            {extension.toUpperCase()}
          </text>
        )}
      </g>
    </svg>
  )
}
