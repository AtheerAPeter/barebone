import type * as acp from '@agentclientprotocol/sdk'
import type { ChatItem, FormAnswers, FormField } from '../shared/types'
import { emitItem, type AgentEvents, type Permissions } from './permissions'
import * as store from './store'

type FormItem = Extract<ChatItem, { kind: 'form' }>

/**
 * What the chat shows for an ACP elicitation: a form with its fields, or a
 * page to open. Undefined when it cannot be shown: a mode the app does not
 * know, a page that is not on the web, or a required field of a type the app
 * does not know, since the answer would leave it out.
 */
export function formFor(params: acp.CreateElicitationRequest): Omit<FormItem, 'id'> | undefined {
  if (params.mode === 'url') {
    const url = typeof params.url === 'string' ? params.url : ''
    if (!/^https?:\/\//i.test(url)) return undefined
    return { kind: 'form', message: params.message, fields: [], url }
  }
  if (params.mode !== 'form') return undefined
  const schema = params.requestedSchema as acp.ElicitationSchema
  const required = new Set(schema.required ?? [])
  const fields: FormField[] = []
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const field = formField(key, property, required.has(key))
    if (field) fields.push(field)
    else if (required.has(key)) return undefined
  }
  return { kind: 'form', message: params.message, fields }
}

function formField(
  key: string,
  property: acp.ElicitationPropertySchema,
  required: boolean
): FormField | undefined {
  const base = {
    key,
    title: typeof property.title === 'string' && property.title ? property.title : key,
    ...(typeof property.description === 'string' && property.description
      ? { description: property.description }
      : {}),
    required
  }
  switch (property.type) {
    case 'string': {
      const string = property as acp.StringPropertySchema
      const options =
        string.oneOf?.map((o) => ({
          value: o.const,
          title: o.title,
          ...(o.description ? { description: o.description } : {})
        })) ?? string.enum?.map((value) => ({ value, title: value }))
      if (options) {
        return { ...base, type: 'choice', options, default: string.default ? [string.default] : [] }
      }
      return { ...base, type: 'text', default: string.default ?? undefined }
    }
    case 'array': {
      const items = (property as acp.MultiSelectPropertySchema).items as {
        anyOf?: acp.EnumOption[]
        enum?: string[]
      }
      const options =
        items.anyOf?.map((o) => ({
          value: o.const,
          title: o.title,
          ...(o.description ? { description: o.description } : {})
        })) ?? items.enum?.map((value) => ({ value, title: value }))
      if (!options) return undefined
      const defaults = (property as acp.MultiSelectPropertySchema).default
      return { ...base, type: 'choices', options, default: defaults ?? [] }
    }
    case 'number':
    case 'integer':
      return {
        ...base,
        type: property.type,
        default: (property as acp.NumberPropertySchema).default ?? undefined
      }
    case 'boolean':
      return {
        ...base,
        type: 'boolean',
        default: (property as acp.BooleanPropertySchema).default ?? undefined
      }
    default:
      return undefined
  }
}

/**
 * The answers as the agent may take them: only the form's own fields, each a
 * value of its type, and for a pick only options the form offers. Undefined
 * when a required field has no answer.
 */
export function formContent(fields: FormField[], answers: FormAnswers): FormAnswers | undefined {
  const content: FormAnswers = {}
  for (const field of fields) {
    const value = answers[field.key]
    const offered = (v: unknown): boolean =>
      'options' in field && field.options.some((o) => o.value === v)
    if (field.type === 'choice' && typeof value === 'string' && offered(value)) {
      content[field.key] = value
    } else if (field.type === 'choices' && Array.isArray(value) && value.length > 0) {
      const picked = value.filter(offered)
      if (picked.length > 0) content[field.key] = picked
    } else if (field.type === 'text' && typeof value === 'string' && value.trim()) {
      content[field.key] = value
    } else if (
      (field.type === 'number' || field.type === 'integer') &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (field.type === 'number' || Number.isInteger(value))
    ) {
      content[field.key] = value
    } else if (field.type === 'boolean' && typeof value === 'boolean') {
      content[field.key] = value
    }
    if (field.required && content[field.key] === undefined) return undefined
  }
  return content
}

/** The answers as the chat shows them afterwards: each answered field's title and answer. */
export function formSummary(
  fields: FormField[],
  content: FormAnswers
): { title: string; answer: string }[] {
  return fields.flatMap((field) => {
    const value = content[field.key]
    if (value === undefined) return []
    const title = (v: string): string =>
      ('options' in field ? field.options.find((o) => o.value === v)?.title : undefined) ?? v
    const answer = Array.isArray(value)
      ? value.map(title).join(', ')
      : typeof value === 'boolean'
        ? value
          ? 'Yes'
          : 'No'
        : typeof value === 'string'
          ? title(value)
          : String(value)
    return [{ title: field.title, answer }]
  })
}

/**
 * Show a form and wait for the user, in every mode: bypass approves tool
 * calls, not answers the agent asks the user for. When the agent withdraws
 * the request (`signal`), the form closes as cancelled.
 */
export function askForm(
  events: AgentEvents,
  permissions: Permissions,
  chatId: string,
  form: Omit<FormItem, 'id'>,
  signal: AbortSignal
): Promise<acp.CreateElicitationResponse> {
  const id = crypto.randomUUID()
  return new Promise((resolve) => {
    permissions.set(id, { chatId, form: true, answer: resolve })
    emitItem(events, permissions, chatId, { ...form, id })
    signal.addEventListener('abort', () => {
      if (!permissions.delete(id)) return
      resolve({ action: 'cancel' })
      const item = store.findItem(chatId, id)
      if (item?.kind === 'form')
        emitItem(events, permissions, chatId, { ...item, resolved: 'cancelled' })
    })
  })
}
