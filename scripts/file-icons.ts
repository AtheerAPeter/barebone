// Builds the file icons of the code panel from VS Code's default file icon
// theme, Seti: its font, and which icon each file gets. Run it again to take a
// newer VS Code's: node scripts/file-icons.ts [vscode tag]
//
// VS Code gives a file the icon of its name, else of its extension (the
// longest that matches), else of its language. Languages come from VS Code's
// built-in language extensions, so they are read from there and resolved to
// icons here, once, and the app only looks names and extensions up.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface IconTheme {
  iconDefinitions: Record<string, { fontCharacter: string; fontColor?: string }>
  file: string
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  languageIds: Record<string, string>
}

interface Manifest {
  contributes?: { languages?: { id: string; extensions?: string[]; filenames?: string[] }[] }
}

type Glyph = { char: string; dark?: string; light?: string }

const tag = process.argv[2] ?? '1.146.0'
const raw = `https://raw.githubusercontent.com/microsoft/vscode/${tag}/extensions`
const out = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/assets/file-icons')

async function get(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response
}

const theme = (await (
  await get(`${raw}/theme-seti/icons/vs-seti-icon-theme.json`)
).json()) as IconTheme
const font = Buffer.from(await (await get(`${raw}/theme-seti/icons/seti.woff`)).arrayBuffer())

// Each icon's character, its color, and its color on a light background, which
// the theme keeps as the same icon with "_light" after its name. An icon with
// no color takes the text's, as in VS Code.
const icons: Record<string, Glyph> = {}
function iconOf(id: string): string {
  if (icons[id]) return id
  const dark = theme.iconDefinitions[id]
  const light = theme.iconDefinitions[`${id}_light`]
  const char = String.fromCodePoint(parseInt(dark.fontCharacter.slice(1), 16))
  icons[id] = dark.fontColor
    ? { char, dark: dark.fontColor, light: light?.fontColor ?? dark.fontColor }
    : { char }
  return id
}
function resolve(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([key, id]) => [key.toLowerCase(), iconOf(id)]))
}

// The languages VS Code knows a file by, from each built-in extension's manifest.
const listing = (await (
  await get(`https://api.github.com/repos/microsoft/vscode/contents/extensions?ref=${tag}`)
).json()) as { name: string; type: string }[]
const languageNames: Record<string, string> = {}
const languageExtensions: Record<string, string> = {}
for (const entry of listing.filter((e) => e.type === 'dir')) {
  // Not every folder there is an extension with a manifest.
  const manifest = (await get(`${raw}/${entry.name}/package.json`)
    .then((r) => r.json())
    .catch(() => undefined)) as Manifest | undefined
  for (const language of manifest?.contributes?.languages ?? []) {
    const id = theme.languageIds[language.id]
    if (!id) continue
    for (const name of language.filenames ?? []) languageNames[name.toLowerCase()] ??= iconOf(id)
    for (const ext of language.extensions ?? []) {
      languageExtensions[ext.replace(/^\./, '').toLowerCase()] ??= iconOf(id)
    }
  }
}

const map = {
  file: iconOf(theme.file),
  fileNames: resolve(theme.fileNames),
  fileExtensions: resolve(theme.fileExtensions),
  languageNames,
  languageExtensions,
  icons
}

await mkdir(out, { recursive: true })
await writeFile(join(out, 'seti.woff'), font)
await writeFile(join(out, 'seti.json'), JSON.stringify(map))
console.log(
  `VS Code ${tag}: ${Object.keys(icons).length} icons, ${Object.keys(map.fileNames).length} names, ` +
    `${Object.keys(map.fileExtensions).length} extensions, ${Object.keys(languageExtensions).length} more by language`
)
