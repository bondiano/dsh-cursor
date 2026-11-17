import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeBridge } from '../lib/bridge.js'
import type { BridgeEvent } from '../lib/bridge.js'

/** Resolved bridge results are doubles of the SDK payload; assertions walk their text blocks. */
const asTextResult = (value: object): { content: Array<{ type: string; text: string }>; isError: boolean } =>
  value as unknown as { content: Array<{ type: string; text: string }>; isError: boolean }

const TOOL = {
  name: 'read',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

const callMessage = (id, args = { path: 'a' }) => ({
  role: 'assistant',
  content: [{ type: 'tool-call', id, name: 'read', arguments: JSON.stringify(args) }],
})

const resultMessage = (id, text = 'hello') => ({
  role: 'tool',
  toolCallId: id,
  content: [{ type: 'text', text }],
})

test('bridge emits one tool-call and resumes with the exact result', async () => {
  const events: BridgeEvent[] = []
  const bridge = new NativeBridge({ tools: [TOOL], notify: event => events.push(event) })
  assert.deepEqual(Object.keys(bridge.customTools), ['read'])
  const pending = bridge.customTools.read.execute({ path: 'a' })
  assert.equal(events.length, 1)
  const event = events[0]
  assert.equal(event.type, 'tool-call')
  assert.equal(event.name, 'read')
  assert.equal(event.arguments, JSON.stringify({ path: 'a' }))
  assert.equal(bridge.pendingCount, 1)

  bridge.resume([callMessage(event.id), resultMessage(event.id, 'contents')], [event.id])
  const result = await pending
  assert.deepEqual(result, { content: [{ type: 'text', text: 'contents' }], isError: false })
  assert.equal(bridge.pendingCount, 0)
})

test('bridge rejects invalid arguments without emitting a call', async () => {
  const events: BridgeEvent[] = []
  const bridge = new NativeBridge({
    tools: [TOOL],
    notify: event => events.push(event),
    validate: (_schema, args) => args?.path === 'a',
  })
  await assert.rejects(() => bridge.customTools.read.execute({ path: 'b' }), /INVALID_ARGUMENTS|arguments/)
  assert.equal(events[0].type, 'failure')
})

test('bridge rejects a mismatched tool result and keeps the callback pending', async () => {
  const events: BridgeEvent[] = []
  const bridge = new NativeBridge({ tools: [TOOL], notify: event => events.push(event) })
  const pending = bridge.customTools.read.execute({ path: 'a' })
  const id = events[0].id
  assert.throws(
    () => bridge.resume([callMessage(id, { path: 'b' }), resultMessage(id)], [id]),
    /exact DSH call/,
  )
  bridge.close()
  await assert.rejects(pending, /ABORTED|cancelled/)
})

test('bridge rejects an unexpected extra tool result', async () => {
  const events: BridgeEvent[] = []
  const bridge = new NativeBridge({ tools: [TOOL], notify: event => events.push(event) })
  const pending = bridge.customTools.read.execute({ path: 'a' })
  const id = events[0].id
  assert.throws(
    () =>
      bridge.resume(
        [callMessage(id), resultMessage(id), { role: 'tool', toolCallId: 'other', content: [] }],
        [id],
      ),
    /Unexpected native tool result/,
  )
  bridge.close()
  await assert.rejects(pending)
})

test('bridge appends sourced runtime context to the first result', async () => {
  const events: BridgeEvent[] = []
  const bridge = new NativeBridge({ tools: [TOOL], notify: event => events.push(event) })
  const pending = bridge.customTools.read.execute({ path: 'a' })
  const id = events[0].id
  bridge.resume(
    [
      callMessage(id),
      resultMessage(id),
      { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'ctx' }] },
    ],
    [id],
  )
  const result = asTextResult(await pending)
  assert.equal(result.content.length, 2)
  assert.match(result.content[1].text, /runtime-context/)
})

test('bridge folds agent-instructions messages into the first result', async () => {
  const events: BridgeEvent[] = []
  const bridge = new NativeBridge({ tools: [TOOL], notify: event => events.push(event) })
  const pending = bridge.customTools.read.execute({ path: 'a' })
  const id = events[0].id
  bridge.resume(
    [
      callMessage(id),
      resultMessage(id),
      {
        role: 'user',
        source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
        content: [{ type: 'text', text: 'Additional instructions from: whale-girl-ru/AGENTS.md' }],
      },
    ],
    [id],
  )
  const result = asTextResult(await pending)
  assert.equal(result.content.length, 2)
  assert.match(result.content[1].text, /instruction updates/)
  assert.match(result.content[1].text, /whale-girl-ru/)
})

test('bridge still rejects a genuine user turn between a call and its results', async () => {
  const events: BridgeEvent[] = []
  const bridge = new NativeBridge({ tools: [TOOL], notify: event => events.push(event) })
  const pending = bridge.customTools.read.execute({ path: 'a' })
  const id = events[0].id
  assert.throws(
    () =>
      bridge.resume(
        [
          callMessage(id),
          resultMessage(id),
          { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'stop' }] },
        ],
        [id],
      ),
    /matching tool results/,
  )
  bridge.close()
  await assert.rejects(pending)
})

test('bridge close rejects every pending callback', async () => {
  const events: BridgeEvent[] = []
  const bridge = new NativeBridge({ tools: [TOOL], notify: event => events.push(event) })
  const pending = bridge.customTools.read.execute({ path: 'a' })
  bridge.close()
  await assert.rejects(pending, /ABORTED|cancelled/)
  await assert.rejects(() => bridge.customTools.read.execute({ path: 'a' }), /closed/)
})
