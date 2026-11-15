import type * as acp from '@agentclientprotocol/sdk'
import { APPROVAL_FIELDS, type ChatItem, type Project } from '../shared/types'
import { botConversation } from './bots'
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

/** What else an approval card does (see Agents.askApproval). */
export interface ApprovalOptions {
  /** Run when the user answers Send, however late. */
  onSend?: () => void
  /** What the agent is told of an answer that comes after its call ended. */
  answerText?: (approval: Approval) => string
}

/** The bot whose own conversation `chatId` is; throws for any other chat. */
function conversationBot(chatId: string): Project {
  const project = store.getProject(store.getChat(chatId).projectId)
  if (!project.bot || botConversation(project.id)?.id !== chatId) {
    throw new Error("This is only for a bot's own conversation, and this chat is not one.")
  }
  return project
}

/**
 * The card that asks the user, once, whether the bot whose conversation
 * `chatId` is may send in their name without asking (set_send_consent).
 * Consent is set only by the user's Send on it, never by the agent alone, so
 * no page or mail the bot reads can give it.
 */
export function consentCard(
  chatId: string
): { question: string; details: string } & ApprovalOptions {
  const { name } = conversationBot(chatId)
  return {
    question: `Let ${name} send and submit without asking you first?`,
    details: `From now on, ${name} and the chats it starts send, submit and apply in your name on their own, without a card each time. Tell ${name} to ask again whenever you want it to.`,
    onSend: () => setSendConsent(chatId, true),
    answerText: consentText
  }
}

/** What the agent is told of the user's answer to the consent card. */
export function consentText(approval: Approval): string {
  return approval.decision === 'send'
    ? 'consent given. From now on you and the chats you start send without ask_approval, and send buttons are no longer held back. Keep within what the user allowed, and tell them in one line that you now go ahead on your own.'
    : 'no consent. Keep asking with ask_approval before anything goes out.'
}

/**
 * Let the bot whose conversation `chatId` is send in the user's name without
 * asking, or make it ask again. Only consentCard's Send allows it; taking it
 * back needs no such proof.
 */
export function setSendConsent(chatId: string, allowed: boolean): void {
  const project = conversationBot(chatId)
  if (!project.bot) return
  const bot = { ...project.bot }
  if (allowed) bot.sendsWithoutAsking = true
  else delete bot.sendsWithoutAsking
  store.updateProject(project.id, { bot })
}

/**
 * Whether the user let the bot `chatId` works for send in their name without
 * asking (set_send_consent): in the bot's conversation and in the chats it
 * started to do the work. Another chat in the bot's project, one the user or
 * another bot's chat started, still asks.
 */
export function sendsWithoutAsking(chatId: string): boolean {
  const { chats, projects } = store.getState()
  const chat = chats.find((c) => c.id === chatId)
  const project = projects.find((p) => p.id === chat?.projectId)
  if (!chat || !project?.bot?.sendsWithoutAsking) return false
  const conversation = botConversation(project.id)?.id
  return chat.id === conversation || chat.startedBy === conversation
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
 * with ask_approval in that chat, within the last 10 minutes, unless the user
 * let the bot send without asking (sendsWithoutAsking). Returns why the click
 * was refused, or undefined when it may go ahead. Keys, scripts and clicks at a
 * point are not checked (see README, Bots).
 */
export function sendGate(
  chatId: string,
  control: { name: string; value: string }
): string | undefined {
  const { chats, projects } = store.getState()
  const chat = chats.find((c) => c.id === chatId)
  const project = projects.find((p) => p.id === chat?.projectId)
  if (!project?.bot || sendsWithoutAsking(chatId)) return undefined
  const word = `${control.name} ${control.value}`.match(SENDING)
  if (!word) return undefined
  const at = approved.get(chatId)
  if (at !== undefined && Date.now() - at <= APPROVED_FOR_MS) return undefined
  const label = control.name || control.value
  return `Nothing was done: "${label}" looks like it sends something in the user's name ("${word[1]}"), and the user has not approved it in the last 10 minutes. Ask first with ask_approval, showing exactly what goes out; once they answer Send, click it again.`
}
