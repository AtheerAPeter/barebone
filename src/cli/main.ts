// First: where the data is, for the modules that read it as they load.
import './runtime'

/**
 * The `barebone` command: Barebone without its window, for a server, where
 * the user controls it from Telegram. See docs/server.md.
 */

const HELP = `Usage: barebone <command>

  setup     Set the Telegram bot token, the projects and the agent new chats start with
  start     Run the agents and the Telegram bot, in the foreground
  service   Print a systemd unit that runs \`barebone start\` from boot
  version   Print the version`

async function main(): Promise<void> {
  const command = process.argv[2]
  switch (command) {
    case 'setup':
      await (await import('./setup')).setup()
      break
    case 'start':
      await (await import('./start')).start()
      break
    case 'service':
      ;(await import('./service')).service()
      break
    case 'version':
    case '--version':
      console.log(BAREBONE_VERSION)
      break
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP)
      break
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`)
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
