import { useEffect, useState } from 'react'
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'
import type { DiffLine } from '../../../shared/types'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/**
 * Syntax colors for the code panel, from VS Code's own grammars and its
 * Light+ and Dark+ themes, through Shiki. Its JavaScript regex engine, not
 * the WebAssembly one, which the window's content security policy would block.
 * Each language loads the first time a file of it shows.
 */

const THEMES = { light: 'light-plus', dark: 'dark-plus' } as const

/** Above this many characters a file shows uncolored: coloring it would hold up the window. */
const MAX_CHARS = 500_000

/** A run of text in one color: both themes' colors, as CSS variables styles.css picks from. */
export interface Token {
  content: string
  style?: React.CSSProperties
}

let highlighter: Promise<Highlighter> | undefined

/** Shiki's language for a file, by its extension or its name (Dockerfile, Makefile). */
function languageOf(path: string): BundledLanguage | undefined {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  // C headers: Shiki knows them as C, not by their extension.
  const id = extension === 'h' ? 'c' : extension
  if (id in bundledLanguages) return id as BundledLanguage
  if (name in bundledLanguages) return name as BundledLanguage
  return undefined
}

/** A text's lines, each as its colored runs; uncolored for a language Shiki does not know. */
async function highlight(text: string, path: string): Promise<Token[][]> {
  const lang = languageOf(path)
  if (!lang || text.length > MAX_CHARS) return plain(text)
  highlighter ??= createHighlighter({
    themes: [THEMES.light, THEMES.dark],
    langs: [],
    engine: createJavaScriptRegexEngine()
  })
  const shiki = await highlighter
  await shiki.loadLanguage(lang)
  const { tokens } = shiki.codeToTokens(text, { lang, themes: THEMES, defaultColor: false })
  return tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      style: {
        '--shiki-light': token.htmlStyle?.['--shiki-light'],
        '--shiki-dark': token.htmlStyle?.['--shiki-dark']
      } as React.CSSProperties
    }))
  )
}

function plain(text: string): Token[][] {
  return text.split('\n').map((line) => [{ content: line }])
}

/**
 * A text's lines as colored runs, uncolored until the colors are ready. A
 * grammar that fails leaves the text uncolored rather than missing.
 */
export function useHighlight(text: string, path: string): Token[][] {
  const [colored, setColored] = useState<{ text: string; path: string; lines: Token[][] }>()
  useEffect(() => {
    let current = true
    highlight(text, path)
      .catch((error: unknown) => {
        console.error(`Could not color ${path}:`, error)
        return plain(text)
      })
      .then((lines) => {
        if (current) setColored({ text, path, lines })
      })
    return () => {
      current = false
    }
  }, [text, path])
  return colored?.text === text && colored.path === path ? colored.lines : plain(text)
}

/** A diff line's colored runs: from the file before for a deleted line, after for the others. */
export function lineTokens(line: DiffLine, oldLines: Token[][], newLines: Token[][]): Token[] {
  return (line.type === 'del' ? oldLines[(line.old ?? 0) - 1] : newLines[(line.new ?? 0) - 1]) ?? []
}
