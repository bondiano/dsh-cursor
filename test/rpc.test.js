import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcHandler, fetchRouteFor } from '../lib/rpc.js'

const MODEL = {
  id: 'grok-4.7',
  catalogName: 'Grok 4.7',
  description: 'test',
  contextTiers: [{ value: '250K', tokens: 250_000 }],
  efforts: [{ id: 'low', name: 'Low' }],
  fastSwitchable: true,
}

function makeHandler(overrides = {}) {
  const calls = []
  const auth = {
    async status() {
      return {
        configured: true,
        source: 'login',
        email: 'user@example.com',
        expiresAt: 123,
        expired: false,
        login: { state: 'idle' },
      }
    },
    async startLogin() {
      return { state: 'pending', url: 'https://cursor.test/login' }
    },
    cancelLogin() {},
    async logout() {},
    async setManualKey(key) {
      calls.push(['key', key])
      return { email: 'user@example.com' }
    },
    async resolveKey() {
      return { apiKey: 'secret-key', source: 'login' }
    },
    ...overrides.auth,
  }
  const settings = {
    async load() {
      return this.snapshot()
    },
    snapshot() {
      return { version: 1, order: ['grok-4.7'], models: { 'grok-4.7': { id: 'grok-4.7', enabled: true, name: 'Saved' } }, updatedAt: 0 }
    },
    async save(rows) {
      calls.push(['save', rows])
      for (const row of rows) if (row.id !== MODEL.id) {
        const error = new Error(`model ${row.id} is not present in the current Cursor catalog`)
        error.name = 'SettingsError'
        throw error
      }
      return { version: 1, order: rows.map(row => row.id), models: Object.fromEntries(rows.map(row => [row.id, { ...row, id: row.id }])), updatedAt: 7 }
    },
    ...overrides.settings,
  }
  const catalog = {
    peek() {
      return { models: [MODEL], updatedAt: 5 }
    },
    async get() {
      return [MODEL]
    },
    clear() {
      calls.push(['catalog.clear'])
    },
    ...overrides.catalog,
  }
  const usage = {
    peek() {
      return { supported: true, source: 'cursor-cli' }
    },
    async get() {
      return { supported: true, source: 'cursor-cli', windows: [] }
    },
    clear() {
      calls.push(['usage.clear'])
    },
    ...overrides.usage,
  }
  const transport = {
    async reset() {
      calls.push(['reset'])
    },
    ...overrides.transport,
  }
  const handler = createRpcHandler({
    auth,
    settings,
    catalog,
    usage,
    transport,
    emitModelsUpdated: () => calls.push(['models-updated']),
    registrationError: overrides.registrationError,
  })
  return { handler, calls }
}

test('status reports account state without a key', async () => {
  const { handler } = makeHandler()
  const result = await handler('cursor-provider.status', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.auth.email, 'user@example.com')
  assert.equal(JSON.stringify(result.value).includes('secret-key'), false)
})

test('status exposes a duplicate-adapter diagnostic', async () => {
  const { handler } = makeHandler({ registrationError: 'route already owned' })
  const result = await handler('cursor-provider.status', {})
  assert.equal(result.value.registrationError, 'route already owned')
})

test('login.start returns the sign-in URL', async () => {
  const { handler } = makeHandler()
  const result = await handler('cursor-provider.login.start', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.url, 'https://cursor.test/login')
})

test('logout clears auth, transport, catalog, usage, and publishes models', async () => {
  const { handler, calls } = makeHandler()
  const result = await handler('cursor-provider.logout', {})
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call[0]), ['reset', 'catalog.clear', 'usage.clear', 'models-updated'])
})

test('catalog requires an account and returns rows with an account', async () => {
  const missing = makeHandler({ auth: { async resolveKey() { return undefined } } })
  const required = await missing.handler('cursor-provider.catalog', {})
  assert.equal(required.value.authRequired, true)

  const { handler } = makeHandler()
  const result = await handler('cursor-provider.catalog', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.models[0].id, 'grok-4.7')
  assert.equal(result.value.models[0].selected, true)
})

test('settings.save validates rows and publishes models', async () => {
  const { handler, calls } = makeHandler()
  const result = await handler('cursor-provider.settings.save', {
    models: [{ id: 'grok-4.7', enabled: true, name: 'New', inputModalities: ['text'] }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.models[0].name, 'New')
  assert.ok(calls.some(call => call[0] === 'models-updated'))

  const bad = await handler('cursor-provider.settings.save', { models: [{ id: 'unknown' }] })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'bad-request')
})

test('key.set stores a manual key and resets agents', async () => {
  const { handler, calls } = makeHandler()
  const result = await handler('cursor-provider.key.set', { apiKey: 'manual-key' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.find(call => call[0] === 'key'), ['key', 'manual-key'])
  assert.ok(calls.some(call => call[0] === 'reset'))
})

test('usage returns the cached reader result', async () => {
  const { handler } = makeHandler()
  const result = await handler('cursor-provider.usage', { force: true, keychain: false })
  assert.equal(result.ok, true)
  assert.equal(result.value.supported, true)
})

test('unknown methods and malformed payloads are bad requests', async () => {
  const { handler } = makeHandler()
  assert.equal((await handler('cursor-provider.nope', {})).error.code, 'bad-request')
  assert.equal((await handler('cursor-provider.usage', null)).error.code, 'bad-request')
  assert.equal((await handler('cursor-provider.settings.save', { models: 'nope' })).error.code, 'bad-request')
})

test('fetchRouteFor answers the client-request envelope', async () => {
  const handler = async payload => ({ ok: true, value: { echoed: payload.value } })
  const route = fetchRouteFor('cursor-provider.echo', handler)
  assert.equal(route.path, '/api/cursor-provider.echo')
  const request = new Request('http://localhost/api/cursor-provider.echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'cursor-provider.echo', payload: { value: 7 } }),
  })
  const response = await route.fetch(request)
  const body = await response.json()
  assert.equal(body.type, 'server-response')
  assert.equal(body.rpcId, 'r1')
  assert.deepEqual(body.result, { ok: true, value: { echoed: 7 } })
})

test('fetchRouteFor rejects a method mismatch and wrong content type', async () => {
  const route = fetchRouteFor('cursor-provider.echo', async () => ({ ok: true, value: true }))
  const mismatch = await route.fetch(
    new Request('http://localhost/api/cursor-provider.echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'cursor-provider.other', payload: {} }),
    }),
  )
  assert.equal((await mismatch.json()).result.error.code, 'gateway/bad-request')
  const wrongType = await route.fetch(
    new Request('http://localhost/api/cursor-provider.echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    }),
  )
  assert.equal(wrongType.status, 415)
})
