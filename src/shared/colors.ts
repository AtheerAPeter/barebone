import type { Project, ProjectColor } from './types'

/** Mid tones, readable on both the light and the dark sidebar. */
export const COLOR_VALUES: Record<ProjectColor, string> = {
  red: '#e0524a',
  orange: '#e8873a',
  yellow: '#e2b41b',
  green: '#3fa866',
  teal: '#2fa3a0',
  blue: '#3d82e0',
  purple: '#8c62d9',
  pink: '#d95a9c'
}

/** The CSS color of a project's color: a preset's value, or the custom color itself. */
export function colorValue(color: NonNullable<Project['color']>): string {
  return color.startsWith('#') ? color : COLOR_VALUES[color as ProjectColor]
}

/** A bot's color when its project has none. */
const BOT_DEFAULT = '#8c62d9'

/** The CSS color of a bot: its character's, its chat's tint, and its dashboard's accent. */
export function botColor(project: Project): string {
  return project.color ? colorValue(project.color) : BOT_DEFAULT
}
