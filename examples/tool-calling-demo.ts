/**
 * tool-calling-demo.ts
 *
 * A self-contained demo that:
 *   1. Spins up a local Express tool-handler server on port 3001.
 *   2. Calls the copilot-cli server (port 18966) with tool definitions.
 *   3. Logs every SSE event including tool_call / tool_result / text.
 *
 * Run:
 *   npx tsx examples/tool-calling-demo.ts
 *
 * Make sure the copilot-cli server is already running:
 *   npx tsx src/cli.ts serve
 */

import express from 'express'
import http from 'http'

const COPILOT_URL = 'http://localhost:18966'
const TOOL_HANDLER_PORT = 3001
const TOOL_HANDLER_URL = `http://localhost:${TOOL_HANDLER_PORT}/tool-handler`
const MODEL = 'claude-sonnet-4'

// ---------------------------------------------------------------------------
// Fake tool implementations (swap these for real logic)
// ---------------------------------------------------------------------------

function getWeather(city: string): string {
  const data: Record<string, string> = {
    london: '14°C, overcast',
    paris: '21°C, sunny',
    tokyo: '18°C, light rain',
    'new york': '9°C, windy',
  }
  return data[city.toLowerCase()] ?? `No weather data for "${city}"`
}

function searchWeb(query: string): string {
  // Fake search results
  return [
    `[Result 1] "${query}" — Wikipedia: Overview of the topic.`,
    `[Result 2] "${query}" — BBC News: Latest coverage.`,
    `[Result 3] "${query}" — Academic paper published 2025.`,
  ].join('\n')
}

function calculator(expression: string): string {
  try {
    // Safe eval of simple arithmetic only (no exec/function constructors)
    const sanitised = expression.replace(/[^0-9+\-*/.() ]/g, '')
    if (sanitised !== expression) return 'Error: unsupported characters in expression'
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${sanitised})`)()
    return String(result)
  } catch {
    return 'Error: could not evaluate expression'
  }
}

// ---------------------------------------------------------------------------
// 1. Start tool-handler Express server
// ---------------------------------------------------------------------------

async function startToolHandler(): Promise<http.Server> {
  const app = express()
  app.use(express.json())

  app.post('/tool-handler', (req, res) => {
    const { toolName, arguments: args } = req.body as {
      toolName: string
      toolCallId: string
      arguments: Record<string, string>
      sessionId: string
    }

    console.log(`\n  [tool-handler] CALLED: ${toolName}`, args)

    let result: string

    switch (toolName) {
      case 'get_weather':
        result = getWeather(args.city ?? '')
        break
      case 'search_web':
        result = searchWeb(args.query ?? '')
        break
      case 'calculator':
        result = calculator(args.expression ?? '')
        break
      default:
        result = `Unknown tool: ${toolName}`
    }

    console.log(`  [tool-handler] RESULT: ${result}\n`)
    res.json({ result })
  })

  return new Promise((resolve) => {
    const server = app.listen(TOOL_HANDLER_PORT, () => {
      console.log(`[demo] Tool-handler listening on http://localhost:${TOOL_HANDLER_PORT}`)
      resolve(server)
    })
  })
}

// ---------------------------------------------------------------------------
// 2. Stream a chat request to copilot-cli with tools
// ---------------------------------------------------------------------------

async function runStreamingDemo(prompt: string): Promise<void> {
  console.log(`\n[demo] Sending prompt: "${prompt}"\n`)

  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    toolCallbackUrl: TOOL_HANDLER_URL,
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'Name of the city' },
          },
          required: ['city'],
        },
      },
      {
        name: 'search_web',
        description: 'Search the web for up-to-date information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      },
      {
        name: 'calculator',
        description: 'Evaluate a basic arithmetic expression.',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'e.g. "12 * (3 + 4)"' },
          },
          required: ['expression'],
        },
      },
    ],
  })

  // Node 18+ built-in fetch
  const response = await fetch(`${COPILOT_URL}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (!response.ok || !response.body) {
    console.error('[demo] Request failed:', response.status, await response.text())
    return
  }

  // Parse SSE stream
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  let fullText = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (!payload) continue

      try {
        const event = JSON.parse(payload) as {
          type: string
          content?: string
          toolName?: string
          toolCallId?: string
          arguments?: unknown
          result?: unknown
          error?: string
          partial?: boolean
        }

        switch (event.type) {
          case 'text':
            process.stdout.write(event.content ?? '')
            fullText += event.content ?? ''
            break

          case 'tool_call':
            console.log(`\n\n[stream event] tool_call → ${event.toolName} (${event.toolCallId})`)
            console.log('  args:', JSON.stringify(event.arguments, null, 2))
            break

          case 'tool_result':
            console.log(`[stream event] tool_result ← ${event.toolName}`)
            console.log('  result:', event.result)
            process.stdout.write('\n')
            break

          case 'done':
            console.log('\n\n[demo] Stream complete' + (event.partial ? ' (partial)' : '') + '.')
            break

          case 'error':
            console.error('\n[demo] Stream error:', event.error)
            break
        }
      } catch {
        // ignore malformed lines
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Poll-based demo (/chat/completions + /run/:runId)
// ---------------------------------------------------------------------------

async function runPollDemo(prompt: string): Promise<void> {
  console.log(`\n[demo] Poll-based prompt: "${prompt}"\n`)

  const { runId } = await fetch(`${COPILOT_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      toolCallbackUrl: TOOL_HANDLER_URL,
      tools: [
        {
          name: 'calculator',
          description: 'Evaluate a basic arithmetic expression.',
          parameters: {
            type: 'object',
            properties: {
              expression: { type: 'string' },
            },
            required: ['expression'],
          },
        },
      ],
    }),
  }).then((r) => r.json()) as { runId: string }

  console.log(`[demo] Run queued: ${runId}. Polling…`)

  // Poll every second until done
  while (true) {
    await new Promise((r) => setTimeout(r, 1000))
    const run = await fetch(`${COPILOT_URL}/run/${runId}`).then((r) => r.json()) as {
      status: string
      result?: { content: string; partial: boolean }
      error?: string
    }

    process.stdout.write(`.`)

    if (run.status === 'completed') {
      console.log('\n\n[demo] Result:')
      console.log(run.result?.content)
      break
    }
    if (run.status === 'failed') {
      console.error('\n[demo] Run failed:', run.error)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const toolServer = await startToolHandler()

try {
  // Check copilot-cli is up
  const status = await fetch(`${COPILOT_URL}/status`).then((r) => r.json()).catch(() => null) as any
  if (!status?.authenticated) {
    console.error(`[demo] copilot-cli is not ready at ${COPILOT_URL}.`)
    console.error('       Start it first:  npx tsx src/cli.ts serve')
    process.exit(1)
  }

  console.log('[demo] copilot-cli status: OK ✓\n')
  console.log('='.repeat(60))

  // --- Demo 1: streaming with weather + search tools ---
  console.log('DEMO 1 — Streaming with tool calling')
  console.log('='.repeat(60))
  await runStreamingDemo(
    "What's the weather like in London and Paris today? Also search the web for 'AI news April 2026' and give me a quick summary."
  )

  console.log('\n' + '='.repeat(60))

  // --- Demo 2: poll-based with calculator tool ---
  console.log('DEMO 2 — Poll-based with calculator tool')
  console.log('='.repeat(60))
  await runPollDemo('What is 1337 * 42 + (100 / 4)?')

} finally {
  toolServer.close()
}
