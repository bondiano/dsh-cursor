import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdapterClass } from '../lib/adapter.js'
import { normalizeCatalog, resolvedModelInfo } from '../lib/catalog.js'
import { ProviderError } from '../lib/errors.js'

const MODEL = {
  id: 'grok-4.7',
  displayName: 'Grok 4.7',
  parameters: [
    { id: 'context', values: [{ value: '250K' }, { value: '500K' }] },
    { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }] },
    { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] },
  ],
  variants: [
    {
      params: [
        { id: 'context', value: '250K' },
        { id: 'reasoning_effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ],
      displayName: 'Default',
      isDefault: true,
    },
  ],
}

class FakeLlmAdapter {
  providerInfo() {
    return { id: 'fake', name: 'Fake' }
  }
  async listModels() {
    return []
  }
  async resolveModel() {
    throw new Error('not implemented')
  }
  async *stream() {}
}

const settings = {
  loaded: false,
  async load() {
    this.loaded = true
  },
  snapshot() {
    return {
      version: 1,
      order: ['grok-4.7'],
      models: {
        'grok-4.7': { id: 'grok-4.7', enabled: true, name: 'My Grok', inputModalities: ['text'] },
      },
      updatedAt: 0,
    }
  },
}

const catalog = { peek: () => ({ models: normalizeCatalog([MODEL]), updatedAt: 1 }) }

function makeAdapter({ stream, credential = { apiKey: 'key' }, transportExtra = {} }) {
  const calls = []
  const transport = {
    async catalog() {
      return normalizeCatalog([MODEL])
    },
    async *stream(request) {
      calls.push(request)
      yield* stream(request)
    },
    ...transportExtra,
  }
  const Adapter = createAdapterClass({
    LlmAdapter: FakeLlmAdapter,
    transport,
    settings,
    getCredential: async () => credential,
    catalog,
    validate: () => true,
  })
  return { adapter: new Adapter(), calls }
}

async function collect(iterator) {
  const chunks = []
  for await (const chunk of iterator) chunks.push(chunk)
  return chunks
}

const baseOptions = {
  provider: 'cursor',
  model: 'grok-4.7',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  system: 'Be brief',
}

test('adapter maps text and usage into DSH chunks', async () => {
  const { adapter, calls } = makeAdapter({
    stream: async function* () {
      yield { type: 'text', text: 'Hi' }
      yield { type: 'text', text: ' there' }
      yield { type: 'usage', billing: { inputTokens: 10, outputTokens: 2 } }
    },
  })
  const chunks = await collect(adapter.stream(baseOptions))
  assert.deepEqual(
    chunks.map(chunk => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  assert.equal(chunks[4].usage.inputTokens, 10)
  assert.equal(chunks[5].reason.kind, 'stop')
  assert.equal(chunks[5].replayState.response.protocol, 'cursor-sdk-v1')
  assert.equal(calls[0].apiKey, 'key')
  assert.equal(calls[0].model.id, 'grok-4.7')
  assert.equal(calls[0].system, 'Be brief')
  assert.match(calls[0].prompt, /Be brief/)
})

test('adapter maps a tool call and continuation', async () => {
  const { adapter } = makeAdapter({
    stream: async function* () {
      yield { type: 'text', text: 'Checking' }
      yield { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }
      yield { type: 'continuation', token: 'token-1' }
    },
  })
  const chunks = await collect(adapter.stream({ ...baseOptions, tools: [{ name: 'read', description: 'Read', parameters: {} }] }))
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.equal(finish.replayState.response.continuation, 'token-1')
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.id),
    ['call-1'],
  )
})

test('adapter forwards a continuation and omits the prompt', async () => {
  const { adapter, calls } = makeAdapter({
    stream: async function* () {
      yield { type: 'text', text: 'Done' }
    },
  })
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
      source: { kind: 'model', provider: 'cursor', model: 'grok-4.7', replayState: { response: { protocol: 'cursor-sdk-v1', continuation: 'token-1' } } },
    },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
  ]
  await collect(adapter.stream({ ...baseOptions, messages }))
  assert.equal(calls[0].continuation, 'token-1')
  assert.equal(calls[0].prompt, undefined)
})

test('adapter rejects unsupported controls before transport', async () => {
  const { adapter, calls } = makeAdapter({
    stream: async function* () {
      yield { type: 'text', text: 'never' }
    },
  })
  const chunks = await collect(adapter.stream({ ...baseOptions, maxTokens: 10 }))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'UNSUPPORTED_CONTROL')
  assert.equal(calls.length, 0)
})

test('adapter reports a missing credential', async () => {
  const { adapter } = makeAdapter({
    credential: null,
    stream: async function* () {
      yield { type: 'text', text: 'never' }
    },
  })
  const chunks = await collect(adapter.stream(baseOptions))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'MISSING_CREDENTIAL')
})

test('adapter maps a transport failure event', async () => {
  const { adapter } = makeAdapter({
    stream: async function* () {
      yield { type: 'failure', error: new ProviderError('AUTH', 'bad key') }
    },
  })
  const chunks = await collect(adapter.stream(baseOptions))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'AUTH')
  assert.equal(chunks.at(-1).reason.failure.message, 'bad key')
})

test('adapter reports empty output', async () => {
  const { adapter } = makeAdapter({ stream: async function* () {} })
  const chunks = await collect(adapter.stream(baseOptions))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

test('adapter lists saved models without network', async () => {
  const { adapter } = makeAdapter({ stream: async function* () {} })
  const models = await adapter.listModels()
  assert.equal(models.length, 1)
  assert.equal(models[0].name, 'My Grok')
  assert.equal(models[0].inputModalities[0], 'text')
})

test('adapter resolves model metadata from the catalog', async () => {
  const { adapter } = makeAdapter({ stream: async function* () {} })
  const info = await adapter.resolveModel('cursor', 'grok-4.7')
  assert.equal(info.id, 'grok-4.7')
  assert.equal(info.context.contextWindow, 250_000)
  assert.deepEqual(info.reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(info.name, 'My Grok')
})

test('resolvedModelInfo matches the adapter view', () => {
  const [model] = normalizeCatalog([MODEL])
  const info = resolvedModelInfo({
    provider: 'cursor',
    model,
    row: { name: 'N', contextBudget: 250_000, inputModalities: ['text'] },
  })
  assert.equal(info.context.contextWindow, 250_000)
})
