/**
 * server.ts — Standalone GitHub Copilot REST API server.
 * Exposes GitHub Copilot as a local HTTP API at http://localhost:18966
 */

import express from 'express'
import cors from 'cors'
import { randomUUID } from 'crypto'
import {
  isReady,
  getInitError,
  getClient,
  getApproveAllFn,
  acquireSession,
  drainSessionQueue,
  waitReady,
  isAuthError,
  isSessionStuckError,
  reinitClient,
  listModels,
} from './sessionManager.js'

export interface ToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  callbackUrl?: string
}

interface ToolCallEvent {
  type: 'tool_call'
  toolName: string
  toolCallId: string
  arguments: unknown
}

interface ToolResultEvent {
  type: 'tool_result'
  toolName: string
  toolCallId: string
  result: unknown
}

interface OAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OAIToolCall[]
  tool_call_id?: string
}

interface OAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

function normalizeToolDefs(tools?: (OAITool | ToolDefinition)[]): ToolDefinition[] {
  if (!tools?.length) return []
  return tools.map(t => {
    if ('type' in t && t.type === 'function' && 'function' in t) {
      const fn = (t as OAITool).function
      return { name: fn.name, description: fn.description, parameters: fn.parameters }
    }
    return t as ToolDefinition
  })
}

function buildFromMessages(messages: OAIMessage[]): { system?: string; prompt: string } {
  const systemMsgs = messages.filter(m => m.role === 'system')
  let system = systemMsgs.map(m => m.content ?? '').join('\n') || undefined

  const toolContext: string[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        toolContext.push(`You called tool "${tc.function.name}" with: ${tc.function.arguments}`)
      }
    }
    if (msg.role === 'tool') {
      toolContext.push(`Tool result (${msg.tool_call_id}): ${msg.content}`)
    }
  }

  if (toolContext.length) {
    const ctx = `\n\n## Tool Results from Previous Turn\n${toolContext.join('\n')}\n\nUse these results to answer the user's question.`
    system = system ? system + ctx : ctx.trim()
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  return { system, prompt: lastUserMsg?.content ?? '' }
}

interface CapturedToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

function buildCaptureTools(
  toolDefs: ToolDefinition[],
  captured: CapturedToolCall[],
  onCapture: () => void,
): any[] {
  return toolDefs.map(def => ({
    name: def.name,
    description: def.description,
    ...(def.parameters ? { parameters: def.parameters } : {}),
    handler: async (args: unknown, invocation: { toolCallId: string }) => {
      captured.push({
        id: invocation.toolCallId,
        type: 'function',
        function: {
          name: def.name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      })
      onCapture()
      return new Promise<never>(() => {})
    },
  }))
}

function buildTools(
  toolDefs: ToolDefinition[],
  defaultUrl: string | undefined,
  onEvent?: (event: ToolCallEvent | ToolResultEvent) => void,
): any[] {
  return toolDefs.map((def) => {
    const cbUrl = def.callbackUrl ?? defaultUrl
    return {
      name: def.name,
      description: def.description,
      ...(def.parameters ? { parameters: def.parameters } : {}),
      handler: async (args: unknown, invocation: { sessionId: string; toolCallId: string; toolName: string }) => {
        onEvent?.({ type: 'tool_call', toolName: def.name, toolCallId: invocation.toolCallId, arguments: args })

        if (!cbUrl) {
          const msg = `No callbackUrl configured for tool "${def.name}"`
          console.warn(`[copilot-cli][tools] ${msg}`)
          onEvent?.({ type: 'tool_result', toolName: def.name, toolCallId: invocation.toolCallId, result: msg })
          return { textResultForLlm: msg, resultType: 'failure' }
        }

        try {
          const resp = await fetch(cbUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              toolName: def.name,
              toolCallId: invocation.toolCallId,
              arguments: args,
              sessionId: invocation.sessionId,
            }),
          })

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => '')
            const msg = `Tool callback HTTP ${resp.status}: ${errBody}`
            onEvent?.({ type: 'tool_result', toolName: def.name, toolCallId: invocation.toolCallId, result: msg })
            return { textResultForLlm: msg, resultType: 'failure' }
          }

          const data = await resp.json().catch(() => null)
          const resultText =
            typeof data === 'string'
              ? data
              : (data?.result ?? data?.textResultForLlm ?? JSON.stringify(data))
          onEvent?.({ type: 'tool_result', toolName: def.name, toolCallId: invocation.toolCallId, result: resultText })
          return { textResultForLlm: String(resultText), resultType: 'success' }
        } catch (err: any) {
          const msg = `Tool callback error: ${err?.message ?? String(err)}`
          console.error(`[copilot-cli][tools] ${msg}`)
          onEvent?.({ type: 'tool_result', toolName: def.name, toolCallId: invocation.toolCallId, result: msg })
          return { textResultForLlm: msg, resultType: 'failure' }
        }
      },
    }
  })
}

