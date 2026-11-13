import { Menu, type MenuItemConstructorOptions } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { Theme } from '../shared/types'

/** Commands the renderer handles; menu items send these. */
export type MenuCommand =
  'new-chat' | 'open-project' | 'import-bot' | 'toggle-sidebar' | 'toggle-browser' | 'open-settings'

/**
 * The native menu bar. Its accelerators work wherever focus is, including
 * inside the browser page, and macOS lists each shortcut next to its item.
 */
export function installMenu(
  run: (command: MenuCommand) => void,
  theme: Theme,
  setTheme: (theme: Theme) => void
): void {
  const appearance = (label: string, value: Theme): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: theme === value,
    click: () => setTheme(value)
  })
  const mac = process.platform === 'darwin'
  const settings: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => run('open-settings')
  }
  const template: MenuItemConstructorOptions[] = [
    // The standard app menu, with Settings where Mac apps put it. Elsewhere
    // there is no app menu; Settings and Quit go in File, as Linux apps have them.
    ...(mac
      ? [
          {
            role: 'appMenu' as const,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              settings,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => run('new-chat') },
        {
          label: 'Open Project Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => run('open-project')
        },
        { label: 'Import Bot…', click: () => run('import-bot') },
        { type: 'separator' },
        ...(mac
          ? [{ role: 'close' as const }]
          : [settings, { type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // ⌘B, as in editors; the browser takes ⇧⌘B.
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => run('toggle-sidebar') },
        {
          label: 'Toggle Browser',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => run('toggle-browser')
        },
        {
          label: 'Appearance',
          submenu: [
            appearance('System', 'system'),
            appearance('Light', 'light'),
            appearance('Dark', 'dark')
          ]
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(is.dev ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : [])
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
