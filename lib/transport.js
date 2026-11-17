/**
 * Cursor SDK transport: one bounded agent per conversation, a background event
 * producer, and single-use tool continuations.
 *
 * The transport deliberately owns no DSH presentation. It normalizes SDK
 * events into a small internal stream; the adapter turns that stream into DSH
 * chunks. A run that ends in an uncertain state is disposed rather than
 * resumed, so a lost or failed call is never silently replayed.
 *
 * @module dsh-cursor/lib/transport
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeBridge } from './bridge.js'
import { bounded, mapSdkError, ProviderError, summarizeUsage } from './errors.js'
import { bridgeIdentity, buildSuffixPrompt, historyIdentity } from './prompt.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * One live or idle Cursor conversation.
 */
export class CursorTransport {
  #loadSdk
  #catalog
  #logger
  #timeoutMs
  #idleTimeoutMs
  #maxIdle
  #closed = false
  #active = new Set()
  #idle = new Map()
  #continuations = new Map()

  /**
   * @param {{loadSdk:()=>Promise<object>, catalog:object, logger?:object, requestTimeoutMs?:number, idleTimeoutMs?:number, maxIdle?:number}} options transport options.
   */
  constructor({
    loadSdk,
    catalog,
    logger,
    requestTimeoutMs = 1_800_000,
    idleTimeoutMs = 1_800_000,
    maxIdle = 8,
  }) {
    if (typeof loadSdk !== 'function') throw new TypeError('loadSdk is required')
    if (catalog === undefined) throw new TypeError('catalog is required')
    this.#loadSdk = loadSdk
    this.#catalog = catalog
    this.#logger = logger
    this.#timeoutMs = requestTimeoutMs
    this.#idleTimeoutMs = idleTimeoutMs
    this.#maxIdle = maxIdle
  }

  /** @returns {boolean} whether the transport is closed. */
  get closed() {
    return this.#closed
  }

  /**
   * Read the SDK catalog through the shared cache.
   * @param {string} apiKey key.
   * @param {{signal?:AbortSignal, refresh?:boolean}} [options] read options.
   * @returns {Promise<object[]>} normalized catalog.
   */
  catalog(apiKey, options = {}) {
    return this.#catalog.get(apiKey, options)
  }

