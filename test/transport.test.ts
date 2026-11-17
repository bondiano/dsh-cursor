import assert from 'node:assert/strict'
import test from 'node:test'
import { CatalogCache } from '../lib/catalog.js'
import { CursorTransport } from '../lib/transport.js'

/** Captured SDK factory calls; assertions read the create options after the run. */
interface TransportCalls {
  created: number
  sent: string[]
  cancelled: number
  disposed: number
  options: { tools: unknown[]; local: { settingSources: unknown[]; enableAgentRetries: boolean } } | undefined
}

const MODEL = {
  id: 'grok-4.7',
  displayName: 'Grok 4.7',
  parameters: [{ id: 'context', values: [{ value: '250K' }] }],
}

function fakeSdk(script) {
  const calls: TransportCalls = { created: 0, sent: [], cancelled: 0, disposed: 0, options: undefined }
  const sdk = {
    Cursor: {
      models: {
        list: async () => [MODEL],
      },
    },
    Agent: {
      create: async options => {
        calls.created += 1
        calls.options = options
        const agent = {
          send: async prompt => {
            calls.sent.push(prompt)
            return script.makeRun({ options, prompt, calls })
          },
          [Symbol.asyncDispose]: async () => {
            calls.disposed += 1
          },
        }
        return agent
      },
    },
  }
  return { sdk, calls }
}

const settings = {
  async load() {},
  snapshot() {
    return { version: 1, order: [], models: {}, updatedAt: 0 }
  },
}

const makeTransport = (script, options: { requestTimeoutMs?: number } = {}) => {
  const fake = fakeSdk(script)
  const catalog = new CatalogCache({ loadSdk: async () => fake.sdk, ttlMs: 60_000 })
  const transport = new CursorTransport({
    loadSdk: async () => fake.sdk,
    catalog,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    idleTimeoutMs: 5_000,
    maxIdle: 2,
  })
  return { transport, calls: fake.calls, catalog }
}

async function collect(iterator): Promise<Array<{ type: string; text?: string; billing?: Record<string, number>; summary?: { status?: string }; token?: string }>> {
  const events: Array<{ type: string; text?: string; billing?: Record<string, number>; summary?: { status?: string }; token?: string }> = []
  for await (const event of iterator) events.push(event)
  return events
}

const request = {
  apiKey: 'key',
  apiKeyHash: 'hash',
  model: { id: 'grok-4.7', params: [] },
  prompt: 'hello',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
  sessionId: 'session-1',
}

test('transport streams text and records a finished run', async () => {
  const { transport, calls } = makeTransport({
    makeRun: () => ({
      status: 'running',
      supports: () => true,
      async *stream() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
      },
      async wait() {
        return { status: 'finished' }
      },
      async cancel() {
        calls.cancelled += 1
      },
    }),
  })
  const events = await collect(transport.stream(request))
  assert.deepEqual(
    events.map(event => event.type),
    ['text', 'usage', 'diagnostic'],
  )
  assert.equal(events[0].text, 'Hi')
  assert.equal(events[1].billing?.inputTokens, 4)
  assert.equal(events[2].summary?.status, 'finished')
  assert.equal(calls.created, 1)
  assert.equal(calls.options?.tools.length, 0)
  assert.equal(calls.options?.local.settingSources.length, 0)
  assert.equal(calls.options?.local.enableAgentRetries, false)
  await transport.close()
})

test('transport reuses an idle conversation and sends only the suffix', async () => {
  const { transport, calls } = makeTransport({
    makeRun: () => ({
      status: 'running',
      supports: () => true,
      async *stream() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }
      },
      async wait() {
        return { status: 'finished' }
      },
      async cancel() {},
    }),
  })
  await collect(transport.stream(request))
  const second = {
    ...request,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ],
  }
  const events = await collect(transport.stream(second))
  assert.equal(events.at(-1)?.type, 'diagnostic')
  assert.equal(calls.created, 1)
  assert.equal(calls.sent.length, 2)
  assert.match(calls.sent[1], /Continue the existing conversation/)
  assert.match(calls.sent[1], /again/)
  await transport.close()
})

test('transport aborts the run when the request is cancelled', async () => {
  let release
  const { transport, calls } = makeTransport({
    makeRun: () => ({
      status: 'running',
      supports: () => true,
      async *stream() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }
        await new Promise(resolve => {
          release = resolve
        })
      },
      async wait() {
        return { status: 'finished' }
      },
      async cancel() {
        calls.cancelled += 1
      },
    }),
  })
  const controller = new AbortController()
  const iterator = transport.stream({ ...request, signal: controller.signal })[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.value.type, 'text')
  controller.abort()
  release?.()
  await assert.rejects(async () => {
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
    }
  }, /ABORTED|cancelled/)
  await transport.close()
})

test('transport maps a request timeout', async () => {
  const { transport } = makeTransport(
    {
      makeRun: () => ({
        status: 'running',
        supports: () => true,
        async *stream() {
          await new Promise(() => {})
        },
        async wait() {
          return { status: 'finished' }
        },
        async cancel() {},
      }),
    },
    { requestTimeoutMs: 60 },
  )
  await assert.rejects(
    () => collect(transport.stream(request)),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'TIMEOUT',
  )
  await transport.close()
})

test('transport blocks an unexpected native tool channel', async () => {
  const { transport } = makeTransport({
    makeRun: () => ({
      status: 'running',
      supports: () => true,
      async *stream() {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'shell' }] } }
      },
      async wait() {
        return { status: 'finished' }
      },
      async cancel() {},
    }),
  })
  await assert.rejects(
    () => collect(transport.stream({ ...request, tools: [{ name: 'read', description: '', parameters: {} }] })),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'NATIVE_TOOL_BLOCKED',
  )
  await transport.close()
})

test('transport drops a continuation from another model and disposes its agent', async () => {
  const { transport, calls } = makeTransport({
    makeRun: ({ options }) => ({
      status: 'running',
      supports: () => true,
      async *stream() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking' }] } }
        await options.local.customTools.read.execute({ path: 'a' }, { toolCallId: 'sdk-1' })
      },
      async wait() {
        return { status: 'finished' }
      },
      async cancel() {
        calls.cancelled += 1
      },
    }),
  })
  const tools = [{ name: 'read', description: 'Read', parameters: {} }]
  const events = await collect(transport.stream({ ...request, tools }))
  const token = events.find(event => event.type === 'continuation')?.token
  assert.equal(typeof token, 'string')
  const history = [
    ...request.messages,
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
  ]
  const next = { ...request, tools, messages: history, continuation: token, model: { id: 'claude-opus-5-5', params: [] } }
  await assert.rejects(
    () => collect(transport.stream(next)),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CONTINUATION_UNAVAILABLE',
  )
  await assert.rejects(
    () => collect(transport.stream(next)),
    error => typeof error === 'object' && error !== null && 'code' in error && error.code === 'CONTINUATION_UNAVAILABLE',
  )
  for (let attempt = 0; attempt < 100 && calls.disposed === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(calls.disposed, 1)
  await transport.close()
})
