// 变更追溯：CHG-20261123-221500-agy-429-cooldown-b018c2a7：上游 429 终止本次请求。

// End-to-end tests of how `AntigravityRuntime.stream()` classifies a failure
// before parking an account: a hard quota window still parks the account for
// the reported reset, an upstream 429 ends the request on the same account,
// and the gatekeeper's degraded-pool abort
// never parks a healthy account at all.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityRuntime, mapError } from '../lib/runtime.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AntigravityAdapter } from '../lib/adapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
const runtimes = []

/** One declared account with its own isolated root and sandbox `$HOME`. */
function account(id, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), `agy-macc-${id}-`))
  return {
    root,
    homeDir: join(root, 'home'),
    profile: { id, displayName: `${id} account`, home: root, enabled: true, env: {}, ...extra },
  }
}

/**
 * Runtime over the fake agent. Accounts listed in `quotaAccounts` get the
 * `FAKE_AGY_FAIL=quota` marker in their ACP process environment, so a prompt
 * carrying the fake's `QUOTA` directive answers with the quota error the real
 * CLI reports for an exhausted weekly window. Accounts listed in
 * `ratelimitAccounts` get `FAKE_AGY_FAIL=ratelimit`, so a prompt carrying the
 * fake's `RATELIMIT` directive answers with a transient 429. Other accounts
 * stay healthy.
 */
function makeRuntime({ accounts = [], quotaAccounts = [], ratelimitAccounts = [], omitArgonAccounts = [], usageByHome = {}, degradeAction, errorMessage, errorData, retryChunks } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-failover-class-test-'))
  const armedHomes = new Set(quotaAccounts.map(entry => entry.homeDir))
  const throttledHomes = new Set(ratelimitAccounts.map(entry => entry.homeDir))
  const noArgonHomes = new Set(omitArgonAccounts.map(entry => entry.homeDir))
  const warnings = []
  const config = {
    provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
    accounts: accounts.map(entry => entry.profile),
    contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
    longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000,
    ...degradeAction === undefined ? {} : { degradeAction },
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd, env) => {
      const childEnv = { ...process.env, ...env }
      delete childEnv.FAKE_AGY_ERROR_MESSAGE
      delete childEnv.FAKE_AGY_ERROR_DATA
      if (errorMessage !== undefined) childEnv.FAKE_AGY_ERROR_MESSAGE = errorMessage
      if (errorData !== undefined) childEnv.FAKE_AGY_ERROR_DATA = JSON.stringify(errorData)
      delete childEnv.FAKE_AGY_FAIL
      delete childEnv.FAKE_AGY_OMIT_MODELS
      childEnv.FAKE_AGY_LOG = join(env?.HOME ?? home, 'prompts.jsonl')
      childEnv.FAKE_AGY_LIFECYCLE = join(env?.HOME ?? home, 'lifecycle.jsonl')
      if (retryChunks && throttledHomes.has(env?.HOME)) childEnv.FAKE_AGY_RATE_RETRY = JSON.stringify(retryChunks)
      if (env?.HOME !== undefined && armedHomes.has(env.HOME)) childEnv.FAKE_AGY_FAIL = 'quota'
      if (env?.HOME !== undefined && throttledHomes.has(env.HOME)) childEnv.FAKE_AGY_FAIL = 'ratelimit'
      if (env?.HOME !== undefined && noArgonHomes.has(env.HOME)) childEnv.FAKE_AGY_OMIT_MODELS = 'gemini-4-argon'
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', d => { stderr += d })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))),
        terminate: () => child.kill(),
        stderrTail: () => stderr,
      }
    },
    // `agy -p /usage` answers per account: the scripted windows are keyed by the
    // sandbox `$HOME` of the account the read runs under, so one account's plan
    // can never answer for another.
    runCommand: async (argv, _timeoutMs, env) => {
      if (argv.includes('--version')) return { code: 0, stdout: 'fake-agy 0.0.1', stderr: '' }
      const groups = env?.HOME !== undefined ? usageByHome[env.HOME] : undefined
      if (argv.includes('/usage') && groups !== undefined) {
        return { code: 0, stdout: JSON.stringify({ command: { data: { groups } } }), stderr: '' }
      }
      return { code: 0, stdout: '{}', stderr: '' }
    },
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: { info: () => undefined, warn: message => { warnings.push(message) } },
    onModelsChanged: () => undefined,
    degradeRetryDelayMs: 15,
  })
  runtimes.push(runtime)
  /** Prompts one account's own ACP process received. */
  const prompts = (entry) => {
    const file = join(entry.homeDir, 'prompts.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  return { runtime, warnings, prompts, adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true) }
}

after(async () => { for (const runtime of runtimes) await runtime.dispose() })

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (id, content) => ({ id, role: 'assistant', content, source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' } })

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const finishOf = chunks => chunks.at(-1)
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
/** Open cooldown families of one account, sorted for stable comparisons. */
const cooldownsOf = (runtime, id) => runtime.status().accounts.find(row => row.id === id).cooldowns.map(row => row.family).sort()

const bash = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }

/** Run one step and return the rejection it must raise. */
async function rejectionOf(iterable) {
  try {
    await collect(iterable)
  } catch (error) {
    return error
  }
  assert.fail('the step resolved instead of failing')
}

test('a transient rate limit on the only account is rethrown with the upstream delay and parks nothing', async () => {
  const a = account('a')
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a], ratelimitAccounts: [a] })

  const error = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'RFC1',
    messages: [sys, user('u1', 'RATELIMIT hi')],
  }))

  assert.equal(error.code, 'UPSTREAM_429', 'the failure keeps the rate-limit code')
  assert.match(error.message, /429 Too Many Requests/, 'the upstream wording reaches the caller')
  assert.doesNotMatch(error.message, /No Antigravity account/, 'a transient 429 is not a pool exhaustion')
  assert.equal(error.failure.providerRetryAfterMs, 2000, 'the stated `retry in 2s` becomes the harness retry delay')
  assert.deepEqual(cooldownsOf(runtime, 'a'), [], 'a transient 429 must not park the account')
  assert.equal(prompts(a).length, 1, 'the account saw the step exactly once; the harness retry layer drives the retry')
})

