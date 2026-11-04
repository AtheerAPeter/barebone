/**
 * The languages Pocket (pocket.ts) speaks in meetings, with their bundle and
 * the voice lineofflight tested with it. Apart from the engine, so the main
 * process can ask without loading it.
 */
export const POCKET_VOICES = {
  en: { bundle: 'english_2026-10', voice: 'charles' },
  de: { bundle: 'german', voice: 'juergen' },
  es: { bundle: 'spanish', voice: 'lola' }
} as const
export type PocketLanguage = keyof typeof POCKET_VOICES

export function isPocketLanguage(language: string): language is PocketLanguage {
  return Object.hasOwn(POCKET_VOICES, language)
}
