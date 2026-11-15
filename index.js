/**
 * Cursor provider for DeepSeek Harness.
 *
 * Registers the `cursor` LLM route, the authenticated Settings RPC used by the
 * client half, and the SDK transport. Account sign-in is a browser flow; the
 * resulting key is stored only in DSH credential records.
 *
 * @module @local/dsh-cursor
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv'
import z from '@deepseek-ai/schemastery'
import * as llm from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createAdapterClass } from './lib/adapter.js'
import { CursorAuth } from './lib/auth.js'
import { CatalogCache } from './lib/catalog.js'
import { SettingsStore, settingsPath } from './lib/settings.js'
import { createRpcHandler, registerRoutes } from './lib/rpc.js'
import { CursorTransport } from './lib/transport.js'
import { UsageCache } from './lib/usage.js'
import { ProviderError } from './lib/errors.js'

/** Provider route registered with the LLM service. */
export const PROVIDER_ID = 'cursor'
/** Plugin name, also the credential-record scope. */
export const name = 'dsh-cursor'

export const inject = ['llm']

/** Deployment tuning; user-facing model choices live in the Settings document. */
export const Config = z.object({
  providerName: z.string().default('Cursor'),
  maxIdleAgents: z.number().min(0).default(8),
  agentIdleTimeoutMs: z.number().min(1).default(1_800_000),
  requestTimeoutMs: z.number().min(1).default(1_800_000),
  catalogTtlMs: z.number().min(1).default(300_000),
  usageTimeoutMs: z.number().min(1).default(10_000),
})

function resolveHome() {
  try {
    return resolveDshHome()
  } catch {
    return process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  }
}

function makeValidator(logger) {
  const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false })
  const cache = new Map()
  let compileFailures = 0
  return (schema, args) => {
    if (schema === undefined || schema === null) return true
    let validate
    try {
      const key = JSON.stringify(schema)
      validate = cache.get(key)
      if (validate === undefined) {
        validate = ajv.compile(schema)
        if (cache.size >= 256) cache.clear()
        cache.set(key, validate)
      }
    } catch (error) {
      if (compileFailures < 3) {
        compileFailures += 1
        logger?.warn?.(`cursor-provider: tool schema cannot be validated: ${error instanceof Error ? error.message : String(error)}`)
      }
      return true
    }
    return validate(args) === true
  }
}

/**
 * Install the Cursor provider.
 * @param {object} ctx Host plugin context.
 * @param {object} [rawConfig] resolved Config.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = {
    providerName: 'Cursor',
    maxIdleAgents: 8,
    agentIdleTimeoutMs: 1_800_000,
    requestTimeoutMs: 1_800_000,
    catalogTtlMs: 300_000,
    usageTimeoutMs: 10_000,
    ...rawConfig,
  }
  const logger = ctx.logger
  const home = resolveHome()
  const settings = new SettingsStore({ file: settingsPath(home), logger })
  const loadSdk = () => import('@cursor/sdk')
  const catalog = new CatalogCache({ loadSdk, ttlMs: config.catalogTtlMs, logger })
  const credentials = () => ctx.get('credentials')
  const usage = new UsageCache({ timeoutMs: config.usageTimeoutMs, logger })

  const emitModelsUpdated = () => {
    try {
      ctx.emit('llm/models-updated', PROVIDER_ID)
    } catch (error) {
      logger?.warn?.(`cursor-provider: models-updated emit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const auth = new CursorAuth({
    credentials,
    recordKey: `${name}/default`,
    loadSdk,
    logger,
    onChange: () => {
      catalog.clear()
      usage.clear()
      emitModelsUpdated()
    },
  })

  const transport = new CursorTransport({
    loadSdk,
    catalog,
    logger,
    requestTimeoutMs: config.requestTimeoutMs,
    idleTimeoutMs: config.agentIdleTimeoutMs,
    maxIdle: config.maxIdleAgents,
  })

  const Adapter = createAdapterClass({
    LlmAdapter: llm.LlmAdapter,
    transport,
    settings,
    getCredential: () => auth.resolveKey(),
    catalog,
    validate: makeValidator(logger),
    attachments: () => ctx.get('attachments'),
    offloadedImageText: typeof llm.offloadedImageText === 'function' ? llm.offloadedImageText : undefined,
    providerId: PROVIDER_ID,
    providerName: config.providerName,
    logger,
  })

  let registrationError
  try {
    ctx.llm.registerAdapter([PROVIDER_ID], new Adapter())
  } catch (error) {
    registrationError = error instanceof Error ? error.message : String(error)
    logger?.error?.(
      `cursor-provider: could not register the "${PROVIDER_ID}" route (another plugin may own it): ${registrationError}`,
    )
  }

  try {
    ctx.llm.registerModelDiscovery(name, async (request, signal) => {
      if (request.provider !== undefined && request.provider !== PROVIDER_ID) {
        throw new ProviderError('INVALID_PROVIDER', 'Only the Cursor provider is supported')
      }
      if (request.baseURL !== undefined) {
        throw new ProviderError('UNSUPPORTED_ENDPOINT', 'Cursor uses its official SDK endpoint, not a custom base URL')
      }
      const key = typeof request.apiKey === 'string' && request.apiKey.length > 0
        ? request.apiKey
        : (await auth.resolveKey())?.apiKey
      if (key === undefined) throw new ProviderError('MISSING_CREDENTIAL', 'Sign in to Cursor first')
      const models = await catalog.get(key, { signal, refresh: true })
      return models.map(model => {
        const tier = model.defaultContext === undefined
          ? model.contextTiers.at(-1)
          : model.contextTiers.find(item => item.value === model.defaultContext)
        return {
          id: model.id,
          name: model.catalogName,
          ...(tier === undefined ? {} : { contextWindow: tier.tokens }),
        }
      })
    })
  } catch (error) {
    logger?.warn?.(
      `cursor-provider: model discovery unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const handler = createRpcHandler({
    auth,
    settings,
    catalog,
    usage,
    transport,
    emitModelsUpdated,
    registrationError,
    logger,
  })
  registerRoutes(ctx, handler)

  ctx.effect(() => () => {
    auth.dispose()
    void transport.close()
  }, 'cursor-provider: close Cursor agents')
}