test('a transient upstream 429 stops at the first account even when another is healthy', async () => {
  const a = account('a')
  const b = account('b')
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a, b], ratelimitAccounts: [a], errorMessage: 'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).' })

  const error = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'RFC2',
    messages: [sys, user('u1', 'RATELIMIT write the weekly report')],
  }))

  assert.equal(error.code, 'UPSTREAM_429')
  assert.equal(error.failure.status, 429)
  assert.equal(adapter.providerRetryPolicy('antigravity').retryableCodes.includes(error.code), false)
  assert.match(error.message, /RESOURCE_EXHAUSTED/)
  assert.deepEqual(cooldownsOf(runtime, 'a'), [])
  assert.deepEqual(cooldownsOf(runtime, 'b'), [])
  assert.equal(prompts(a).length, 1)
  assert.equal(prompts(b).length, 0)
})

test('a degraded route fails the step without cooling the account down or failing it over', async () => {
  const a = account('a')
  const b = account('b')
  // The refusal path is what this test pins, so it opts into the level that
  // refuses on any degraded verdict.
  const { runtime, adapter, prompts } = makeRuntime({ accounts: [a, b], degradeAction: 'legacy' })

  const degradedText = {
    text: '我明白您的意思了，我将先检查代码中处理额度显示逻辑的相关部分。',
    gen: { cwmEstTokens: 32_736, inputTokens: 3_437, cachedReadTokens: 18_432, outputTokens: 276, thoughtTokens: 0, textOutTokens: 276, ttftSeconds: 2.06, streamSeconds: 1.16 },
  }
  const degradedTool = {
    tool: 'bash',
    args: { command: 'rm -rf /tmp/wrong' },
    gen: { cwmEstTokens: 320_000, inputTokens: 3_069, cachedReadTokens: 124_928, outputTokens: 45, thoughtTokens: 0, textOutTokens: 45, ttftSeconds: 1.8, streamSeconds: 0.2 },
  }

  // A degraded text answer asks the harness retry layer for the same request
  // again (`DEGRADED_ROUTE`); it is not upstream quota, so nothing is parked.
  const textError = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'RFC3',
    tools: [bash],
    messages: [sys, user('u1', `GATEDCALL ${JSON.stringify(degradedText)}`)],
  }))
  assert.equal(textError.code, 'DEGRADED_ROUTE', 'the degraded answer reports the re-answer code')
  assert.match(textError.message, /自动重答/, 'the caller is told this was an automatic re-answer')
  assert.doesNotMatch(textError.message, /No Antigravity account/)
  assert.deepEqual(cooldownsOf(runtime, 'a'), [], 'the account serving the degraded route stays usable')
  assert.deepEqual(cooldownsOf(runtime, 'b'), [], 'no healthy account is cooled down either')
  assert.equal(runtime.status().lastAccount, 'a', 'the step never moves to another account')
  assert.equal(prompts(a).length, 1, 'the account saw the degraded attempt exactly once')
  assert.equal(prompts(b).length, 0, 'the other account was never asked')
  const afterText = prompts(a).length

  // A degraded tool gate that survives all four automatic re-answers hands its
  // tool call to the harness instead of aborting, and still never fails over.
  const toolPrompt = `GATEDCALL ${JSON.stringify(degradedTool)} => ${JSON.stringify(degradedTool)} => ${JSON.stringify(degradedTool)} => ${JSON.stringify(degradedTool)} => ${JSON.stringify(degradedTool)}`
  const request = () => adapter.stream({
    provider: 'antigravity',
    model: 'gemini-4-argon',
    sessionId: 'RFC3b',
    tools: [bash],
    messages: [sys, user('u1', toolPrompt)],
  })
  for (const [index, code] of [await rejectionOf(request()), await rejectionOf(request()), await rejectionOf(request()), await rejectionOf(request())].entries()) {
    assert.equal(code.code, 'DEGRADED_ROUTE', `gate degrade ${index + 1} asks for another re-answer`)
  }
  const fifth = await collect(request())
  assert.equal(fifth.at(-1).reason.kind, 'tool-calls', 'the exhausted budget delivers the tool call to the harness')
  assert.deepEqual(cooldownsOf(runtime, 'a'), [], 'the exhausted budget parks nothing on the first account')
  assert.deepEqual(cooldownsOf(runtime, 'b'), [], 'the exhausted budget parks nothing on the second account')
  // A new conversation may be balanced onto either account; all five of its
  // attempts must still run on the one account it was given.
  const servedA = prompts(a).length - afterText
  const servedB = prompts(b).length
  assert.ok(
    (servedA === 5 && servedB === 0) || (servedA === 0 && servedB === 5),
    `each attempt ran one session/prompt on the conversation's own account (a: ${servedA}, b: ${servedB})`,
  )
  assert.equal(runtime.status().lastAccount, servedA === 5 ? 'a' : 'b', 'the step never fails over to another account')
})

