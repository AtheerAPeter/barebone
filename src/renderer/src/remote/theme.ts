/**
 * Light or dark for a page of the remote link, kept in that browser. In the
 * app, the theme flips the window's prefers-color-scheme (main/index.ts
 * setTheme); a page cannot, so its stylesheets' dark rules are switched on or
 * off here instead, and the Mac's own theme is left as it is. With no choice
 * made, the page follows its device.
 */

export type PageTheme = 'light' | 'dark'

const KEY = 'remote:theme'
const DARK = '(prefers-color-scheme: dark)'
/** Conditions that always and never hold, in place of the dark query. */
const ALWAYS = '(min-width: 0px)'
const NEVER = '(max-width: 0px)'

const device = window.matchMedia(DARK)
const stored = localStorage.getItem(KEY)
let chosen: PageTheme | undefined = stored === 'light' || stored === 'dark' ? stored : undefined
const listeners = new Set<() => void>()
/** Each dark rule's own condition, from before it was switched. */
const originals = new WeakMap<CSSMediaRule, string>()

export function pageDark(): boolean {
  return chosen ? chosen === 'dark' : device.matches
}

export function setPageTheme(theme: PageTheme): void {
  chosen = theme
  localStorage.setItem(KEY, theme)
  applyPageTheme()
  for (const listener of listeners) listener()
}

export function onPageTheme(listener: () => void): () => void {
  listeners.add(listener)
  device.addEventListener('change', listener)
  return () => {
    listeners.delete(listener)
    device.removeEventListener('change', listener)
  }
}

/** Switch the dark rules of every stylesheet loaded so far to the chosen theme. */
export function applyPageTheme(): void {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSMediaRule)) continue
      const original = originals.get(rule) ?? rule.media.mediaText
      if (!original.includes(DARK)) continue
      originals.set(rule, original)
      rule.media.mediaText = chosen
        ? original.replace(DARK, chosen === 'dark' ? ALWAYS : NEVER)
        : original
    }
  }
  // Scrollbars and form controls, and the phone's toolbar color.
  document.documentElement.style.colorScheme = chosen ?? ''
  for (const meta of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) {
    meta.setAttribute('content', pageDark() ? '#000000' : '#ffffff')
  }
}
