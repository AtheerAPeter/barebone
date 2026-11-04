/** Aliased in electron.vite.config.ts to @tabler/icons/icons.json, which the package does not export. */
declare module 'tabler-icons-meta' {
  /** Every icon by name, with its category and search tags. */
  const icons: Record<string, import('./topic-icon').TablerIcon>
  export default icons
}