  /**
   * Stream one model call as transport events.
   *
   * Events: `text`, `reasoning`, `tool-call`, `usage`, `diagnostic`,
   * `continuation`, `failure`, `done`.
   *
   * @param {{apiKey:string, apiKeyHash:string, model:object, prompt?:string|object, messages:readonly object[], tools?:readonly object[], validate?:Function, continuation?:string, sessionId?:string, purpose?:string, system?:string, toolHistory?:object, signal?:AbortSignal}} request request.
   * @returns {AsyncGenerator<object, void, void>} events.
   */
  async *stream(request) {
    if (this.#closed) throw new ProviderError('DISPOSED', 'Cursor transport is closed')
    if (typeof request.apiKey !== 'string' || request.apiKey.length === 0) {
      throw new ProviderError('MISSING_CREDENTIAL', 'An explicit Cursor credential is required')
    }
    if (request.signal?.aborted) throw new ProviderError('ABORTED', 'Request cancelled')
    const tools = Array.isArray(request.tools) ? request.tools : []
    const identity = bridgeIdentity({
      apiKeyHash: request.apiKeyHash,
      model: request.model,
      tools,
      sessionId: request.sessionId,
      system: request.system,
      purpose: request.purpose,
      toolHistory: request.toolHistory,
    })

    let state
    let resumed = false
    if (request.continuation !== undefined) {
      state = this.#continuations.get(request.continuation)
      if (state === undefined || state.identity !== identity || state.busy || state.disposed) {
        this.#continuations.delete(request.continuation)
        // The caller replays as a fresh agent; this native run can never be
        // resumed, and leaving it alive would keep a paid run and its temp
        // directory until the request timeout.
        if (state !== undefined && state.busy !== true && state.disposed !== true) void state.dispose()
        throw new ProviderError('CONTINUATION_UNAVAILABLE', 'Native tool continuation expired or no longer matches this request')
      }
      const history = request.messages
      if (history.length < state.prefixLength || historyIdentity(history.slice(0, state.prefixLength)) !== state.prefix) {
        this.#continuations.delete(request.continuation)
        void state.dispose()
        throw new ProviderError('CONTINUATION_UNAVAILABLE', 'Native continuation history was rewritten')
      }
      // Validate before consuming the token so a mismatch leaves no half-resumed run.
      try {
        state.bridge.results(history, state.delivered)
      } catch (error) {
        this.#continuations.delete(request.continuation)
        throw error
      }
      this.#continuations.delete(request.continuation)
      state.token = undefined
      state.bridge.resume(history, state.delivered)
      state.delivered = []
      resumed = true
    } else {
      const cached = request.sessionId !== undefined && request.purpose === undefined ? this.#idle.get(request.sessionId) : undefined
      if (cached !== undefined) {
        this.#idle.delete(request.sessionId)
        clearTimeout(cached.idleTimer)
        cached.idleTimer = undefined
        const suffix = request.messages.slice(cached.committedLength)
        const reusable =
          cached.disposed !== true &&
          cached.identity === identity &&
          cached.committed !== undefined &&
          request.messages.length >= cached.committedLength &&
          historyIdentity(request.messages.slice(0, cached.committedLength)) === cached.committed &&
          suffix.length > 0 &&
          suffix.every(message => message.role === 'user') &&
          !JSON.stringify(suffix).includes('"type":"image"')
        if (reusable) {
          state = cached
          state.queue = []
          state.wake = undefined
          state.success = undefined
          state.timedOut = false
          state.usageReported = false
          state.eventCounts = {}
          state.delivered = []
          state.token = undefined
          state.prefixLength = 0
          state.prefix = undefined
          state.controller = new AbortController()
          state.bridge = new NativeBridge({
            tools,
            validate: request.validate,
            notify: event => state.push(event),
          })
          state.prompt = buildSuffixPrompt(suffix)
          state.timer = this.#armTimer(state)
          state.done = this.#produce(state, { ...request, prompt: state.prompt })
          this.#active.add(state)
        } else {
          await cached.dispose()
        }
      }
      if (state === undefined) state = this.#start(request, tools, identity)
    }

    if (resumed) {
      // The producer kept running while the tools executed; resume the consumer.
      state.busy = true
    }
    state.busy = true
    const abort = () => state.controller.abort()
    request.signal?.addEventListener('abort', abort, { once: true })
    let handedOff = false
    let cached = false
    const content = []
    const append = event => {
      if (event.type === 'tool-call') {
        content.push({ type: 'tool-call', id: event.id, name: event.name, arguments: event.arguments })
        return
      }
      const type = event.type === 'reasoning' ? 'reasoning' : 'text'
      const last = content.at(-1)
      if (last?.type === type) last.text += event.text
      else content.push({ type, text: event.text })
    }
    try {
      for (;;) {
        const event = await state.next()
        if (event.type === 'failure') throw event.error
        if (event.type === 'done') break
        if (event.type === 'text' || event.type === 'reasoning') {
          if (event.text) append(event)
          yield event
          continue
        }
        if (event.type === 'usage' || event.type === 'diagnostic') {
          yield event
          continue
        }
        if (event.type === 'tool-call') {
          append(event)
          yield event
          state.delivered = [event.id]
          while (state.queue[0]?.type === 'tool-call') {
            const queued = state.queue.shift()
            append(queued)
            state.delivered.push(queued.id)
            yield queued
          }
          const token = randomUUID()
          state.prefixLength = request.messages.length
          state.prefix = historyIdentity(request.messages)
          state.token = token
          this.#continuations.set(token, state)
          handedOff = true
          request.signal?.removeEventListener('abort', abort)
          yield { type: 'continuation', token }
          break
        }
      }
      if (!handedOff) {
        if (state.success !== true) {
          throw new ProviderError('CURSOR_SDK_ERROR', 'Cursor run did not finish successfully')
        }
        await state.done
        if (
          !this.#closed &&
          request.sessionId !== undefined &&
          request.purpose === undefined &&
          content.length > 0 &&
          !state.controller.signal.aborted
        ) {
          this.#remember(state, { messages: request.messages, content, identity, sessionId: request.sessionId })
          cached = true
        }
      }
    } finally {
      state.busy = false
      request.signal?.removeEventListener('abort', abort)
      if (!handedOff) {
        await state.done
        if (state.success !== true || !cached) await state.dispose()
      }
    }
  }

  #armTimer(state) {
    const timer = setTimeout(() => {
      state.timedOut = true
      state.controller.abort()
    }, this.#timeoutMs)
    timer.unref?.()
    return timer
  }

  #start(request, tools, identity) {
    const controller = new AbortController()
    const state = {
      controller,
      queue: [],
      wake: undefined,
      busy: false,
      identity,
      bridge: undefined,
      agent: undefined,
      directory: undefined,
      run: undefined,
      done: undefined,
      timer: undefined,
      idleTimer: undefined,
      token: undefined,
      delivered: [],
      success: undefined,
      timedOut: false,
      disposed: false,
      disposePromise: undefined,
      usageReported: false,
      eventCounts: {},
      committedLength: 0,
      committed: undefined,
      prefixLength: 0,
      prefix: undefined,
    }
    state.push = event => {
      state.queue.push(event)
      const wake = state.wake
      if (wake === undefined) return
      state.wake = undefined
      wake(state.queue.shift())
    }
    state.next = () =>
      new Promise(resolve => {
        if (state.queue.length > 0) resolve(state.queue.shift())
        else state.wake = resolve
      })
    state.bridge = new NativeBridge({
      tools,
      validate: request.validate,
      notify: event => state.push(event),
    })
    state.timer = this.#armTimer(state)
    state.dispose = () => this.#dispose(state)
    this.#active.add(state)
    state.done = this.#produce(state, request)
    return state
  }

