import { useEffect, useState } from 'react'
import { onPageTheme, pageDark, setPageTheme } from '../remote/theme'

/**
 * Light or dark, and the switch between them (the sidebar's More menu). View →
 * Appearance also offers "System". In a browser through the remote link it
 * flips that page only (remote/theme.ts).
 */
export function useThemeSwitch(): { dark: boolean; toggle: () => void } {
  const remote = window.api.remote
  const [dark, setDark] = useState(() =>
    remote ? pageDark() : window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  // Follows the effective appearance (the app setting, or macOS when set to System).
  useEffect(() => {
    if (remote) return onPageTheme(() => setDark(pageDark()))
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [remote])

  const toggle = (): void => {
    if (remote) setPageTheme(dark ? 'light' : 'dark')
    else void window.api.setTheme(dark ? 'light' : 'dark')
  }
  return { dark, toggle }
}
