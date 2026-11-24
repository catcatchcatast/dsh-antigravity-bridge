
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AcpTurn } from '../lib/conversation.js'
import { AntigravityRuntime } from '../lib/runtime.js'


function setup(t, watched = true, acknowledge = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const turn = new AcpTurn('fixture')
  const conv = {
    sessionId: 'fixture', promptGen: 0, turn, toolNames: new Set(['write']),
    activeToolSchemas: new Map([['write', { name: 'write', parameters: { type: 'object', properties: {} } }]]),
  }
  const abort = new AbortController()
  const prompts = []
  const cancelled = []
  let finish, rejectPrompt
  const proc = {
    prompt: (id, blocks) => { prompts.push({ id, blocks }); return new Promise((resolve, reject) => { finish = resolve; rejectPrompt = reject }) },
    cancel: id => { cancelled.push(id); if (acknowledge) finish({ stopReason: 'cancelled' }) },
  }
  const runtime = Object.create(AntigravityRuntime.prototype)
  runtime.startPrompt(conv, proc, [], watched, abort.signal)
  return { turn, conv, abort, cancelled, runtime, prompts, finish: result => finish(result), reject: error => rejectPrompt(error), tick: ms => t.mock.timers.tick(ms) }
}

test('five automatic retries share one session; sixth silence is terminal', async t => {
  const r = setup(t)
  for (let attempt = 0; attempt <= 5; attempt++) {
    r.turn.onUpdate({ sessionUpdate: 'usage_update', used: 123 })
    r.tick(179999)
    assert.equal(r.cancelled.length, attempt)
    r.tick(1)
    await Promise.resolve()
    assert.equal(r.prompts.length, Math.min(attempt + 2, 6))
  }
  assert.equal(r.turn.events.shift().error.code, 'MODEL_IDLE')
  assert.deepEqual(new Set(r.prompts.map(p => p.id)), new Set(['fixture']))
  assert.equal(r.turn.events.size, 0)
})

test('missing cancel acknowledgement stops without opening a second prompt', t => {
  const r = setup(t, true, false)
  r.tick(180000)
  r.tick(180000)
  const failure = r.turn.events.shift().error
  assert.match(failure.message, /取消回执/)
  assert.equal(r.prompts.length, 1)
  assert.equal(r.cancelled.length, 1)
})

test('user abort while waiting for cancellation prevents automatic resumption', async t => {
  const r = setup(t, true, false)
  r.tick(180000)
  r.abort.abort()
  r.finish({ stopReason: 'cancelled' })
  await r.conv.promptSettled
  assert.equal(r.prompts.length, 1)
})

for (const event of [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } },
  { sessionUpdate: 'tool_call', toolCallId: '1' },
  { sessionUpdate: 'tool_call_update', toolCallId: '1', status: 'in_progress' },
  { sessionUpdate: 'plan', entries: [{ content: 'Read' }] },
]) {
  test('progress at 179999 ms restarts the idle deadline: ' + (event.content?.type ?? '') + event.sessionUpdate, async t => {
    const r = setup(t)
    r.tick(179999)
    r.turn.onUpdate(event)
    r.tick(179999)
    assert.deepEqual(r.cancelled, [])
    r.tick(1)
    assert.deepEqual(r.cancelled, ['fixture'])
    await Promise.resolve()
    assert.equal(r.prompts.length, 2)
    assert.match(r.prompts[1].blocks[0].text, /Continue/)
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

test('provider retry chatter alone still counts as silence', async t => {
  const r = setup(t)
  r.tick(179999)
  r.turn.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ API error (attempt 1)' } })
  r.tick(1)
  assert.deepEqual(r.cancelled, ['fixture'])
  await Promise.resolve()
  assert.equal(r.prompts.length, 2)
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
  await Promise.resolve()
  assert.equal(r.prompts.length, 2)
})

test('a closed connection while cancelling cannot replay the request through host retries', async t => {
  const r = setup(t, true, false)
  r.tick(180000)
  r.reject(new Error('transport disconnected'))
  await r.conv.promptSettled
  assert.equal(r.turn.events.shift().error.code, 'MODEL_IDLE')
  assert.equal(r.prompts.length, 1)
})

test('an upstream 429 when cancellation is in flight retains the original error', async t => {
  const r = setup(t, true, false)
  r.tick(180000)
  r.reject(new Error('HTTP 429, retry in 2s, request_id="idle-rate"'))
  await r.conv.promptSettled
  const error = r.turn.events.shift().error
  assert.equal(error.code, 'UPSTREAM_429')
  assert.equal(error.failure.requestId, 'idle-rate')
  assert.equal(r.prompts.length, 1)
})
