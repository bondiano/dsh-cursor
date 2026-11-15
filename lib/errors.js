/**
 * Shared provider errors, bounded operations, and usage summarization.
 *
 * The transport never lets a raw SDK error reach the model or the browser:
 * SDK messages can contain credential-bearing URLs, so callers map errors to a
 * small provider-neutral vocabulary first.
 *
 * @module dsh-cursor/lib/errors
 */

/** A failure whose code is safe to show in a chat failure or the Settings page. */
export class ProviderError extends Error {
  /**
   * @param {string} code stable short code.
   * @param {string} message safe human-readable message.
   * @param {{cause?:unknown}} [options] optional cause for local logs only.
   */
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'ProviderError'
    this.code = code
  }
}

/** Safe failure object for a terminal `finish` chunk. */
export function failureOf(error, fallbackCode = 'CURSOR_SDK_ERROR') {
  if (error instanceof ProviderError) return { code: error.code, message: error.message }
  return { code: fallbackCode, message: 'Cursor request failed; no credential details were logged' }
}

/**
 * Bound one promise by a timeout and an abort signal.
 *
 * The optional `lateCleanup` runs for a value that arrives after the race was
 * lost, so a timed-out `Agent.create` cannot leak an agent or a temporary
 * directory.
 *
 * @template T
 * @param {() => Promise<T>} operation lazy operation.
 * @param {{signal?:AbortSignal, timeoutMs?:number, lateCleanup?:(value:T)=>Promise<void>|void}} [options] bounds.
 * @returns {Promise<T>} the operation result.
 */
export async function bounded(operation, { signal, timeoutMs = 30_000, lateCleanup } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new ProviderError('CONFIG', 'timeoutMs must be a positive finite number')
  }
  if (signal?.aborted) throw new ProviderError('ABORTED', 'Request cancelled')

  let abandoned = false
  const task = Promise.resolve().then(operation)
  let timer
  let listener
  const stop = new Promise((_, reject) => {
    const end = code => {
      abandoned = true
      reject(new ProviderError(code, code === 'ABORTED' ? 'Request cancelled' : 'Operation timed out'))
    }
    timer = setTimeout(() => end('TIMEOUT'), timeoutMs)
    timer.unref?.()
    listener = () => end('ABORTED')
    signal?.addEventListener('abort', listener, { once: true })
  })
  task.then(
    value => {
      if (!abandoned || lateCleanup === undefined) return
      Promise.resolve()
        .then(() => lateCleanup(value))
        .catch(() => {})
    },
    () => {},
  )
  try {
    return await Promise.race([task, stop])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', listener)
  }
}

/**
 * Sum observed token counts and keep the largest single-turn input.
 *
 * Billing totals and the largest context observation are deliberately distinct:
 * a sum is not a context-window measurement.
 *
 * @param {Array<{inputTokens?:number,outputTokens?:number,cacheReadTokens?:number,cacheWriteTokens?:number,singleTurn?:boolean}>} turns usage events.
 * @returns {{billing:{inputTokens:number,outputTokens:number,cacheReadTokens:number,cacheWriteTokens:number}, contextInputTokens?:number}} summary.
 */
export function summarizeUsage(turns) {
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
  const billing = Object.fromEntries(fields.map(key => [key, 0]))
  let contextInputTokens
  for (const turn of turns) {
    for (const key of fields) {
      const value = turn?.[key]
      if (value === undefined) continue
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new ProviderError('USAGE', 'Invalid usage count')
      }
      billing[key] += value
      if (!Number.isSafeInteger(billing[key])) throw new ProviderError('USAGE', 'Usage exceeds safe integer range')
    }
    if (turn?.singleTurn === true && turn.inputTokens !== undefined) {
      contextInputTokens = Math.max(contextInputTokens ?? 0, turn.inputTokens)
    }
  }
  return { billing, ...(contextInputTokens === undefined ? {} : { contextInputTokens }) }
}

/**
 * Map an unknown SDK/network error to a safe provider error.
 * @param {unknown} error original error.
 * @param {AbortSignal|undefined} signal request signal.
 * @param {boolean} timedOut whether our own timeout fired.
 * @returns {ProviderError} safe error.
 */
export function mapSdkError(error, signal, timedOut = false) {
  if (error instanceof ProviderError) return error
  if (timedOut) return new ProviderError('TIMEOUT', 'Cursor call timed out')
  if (signal?.aborted) return new ProviderError('ABORTED', 'Request cancelled')
  const status = typeof error?.status === 'number' ? error.status : undefined
  if (status === 401) return new ProviderError('AUTH', 'Cursor authentication was rejected; sign in again')
  if (status === 403) return new ProviderError('AUTH', 'Cursor account permission was rejected')
  if (status === 429) return new ProviderError('RATE_LIMIT', 'Cursor rate limit reached')
  if (status !== undefined && status >= 500) return new ProviderError(`HTTP_${status}`, 'Cursor service is temporarily unavailable')
  const code = typeof error?.code === 'string' ? error.code : ''
  if (/auth|unauthenticated|credential/i.test(code)) return new ProviderError('AUTH', 'Cursor authentication failed')
  if (/rate|limit/i.test(code)) return new ProviderError('RATE_LIMIT', 'Cursor rate limit reached')
  if (/network|timeout|fetch/i.test(code)) return new ProviderError('NETWORK', 'Cursor service is unreachable')
  return new ProviderError('CURSOR_SDK_ERROR', 'Cursor request failed; no credential details were logged')
}
