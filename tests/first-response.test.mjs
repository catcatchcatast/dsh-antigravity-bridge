
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AcpTurn, pumpStep } from '../lib/conversation.js'
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
  runtime.startPrompt(conv, proc, [{ type: 'text', text: 'original DSH input' }], watched, abort.signal)
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
    assert.deepEqual(r.prompts[1].blocks, r.prompts[0].blocks)
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

// 同会话、同轮次的超时诊断。CHG-20261126-204000-agy-idle-cause-92b178e0
test('idle failure reports partial answer and the latest generation error in this turn only', async t => {
  const r = setup(t)
  const dir = mkdtempSync(join(tmpdir(), 'agy-idle-cause-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'target.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type, status, metadata, error_details, step_payload)')
  const insert = db.prepare('INSERT INTO steps VALUES(?,?,?,?,?,?)')
  const field = (n, bytes) => Buffer.from([n * 8 + 2, bytes.length, ...bytes])
  const notice = text => Buffer.concat([Buffer.from([194, 1]), Buffer.from([text.length + 4]), field(3, field(2, Buffer.from(text)))])
  const time = second => field(1, [8, second])
  insert.run(1, 15, 7, time(1), field(2, Buffer.from('ETIMEDOUT')), null)
  insert.run(2, 15, 7, time(3), field(2, Buffer.from('unexpected EOF')), null)
  insert.run(3, 17, 3, time(4), null, notice('API error (attempt 1): request failed: Post "https://private.invalid": ECONNRESET'))
  db.close()
  r.turn.idleRecovery.dbPath = path
  r.turn.idleRecovery.startedAt = 2000
  r.turn.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } })
  const stream = pumpStep(r.turn, {}, undefined)
  while ((await stream.next()).value.type !== 'text-delta') {}
  for (let attempt = 0; attempt <= 5; attempt++) {
    r.tick(180000)
    await Promise.resolve()
  }
  await assert.rejects(async () => { for await (const chunk of stream) {} }, error => {
    assert.equal(error.code, 'MODEL_IDLE')
    assert.match(error.message, /部分正文.*ECONNRESET.*5 次/)
    assert.doesNotMatch(error.message, /private|EOF|ETIMEDOUT/)
    return true
  })
  for (const [session, since] of [[path, 5000], [join(dir, 'other.db'), 2000]]) {
    const clean = new AcpTurn('different-turn')
    Object.assign(clean.idleRecovery, { dbPath: session, startedAt: since, retries: 5 })
    let failure
    clean.watchIdleRecovery(() => true, () => {}, error => { failure = error })
    r.tick(180000)
    assert.equal(failure.code, 'MODEL_IDLE')
    assert.doesNotMatch(failure.message, /部分正文|错误为|记录过/)
  }
})

test('session ACP retry notice is available without a local database', t => {
  const r = setup(t)
  r.turn.idleRecovery.retries = 5
  for (const text of ['⚠ API error (attempt 1): stream reading error: ', 'unexpected EOF']) {
    r.turn.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }
  r.tick(180000)
  const error = r.turn.events.shift().error
  assert.match(error.message, /unexpected EOF.*5 次/)
  assert.doesNotMatch(error.message, /部分正文/)
})