for (const message of [
  'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
  '429 Too Many Requests',
  '429 quota limit exceeded for requests per minute',
  'RESOURCE_EXHAUSTED',
]) {
  test('an upstream rate refusal preserves diagnostics and allows a later user request: ' + message, async () => {
    const a = account('a')
    const { runtime, adapter, prompts, warnings } = makeRuntime({
      accounts: [a], ratelimitAccounts: [a], errorMessage: message,
      errorData: { error: { details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com', metadata: { requestId: 'req-test-429', authorization: 'SECRET' } },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3s' },
        { '@type': 'type.googleapis.com/google.rpc.RequestInfo', requestId: 'trace-test-429', servingData: 'PRIVATE' },
      ] } },
    })
    const error = await rejectionOf(adapter.stream({
      provider: 'antigravity', model: 'gemini-3.8-flash', sessionId: 'AMBIGUOUS',
      messages: [sys, user('u1', 'RATELIMIT hi')],
    }))
    assert.equal(error.code, 'UPSTREAM_429')
    assert.equal(error.failure.providerRetryAfterMs, 3000)
    assert.deepEqual(cooldownsOf(runtime, 'a'), [])
    assert.equal(prompts(a).length, 1)
    const diagnostic = warnings.join('\n')
    assert.match(diagnostic, /req-test-429/)
    assert.match(diagnostic, /trace-test-429/)
    assert.match(diagnostic, /RATE_LIMIT_EXCEEDED/)
    assert.doesNotMatch(diagnostic, /SECRET|PRIVATE/)
    const recovered = await collect(adapter.stream({
      provider: 'antigravity', model: 'gemini-3.8-flash', sessionId: 'AMBIGUOUS',
      messages: [sys, user('u2', 'healthy request')],
    }))
    assert.equal(finishOf(recovered).reason.kind, 'stop')
    assert.equal(prompts(a).length, 2)
  })
}
test('explicit upstream quota parks only the requested model family', async () => {
  const a = account('a'), b = account('b')
  const { runtime, adapter, prompts, warnings } = makeRuntime({
    accounts: [a, b], ratelimitAccounts: [a], errorMessage: '429 quota exhausted',
    errorData: { reason: 'QUOTA_EXHAUSTED', requestId: 'quota-req', resetTime: new Date(Date.now() + 120000).toISOString() },
  })
  const error = await rejectionOf(adapter.stream({
    provider: 'antigravity', model: 'gemini-3.8-flash', sessionId: 'HARDQUOTA',
    messages: [sys, user('u1', 'RATELIMIT hi')],
  }))
  assert.equal(error.code, 'QUOTA')
  assert.equal(error.failure.status, 429)
  assert.equal(prompts(b).length, 0)
  assert.deepEqual(cooldownsOf(runtime, 'b'), [])
  assert.deepEqual(cooldownsOf(runtime, 'a'), ['gemini'])
  assert.equal(prompts(a).length, 1)
  assert.match(warnings.join('\n'), /quota-req/)
  const cooldown = runtime.status().accounts.find(row => row.id === 'a').cooldowns[0]
  assert.ok(Date.parse(cooldown.until) - Date.now() <= 120000)
  assert.ok(Date.parse(cooldown.until) - Date.now() > 60000)
})

