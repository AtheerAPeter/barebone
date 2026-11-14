import { fileIcon } from '../lib/file-icons'

/** A file's icon, as VS Code shows it (lib/file-icons.ts). */
export function FileIcon({ path }: { path: string }): React.JSX.Element {
  const { char, dark, light } = fileIcon(path)
  return (
    <span
      className="file-icon"
      aria-hidden
      style={{ '--icon-light': light, '--icon-dark': dark } as React.CSSProperties}
    >
      {char}
    </span>
  )
}
