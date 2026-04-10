/**
 * server.ts — Standalone GitHub Copilot REST API server.
 *
 * Exposes GitHub Copilot as a local HTTP API at http://localhost:18966
 * (port chosen to avoid conflicts with common dev servers).
 *
 * Endpoints:
 *   GET  /status          — Health check + auth status
 *   GET  /models          — List available models
 *   POST /chat/completions — Chat completion (non-streaming, poll-based)
 *   POST /chat/stream      — Chat completion (SSE streaming)
 *   GET  /run/:runId       — Poll for run result
 *
 * The API is designed to be called directly from the browser — no proxy needed.
 * CORS is wide open (localhost only) since this is a local-only server.
 */

import express from 'express'
import cors from 'cors'
import { randomUUID } from 'crypto'
import {
  init,
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

// In-memory run store (lightweight version of copilot-server/runStore)

interface Run {
  runId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  result?: { content: string; model: string; partial: boolean; usage: { promptTokens: number; completionTokens: number } }
  error?: string
  createdAt: number
  updatedAt: number
}

const runs = new Map<string, Run>()

// Prune completed runs older than 10 minutes
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

  // GET /status
  app.get('/status', (_req, res) => {
    if (isReady()) {
      res.json({ status: 'ok', authenticated: true })
    } else {
      res.json({ status: 'not_ready', authenticated: false, error: getInitError() ?? 'Starting…' })
    }
  })

  // GET /models
  app.get('/models', async (_req, res) => {
    try {
      const models = await listModels()
      res.json({ models })
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to list models' })
    }
  })

  // POST /chat/stream — SSE streaming 
  app.post('/chat/stream', async (req, res) => {
    const { model, messages, system, temperature, maxTokens, responseFormat, reasoning, timeoutMs } = req.body as {
      model: string
      messages: Array<{ role: string; content: string }>
      system?: string
      temperature?: number
      maxTokens?: number
      responseFormat?: string
      reasoning?: { enabled: boolean; budgetTokens?: number }
      timeoutMs?: number
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

  // POST /chat/completions — poll-based (returns runId)
  app.post('/chat/completions', async (req, res) => {
    const { model, messages, system, temperature, maxTokens, responseFormat, reasoning, timeoutMs, screenshot } = req.body as {
      model: string
      messages: Array<{ role: string; content: string }>
      system?: string
      temperature?: number
      maxTokens?: number
      responseFormat?: string
      reasoning?: { enabled: boolean; budgetTokens?: number }
      timeoutMs?: number
      screenshot?: string
    }

    const runId = randomUUID()
    runs.set(runId, { runId, status: 'queued', createdAt: Date.now(), updatedAt: Date.now() })

    res.json({ runId, status: 'queued' })

    // Fire-and-forget background execution
    executeRun(runId, { model, messages, system, temperature, maxTokens, responseFormat, reasoning, timeoutMs, screenshot }).catch((err) => {
      const run = runs.get(runId)
      if (run) {
        run.status = 'failed'
        run.error = err?.message ?? 'Unknown error'
        run.updatedAt = Date.now()
      }
    })
  })

  // GET /run/:runId — poll for result 
  app.get('/run/:runId', (req, res) => {
    const run = runs.get(req.params.runId)
    if (!run) return res.status(404).json({ error: 'Run not found' })
    res.json(run)
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
  },
): Promise<void> {
  const { model, messages, system, temperature, maxTokens, responseFormat, reasoning, timeoutMs, screenshot } = params

  // Convert screenshot to temp file for SDK attachments
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

  // Heartbeat — keep run's updatedAt alive
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

      // Build send payload
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
      // Retry with sendAndWait
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
    // Clean up temp file
    if (screenshotTmpFile) {
      import('fs/promises').then((fs) => fs.unlink(screenshotTmpFile!)).catch(() => {})
    }
    release()
  }
}
