import { useEffect, useState } from 'react'
import { isHarnessAgent, type Chat, type WaitingMessage } from '../../../shared/types'
import { elapsed } from '../lib/time'
import { ClockIcon, ListIcon } from './icons'
import { RowMenu, type RowMenuItem } from './RowMenu'

/**
 * The user's messages sent while the agent works, docked on the composer's
 * top edge until they join the chat. Each row says what it waits for: a
 * steer the agent takes at once ("Steering in"), the step the agent is on,
 * or for a queued one the turn's end. A queued one can steer instead, and
 * one held by a step can end it to go in now.
 */
export function WaitingStrip({
  chat,
  messages,
  onEdit
}: {
  chat: Chat
  messages: WaitingMessage[]
  /** Take the message back into the composer to edit it. */
  onEdit: (id: string) => void
}): React.JSX.Element {
  const held = messages.some((m) => !m.queued && m.joins === 'step')
  const [now, setNow] = useState(Date.now)
  // A row held by a step counts up, so a long wait shows.
  useEffect(() => {
    if (!held) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [held])
  const firstQueued = messages.findIndex((m) => m.queued)
  // The app's own agents take a message between their calls; ending the turn would not be sooner.
  const interrupts = !isHarnessAgent(chat.agent)

  return (
    <div className="waiting-strip">
      {messages.map((message, index) => {
        const steering = !message.queued
        const atOnce = steering && message.joins === 'now'
        const items: RowMenuItem[] = [
          {
            name: 'Edit',
            shortcut: index === messages.length - 1 ? '↑' : undefined,
            onSelect: () => onEdit(message.id)
          },
          ...(index > 0
            ? [
                {
                  name: 'Move up',
                  onSelect: () => void window.api.moveWaiting(chat.id, message.id, -1)
                }
              ]
            : []),
          ...(index < messages.length - 1
            ? [
                {
                  name: 'Move down',
                  onSelect: () => void window.api.moveWaiting(chat.id, message.id, 1)
                }
              ]
            : []),
          {
            name: 'Delete',
            danger: true,
            onSelect: () => void window.api.takeWaiting(chat.id, message.id)
          }
        ]
        return (
          <div className="waiting-row" key={message.id}>
            {atOnce ? (
              <span className="spinner" />
            ) : steering ? (
              <ClockIcon width={12} height={12} />
            ) : (
              <ListIcon width={12} height={12} />
            )}
            <span className="waiting-body">
              <span className="waiting-text" title={message.text}>
                {message.text}
              </span>
              <span className={`waiting-state${atOnce ? ' shimmer' : ''}`}>
                {atOnce
                  ? 'Steering in'
                  : steering
                    ? `After ${afterWhat(chat.activity)} · ${elapsed(Math.max(0, Math.floor((now - message.at) / 1000)))}`
                    : index === firstQueued
                      ? 'After this turn'
                      : 'Queued'}
              </span>
            </span>
            {message.queued ? (
              <button
                type="button"
                className="waiting-action"
                onClick={() => void window.api.steerWaiting(chat.id, message.id)}
              >
                Steer now
              </button>
            ) : (
              !atOnce &&
              interrupts && (
                <button
                  type="button"
                  className="waiting-action key"
                  title="End the step the agent is on, and send this now"
                  onClick={() => void window.api.steerWaiting(chat.id, message.id)}
                >
                  Interrupt &amp; send
                </button>
              )
            )}
            <RowMenu label="More" items={items} />
          </div>
        )
      })}
    </div>
  )
}

/** "running npm test" from the chat's activity ("Running npm test"), or the step in general. */
function afterWhat(activity: string | undefined): string {
  if (!activity) return 'this step'
  return activity.charAt(0).toLowerCase() + activity.slice(1)
}
