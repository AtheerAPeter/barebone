import type * as acp from '@agentclientprotocol/sdk'
import { APPROVAL_FIELDS, type ChatItem } from '../shared/types'
import * as store from './store'

/**
 * Asking the user before anything goes out in their name (ask_approval in
 * chats-mcp.ts): the card the chat shows, what the agent is told of the
 * answer, and the gate that holds back a bot's clicks on send buttons until
 * the user approved (see sendGate).
 */

/**
 * How long one ask_approval call waits for the answer. MCP clients give up
 * on a tool call after 60 s by default (the MCP SDK, Cline, Codex), so an
 * answer that comes later wakes the chat instead.
 */
export const APPROVAL_WAIT_MS = 50_000

/** How long after the user approved a bot may click a send button. */
const APPROVED_FOR_MS = 10 * 60_000

/** The user's answer to an approval card. */
export type Approval =
  { decision: 'send' } | { decision: 'change'; change: string } | { decision: 'skip' }

/** The card: the question, the draft to approve, and Send, Change or Skip. */
export function approvalForm(
  question: string,
  details: string
): Omit<Extract<ChatItem, { kind: 'form' }>, 'id'> {
  return { kind: 'form', message: question, details, fields: APPROVAL_FIELDS }
}

/** The answer from the form's; declining the form (Telegram's Decline) is a skip. */
export function approvalOf(response: acp.CreateElicitationResponse): Approval {
  const content =
    (response.action === 'accept' && (response as acp.ElicitationAcceptAction).content) || {}
  if (content.decision === 'send') return { decision: 'send' }
  if (content.decision === 'change') {
    const change = typeof content.change === 'string' ? content.change.trim() : ''
    return { decision: 'change', change }
  }
  return { decision: 'skip' }
}

/** What the agent is told of the answer. */
export function approvalText(approval: Approval): string {
  switch (approval.decision) {
    case 'send':
      return 'approved. Send it now, exactly as shown.'
    case 'skip':
      return 'skip. The user does not want it sent: do not send it.'
    case 'change':
      return approval.change
        ? `change: ${approval.change}\n\nRevise it and ask again with ask_approval before sending.`
        : 'change: the user did not say what. Ask them what to change, then ask again with ask_approval.'
  }
}

/** When the user last approved something going out, by chat. */
const approved = new Map<string, number>()

export function approve(chatId: string): void {
  approved.set(chatId, Date.now())
}

/**
 * Words on a control that sends something in the user's name, in English and
 * German, as whole words: "Submit application", "Jetzt bewerben", "Absenden".
 */
const SENDING =
  /(?<![\p{L}\p{N}])(send|submit|apply|pay|buy|purchase|order|book|confirm|post|publish|senden|absenden|versenden|abschicken|einreichen|bewerben|bestellen|kaufen|bezahlen|zahlen|buchen|bestätigen|veröffentlichen)(?![\p{L}\p{N}])/iu

/**
 * The gate on a bot's clicks: in any chat of a bot's project, a click on a
 * control whose name or value reads as sending waits until the user approved
 * with ask_approval in that chat, within the last 10 minutes. Returns why the
 * click was refused, or undefined when it may go ahead. Keys, scripts and
 * clicks at a point are not checked (see README, Bots).
 */
export function sendGate(
  chatId: string,
  control: { name: string; value: string }
): string | undefined {
  const { chats, projects } = store.getState()
  const chat = chats.find((c) => c.id === chatId)
  if (!projects.some((p) => p.id === chat?.projectId && p.bot)) return undefined
  const word = `${control.name} ${control.value}`.match(SENDING)
  if (!word) return undefined
  const at = approved.get(chatId)
  if (at !== undefined && Date.now() - at <= APPROVED_FOR_MS) return undefined
  const label = control.name || control.value
  return `Nothing was done: "${label}" looks like it sends something in the user's name ("${word[1]}"), and the user has not approved it in the last 10 minutes. Ask first with ask_approval, showing exactly what goes out; once they answer Send, click it again.`
}
