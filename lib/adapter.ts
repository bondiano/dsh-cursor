/**
 * DSH LLM adapter for the Cursor provider.
 *
 * The adapter turns Cursor SDK events into DSH stream chunks, keeps tool
 * execution on the DSH side, and records only opaque continuation state in
 * `replayState`. It never passes SDK error text through: those messages can
 * contain credential-bearing URLs.
 *
 * @module dsh-cursor/lib/adapter
 */

import {
  buildModelSelection,
  catalogKey,
  defaultModelName,
  findModel,
  resolvedModelInfo,
  type NormalizedModel,
  type ModelSelection,
} from './catalog.js'
import type { ResolvedModelInfo } from './catalog.js'
import { failureOf, ProviderError, summarizeUsage } from './errors.js'
import { buildPrompt, projectImages, validateContent } from './prompt.js'
import type { SettingsDocument } from './settings.js'
import type { AttachmentService } from './prompt.js'

export interface TransportEvent {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  billing?: Record<string, number>
  summary?: unknown
  token?: string
  error?: ProviderError
}

/** One request the adapter sends to the transport. */
interface TransportRequest {
  apiKey: string
  apiKeyHash: string
  model: ModelSelection
  prompt?: string | { text: string; images: unknown[] }
  messages: unknown[]
  tools: unknown[]
  validate?: (schema: object, args: object) => boolean
  continuation?: string
  sessionId?: string
  purpose?: string
  system?: string
  toolHistory?: unknown
  signal?: AbortSignal
}

/** Transport and catalog surface the adapter drives. */
interface TransportService {
  catalog(apiKey: string, options?: { signal?: AbortSignal }): Promise<NormalizedModel[]>
  stream(request: TransportRequest): AsyncIterable<TransportEvent>
}

/** Catalog peek this adapter reads without network. */
interface CatalogService {
  peek(): { models: NormalizedModel[] } | undefined
}

/** Settings store this adapter reads. */
interface SettingsService {
  load(): Promise<unknown>
  snapshot(): SettingsDocument
}

/** Credential the adapter requires before any call. */
interface Credential {
  apiKey: string
}

/** Dependencies the host injects around the DSH LlmAdapter base class. */
export interface AdapterDeps {
  LlmAdapter: abstract new () => object
  transport: TransportService
  settings: SettingsService
  getCredential: () => Promise<Credential | null | undefined>
  catalog: CatalogService
  validate: (schema: object, args: object) => boolean
  attachments?: () => AttachmentService | undefined
  offloadedImageText?: (attachment: unknown) => string
  providerId?: string
  providerName?: string
  logger?: { warn?: (message: string) => void }
}

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

const addUsage = (total, usage) => {
  let seen = false
  for (const field of USAGE_FIELDS) {
    const value = usage?.[field]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 0) continue
    total[field] += value
    seen = true
  }
  return seen
}

/**
 * Build the adapter class around the injected DSH base and services.
 * @param {AdapterDeps} deps dependencies.
 * @returns {Function} adapter class.
 */
