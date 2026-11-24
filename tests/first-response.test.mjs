
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AcpTurn } from '../lib/conversation.js'
import { AntigravityRuntime } from '../lib/runtime.js'


function setup(t, watched = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const turn = new AcpTurn('fixture')
  const conv = {
    sessionId: 'fixture', promptGen: 0, turn, toolNames: new Set(['write']),
    activeToolSchemas: new Map([['write', { name: 'write', parameters: { type: 'object', properties: {} } }]]),
  }
  const abort = new AbortController()
  const cancelled = []
  let finish
  const proc = {
    prompt: () => new Promise(resolve => { finish = resolve }),
    cancel: id => { cancelled.push(id); finish({ stopReason: 'cancelled' }) },
  }
  const runtime = Object.create(AntigravityRuntime.prototype)
  runtime.startPrompt(conv, proc, [], watched, abort.signal)
  return { turn, conv, abort, cancelled, runtime, finish, tick: ms => t.mock.timers.tick(ms) }
}

test('only silence expires at 180 seconds and the late cancel result is discarded', async t => {
  const r = setup(t)
  r.turn.onUpdate({ sessionUpdate: 'usage_update', used: 123 })
  r.turn.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } })
  r.tick(179999)
  assert.deepEqual(r.cancelled, [])
  r.tick(1)
  await r.conv.promptSettled
  assert.deepEqual(r.cancelled, ['fixture'])
  assert.equal(r.turn.events.shift().error.code, 'TIMEOUT')
  assert.equal(r.turn.events.size, 0)
  r.tick(180000)
  assert.equal(r.cancelled.length, 1)
})

for (const event of [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } },
  { sessionUpdate: 'tool_call', toolCallId: '1' },
  { sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'in_progress' },
  { sessionUpdate: 'plan', entries: [{ content: 'Read' }] },
]) {
  test('progress at 179999 ms restarts the idle deadline: ' + (event.content?.type ?? '') + event.sessionUpdate, t => {
    const r = setup(t)
    r.tick(179999)
    r.turn.onUpdate(event)
    r.tick(179999)
    assert.deepEqual(r.cancelled, [])
    r.tick(1)
    assert.deepEqual(r.cancelled, ['fixture'])
    let last
    for (let event; (event = r.turn.events.shift());) last = event
    assert.equal(last.error.code, 'MODEL_IDLE')
  })
}

test('DSH tool waiting for its result or approval across deadline is handed off once', async t => {
  const r = setup(t)
  r.runtime.tenants = new Map([['fixture', r.conv]])
  let release
  r.runtime.evaluateToolGate = () => new Promise(resolve => { release = resolve })
  r.runtime.awaitCall = async () => ({ content: [] })
  r.tick(179999)
  const pending = r.runtime.callTool({ tenantKey: 'fixture', name: 'write', arguments: {} })
  r.tick(600001)
  assert.deepEqual(r.cancelled, [])
  release(undefined)
  await pending
  assert.equal(r.turn.calls.size, 1)
})

test('a synchronous ACP permission answer returns control to the model', t => {
  const r = setup(t)
  r.runtime.host = { log: { warn() {} } }
  r.tick(179999)
  r.runtime.answerPermission(r.conv, { sessionId: 'fixture', options: [] })
  r.tick(179999)
  assert.deepEqual(r.cancelled, [])
  r.tick(1)
  assert.deepEqual(r.cancelled, ['fixture'])
})

test('normal completion clears countdown', async t => {
  const r = setup(t)
  r.finish({ stopReason: 'end_turn' })
  await r.conv.promptSettled
  r.tick(180000)
  assert.deepEqual(r.cancelled, [])
  assert.equal(r.turn.events.shift().kind, 'done')
})

test('manual abort takes precedence at the deadline', t => {
  const r = setup(t)
  r.tick(179999)
  r.abort.abort()
  r.tick(1)
  assert.deepEqual(r.cancelled, [])
  assert.equal(r.turn.events.size, 0)
})

test('unwatched tool continuation has no countdown', t => {
  const r = setup(t, false)
  r.tick(600001)
  assert.deepEqual(r.cancelled, [])
})

test('provider retry chatter alone still counts as silence', t => {
  const r = setup(t)
  r.tick(179999)
  r.turn.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ API error (attempt 1)' } })
  r.tick(1)
  assert.deepEqual(r.cancelled, ['fixture'])
  assert.equal(r.turn.events.shift().error.code, 'TIMEOUT')
})

test('superseded generation cannot cancel a replacement', t => {
  const r = setup(t)
  r.conv.promptGen++
  r.tick(180000)
  assert.deepEqual(r.cancelled, [])
})

test('parallel DSH waits stay paused until both finish despite provider activity', async t => {
  const r = setup(t)
  const waits = []
  const pending = [0, 1].map(() => r.turn.duringTool(() => new Promise(resolve => waits.push(resolve))))
  waits[0]()
  await pending[0]
  r.turn.onUpdate({ sessionUpdate: 'plan', entries: [{ content: 'working' }] })
  r.tick(600000)
  assert.deepEqual(r.cancelled, [])
  waits[1]()
  await pending[1]
  r.tick(179999)
  r.turn.onUpdate({ sessionUpdate: 'usage_update', used: 100 })
  r.tick(1)
  assert.deepEqual(r.cancelled, ['fixture'])
  assert.equal(r.turn.events.shift().error.code, 'MODEL_IDLE')
})
