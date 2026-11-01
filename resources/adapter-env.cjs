// Loaded first in the Codex and Claude Code adapters (main/agents.ts), which
// run on the app's own Node: ELECTRON_RUN_AS_NODE makes the app's binary start
// as Node. What the adapters start (the CLI, and the commands it runs) must not
// inherit it, or an Electron app an agent runs would start as Node too.
delete process.env.ELECTRON_RUN_AS_NODE
