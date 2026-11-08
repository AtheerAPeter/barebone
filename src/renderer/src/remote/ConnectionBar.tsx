import { useEffect, useState } from 'react'
import type { Connection } from './socket'

/** Says so while the page has lost the Mac; the UI stays as it was. */
export function ConnectionBar({
  onConnection
}: {
  onConnection: (listener: (connection: Connection) => void) => () => void
}): React.JSX.Element | null {
  const [connection, setConnection] = useState<Connection>('connecting')
  useEffect(() => onConnection(setConnection), [onConnection])
  if (connection === 'online') return null
  return (
    <div className="connection-bar" role="status">
      <span className="spinner" />
      {connection === 'connecting' ? 'Connecting to your Mac…' : 'Reconnecting to your Mac…'}
    </div>
  )
}
