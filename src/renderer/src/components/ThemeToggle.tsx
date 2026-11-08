import { useEffect, useState } from 'react'
import { onPageTheme, pageDark, setPageTheme } from '../remote/theme'
import { MoonIcon, SunIcon } from './icons'

/**
 * Flips between light and dark. View → Appearance also offers "System". In a
 * browser through the remote link it flips that page only (remote/theme.ts).
 */
export function ThemeToggle(): React.JSX.Element {
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

  return (
    <button
      className="icon-btn"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() =>
        remote
          ? setPageTheme(dark ? 'light' : 'dark')
          : window.api.setTheme(dark ? 'light' : 'dark')
      }
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
