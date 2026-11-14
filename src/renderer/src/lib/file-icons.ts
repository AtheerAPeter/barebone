import seti from '../assets/file-icons/seti.json'

/**
 * VS Code's default file icons, Seti: a character of its font, in a color for
 * dark and one for light backgrounds. scripts/file-icons.mjs builds the map
 * from VS Code's theme.
 */
export interface FileIconGlyph {
  char: string
  /** None for an icon in the text's color. */
  dark?: string
  light?: string
}

const icons: Record<string, FileIconGlyph> = seti.icons
const byName: Record<string, string> = seti.fileNames
const byExtension: Record<string, string> = seti.fileExtensions
const byLanguageName: Record<string, string> = seti.languageNames
const byLanguageExtension: Record<string, string> = seti.languageExtensions

/**
 * A file's icon, as VS Code picks it: by the file's name, else by its
 * extension, the longest first (spec.ts before ts), else by its language.
 */
export function fileIcon(path: string): FileIconGlyph {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return icons[
    byName[name] ??
      longest(name, byExtension) ??
      byLanguageName[name] ??
      longest(name, byLanguageExtension) ??
      seti.file
  ]
}

/** The icon of a name's longest extension in a map: "a.spec.ts" tries "spec.ts", then "ts". */
function longest(name: string, map: Record<string, string>): string | undefined {
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const icon = map[name.slice(dot + 1)]
    if (icon) return icon
  }
  return undefined
}
