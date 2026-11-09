import type { ChatItem } from '../shared/types'
import { callVerb, toolInput, toolKindAndTarget } from '../shared/tool-calls'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** Long enough for a sidebar line, which cuts it to fit anyway. */
const MAX_ACTIVITY = 100

/** Whether the agent has sent what a call acts on: opencode sends nothing, or {}, at first. */
function hasInput(call: ToolItem): boolean {
  const fields = toolInput(call)
  return fields ? Object.keys(fields).length > 0 : Boolean(call.input)
}

/**
 * What a chat is doing in its turn: its newest call that has not ended, in
 * the words the chat view and Telegram use ("Running npm test"). Undefined
 * between calls. Calls a turn left unfinished are marked interrupted when it
 * ends, so any call still going belongs to the turn that runs. A pending call
 * without input is one the model is still writing out (opencode names a write
 * long before its path), so it is still thinking.
 */
export function chatActivity(items: ChatItem[]): string | undefined {
  const call = items.findLast(
    (i): i is ToolItem =>
      i.kind === 'tool' && (i.status === 'in_progress' || (i.status === 'pending' && hasInput(i)))
  )
  if (!call) return undefined
  const text = `${callVerb(call)[1]} ${toolKindAndTarget(call)[1]}`.replace(/\s+/g, ' ').trim()
  return text.length > MAX_ACTIVITY ? `${text.slice(0, MAX_ACTIVITY - 1)}…` : text
}
