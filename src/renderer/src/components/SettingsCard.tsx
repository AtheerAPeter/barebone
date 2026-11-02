import type { ReactNode } from 'react'

/** The color of a card's icon tile, as System Settings gives each pane its own. */
export type SettingsTone =
  'indigo' | 'orange' | 'pink' | 'red' | 'purple' | 'blue' | 'green' | 'teal' | 'gray'

/**
 * One section of Settings: an icon tile, a bold title and, on the right, the
 * card's own control (a switch); what it does and its fields sit under the title.
 */
export function SettingsCard({
  icon,
  tone,
  title,
  action,
  children
}: {
  icon: ReactNode
  tone: SettingsTone
  title: string
  action?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="settings-card">
      <header className="settings-card-head">
        <span className={`settings-icon tone-${tone}`}>{icon}</span>
        <h3>{title}</h3>
        {action}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  )
}

/** An on/off switch, as macOS draws one. */
export function Switch({
  label,
  on,
  onChange
}: {
  label: string
  on: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  )
}
