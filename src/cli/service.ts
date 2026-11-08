import { realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'

/**
 * `barebone service`: a systemd unit that runs `barebone start` as this user,
 * from boot, restarted when it stops. It is printed, for the user to install:
 *
 *   barebone service | sudo tee /etc/systemd/system/barebone.service
 *   sudo systemctl enable --now barebone
 */
export function service(): void {
  const script = realpathSync(process.argv[1])
  // What the command was run with that changes where it looks.
  const environment = ['BAREBONE_HOME', 'BAREBONE_CHROMIUM', 'XDG_DATA_HOME']
    .filter((name) => process.env[name])
    .map((name) => `Environment=${name}=${process.env[name]}`)
  console.log(
    [
      '[Unit]',
      'Description=Barebone: coding agents controlled from Telegram',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `User=${userInfo().username}`,
      `WorkingDirectory=${homedir()}`,
      `Environment=HOME=${homedir()}`,
      ...environment,
      `ExecStart=${process.execPath} ${script} start`,
      'Restart=on-failure',
      'RestartSec=5',
      // Time to stop the agents and the browser (start.ts waits 5 s for them).
      'TimeoutStopSec=15',
      '',
      '[Install]',
      'WantedBy=multi-user.target'
    ].join('\n')
  )
}