test('bare production error leaves the account available and provides no invented retry delay', async () => {
  const a = account('a')
  const { runtime, adapter, prompts, warnings } = makeRuntime({
    accounts: [a], ratelimitAccounts: [a],
    errorMessage: 'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
  })
  const error = await rejectionOf(adapter.stream({
    provider: 'antigravity', model: 'gemini-3.8-flash', sessionId: 'BARE',
    messages: [sys, user('u1', 'RATELIMIT hi')],
  }))
  assert.equal(error.code, 'UPSTREAM_429')
  assert.equal(error.failure.providerRetryAfterMs, undefined)
  assert.deepEqual(cooldownsOf(runtime, 'a'), [])
  assert.equal(prompts(a).length, 1)
  assert.match(warnings.join('\n'), /RESOURCE_EXHAUSTED/)
  assert.doesNotMatch(warnings.join('\n'), /requestId|traceId/)
})

const retryWarning = '⚠ API error (attempt 1): upstream HTTP 429, retry in 2s, request_id="lab429"'
for (const [name, chunks, history, status = 429] of [
  ['whole', [retryWarning], false],
  ['split', ['⚠ API error (attempt ', '1): upstream HTTP 4', '29, retry in 2s, request_id="lab429"'], false],
  ['split reason', ['⚠ API error (attempt 1): provider rej', 'ected the request: RESOURCE_EXH', 'AUSTED, retry in 2s, request_id="lab429"'], false],
  ['split diagnostics', ['⚠ API error (attempt 1): HTTP 429', ', retry in 2s, request_id="lab429"\n'], false],
  ['history ACK', [retryWarning], true],
  ['HTTP 401', ['⚠ API error (attempt 1): HTTP 401', ', request_id="auth-trace"\n'], false, 401],
  ['UNAUTHENTICATED', ['⚠ API error (attempt 1): UNAUTH', 'ENTICATED trace_id="auth-trace"'], true, 401],
  ['HTTP 403', ['⚠ API error (attempt 1): provider {"code":403} trace_id="auth-trace"'], false, 403],
  ['PERMISSION_DENIED', ['⚠ API error (attempt 1): PERMISSION_DENIED trace_id="auth-trace"'], false, 403],
  ['TOS_VIOLATION', ['⚠ API error (attempt 1): TOS_VIOLATION trace_id="auth-trace"'], false, 403],
]) {
  test('one upstream attempt, one cancel and no account switch for upstream failure: ' + name, async () => {
    const a = account('a'), b = account('b')
    const { adapter, prompts, runtime } = makeRuntime({ accounts: [a, b], ratelimitAccounts: [a], retryChunks: chunks })
    const messages = history
      ? [sys, user('u0', 'old material '.repeat(22_000)), assistant('a0', [{ type: 'text', text: 'noted' }]), user('u1', 'RATELIMIT')]
      : [sys, user('u1', 'RATELIMIT')]
    const error = await rejectionOf(adapter.stream({ provider: 'antigravity', model: 'gemini-3.8-flash', sessionId: 'cancel429', messages }))
    assert.equal(error.code, status === 429 ? 'UPSTREAM_429' : 'AUTH')
    assert.equal(error.failure.status, status)
    assert.ok(error.message.includes(chunks.join('').trimEnd()))
    assert.equal(error.failure.requestId, status === 429 ? 'lab429' : 'auth-trace')
    if (status === 429) assert.equal(error.failure.providerRetryAfterMs, 2000)
    assert.equal(adapter.providerRetryPolicy('antigravity').retryableCodes.includes(error.code), false)
    const log = join(a.homeDir, 'lifecycle.jsonl')
    let events
    for (let n = 0; n < 120; n++) {
      events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).op)
      if (events.includes('upstream-finished')) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(events.includes('upstream-finished'))
    assert.equal(events.filter(op => op === 'upstream-attempt').length, 1)
    assert.equal(events.filter(op => op === 'cancel').length, 1)
    assert.equal(prompts(a).length, 1)
    assert.equal(prompts(b).length, 0)
    assert.deepEqual(cooldownsOf(runtime, 'a'), [])
  })
}