interface Run {
  runId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  result?: { content: string; model: string; partial: boolean; usage: { promptTokens: number; completionTokens: number } }
  error?: string
  createdAt: number
  updatedAt: number
}

const runs = new Map<string, Run>()

setInterval(() => {
  const cutoff = Date.now() - 600_000
  for (const [id, run] of runs) {
    if ((run.status === 'completed' || run.status === 'failed') && run.updatedAt < cutoff) {
      runs.delete(id)
    }
  }
}, 60_000)

export const DEFAULT_PORT = 18966

export function createServer() {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))

  app.get('/status', (_req, res) => {
    if (isReady()) {
      res.json({ status: 'ok', authenticated: true })
    } else {
      res.json({ status: 'not_ready', authenticated: false, error: getInitError() ?? 'Starting…' })
    }
  })

  app.get('/models', async (_req, res) => {
    try {
      const models = await listModels()
      res.json({ models })
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to list models' })
    }
  })

  app.post('/chat/stream', async (req, res) => {
    const { model, messages, system, temperature, maxTokens, responseFormat, reasoning, timeoutMs, tools, toolCallbackUrl } = req.body as {
      model: string
      messages: Array<{ role: string; content: string }>
      system?: string
      temperature?: number
      maxTokens?: number
      responseFormat?: string
      reasoning?: { enabled: boolean; budgetTokens?: number }
      timeoutMs?: number
      tools?: ToolDefinition[]
      toolCallbackUrl?: string
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)

    try {
      await waitReady(20_000)
    } catch (err: any) {
      send({ type: 'error', error: err?.message ?? 'Copilot client not ready' })
      res.end()
      return
    }

    let session: any = null
    const release = await acquireSession()
    try {
      const c = getClient()
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')

      session = await c.createSession({
        model,
        streaming: true,
        onPermissionRequest: getApproveAllFn(),
        infiniteSessions: { enabled: false },
        hooks: {
          onErrorOccurred: async (input: any) => {
            console.warn(`[copilot-cli] /chat/stream session error: ${input.error}`)
            return { errorHandling: 'retry' }
          },
        },
        ...(system ? { systemMessage: { mode: 'replace', content: system } } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(responseFormat === 'json_object' ? { responseFormat: 'json' } : {}),
        ...(reasoning?.enabled ? { reasoning: { budgetTokens: reasoning.budgetTokens ?? 6000 } } : {}),
        ...(tools?.length ? { tools: buildTools(tools, toolCallbackUrl, (ev) => send(ev)) } : {}),
      })

      const waitTimeout = timeoutMs ?? 180_000

      await new Promise<void>((resolve) => {
        let settled = false
        let gotFirstToken = false
        let lastDeltaAt = Date.now()
        const sendStartedAt = Date.now()
        let hasContent = false
        let activityCheckInterval: ReturnType<typeof setInterval> | null = null

        const unsubDelta = session.on('assistant.message_delta', (event: any) => {
          const delta = event.data?.deltaContent ?? ''
          if (delta) {
            if (!gotFirstToken) gotFirstToken = true
            send({ type: 'text', content: delta })
            hasContent = true
            lastDeltaAt = Date.now()
          }
        })

        const unsubIdle = session.on('session.idle', () => {
          if (settled) return
          settled = true
          if (activityCheckInterval) clearInterval(activityCheckInterval)
          send({ type: 'done' })
          resolve()
        })

        const unsubError = session.on('session.error', (event: any) => {
          const errType = event.data?.errorType ?? 'unknown'
          const errMsg = event.data?.message ?? 'Unknown session error'
          if (settled) return
          if (errType === 'rate_limit') return
          settled = true
          if (activityCheckInterval) clearInterval(activityCheckInterval)
          send({ type: 'error', error: `${errType}: ${errMsg}` })
          resolve()
        })

        const unsubReasoning = session.on('assistant.reasoning_delta', () => {
          lastDeltaAt = Date.now()
        })

        session.__unsubs = [unsubDelta, unsubIdle, unsubError, unsubReasoning]

        const FIRST_TOKEN_TIMEOUT = 120_000
        const STALL_TIMEOUT = 45_000
        const hardDeadline = Date.now() + waitTimeout

        activityCheckInterval = setInterval(() => {
          if (settled) {
            clearInterval(activityCheckInterval!)
            return
          }
          const now = Date.now()
          if (!gotFirstToken) {
            if (now - sendStartedAt >= FIRST_TOKEN_TIMEOUT || now >= hardDeadline) {
              settled = true
              clearInterval(activityCheckInterval!)
              send({ type: 'error', error: 'Timeout waiting for LLM response' })
              resolve()
            }
            return
          }
          const stalledFor = now - lastDeltaAt
          if (stalledFor >= STALL_TIMEOUT || now >= hardDeadline) {
            settled = true
            clearInterval(activityCheckInterval!)
            send(hasContent ? { type: 'done', partial: true } : { type: 'error', error: 'Timeout waiting for LLM response' })
            resolve()
          }
        }, 5_000)

        session.send({ prompt: lastUserMsg?.content ?? '' }).catch((sendErr: any) => {
          if (settled) return
          settled = true
          if (activityCheckInterval) clearInterval(activityCheckInterval)
          send({ type: 'error', error: sendErr?.message ?? 'Send failed' })
          resolve()
        })
      })

      res.end()
    } catch (err: any) {
      if (isSessionStuckError(err) || isAuthError(err)) {
        drainSessionQueue()
        reinitClient().catch(() => {})
      }
      send({ type: 'error', error: err?.message ?? 'Chat failed' })
      res.end()
    } finally {
      try {
        if (session?.__unsubs) for (const unsub of session.__unsubs) unsub?.()
      } catch {}
      try { session?.abort?.() } catch {}
      try {
        await Promise.race([session?.disconnect?.() ?? session?.destroy?.(), new Promise((r) => setTimeout(r, 2_000))])
      } catch {}
      release()
    }
  })

  app.post('/chat/completions', async (req, res) => {
    const { model, messages, temperature, responseFormat, reasoning, timeoutMs, screenshot, tools, toolCallbackUrl } = req.body as {
      model: string
      messages: Array<{ role: string; content: string }>
      system?: string
      temperature?: number
      maxTokens?: number
      responseFormat?: string
      reasoning?: { enabled: boolean; budgetTokens?: number }
      timeoutMs?: number
      screenshot?: string
      tools?: ToolDefinition[]
      toolCallbackUrl?: string
    }

    const maxTokens = (req.body.maxTokens ?? req.body.max_tokens) as number | undefined
    const systemFromBody = req.body.system as string | undefined
    const systemFromMessages = messages?.find?.((m) => m.role === 'system')?.content
    const system = systemFromBody ?? systemFromMessages

    const runId = randomUUID()
    runs.set(runId, { runId, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() })

    res.json({ runId, status: 'queued' })
    executeRun(runId, { model, messages, system, temperature, maxTokens, responseFormat, reasoning, timeoutMs, screenshot, tools, toolCallbackUrl }).catch((err) => {
      const run = runs.get(runId)
      if (run) {
        run.status = 'failed'
        run.error = err?.message ?? 'Unknown error'
        run.updatedAt = Date.now()
      }
    })
  })

  app.get('/run/:runId', (req, res) => {
    const run = runs.get(req.params.runId)
    if (!run) return res.status(404).json({ error: 'Run not found' })
    res.json(run)
  })

  app.post('/v1/chat/completions', async (req, res) => {
    const body = req.body
    const model: string = body.model
    const messages: OAIMessage[] = body.messages ?? []
    const toolDefs = normalizeToolDefs(body.tools)
    const toolChoice: string | undefined = typeof body.tool_choice === 'string' ? body.tool_choice : undefined
    const isStream: boolean = body.stream === true
    const temperature: number | undefined = body.temperature
    const maxTokens: number | undefined = body.max_tokens
    const responseFormat: string | undefined = body.response_format?.type
    const reasoning = body.reasoning as { enabled: boolean; budgetTokens?: number } | undefined
    const timeoutMs: number | undefined = body.timeoutMs ?? body.timeout_ms
    const toolCallbackUrl: string | undefined = body.toolCallbackUrl

    const { system, prompt } = buildFromMessages(messages)

    const completionId = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    const skipTools = toolChoice === 'none' || !toolDefs.length
    const useCallbackMode = !skipTools && !!toolCallbackUrl
    const useClientSideMode = !skipTools && !toolCallbackUrl

    const makeChoice = (content: string | null, finishReason: string, toolCalls?: CapturedToolCall[]) => ({
      index: 0,
      message: {
        role: 'assistant' as const,
        content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    })

    const makeResponse = (choices: ReturnType<typeof makeChoice>[], usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }) => ({
      id: completionId,
      object: 'chat.completion' as const,
      created,
      model,
      choices,
      usage,
    })

    const makeChunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
      id: completionId,
      object: 'chat.completion.chunk' as const,
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })

    try {
      await waitReady(20_000)
    } catch (err: any) {
      const errMsg = err?.message ?? 'Copilot client not ready'
      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()
        res.write(`data: ${JSON.stringify({ error: { message: errMsg, type: 'server_error' } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.status(503).json({ error: { message: errMsg, type: 'server_error' } })
      }
      return
    }

    const captured: CapturedToolCall[] = []
    let captureResolve: (() => void) | null = null
    const capturePromise = new Promise<void>(r => { captureResolve = r })

    let sdkTools: any[] | undefined
    if (useCallbackMode) {
      sdkTools = buildTools(toolDefs, toolCallbackUrl)
    } else if (useClientSideMode) {
      sdkTools = buildCaptureTools(toolDefs, captured, () => captureResolve?.())
    }

    const release = await acquireSession()
    let session: any = null

    try {
      const c = getClient()
      session = await c.createSession({
        model,
        streaming: true,
        onPermissionRequest: getApproveAllFn(),
        infiniteSessions: { enabled: false },
        hooks: {
          onErrorOccurred: async (input: any) => {
            console.warn(`[copilot-cli] /v1/chat/completions session error: ${input.error}`)
            return { errorHandling: 'retry' }
          },
        },
        ...(system ? { systemMessage: { mode: 'replace', content: system } } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(responseFormat === 'json_object' ? { responseFormat: 'json' } : {}),
        ...(reasoning?.enabled ? { reasoning: { budgetTokens: reasoning.budgetTokens ?? 6000 } } : {}),
        ...(sdkTools?.length ? { tools: sdkTools } : {}),
      })

      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.flushHeaders()

        const sendChunk = (chunk: object) => res.write(`data: ${JSON.stringify(chunk)}\n\n`)

        sendChunk(makeChunk({ role: 'assistant' }, null))

        await new Promise<void>((resolve) => {
          let settled = false
          let gotFirstToken = false
          let lastDeltaAt = Date.now()
          const sendStartedAt = Date.now()
          let activityCheckInterval: ReturnType<typeof setInterval> | null = null

          const settle = (finishReason: string) => {
            if (settled) return
            settled = true
            if (activityCheckInterval) clearInterval(activityCheckInterval)
            sendChunk(makeChunk({}, finishReason))
            res.write('data: [DONE]\n\n')
            resolve()
          }

          const unsubDelta = session.on('assistant.message_delta', (event: any) => {
            const delta = event.data?.deltaContent ?? ''
            if (delta) {
              if (!gotFirstToken) gotFirstToken = true
              sendChunk(makeChunk({ content: delta }, null))
              lastDeltaAt = Date.now()
            }
          })

          const unsubIdle = session.on('session.idle', () => {
            settle('stop')
          })

          const unsubError = session.on('session.error', (event: any) => {
            const errType = event.data?.errorType ?? 'unknown'
            const errMsg = event.data?.message ?? 'Unknown session error'
            if (settled || errType === 'rate_limit') return
            settled = true
            if (activityCheckInterval) clearInterval(activityCheckInterval)
            sendChunk({ error: { message: `${errType}: ${errMsg}`, type: errType } })
            res.write('data: [DONE]\n\n')
            resolve()
          })

          const unsubReasoning = session.on('assistant.reasoning_delta', () => {
            lastDeltaAt = Date.now()
          })

          session.__unsubs = [unsubDelta, unsubIdle, unsubError, unsubReasoning]

          if (useClientSideMode) {
            capturePromise.then(() => {
              if (settled) return
              setTimeout(() => {
                if (settled) return
                for (let i = 0; i < captured.length; i++) {
                  const tc = captured[i]
                  sendChunk(makeChunk({
                    tool_calls: [{
                      index: i,
                      id: tc.id,
                      type: 'function',
                      function: { name: tc.function.name, arguments: tc.function.arguments },
                    }],
                  }, null))
                }
                settle('tool_calls')
              }, 150)
            })
          }

          const waitTimeout = timeoutMs ?? 180_000
          const FIRST_TOKEN_TIMEOUT = 120_000
          const STALL_TIMEOUT = 45_000
          const hardDeadline = Date.now() + waitTimeout

          activityCheckInterval = setInterval(() => {
            if (settled) { clearInterval(activityCheckInterval!); return }
            const now = Date.now()
            if (!gotFirstToken) {
              if (now - sendStartedAt >= FIRST_TOKEN_TIMEOUT || now >= hardDeadline) settle('stop')
              return
            }
            if (now - lastDeltaAt >= STALL_TIMEOUT || now >= hardDeadline) settle('stop')
          }, 5_000)

          session.send({ prompt }).catch((sendErr: any) => {
            if (settled) return
            settled = true
            if (activityCheckInterval) clearInterval(activityCheckInterval)
            sendChunk({ error: { message: sendErr?.message ?? 'Send failed', type: 'server_error' } })
            res.write('data: [DONE]\n\n')
            resolve()
          })
        })

        res.end()
      } else {
        const waitTimeout = timeoutMs ?? 300_000
        let fullContent = ''

        const { content, toolCalls, errorMessage } = await new Promise<{
          content: string
          toolCalls: CapturedToolCall[]
          errorMessage?: string
        }>((resolve) => {
          let settled = false
          let gotFirstToken = false
          let lastDeltaAt = Date.now()
          const sendStartedAt = Date.now()
          let activityCheckInterval: ReturnType<typeof setInterval> | null = null

          const unsubDelta = session.on('assistant.message_delta', (event: any) => {
            const delta = event.data?.deltaContent ?? ''
            if (!gotFirstToken && delta) gotFirstToken = true
            fullContent += delta
            lastDeltaAt = Date.now()
          })

          const unsubIdle = session.on('session.idle', () => {
            if (settled) return
            settled = true
            if (activityCheckInterval) clearInterval(activityCheckInterval)
            resolve({ content: fullContent, toolCalls: [] })
          })

          const unsubMsg = session.on('assistant.message', (event: any) => {
            const finalContent = event.data?.content
            if (finalContent && finalContent.length > fullContent.length) fullContent = finalContent
          })

          const unsubError = session.on('session.error', (event: any) => {
            const errType = event.data?.errorType ?? 'unknown'
            const errMsg = event.data?.message ?? 'Unknown session error'
            if (settled || errType === 'rate_limit') return
            settled = true
            if (activityCheckInterval) clearInterval(activityCheckInterval)
            resolve({ content: fullContent, toolCalls: [], errorMessage: `${errType}: ${errMsg}` })
          })

          const unsubReasoning = session.on('assistant.reasoning_delta', () => {
            lastDeltaAt = Date.now()
          })

          session.__unsubs = [unsubDelta, unsubIdle, unsubMsg, unsubError, unsubReasoning]

          if (useClientSideMode) {
            capturePromise.then(() => {
              setTimeout(() => {
                if (settled) return
                settled = true
                if (activityCheckInterval) clearInterval(activityCheckInterval)
                resolve({ content: fullContent, toolCalls: [...captured] })
              }, 150)
            })
          }

          const FIRST_TOKEN_TIMEOUT = 120_000
          const STALL_TIMEOUT = 45_000
          const hardDeadline = Date.now() + waitTimeout

          activityCheckInterval = setInterval(() => {
            if (settled) { clearInterval(activityCheckInterval!); return }
            const now = Date.now()
            if (!gotFirstToken) {
              if (now - sendStartedAt >= FIRST_TOKEN_TIMEOUT || now >= hardDeadline) {
                settled = true
                clearInterval(activityCheckInterval!)
                resolve({ content: '', toolCalls: [], errorMessage: 'Timeout waiting for response' })
              }
              return
            }
            if (now - lastDeltaAt >= STALL_TIMEOUT || now >= hardDeadline) {
              settled = true
              clearInterval(activityCheckInterval!)
              resolve({ content: fullContent, toolCalls: [] })
            }
          }, 5_000)

          session.send({ prompt }).catch((sendErr: any) => {
            if (settled) return
            settled = true
            if (activityCheckInterval) clearInterval(activityCheckInterval)
            resolve({ content: fullContent, toolCalls: [], errorMessage: sendErr?.message })
          })
        })

        if (errorMessage && content.length === 0) {
          res.status(500).json({ error: { message: errorMessage, type: 'server_error' } })
        } else if (toolCalls.length > 0) {
          res.json(makeResponse([makeChoice(content || null, 'tool_calls', toolCalls)]))
        } else {
          res.json(makeResponse([makeChoice(content, 'stop')]))
        }
      }
    } catch (err: any) {
      if (isSessionStuckError(err) || isAuthError(err)) {
        drainSessionQueue()
        reinitClient().catch(() => {})
      }
      if (isStream) {
        try {
          res.write(`data: ${JSON.stringify({ error: { message: err?.message ?? 'Chat failed', type: 'server_error' } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        } catch {}
      } else {
        res.status(500).json({ error: { message: err?.message ?? 'Chat failed', type: 'server_error' } })
      }
    } finally {
      try {
        if (session?.__unsubs) for (const unsub of session.__unsubs) unsub?.()
      } catch {}
      try { session?.abort?.() } catch {}
      try {
        await Promise.race([session?.disconnect?.() ?? session?.destroy?.(), new Promise((r) => setTimeout(r, 2_000))])
      } catch {}
      release()
    }
  })

  return app
}



