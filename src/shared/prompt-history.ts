/**
 * The prompts the user sent in a project's chats, newest first, which the
 * composer completes from (see store.promptHistory and Composer). Kept the
 * same in the main process and the composer with addPrompt.
 */

/** How many prompts a project keeps; older ones drop off. */
export const PROMPT_HISTORY_LIMIT = 500

/** Longer messages are pastes rather than something typed again, and are left out. */
export const PROMPT_MAX_LENGTH = 2000

/** A sent message as the history keeps it, or undefined when it is left out. */
export function historyPrompt(text: string): string | undefined {
  const prompt = text.trim()
  return prompt && prompt.length <= PROMPT_MAX_LENGTH ? prompt : undefined
}

/** The history with a just-sent message first, once, within the limit. */
export function addPrompt(history: string[], text: string): string[] {
  const prompt = historyPrompt(text)
  if (!prompt || history[0] === prompt) return history
  return [prompt, ...history.filter((p) => p !== prompt)].slice(0, PROMPT_HISTORY_LIMIT)
}