  async #produce(state, request) {
    let run
    try {
      if (state.agent === undefined) {
        const directory = await mkdtemp(join(tmpdir(), 'dsh-cursor-'))
        state.directory = directory
        const sdk = await this.#loadSdk()
        if (sdk?.Agent?.create === undefined) throw new ProviderError('SDK_UNAVAILABLE', 'Cursor SDK is unavailable')
        const agent = await bounded(
          () =>
            sdk.Agent.create({
              apiKey: request.apiKey,
              model: request.model,
              tools: state.bridge.tools.length > 0 ? ['mcp'] : [],
              mcpServers: {},
              local: {
                cwd: directory,
                settingSources: [],
                customTools: state.bridge.customTools,
                enableAgentRetries: false,
              },
            }),
          {
            signal: state.controller.signal,
            timeoutMs: this.#timeoutMs,
            lateCleanup: async late => {
              try {
                await late[Symbol.asyncDispose]?.()
              } catch {
                /* best effort */
              }
            },
          },
        )
        if (state.controller.signal.aborted) {
          await agent[Symbol.asyncDispose]?.().catch(() => {})
          throw new ProviderError('ABORTED', 'Request cancelled')
        }
        state.agent = agent
      }
      run = await bounded(() => state.agent.send(request.prompt), {
        signal: state.controller.signal,
        timeoutMs: this.#timeoutMs,
        lateCleanup: async late => {
          try {
            if (late?.supports?.('cancel') && late.status === 'running') await late.cancel()
          } catch {
            /* best effort */
          }
        },
      })
      state.run = run
      const iterator = run.stream()[Symbol.asyncIterator]()
      for (;;) {
        const next = await bounded(() => iterator.next(), {
          signal: state.controller.signal,
          timeoutMs: this.#timeoutMs,
        })
        if (next.done) break
        this.#handleEvent(state, next.value)
      }
      const result = await bounded(() => run.wait(), {
        signal: state.controller.signal,
        timeoutMs: this.#timeoutMs,
      })
      state.push({
        type: 'diagnostic',
        summary: {
          status: ['finished', 'cancelled', 'error'].includes(result?.status) ? result.status : 'unknown',
          eventCounts: { ...state.eventCounts },
        },
      })
      if (!state.usageReported && isRecord(result?.usage)) {
        try {
          state.push({ type: 'usage', billing: summarizeUsage([{ ...result.usage, singleTurn: true }]).billing })
        } catch {
          /* invalid usage is not worth failing a finished answer */
        }
      }
      if (result?.status !== 'finished') {
        if (result?.status === 'cancelled' || state.controller.signal.aborted) {
          throw new ProviderError('ABORTED', 'Cursor run was cancelled')
        }
        throw new ProviderError('CURSOR_RUN_FAILED', 'Cursor run did not finish successfully')
      }
      state.success = true
    } catch (error) {
      const mapped = state.timedOut
        ? new ProviderError('TIMEOUT', 'Cursor call timed out')
        : mapSdkError(error, state.controller.signal, false)
      state.push({ type: 'failure', error: mapped })
      state.success = false
    } finally {
      clearTimeout(state.timer)
      state.timer = undefined
      state.push({ type: 'done' })
      if (state.success !== true) {
        await this.#settle(state)
      }
    }
  }

  #handleEvent(state, event) {
    if (!isRecord(event)) return
    const kind = typeof event.type === 'string' ? event.type : 'other'
    state.eventCounts[kind] = (state.eventCounts[kind] ?? 0) + 1
    if (kind === 'assistant') {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : []
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          state.push({ type: 'text', text: block.text })
        } else if (block?.type === 'tool_use') {
          if (!this.#allowedToolName(state, block.name)) {
            throw new ProviderError('NATIVE_TOOL_BLOCKED', 'Unexpected Cursor native tool channel; no host tool was executed')
          }
        }
      }
      return
    }
    if (kind === 'thinking' && typeof event.text === 'string' && event.text.length > 0) {
      state.push({ type: 'reasoning', text: event.text })
      return
    }
    if (kind === 'usage' && isRecord(event.usage)) {
      try {
        state.push({ type: 'usage', billing: summarizeUsage([{ ...event.usage, singleTurn: true }]).billing })
        state.usageReported = true
      } catch {
        /* ignore malformed usage */
      }
      return
    }
    if (kind === 'tool_call') {
      if (!this.#allowedToolName(state, event.name)) {
        throw new ProviderError('NATIVE_TOOL_BLOCKED', 'Unexpected Cursor native tool channel; no host tool was executed')
      }
    }
  }

  #allowedToolName(state, name) {
    if (typeof name !== 'string') return false
    if (state.bridge.tools.length === 0) return false
    if (name === 'mcp') return true
    return state.bridge.tools.some(
      tool => name === tool.name || name === `custom-user-tools-${tool.name}` || name.endsWith(`__${tool.name}`),
    )
  }

  #remember(state, { messages, content, identity, sessionId }) {
    if (sessionId === undefined) return
    const committed = [...messages, { role: 'assistant', content }]
    state.committedLength = committed.length
    state.committed = historyIdentity(committed)
    state.identity = identity
    const existing = this.#idle.get(sessionId)
    if (existing !== undefined && existing !== state) void existing.dispose()
    this.#idle.set(sessionId, state)
    state.idleTimer = setTimeout(() => {
      if (this.#idle.get(sessionId) === state) {
        this.#idle.delete(sessionId)
        void state.dispose()
      }
    }, this.#idleTimeoutMs)
    state.idleTimer.unref?.()
    while (this.#idle.size > this.#maxIdle) {
      const [key, victim] = this.#idle.entries().next().value
      this.#idle.delete(key)
      void victim.dispose()
    }
  }

  async #settle(state) {
    if (state.disposed) return state.disposePromise
    state.disposed = true
    state.disposePromise = (async () => {
      if (state.token !== undefined) this.#continuations.delete(state.token)
      clearTimeout(state.timer)
      state.timer = undefined
      clearTimeout(state.idleTimer)
      state.idleTimer = undefined
      state.bridge?.close()
      try {
        if (state.run?.supports?.('cancel') && state.run.status === 'running') {
          await bounded(() => state.run.cancel(), { timeoutMs: 5_000 })
        }
      } catch {
        /* best effort */
      }
      try {
        if (state.agent !== undefined) {
          await bounded(() => state.agent[Symbol.asyncDispose](), { timeoutMs: 5_000 })
        }
      } catch {
        /* best effort */
      }
      if (state.directory !== undefined) {
        await rm(state.directory, { recursive: true, force: true }).catch(() => {})
      }
      this.#active.delete(state)
    })()
    return state.disposePromise
  }

  #dispose(state) {
    return this.#settle(state)
  }

  /** Abort live work and dispose agents without closing the provider. */
  async reset() {
    if (this.#closed) return
    this.#continuations.clear()
    const active = [...this.#active]
    this.#idle.clear()
    for (const state of active) state.controller.abort()
    await Promise.all(
      active.map(async state => {
        await state.done?.catch(() => {})
        await this.#settle(state)
      }),
    )
  }

  /** Abort every active run and dispose all agents. */
  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#continuations.clear()
    const active = [...this.#active]
    this.#idle.clear()
    for (const state of active) state.controller.abort()
    await Promise.all(
      active.map(async state => {
        await state.done?.catch(() => {})
        await this.#settle(state)
      }),
    )
  }
}
