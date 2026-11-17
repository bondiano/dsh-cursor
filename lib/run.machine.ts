/**
 * Cursor run lifecycle (extensions/dsh/machines/machines/dsh-cursor.mjs).
 *
 * `state.phase` on a transport run is the machine state; every phase write goes
 * through `nextRunPhase`, so an illegal transition fails instead of silently
 * producing a phase the transport cannot explain.
 *
 * Two corrections over the documented model, because the SDK run keeps
 * streaming behind a tool handoff and disposal-on-uncertainty may strike any
 * live run (reset/close, producer failure while tools are awaited):
 * - `streaming` also allows DISPOSE (producer already finished, consumer still
 *   draining, reset() settles the run).
 * - `awaitingTools` also allows DISPOSE (background producer failure settles
 *   immediately; the single-use continuation dies with the run).
 */
import { createMachine, initialTransition, transition } from 'xstate'

export const cursorRunMachine = createMachine({
  id: 'cursorRun',
  initial: 'idle',
  description: 'One Cursor SDK run: streaming, optional native-tool handoff, resume, then a terminal result.',
  states: {
    idle: { on: { START: 'streaming' } },
    streaming: {
      on: {
        TOOL_CALL: 'awaitingTools',
        COMPLETE: 'completed',
        TIMEOUT: 'timedOut',
        ABORT: 'aborted',
        FAIL: 'failed',
        DISPOSE: 'disposed',
      },
    },
    awaitingTools: {
      on: {
        CONTINUATION_RESUME: 'streaming',
        CONTINUATION_EXPIRED: 'failed',
        DISPOSE: 'disposed',
      },
    },
    completed: { on: { CACHE: 'cached', DISPOSE: 'disposed' } },
    cached: { on: { REUSE: 'streaming', DISPOSE: 'disposed' } },
    timedOut: { on: { DISPOSE: 'disposed' } },
    aborted: { on: { DISPOSE: 'disposed' } },
    failed: { on: { DISPOSE: 'disposed' } },
    disposed: { type: 'final' },
  },
})

/** @returns {string} the phase a freshly started run begins in. */
export function initialRunPhase() {
  return initialTransition(cursorRunMachine)[0].value
}

/**
 * Apply one lifecycle event to a run phase.
 * @param {string} phase current run phase.
 * @param {string | { type: string }} event event type or event object.
 * @returns {string} the next phase.
 */
/** Apply an event only when the current phase accepts it (teardown paths). */
export function tryRunPhase(phase, event) {
  const eventObject = typeof event === 'string' ? { type: event } : event
  const snapshot = cursorRunMachine.resolveState({ value: phase })
  return snapshot.can(eventObject) ? transition(cursorRunMachine, snapshot, eventObject)[0].value : phase
}

export function nextRunPhase(phase, event) {
  const eventObject = typeof event === 'string' ? { type: event } : event
  const snapshot = cursorRunMachine.resolveState({ value: phase })
  if (!snapshot.can(eventObject)) {
    throw new Error(`illegal cursor run transition: ${phase} --${eventObject.type}-->`)
  }
  return transition(cursorRunMachine, snapshot, eventObject)[0].value
}
