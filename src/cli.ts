#!/usr/bin/env node
/**
 * copilot-cli — Standalone local server for GitHub Copilot.
 *
 * Usage:
 *   copilot-cli serve              — Start the server (default port 18966)
 *   copilot-cli serve --port 9999  — Start on a custom port
 *   copilot-cli status             — Check if Copilot is authenticated
 *   copilot-cli login              — Open GitHub device-code auth flow
 *
 * The server exposes GitHub Copilot as a local REST API — like Ollama for Copilot.
 * Once running, any app on localhost can call http://localhost:18966/chat/completions.
 */

import { createServer, DEFAULT_PORT } from './server.js'
import { init, isReady, getInitError } from './sessionManager.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'serve'

async function main() {
  switch (command) {
    case 'serve':
      await cmdServe()
      break
    case 'status':
      await cmdStatus()
      break
    case 'login':
      await cmdLogin()
      break
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
  }
}

function printHelp() {
  console.log(`
copilot-cli — GitHub Copilot local REST API server

Commands:
  serve [--port PORT]   Start the server (default: ${DEFAULT_PORT})
  status                Check if Copilot is authenticated
  login                 Run GitHub Copilot device-code authentication

Options:
  --port PORT           Port to listen on (default: ${DEFAULT_PORT})
  -h, --help            Show this help
`)
}

async function cmdServe() {
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : DEFAULT_PORT

  if (isNaN(port) || port < 1 || port > 65535) {
    console.error('Invalid port number')
    process.exit(1)
  }

  console.log('[copilot-cli] Initialising GitHub Copilot SDK…')
  await init()

  if (!isReady()) {
    const err = getInitError()
    if (err?.includes('authentication') || err?.includes('unauthenticated')) {
      console.error('\n✗ GitHub Copilot is not authenticated.')
      console.error('  Run: copilot-cli login\n')
      process.exit(1)
    }
    console.warn(`[copilot-cli] Warning: ${err}`)
  }

  const app = createServer()

  app.listen(port, () => {
    console.log(`
┌─────────────────────────────────────────────────────────┐
│  copilot-cli server running on http://localhost:${port}  │
│                                                         │
│  Endpoints:                                             │
│    GET  /status            — Health & auth check        │
│    GET  /models            — List available models      │
│    POST /chat/completions  — Chat (poll-based)          │
│    POST /chat/stream       — Chat (SSE streaming)       │
│    GET  /run/:runId        — Poll for run result        │
└─────────────────────────────────────────────────────────┘
`)
  })
}

async function cmdStatus() {
  console.log('[copilot-cli] Checking GitHub Copilot authentication…')
  await init()

  if (isReady()) {
    console.log('✓ GitHub Copilot is authenticated and ready.')
    process.exit(0)
  } else {
    const err = getInitError()
    console.error(`✗ Not ready: ${err}`)
    process.exit(1)
  }
}

async function cmdLogin() {
  console.log('[copilot-cli] Starting GitHub Copilot authentication…\n')
  try {
    const sdk = await import('@github/copilot-sdk')
    // CopilotClient with autoStart triggers the device-code flow
    // which prints the auth URL to stdout for the user.
    const client = new sdk.CopilotClient({ autoStart: true })
    await client.start()
    console.log('\n✓ Authentication successful! You can now run: copilot-cli serve')
    await client.stop()
    process.exit(0)
  } catch (err: any) {
    console.error(`\n✗ Authentication failed: ${err?.message}`)
    console.error('  Make sure you have an active GitHub Copilot subscription.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
