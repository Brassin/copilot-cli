/**
 * sessionManager.ts — Manages the persistent CopilotClient lifecycle.
 *
 * Extracted from copilot-server/server.ts. Handles:
 *   - Single CopilotClient instance (reused for all requests)
 *   - Session mutex (only one active session at a time)
 *   - Auth-error recovery (reinit on authentication failures)
 *   - Stuck-session recovery (drain queue + reinit)
 */

let client: any = null
let modelsCache: any[] | null = null
let ready = false
let initError: string | null = null
let approveAllFn: any = null
let reinitInProgress = false

// Mutex: only one Copilot session may be active at a time.
let sessionQueue: Promise<void> = Promise.resolve()

/** Waits until no other session is active, then returns a `release` callback. */
export function acquireSession(): Promise<() => void> {
  let release!: () => void
  const acquired = new Promise<() => void>((outer) => {
    sessionQueue = sessionQueue.then(
      () =>
        new Promise<void>((inner) => {
          release = inner
          outer(release)
        }),
    )
  })
  return acquired
}

/** Immediately drains the session queue so queued requests don't wait forever. */
export function drainSessionQueue(): void {
  sessionQueue = Promise.resolve()
}

export function getClient() {
  if (client && ready) return client
  throw new Error(initError ?? 'Copilot client not ready yet — try again in a moment')
}

export function getApproveAllFn() {
  return approveAllFn
}

export function isReady(): boolean {
  return ready
}

export function getInitError(): string | null {
  return initError
}

/** Polls until client is ready or times out. */
export async function waitReady(timeoutMs = 20_000): Promise<void> {
  if (ready) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(initError ?? 'Copilot client did not become ready in time')
}

/** Detects auth errors that require client reinit. */
export function isAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes('authentication info') ||
    msg.includes('custom provider') ||
    msg.includes('not created with auth') ||
    msg.includes('unauthenticated')
  )
}

/** Detects stuck/dangling session errors. */
export function isSessionStuckError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    (msg.includes('timeout') && msg.includes('session')) ||
    msg.includes('waiting for session.idle') ||
    msg.includes('session is not idle')
  )
}

/** Tears down the current client and starts a fresh one. */
export async function reinitClient(): Promise<void> {
  if (reinitInProgress) {
    await waitReady(30_000)
    return
  }
  reinitInProgress = true
  console.warn('[copilot-cli] reinitialising CopilotClient…')
  ready = false
  drainSessionQueue()
  try {
    await Promise.race([client?.stop?.(), new Promise((r) => setTimeout(r, 3_000))])
  } catch {
    try {
      await client?.forceStop?.()
    } catch {
      /* ignore */
    }
  }
  client = null
  modelsCache = null
  try {
    await init()
  } finally {
    reinitInProgress = false
  }
}

/** Initialise the CopilotClient. Called once at startup and on re-init. */
export async function init() {
  try {
    console.log('[copilot-cli] starting CopilotClient…')
    const sdk = await import('@github/copilot-sdk')
    approveAllFn = sdk.approveAll
    client = new sdk.CopilotClient({ autoStart: true })
    await client.start()
    ready = true
    initError = null
    console.log('[copilot-cli] CopilotClient ready ✓')
  } catch (e: any) {
    initError = e?.message ?? 'Failed to start CopilotClient'
    console.error('[copilot-cli] init error:', initError)
  }
}

/** Return cached models list, or fetch from SDK and cache. */
export async function listModels(): Promise<any[]> {
  const c = getClient()
  if (!modelsCache) {
    const modelList = await c.listModels()
    modelsCache = modelList
      .filter((m: any) => !m.policy || m.policy.state === 'enabled')
      .map((m: any) => ({
        id: m.id,
        name: m.name ?? m.id,
        supportsReasoning: /^o\d|reasoning|claude-3-[57]/i.test(m.id),
        contextWindow: m.capabilities?.limits?.max_context_window_tokens ?? 128_000,
        provider: 'github-copilot',
      }))
  }
  return modelsCache!
}

/** Clear model cache (e.g. after reinit). */
export function clearModelsCache() {
  modelsCache = null
}