test('an SDK rate-limit error carrying HTTP 429 keeps provider details and stops host retries', () => {
  const raw = LlmError.fromFailure({ code: 'RATE_LIMIT', status: 429, message: 'busy', providerRetryAfterMs: 19000, requestId: 'upstream-test' })
  const mapped = mapError(raw)
  assert.equal(mapped.code, 'UPSTREAM_429')
  assert.equal(mapped.failure.providerRetryAfterMs, 19000)
  assert.equal(mapped.failure.requestId, 'upstream-test')
  assert.equal(mapError(mapped), mapped)
})

test('numeric HTTP 429 in RPC error data preserves trace and Retry-After and does not fail over', async () => {
  const a = account('a'), b = account('b')
  const { adapter, prompts } = makeRuntime({
    accounts: [a, b], ratelimitAccounts: [a], errorMessage: 'provider busy',
    errorData: { error: { code: 429 }, headers: { 'x-request-id': 'req-structured', 'Retry-After': '19' } },
  })
  const error = await rejectionOf(adapter.stream({ provider: 'antigravity', model: 'gemini-3.8-flash', sessionId: 'structured', messages: [sys, user('u1', 'RATELIMIT')] }))
  assert.equal(error.code, 'UPSTREAM_429')
  assert.equal(error.failure.providerRetryAfterMs, 19_000)
  assert.equal(error.failure.requestId, 'req-structured')
  assert.equal(prompts(a).length, 1)
  assert.equal(prompts(b).length, 0)
  const lifecycle = readFileSync(join(a.homeDir, 'lifecycle.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lifecycle.filter(event => event.op === 'cancel').length, 0)
})