export function createAdapterClass({
  LlmAdapter,
  transport,
  settings,
  getCredential,
  catalog,
  validate,
  attachments = () => undefined,
  offloadedImageText,
  providerId = 'cursor',
  providerName = 'Cursor',
  logger,
}: AdapterDeps) {
  if (typeof LlmAdapter !== 'function') throw new TypeError('LlmAdapter is required')
  return class CursorAdapter extends LlmAdapter {
    providerInfo() {
      return { id: providerId, name: providerName }
    }

    providerRetryPolicy() {
      return {
        mode: 'normal',
        maxRetries: 3,
        retryableCodes: [],
        initialDelayMs: 1_000,
        maxDelayMs: 10_000,
        jitterRatio: 0.2,
      }
    }

    async listModels() {
      await settings.load()
      const saved = settings.snapshot()
      const enabled = Object.values(saved.models).filter(row => row.enabled !== false)
      const peeked = catalog.peek()
      return enabled.map(row => {
        const model = peeked?.models.find(entry => entry.id === row.id)
        return {
          provider: providerId,
          id: row.id,
          name: row.name ?? (model === undefined ? row.id : defaultModelName(model)),
          ...(model?.description === undefined ? {} : { description: model.description }),
          inputModalities: row.inputModalities ?? ['text'],
        }
      })
    }

    async resolveModel(provider, modelId, signal = undefined): Promise<ResolvedModelInfo> {
      await settings.load()
      const saved = settings.snapshot()
      const row = saved.models[modelId]
      const credential = await getCredential()
      let entry
      if (credential !== undefined && credential !== null) {
        try {
          const models = await transport.catalog(credential.apiKey, { signal })
          entry = findModel(models, modelId)
        } catch (error) {
          logger?.warn?.(`cursor model lookup fell back to saved metadata: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (entry === undefined) {
        entry = catalog.peek()?.models.find(item => item.id === modelId)
      }
      if (entry === undefined) {
        return {
          provider,
          id: modelId,
          name: row?.name ?? modelId,
          inputModalities: row?.inputModalities ?? ['text'],
        }
      }
      try {
        return resolvedModelInfo({ provider, model: entry, row })
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        logger?.warn?.(`cursor model metadata ignored: ${error.message}`)
        return {
          provider,
          id: modelId,
          name: row?.name ?? defaultModelName(entry),
          inputModalities: row?.inputModalities ?? ['text'],
        }
      }
    }

    async *stream(options) {
      let index = 0
      let open
      let calls = 0
      let visible = false
      let token
      const attempts: Array<{ upstream: unknown }> = []
      const usage = Object.fromEntries(USAGE_FIELDS.map(field => [field, 0]))

      const closeOpen = function* () {
        if (open === undefined) return
        yield { type: 'block-end', index: open.index, block: { type: open.type, text: open.text } }
        open = undefined
      }
      const block = function* (event) {
        if (event.type === 'tool-call') {
          yield* closeOpen()
          const current = index++
          calls += 1
          visible = true
          yield { type: 'block-start', index: current, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: current,
            id: event.id,
            name: event.name,
            argumentsDelta: event.arguments,
          }
          yield {
            type: 'block-end',
            index: current,
            block: { type: 'tool-call', id: event.id, name: event.name, arguments: event.arguments },
          }
          return
        }
        if (typeof event.text === 'string' && event.text.length > 0) {
          visible = true
          const type = event.type === 'reasoning' ? 'reasoning' : 'text'
          if (open === undefined || open.type !== type) {
            yield* closeOpen()
            open = { type, index: index++, text: '' }
            yield { type: 'block-start', index: open.index, blockType: type }
          }
          open.text += event.text
          yield { type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: open.index, text: event.text }
        }
      }

      try {
        if (options.temperature !== undefined || options.maxTokens !== undefined || options.stop !== undefined) {
          throw new ProviderError('UNSUPPORTED_CONTROL', 'Cursor does not expose temperature/maxTokens/stop controls')
        }
        validateContent(options.messages)
        const credential = await getCredential()
        if (credential === undefined || credential === null || typeof credential.apiKey !== 'string') {
          throw new ProviderError('MISSING_CREDENTIAL', 'Sign in to Cursor or configure a Cursor API key')
        }
        const models = await transport.catalog(credential.apiKey, { signal: options.signal })
        await settings.load()
        const row = settings.snapshot().models[options.model]
        const selection = buildModelSelection({
          id: options.model,
          catalog: models,
          reasoningEffort: options.reasoningEffort,
          fast: row?.fast === true,
          contextBudget: row?.contextBudget,
        })

        const previous = [...options.messages].reverse().find(message => message.role === 'assistant')
        const replay = previous?.source?.replayState?.response
        let continuation =
          replay?.protocol === 'cursor-sdk-v1' && typeof replay.continuation === 'string'
            ? replay.continuation
            : undefined

        // A model, tool or history change invalidates the native continuation;
        // replay the whole conversation as a fresh agent instead of failing the turn.
        for (let attempt = 0; ; attempt += 1) {
          let prompt
          if (continuation === undefined) {
            const projected = await projectImages(options, {
              attachments: attachments(),
              offloadedImageText,
            })
            prompt = buildPrompt({
              system: options.system,
              messages: projected.messages,
              toolHistory: options.toolHistory,
              images: projected.images,
            })
          }

          try {
            for await (const event of transport.stream({
              apiKey: credential.apiKey,
              apiKeyHash: catalogKey(credential.apiKey),
              model: selection,
              prompt,
              messages: options.messages,
              tools: options.tools ?? [],
              validate,
              continuation,
              sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
              purpose: options.purpose,
              system: options.system,
              toolHistory: options.toolHistory,
              signal: options.signal,
            })) {
              if (event.type === 'failure') {
                throw event.error
              }
              if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool-call') {
                yield* block(event)
              } else if (event.type === 'usage') {
                addUsage(usage, event.billing)
              } else if (event.type === 'diagnostic') {
                attempts.push({ upstream: event.summary })
              } else if (event.type === 'continuation') {
                token = event.token
              }
            }
            break
          } catch (error) {
            if (
              attempt > 0 ||
              continuation === undefined ||
              visible ||
              !(error instanceof ProviderError) ||
              error.code !== 'CONTINUATION_UNAVAILABLE'
            ) {
              throw error
            }
            logger?.warn?.('cursor continuation is unusable; replaying the conversation as a fresh agent')
            attempts.push({ upstream: { continuation: 'unavailable', fallback: 'fresh-conversation' } })
            continuation = undefined
          }
        }
        yield* closeOpen()
        if (!visible) throw new ProviderError('EMPTY_RESPONSE', 'Cursor returned no content')
        if (USAGE_FIELDS.some(field => usage[field] > 0)) {
          const summary = summarizeUsage([usage])
          yield { type: 'usage', usage: summary.billing }
        }
        yield {
          type: 'finish',
          reason: { kind: calls > 0 ? 'tool-calls' : 'stop' },
          replayState: {
            response: {
              protocol: 'cursor-sdk-v1',
              ...(token === undefined ? {} : { continuation: token }),
              attempts,
            },
          },
        }
      } catch (error) {
        yield* closeOpen()
        if (USAGE_FIELDS.some(field => usage[field] > 0)) {
          try {
            yield { type: 'usage', usage: summarizeUsage([usage]).billing }
          } catch {
            /* ignore invalid usage */
          }
        }
        const aborted = options.signal?.aborted === true
        const failure = failureOf(
          error,
          aborted ? 'ABORTED' : 'CURSOR_SDK_ERROR',
        )
        yield {
          type: 'finish',
          reason: {
            kind: aborted || failure.code === 'ABORTED' ? 'aborted' : 'error',
            failure: aborted ? { code: 'ABORTED', message: 'Request cancelled' } : failure,
          },
          replayState: {
            response: {
              protocol: 'cursor-sdk-v1',
              ...(token === undefined ? {} : { continuation: token }),
              attempts,
            },
          },
        }
      }
    }
  }
}
