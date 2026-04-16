/**
 * OpenAI-compatible tool calling demo for copilot-cli.
 *
 * Run:  npx tsx examples/openai-tool-calling-demo.ts
 * Requires copilot-cli server running:  npx tsx src/cli.ts serve
 */

const COPILOT_URL = 'http://localhost:18966'
const MODEL = 'claude-sonnet-4'

export {}

const tools = [
  {
    type: 'function' as const,
    function: {
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
  },
  {
    type: 'function' as const,
    function: {
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
  },
  {
    type: 'function' as const,
    function: {
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
  },
]

function executeTool(name: string, args: Record<string, string>): string {
  switch (name) {
    case 'get_weather': {
      const data: Record<string, string> = {
        london: '14°C, overcast',
        paris: '21°C, sunny',
        tokyo: '18°C, light rain',
        'new york': '9°C, windy',
      }
      return data[(args.city ?? '').toLowerCase()] ?? `No weather data for "${args.city}"`
    }
    case 'search_web':
      return [
        `[Result 1] "${args.query}" — Wikipedia: Overview of the topic.`,
        `[Result 2] "${args.query}" — BBC News: Latest coverage.`,
        `[Result 3] "${args.query}" — Academic paper published 2025.`,
      ].join('\n')
    case 'calculator': {
      const expr = (args.expression ?? '').replace(/[^0-9+\-*/.() ]/g, '')
      if (expr !== args.expression) return 'Error: unsupported characters'
      try {
        // eslint-disable-next-line no-new-func
        return String(Function(`"use strict"; return (${expr})`)())
      } catch {
        return 'Error: could not evaluate expression'
      }
    }
    default:
      return `Unknown tool: ${name}`
  }
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ChatCompletionResponse {
  id: string
  object: string
  model: string
  choices: Array<{
    index: number
    message: Message
    finish_reason: string
  }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

async function runNonStreamingDemo(prompt: string): Promise<void> {
  console.log(`\n[demo] Non-streaming prompt: "${prompt}"\n`)

  const messages: Message[] = [{ role: 'user', content: prompt }]
  let iterations = 0
  const MAX_ITERATIONS = 10

  while (iterations < MAX_ITERATIONS) {
    iterations++
    console.log(`  [turn ${iterations}] Sending ${messages.length} messages…`)

    const response = await fetch(`${COPILOT_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, tools }),
    })

    if (!response.ok) {
      console.error(`  [error] HTTP ${response.status}:`, await response.text())
      return
    }

    const data = (await response.json()) as ChatCompletionResponse
    const choice = data.choices[0]
    const assistantMsg = choice.message

    messages.push(assistantMsg)

    if (choice.finish_reason === 'tool_calls' && assistantMsg.tool_calls?.length) {
      for (const tc of assistantMsg.tool_calls) {
        const args = JSON.parse(tc.function.arguments)
        console.log(`  [tool_call] ${tc.function.name}(${JSON.stringify(args)})`)

        const result = executeTool(tc.function.name, args)
        console.log(`  [tool_result] → ${result.slice(0, 100)}${result.length > 100 ? '…' : ''}`)

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        })
      }
      continue
    }

    console.log(`\n  [assistant] ${assistantMsg.content}\n`)
    break
  }

  if (iterations >= MAX_ITERATIONS) {
    console.warn('  [warning] Hit max iteration limit')
  }
}

async function runStreamingDemo(prompt: string): Promise<void> {
  console.log(`\n[demo] Streaming prompt: "${prompt}"\n`)

  const messages: Message[] = [{ role: 'user', content: prompt }]
  let iterations = 0
  const MAX_ITERATIONS = 10

  while (iterations < MAX_ITERATIONS) {
    iterations++
    console.log(`  [turn ${iterations}] Streaming ${messages.length} messages…`)

    const response = await fetch(`${COPILOT_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, tools, stream: true }),
    })

    if (!response.ok || !response.body) {
      console.error(`  [error] HTTP ${response.status}:`, await response.text())
      return
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let fullContent = ''
    const collectedToolCalls: ToolCall[] = []
    let finishReason = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') continue
        if (!payload) continue

        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{
              delta: {
                role?: string
                content?: string
                tool_calls?: Array<{
                  index: number
                  id?: string
                  type?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason: string | null
            }>
            error?: { message: string }
          }

          if (chunk.error) {
            console.error(`\n  [error] ${chunk.error.message}`)
            continue
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue

          if (choice.delta.content) {
            process.stdout.write(choice.delta.content)
            fullContent += choice.delta.content
          }

          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (tc.id) {
                collectedToolCalls.push({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
                })
              } else if (collectedToolCalls.length > 0) {
                const last = collectedToolCalls[collectedToolCalls.length - 1]
                last.function.arguments += tc.function?.arguments ?? ''
              }
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason
          }
        } catch {
        }
      }
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: fullContent || null,
      ...(collectedToolCalls.length ? { tool_calls: collectedToolCalls } : {}),
    }
    messages.push(assistantMsg)

    if (finishReason === 'tool_calls' && collectedToolCalls.length) {
      console.log('')
      for (const tc of collectedToolCalls) {
        const args = JSON.parse(tc.function.arguments)
        console.log(`  [tool_call] ${tc.function.name}(${JSON.stringify(args)})`)

        const result = executeTool(tc.function.name, args)
        console.log(`  [tool_result] → ${result.slice(0, 100)}${result.length > 100 ? '…' : ''}`)

        messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
      continue
    }

    console.log(`\n\n  [stream complete] finish_reason: ${finishReason}\n`)
    break
  }
}

const statusCheck = await fetch(`${COPILOT_URL}/status`).then((r) => r.json()).catch(() => null) as any
if (!statusCheck?.authenticated) {
  console.error(`copilot-cli is not ready at ${COPILOT_URL}.`)
  console.error('Start it first:  npx tsx src/cli.ts serve')
  process.exit(1)
}

console.log('[demo] copilot-cli status: OK ✓')
console.log('='.repeat(60))

console.log('DEMO 1 — Non-streaming with client-side tool calling')
console.log('='.repeat(60))
await runNonStreamingDemo("What's the weather in London and Paris?")

console.log('\n' + '='.repeat(60))

console.log('DEMO 2 — Streaming with client-side tool calling')
console.log('='.repeat(60))
await runStreamingDemo('What is 1337 * 42 + (100 / 4)?')
