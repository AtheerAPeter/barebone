import { createElement, useSyncExternalStore, type CSSProperties } from 'react'
import type { Chat } from '../../../shared/types'

/**
 * A chat's topic icon (see main/topic-icon.ts) in the chat's own hue, so
 * chats are told apart at a glance in the sidebar, the top bar and the orb.
 * The main process picks any of Tabler's icons by name, so their SVGs are
 * loaded as one file, the first time an icon is drawn.
 */

type IconNode = [tag: string, attributes: Record<string, string>][]

let nodes: Record<string, IconNode> | undefined
let loading: Promise<void> | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  loading ??= import('tabler-icon-nodes').then(
    (module) => {
      nodes = module.default
      for (const notify of listeners) notify()
    },
    (error) => console.error('Could not load the topic icons:', error)
  )
  return () => listeners.delete(listener)
}

export function TopicIcon({
  chat,
  size = 16
}: {
  chat: Pick<Chat, 'icon' | 'hue'>
  size?: number
}): React.JSX.Element {
  const all = useSyncExternalStore(subscribe, () => nodes)
  const node = chat.icon ? all?.[chat.icon] : undefined
  // Until the chat's topic is matched, or the icons load, its place is kept so nothing moves.
  if (!node) {
    return <span className="topic-icon" style={{ width: size, height: size }} aria-hidden="true" />
  }
  // Drawn as Tabler draws its outline icons (@tabler/icons-react's defaultAttributes).
  return (
    <svg
      className="topic-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ '--topic-hue': chat.hue } as CSSProperties}
      aria-hidden="true"
    >
      {node.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
    </svg>
  )
}
