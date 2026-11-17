import test from 'node:test'
import assert from 'node:assert/strict'
import { initialRunPhase, nextRunPhase, tryRunPhase } from '../lib/run.machine.js'

test('cursor run machine covers the tool handoff and every termination', () => {
  assert.equal(initialRunPhase(), 'idle')
  assert.equal(nextRunPhase('idle', 'START'), 'streaming')
  assert.equal(nextRunPhase('streaming', 'TOOL_CALL'), 'awaitingTools')
  assert.equal(nextRunPhase('awaitingTools', 'CONTINUATION_RESUME'), 'streaming')
  assert.equal(nextRunPhase('streaming', 'COMPLETE'), 'completed')
  assert.equal(nextRunPhase('completed', 'CACHE'), 'cached')
  assert.equal(nextRunPhase('cached', 'REUSE'), 'streaming')
  assert.equal(nextRunPhase('streaming', 'TIMEOUT'), 'timedOut')
  assert.equal(nextRunPhase('streaming', 'ABORT'), 'aborted')
  assert.equal(nextRunPhase('streaming', 'FAIL'), 'failed')
  assert.equal(nextRunPhase('failed', 'DISPOSE'), 'disposed')
})

test('expired continuations and teardown are explicit', () => {
  assert.equal(nextRunPhase('awaitingTools', 'CONTINUATION_EXPIRED'), 'failed')
  assert.equal(tryRunPhase('awaitingTools', 'DISPOSE'), 'disposed')
  assert.equal(tryRunPhase('cached', 'DISPOSE'), 'disposed')
  assert.equal(tryRunPhase('idle', 'DISPOSE'), 'idle')
  assert.throws(() => nextRunPhase('disposed', 'START'), /illegal cursor run transition/)
})
