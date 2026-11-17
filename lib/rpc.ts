/**
 * Authenticated Settings RPC for the Cursor provider.
 *
 * The browser reaches these endpoints through the same `/api` channel and
 * client-request envelope the host already authenticates for its own pages, so
 * a plugin does not open a second, unprotected HTTP surface. Responses never
 * carry a key or a CLI token.
 *
 * @module dsh-cursor/lib/rpc
 */

import { catalogRows } from './catalog.js'
import type { NormalizedModel } from './catalog.js'
import type { UsageSnapshot } from './usage.js'
import type { SettingsDocument } from './settings.js'
import { ProviderError } from './errors.js'

/** Method prefix used by the client half. */
export const RPC_PREFIX = 'cursor-provider.'

/** Every endpoint served by this plugin. */
export const RPC_ENDPOINTS = Object.freeze([
  'status',
  'login.start',
  'login.cancel',
  'logout',
  'key.set',
  'catalog',
  'settings.save',
  'usage',
])

/** A client-side payload bug, answered as `bad-request`. */
class BadRequest extends Error {}

const isRecord = (value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Services the Settings RPC dispatcher drives. */
export interface RpcDeps {
  auth: {
    status(): Promise<unknown>
    startLogin(): Promise<unknown>
    cancelLogin(): void
    logout(): Promise<void>
    setManualKey(value: unknown): Promise<{ email?: string }>
    resolveKey(): Promise<{ apiKey: string } | undefined>
  }
  settings: {
    load(): Promise<SettingsDocument>
    save(rows: unknown, knownIds?: Iterable<string>): Promise<SettingsDocument>
  }
  catalog: {
    peek(): { models: Array<{ id: string }>; updatedAt: number } | undefined
    get(apiKey: string, options?: { signal?: AbortSignal; refresh?: boolean }): Promise<unknown[]>
    clear(): void
  }
  usage: {
    peek(): { supported?: boolean; source?: string; reason?: string } | undefined
    get(options?: { force?: boolean; keychain?: boolean; signal?: AbortSignal }): Promise<unknown>
    clear(): void
  }
  transport: { reset(): Promise<void> }
  emitModelsUpdated?: () => void
  registrationError?: string
  logger?: { warn?: (message: string) => void }
}


const readObject = payload => {
  if (!isRecord(payload)) throw new BadRequest('payload must be an object')
  return payload
}

const readOptionalBoolean = (payload, field) => {
  const value = payload[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new BadRequest(`payload.${field} must be a boolean`)
  return value
}

const readApiKey = payload => {
  const value = payload.apiKey
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequest('payload.apiKey must be a non-empty string')
  }
  return value
}

const failure = error => ({
  ok: false,
  error: {
    code:
      error instanceof BadRequest || error?.name === 'SettingsError'
        ? 'bad-request'
        : error instanceof ProviderError
          ? error.code
          : 'internal',
    message: error instanceof Error ? error.message : String(error),
  },
})

const ok = value => ({ ok: true, value })

/**
 * Build the endpoint dispatcher.
 * @param {{auth:object, settings:object, catalog:object, usage:object, transport:object, emitModelsUpdated?:Function, logger?:object}} deps services.
 * @returns {(method:string, payload:unknown, signal?:AbortSignal)=>Promise<object>} dispatcher.
 */
export function createRpcHandler({ auth, settings, catalog, usage, transport, emitModelsUpdated, registrationError, logger }: RpcDeps) {
  return async function dispatch(method, payload, signal?: AbortSignal) {
    const endpoint = typeof method === 'string' && method.startsWith(RPC_PREFIX) ? method.slice(RPC_PREFIX.length) : method
    try {
      switch (endpoint) {
        case 'status': {
          const authStatus = await auth.status()
          const document: SettingsDocument = await settings.load()
          const enabled = Object.values(document.models).filter(row => row.enabled !== false).length
          const cached = catalog.peek()
          const usagePeek = usage.peek()
          return ok({
            auth: authStatus,
            models: { enabled, total: cached?.models.length ?? 0 },
            usage: {
              supported: usagePeek?.supported === true,
              source: usagePeek?.source ?? 'none',
              ...(usagePeek?.reason === undefined ? {} : { reason: usagePeek.reason }),
            },
            catalogUpdatedAt: cached?.updatedAt ?? 0,
            ...(registrationError === undefined ? {} : { registrationError }),
          })
        }
        case 'login.start':
          return ok(await auth.startLogin())
        case 'login.cancel':
          auth.cancelLogin()
          return ok({ state: 'idle' })
        case 'logout':
          await auth.logout()
          await transport.reset()
          catalog.clear()
          usage.clear()
          emitModelsUpdated?.()
          return ok({ state: 'idle' })
        case 'key.set': {
          const input = readObject(payload)
          const result = await auth.setManualKey(readApiKey(input))
          await transport.reset()
          catalog.clear()
          usage.clear()
          emitModelsUpdated?.()
          return ok({ configured: true, ...result })
        }
        case 'catalog': {
          const input = readObject(payload)
          const refresh = readOptionalBoolean(input, 'refresh') === true
          const credential = await auth.resolveKey()
          if (credential === undefined) return ok({ models: [], updatedAt: 0, authRequired: true })
          let models
          let stale = false
          try {
            models = await catalog.get(credential.apiKey, { refresh, signal })
          } catch (error) {
            models = catalog.peek()?.models
            if (models === undefined) throw error
            stale = true
            logger?.warn?.(`cursor catalog refresh failed, serving cached rows: ${error instanceof Error ? error.message : String(error)}`)
          }
          const document: SettingsDocument = await settings.load()
          return ok({
            models: catalogRows({ catalog: models, settings: document }),
            updatedAt: catalog.peek()?.updatedAt ?? Date.now(),
            stale,
          })
        }
        case 'settings.save': {
          const input = readObject(payload)
          if (!Array.isArray(input.models)) throw new BadRequest('payload.models must be an array')
          const known = catalog.peek()?.models.map(model => model.id)
          const saved = await settings.save(input.models, known)
          emitModelsUpdated?.()
          const rows = catalogRows({ catalog: catalog.peek()?.models ?? [], settings: saved })
          return ok({ models: rows, updatedAt: saved.updatedAt })
        }
        case 'usage': {
          const input = readObject(payload)
          const force = readOptionalBoolean(input, 'force') === true
          const keychain = readOptionalBoolean(input, 'keychain') === true
          return ok(await usage.get({ force, keychain, signal }))
        }
        default:
          throw new BadRequest(`unknown cursor-provider method "${endpoint}"`)
      }
    } catch (error) {
      return failure(error)
    }
  }
}

function readEnvelope(body) {
  if (!isRecord(body)) return undefined
  if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') return undefined
  return { rpcId: body.rpcId, method: body.method, payload: body.payload }
}

function serverResponse(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * Wrap one endpoint as a buffered exact POST route on the shared `/api` channel.
 * @param {string} method full RPC method name.
 * @param {(payload:unknown, signal?:AbortSignal)=>Promise<object>} handler endpoint.
 * @returns {object} webServer/connection route.
 */
export function fetchRouteFor(method, handler) {
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) {
        const rawId = isRecord(body) && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
        return serverResponse(rawId, {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'invalid client-request message' },
        })
      }
      if (envelope.method !== method) {
        return serverResponse(envelope.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`,
          },
        })
      }
      try {
        return serverResponse(envelope.rpcId, await handler(envelope.payload, request.signal))
      } catch (error) {
        return serverResponse(envelope.rpcId, failure(error))
      }
    },
  }
}

/**
 * Register every endpoint when the host exposes an authenticated connection.
 * @param {object} ctx plugin context.
 * @param {(method:string,payload:unknown,signal?:AbortSignal)=>Promise<object>} handler dispatcher.
 * @returns {void}
 */
export function registerRoutes(ctx, handler) {
  ctx.inject(['connection'], scope => {
    const connection = scope.get('connection')
    if (connection?.fetch?.register === undefined) {
      scope.logger?.warn?.('cursor-provider: authenticated connection service has no fetch registry; Settings RPC is unavailable')
      return
    }
    const register = connection.fetch.register
    for (const endpoint of RPC_ENDPOINTS) {
      const method = `${RPC_PREFIX}${endpoint}`
      scope.effect(
        () => register(fetchRouteFor(method, (payload, signal) => handler(method, payload, signal))),
        `cursor-provider: /api/${method} route`,
      )
    }
  })
}
