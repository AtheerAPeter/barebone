import { useId, type ReactNode } from 'react'
import { ChevronDownIcon } from './icons'

/** The color of an icon tile, as System Settings gives each pane its own. */
export type SettingsTone =
  'indigo' | 'orange' | 'pink' | 'red' | 'purple' | 'blue' | 'green' | 'teal' | 'gray'

/**
 * One line of Settings: an icon tile, the setting's name and what it does in a
 * line, its state, its control, and a chevron that opens the full explanation
 * and fields under the line. The line itself opens them too; controls do not.
 */
export function SettingsRow({
  icon,
  tone,
  name,
  summary,
  pill,
  pillTone = 'on',
  action,
  open,
  onToggle,
  children
}: {
  icon: ReactNode
  tone: SettingsTone
  name: string
  summary: string
  /** What the setting is now, such as "On" or "Key saved". */
  pill?: string
  pillTone?: 'on' | 'off' | 'warn'
  /** The switch, or a button that opens the row, as Manage does. */
  action?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section className={`setting${open ? ' open' : ''}`}>
      <div
        className="setting-line"
        onClick={(e) => {
          // The controls keep their own clicks; the rest of the line opens the row.
          if ((e.target as HTMLElement).closest('button, input, textarea, select, a')) return
          onToggle()
        }}
      >
        <span className={`settings-icon tone-${tone}`}>{icon}</span>
        <span className="setting-text">
          <span className="setting-name">{name}</span>
          <span className="setting-summary" title={summary}>
            {summary}
          </span>
        </span>
        {(pill || action) && (
          <span className="setting-ctl">
            {pill && (
              <span
                className={`setting-pill${pillTone === 'on' ? ' on' : pillTone === 'warn' ? ' warn' : ''}`}
              >
                {pill}
              </span>
            )}
            {action}
          </span>
        )}
        <button
          type="button"
          className="setting-more"
          aria-expanded={open}
          aria-controls={id}
          aria-label={open ? `Hide what ${name} does` : `What ${name} does`}
          onClick={onToggle}
        >
          <ChevronDownIcon />
        </button>
      </div>
      <div className="setting-detail" id={id} hidden={!open}>
        {children}
      </div>
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