async function executeRun(
  runId: string,
  params: {
    model: string
    messages: Array<{ role: string; content: string }>
    system?: string
    temperature?: number
    maxTokens?: number
    responseFormat?: string
    reasoning?: { enabled: boolean; budgetTokens?: number }
    timeoutMs?: number
    screenshot?: string
    tools?: ToolDefinition[]
    toolCallbackUrl?: string
  },
): Promise<void> {
  const { model, messages, system, temperature, maxTokens, responseFormat, reasoning, timeoutMs, screenshot, tools, toolCallbackUrl } = params

  let screenshotTmpFile: string | null = null
  if (screenshot) {
    try {
      const m = screenshot.match(/^data:(image\/\w+);base64,(.+)$/)
      if (m) {
        const ext = m[1].split('/')[1] ?? 'png'
        const buffer = Buffer.from(m[2], 'base64')
        const os = await import('os')
        const path = await import('path')
        const fs = await import('fs/promises')
        screenshotTmpFile = path.join(os.tmpdir(), `copilot_cli_${runId}.${ext}`)
        await fs.writeFile(screenshotTmpFile, buffer)
      }
    } catch (err: any) {
      console.warn(`[copilot-cli] run ${runId} screenshot write failed:`, err?.message)
    }
  }

  const run = runs.get(runId)!
  run.status = 'running'
  run.updatedAt = Date.now()

  try {
    await waitReady(20_000)
  } catch (err: any) {
    run.status = 'failed'
    run.error = err?.message ?? 'Copilot client not ready'
    run.updatedAt = Date.now()
    return
  }

  const release = await acquireSession()
  let session: any = null
  let fullContent = ''

  const heartbeatInterval = setInterval(() => {
    run.updatedAt = Date.now()
  }, 10_000)

  try {
    const c = getClient()
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')

    session = await c.createSession({
      model,
      streaming: true,
      onPermissionRequest: getApproveAllFn(),
      infiniteSessions: { enabled: false },
      hooks: {
        onErrorOccurred: async (input: any) => {
          console.warn(`[copilot-cli] run ${runId} session error: ${input.error}`)
          return { errorHandling: 'retry' }
        },
      },
      ...(system ? { systemMessage: { mode: 'replace', content: system } } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
      ...(responseFormat === 'json_object' ? { responseFormat: 'json' } : {}),
      ...(reasoning?.enabled ? { reasoning: { budgetTokens: reasoning.budgetTokens ?? 6000 } } : {}),
      ...(tools?.length ? { tools: buildTools(tools, toolCallbackUrl) } : {}),
    })

    const waitTimeout = timeoutMs ?? 300_000

    const { content: responseContent, partial, timedOut, errorMessage } = await new Promise<{
      content: string; partial: boolean; timedOut: boolean; errorMessage?: string
    }>((resolve) => {
      let settled = false
      let gotFirstToken = false
      let lastDeltaAt = Date.now()
      const sendStartedAt = Date.now()
      let activityCheckInterval: ReturnType<typeof setInterval> | null = null

      const unsubDelta = session.on('assistant.message_delta', (event: any) => {
        const delta = event.data?.deltaContent ?? ''
        if (!gotFirstToken && delta) gotFirstToken = true
        fullContent += delta
        lastDeltaAt = Date.now()
      })

      const unsubIdle = session.on('session.idle', () => {
        if (settled) return
        settled = true
        if (activityCheckInterval) clearInterval(activityCheckInterval)
        resolve({ content: fullContent, partial: false, timedOut: false })
      })

      const unsubMsg = session.on('assistant.message', (event: any) => {
        const finalContent = event.data?.content
        if (finalContent && finalContent.length > fullContent.length) fullContent = finalContent
      })

      const unsubError = session.on('session.error', (event: any) => {
        const errType = event.data?.errorType ?? 'unknown'
        const errMsg = event.data?.message ?? 'Unknown session error'
        if (settled) return
        if (errType === 'rate_limit') return
        settled = true
        if (activityCheckInterval) clearInterval(activityCheckInterval)
        resolve({ content: fullContent, partial: fullContent.length > 0, timedOut: false, errorMessage: `${errType}: ${errMsg}` })
      })

      const unsubReasoning = session.on('assistant.reasoning_delta', () => {
        lastDeltaAt = Date.now()
      })

      session.__unsubs = [unsubDelta, unsubIdle, unsubMsg, unsubError, unsubReasoning]

      const FIRST_TOKEN_TIMEOUT = 120_000
      const STALL_TIMEOUT = 45_000
      const hardDeadline = Date.now() + waitTimeout

      activityCheckInterval = setInterval(() => {
        if (settled) {
          clearInterval(activityCheckInterval!)
          return
        }
        const now = Date.now()
        if (!gotFirstToken) {
          if (now - sendStartedAt >= FIRST_TOKEN_TIMEOUT || now >= hardDeadline) {
            settled = true
            clearInterval(activityCheckInterval!)
            resolve({ content: '', partial: false, timedOut: true })
          }
          return
        }
        const stalledFor = now - lastDeltaAt
        if (stalledFor >= STALL_TIMEOUT || now >= hardDeadline) {
          settled = true
          clearInterval(activityCheckInterval!)
          resolve(
            fullContent.trim().length > 0
              ? { content: fullContent, partial: true, timedOut: true }
              : { content: '', partial: false, timedOut: true },
          )
        }
      }, 5_000)

      const promptText = lastUserMsg?.content ?? ''
      const sendPayload: { prompt: string; attachments?: Array<{ type: string; path: string; displayName: string }> } = { prompt: promptText }
      if (screenshotTmpFile) {
        sendPayload.attachments = [{ type: 'file', path: screenshotTmpFile, displayName: 'screenshot' }]
      }

      session.send(sendPayload).catch((sendErr: any) => {
        if (settled) return
        settled = true
        if (activityCheckInterval) clearInterval(activityCheckInterval)
        resolve({ content: fullContent, partial: fullContent.length > 0, timedOut: false, errorMessage: sendErr?.message })
      })
    })

    clearInterval(heartbeatInterval)

    if (errorMessage && responseContent.length === 0) {
      run.status = 'failed'
      run.error = errorMessage
      run.updatedAt = Date.now()

      if (errorMessage.toLowerCase().includes('auth')) {
        drainSessionQueue()
        reinitClient().catch(() => {})
      }
    } else if (timedOut && responseContent.length === 0) {
      console.warn(`[copilot-cli] run ${runId} retrying with sendAndWait…`)
      try {
        const lastUserMsg2 = [...messages].reverse().find((m) => m.role === 'user')
        const retryPayload: { prompt: string; attachments?: Array<{ type: string; path: string; displayName: string }> } = {
          prompt: lastUserMsg2?.content ?? '',
        }
        if (screenshotTmpFile) {
          retryPayload.attachments = [{ type: 'file', path: screenshotTmpFile, displayName: 'screenshot' }]
        }
        const retryResult = await session.sendAndWait(retryPayload, 120_000)
        const retryContent = retryResult?.data?.content ?? ''
        if (retryContent.length > 0) {
          run.status = 'completed'
          run.result = { content: retryContent, model, partial: false, usage: { promptTokens: 0, completionTokens: 0 } }
        } else {
          throw new Error('sendAndWait returned empty')
        }
      } catch {
        run.status = 'failed'
        run.error = 'Timeout — no content received after retry'
        drainSessionQueue()
        reinitClient().catch(() => {})
      }
    } else {
      run.status = 'completed'
      run.result = { content: responseContent, model, partial, usage: { promptTokens: 0, completionTokens: 0 } }
    }
    run.updatedAt = Date.now()
  } catch (err: any) {
    clearInterval(heartbeatInterval)
    if (isSessionStuckError(err) || isAuthError(err)) {
      drainSessionQueue()
      reinitClient().catch(() => {})
    }
    if (fullContent.trim().length > 0) {
      run.status = 'completed'
      run.result = { content: fullContent, model: params.model, partial: true, usage: { promptTokens: 0, completionTokens: 0 } }
    } else {
      run.status = 'failed'
      run.error = err?.message ?? 'Chat failed'
    }
    run.updatedAt = Date.now()
  } finally {
    clearInterval(heartbeatInterval)
    try {
      if (session?.__unsubs) for (const unsub of session.__unsubs) unsub?.()
    } catch {}
    try { session?.abort?.() } catch {}
    try {
      await Promise.race([session?.disconnect?.() ?? session?.destroy?.(), new Promise((r) => setTimeout(r, 2_000))])
    } catch {}
    if (screenshotTmpFile) {
      import('fs/promises').then((fs) => fs.unlink(screenshotTmpFile!)).catch(() => {})
    }
    release()
  }
}
