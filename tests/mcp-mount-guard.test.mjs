import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityRuntime } from '../lib/runtime.js'
import { AntigravityAdapter } from '../lib/adapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
chmodSync(fake, 0o755)
const runtimes = []

function makeRuntime({ home: existingHome, plan, env: envExtra = {} } = {}) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'agy-mcp-guard-'))
  const log = join(home, 'prompts.jsonl')
  const lifecycleFile = join(home, 'lifecycle.jsonl')
  const config = {
    provider: 'antigravity',
    displayName: 'Antigravity',
    command: fake,
    home,
    accounts: [{
      id: 'default',
      displayName: '',
      home: '',
      enabled: true,
      env: {},
      contextWindow: 0,
      system: true,
      visibleModels: [],
      priority: 1,
      weight: 1,
    }],
    contextWindow: 0,
    defaultEffort: 'high',
    autoPatch: false,
    patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16,
    idleSessionTtlMs: 600_000,
    parkSettleMs: 50,
    keepAliveMs: 1_000,
    longDecodeContinuations: 3,
    warmup: false,
    quotaTtlMs: 60_000,
    coldSwitchSettleMs: 0,
  }
  const warnings = []
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: {
          ...process.env,
          FAKE_AGY_LOG: log,
          FAKE_AGY_LIFECYCLE: lifecycleFile,
          ...(plan === undefined ? {} : { FAKE_AGY_PLAN: JSON.stringify(plan) }),
          ...envExtra,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
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
    runCommand: async (argv) => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' }),
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: { info: () => undefined, warn: msg => warnings.push(msg) },
    onModelsChanged: () => undefined,
  })
  runtimes.push(runtime)
  const readJsonl = file => existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return {
    home,
    runtime,
    warnings,
    prompts: () => readJsonl(log),
    lifecycle: () => readJsonl(lifecycleFile),
    adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true),
  }
}

after(async () => {
  for (const runtime of runtimes) await runtime.dispose()
})

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (id, content) => ({ id, role: 'assistant', content, source: { kind: 'model', provider: 'antigravity', model: 'gemini-3.8-flash' } })
const toolResult = (id, callId, text) => ({ id, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId } })
const readTool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }

const flashStep = (messages, extra = {}) => ({
  provider: 'antigravity',
  model: 'gemini-3.8-flash',
  reasoningEffort: 'high',
  messages,
  ...extra,
})

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

async function failedStep(iterable) {
  const chunks = []
  try {
    for await (const chunk of iterable) chunks.push(chunk)
  } catch (error) {
    return { chunks, error }
  }
  return { chunks, error: undefined }
}

const finishOf = chunks => chunks.at(-1)
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const callsOf = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block)
const assistantFrom = (id, chunks) => assistant(id, chunks.filter(c => c.type === 'block-end').map(c => c.block))

const BUILTINS_ONLY = ['list_resources', 'read_resource', 'manage_task']
const WITH_BRIDGE_TOOLS = ['mcp_dsh_read', 'mcp_dsh_dsh_call_tool', ...BUILTINS_ONLY]
const GEN_OK = { inputTokens: 20_000, cachedReadTokens: 0, outputTokens: 80, thoughtTokens: 40, textOutTokens: 40, declaredTools: WITH_BRIDGE_TOOLS }
const GEN_MISSING_MCP = { inputTokens: 12_000, cachedReadTokens: 0, outputTokens: 80, thoughtTokens: 40, textOutTokens: 40, declaredTools: BUILTINS_ONLY }
const GEN_STRIPPED = { inputTokens: 12_000, cachedReadTokens: 0, outputTokens: 80, thoughtTokens: 40, textOutTokens: 40 }

test('M1 proactive guard retires a worker that missed ListExperiments on session/new before sending any prompt', { timeout: 60_000 }, async () => {
  const { adapter, prompts, lifecycle, warnings } = makeRuntime({
    plan: [
      { gen: GEN_OK, thought: 'Tools are mounted.', text: 'Mounted cleanly on fresh worker.' },
    ],
    env: { FAKE_AGY_WORKER_LOG_EVENTS: JSON.stringify(['eof', 'ok']) },
  })

  const chunks = await collect(adapter.stream(flashStep([sys, user('u1', 'check repo')], { sessionId: 'M1', tools: [readTool] })))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(textOf(chunks), 'Mounted cleanly on fresh worker.')
  assert.equal(prompts().length, 1, 'no prompt is wasted on the broken worker')
  assert.deepEqual(lifecycle().map(e => e.op), ['new', 'close', 'new'], 'the bad worker is closed and replaced once before prompt')
  assert.ok(warnings.some(w => /ListExperiments/i.test(w)), `expected proactive warning, got: ${JSON.stringify(warnings)}`)
})

test('M2 proactive guard retires a worker that missed ListExperiments on session/load and preserves fast resume', { timeout: 60_000 }, async () => {
  const firstRun = makeRuntime({
    plan: [{ gen: GEN_OK, thought: 'Turn 1 ok.', text: 'Turn 1 done.' }],
    env: { FAKE_AGY_WORKER_LOG_EVENTS: JSON.stringify(['ok']) },
  })
  const m1 = [sys, user('u1', 'first turn')]
  const r1 = await collect(firstRun.adapter.stream(flashStep(m1, { sessionId: 'M2', tools: [readTool] })))
  assert.equal(finishOf(r1).reason.kind, 'stop')
  await firstRun.runtime.dispose()

  const secondRun = makeRuntime({
    home: firstRun.home,
    plan: [{ gen: GEN_OK, thought: 'Turn 2 ok.', text: 'Turn 2 done.' }],
    env: { FAKE_AGY_WORKER_LOG_EVENTS: JSON.stringify(['eof', 'ok']) },
  })
  const m2 = [...m1, assistantFrom('a1', r1), user('u2', 'second turn')]
  const r2 = await collect(secondRun.adapter.stream(flashStep(m2, { sessionId: 'M2', tools: [readTool] })))
  assert.equal(finishOf(r2).reason.kind, 'stop')
  assert.equal(textOf(r2), 'Turn 2 done.')
  const opsAfterRestart = secondRun.lifecycle().slice(1).map(e => e.op)
  assert.deepEqual(opsAfterRestart, ['load', 'close', 'load'], 'retires broken load worker and reloads without replaying history')
  assert.equal(secondRun.prompts().length, 2, 'only one prompt per turn, zero wasted on broken worker')
})

test('M3 reactive guard catches gen_metadata missing mcp_dsh_* on non-flagship model, retires worker, keeps persisted session, and recovers on retry', { timeout: 60_000 }, async () => {
  const firstRun = makeRuntime({
    plan: [{ gen: GEN_OK, thought: 'Turn 1 ok.', text: 'Turn 1 done.' }],
  })
  const m1 = [sys, user('u1', 'turn one')]
  const r1 = await collect(firstRun.adapter.stream(flashStep(m1, { sessionId: 'M3', tools: [readTool] })))
  assert.equal(finishOf(r1).reason.kind, 'stop')
  await firstRun.runtime.dispose()

  const secondRun = makeRuntime({
    home: firstRun.home,
    plan: [
      { gen: GEN_MISSING_MCP, thought: 'No tools visible.', text: '当前会话仅暴露了 list_resources、read_resource、manage_task 三个内置工具。' },
      { gen: GEN_OK, thought: 'Tools mounted now.', tool: { name: 'read', args: { file_path: 'a.py' } }, text: '', afterTool: { gen: GEN_OK, text: 'Read succeeded.' } },
    ],
  })
  const m2 = [...m1, assistantFrom('a1', r1), user('u2', 'read a.py')]
  const attempt1 = await failedStep(secondRun.adapter.stream(flashStep(m2, { sessionId: 'M3', tools: [readTool] })))
  assert.ok(attempt1.error !== undefined, 'must fail with retryable TRANSPORT when bridge MCP tools are absent')
  assert.equal(attempt1.error.code, 'TRANSPORT')
  assert.equal(attempt1.error.failure?.providerRetryAfterMs, 1000)

  const opsBeforeRetry = secondRun.lifecycle().slice(1).map(e => e.op)
  assert.deepEqual(opsBeforeRetry, ['load', 'close'], 'broken worker must be closed immediately')

  const attempt2 = await collect(secondRun.adapter.stream(flashStep(m2, { sessionId: 'M3', tools: [readTool] })))
  assert.equal(finishOf(attempt2).reason.kind, 'tool-calls')
  const call = callsOf(attempt2)[0]
  assert.equal(call.name, 'read')
  const opsAfterRetry = secondRun.lifecycle().slice(1).map(e => e.op)
  assert.deepEqual(opsAfterRetry, ['load', 'close', 'load'], 'retry reloads persisted session on a fresh worker without full replay')

  const final = await collect(secondRun.adapter.stream(flashStep([...m2, assistantFrom('a2', attempt2), toolResult('t1', call.id, 'file-body')], { sessionId: 'M3', tools: [readTool] })))
  assert.equal(finishOf(final).reason.kind, 'stop')
  assert.equal(textOf(final), 'Read succeeded.')
})

test('M4 reactive guard catches unknown tool mcp_dsh_* in steps table even when gen_metadata omits tool declarations, without false-triggering on historical errors', { timeout: 60_000 }, async () => {
  const { adapter, lifecycle } = makeRuntime({
    plan: [
      { gen: GEN_STRIPPED, unknownToolSteps: ['mcp_dsh_read', 'mcp_dsh_list_agents'], text: 'mcp_dsh_read returned unknown tool.' },
      { gen: GEN_STRIPPED, text: 'Recovered on fresh worker.' },
      { gen: GEN_STRIPPED, text: 'Next turn stays healthy.' },
    ],
  })
  const m1 = [sys, user('u1', 'inspect files')]
  const attempt1 = await failedStep(adapter.stream(flashStep(m1, { sessionId: 'M4', tools: [readTool] })))
  assert.ok(attempt1.error !== undefined, 'unknown mcp_dsh_* step must trigger recovery')
  assert.equal(attempt1.error.code, 'TRANSPORT')

  const attempt2 = await collect(adapter.stream(flashStep(m1, { sessionId: 'M4', tools: [readTool] })))
  assert.equal(finishOf(attempt2).reason.kind, 'stop')
  assert.equal(textOf(attempt2), 'Recovered on fresh worker.')
  assert.deepEqual(lifecycle().map(e => e.op), ['new', 'close', 'new'])

  const m2 = [...m1, assistantFrom('a1', attempt2), user('u2', 'follow up')]
  const turn2 = await collect(adapter.stream(flashStep(m2, { sessionId: 'M4', tools: [readTool] })))
  assert.equal(finishOf(turn2).reason.kind, 'stop')
  assert.equal(textOf(turn2), 'Next turn stays healthy.')
  assert.deepEqual(lifecycle().map(e => e.op), ['new', 'close', 'new'], 'no spurious reset on subsequent healthy turn')
})

test('M5 reactive recovery caps at one retry per request and retires the broken worker afterward so it never loops infinitely', { timeout: 60_000 }, async () => {
  const { adapter, lifecycle } = makeRuntime({
    plan: [
      { gen: GEN_MISSING_MCP, text: 'First broken worker reply.' },
      { gen: GEN_MISSING_MCP, text: 'Second broken worker reply.' },
      { gen: GEN_OK, text: 'Later turn gets a fresh worker.' },
    ],
  })
  const m1 = [sys, user('u1', 'do work')]
  const first = await failedStep(adapter.stream(flashStep(m1, { sessionId: 'M5', tools: [readTool] })))
  assert.equal(first.error?.code, 'TRANSPORT')

  const second = await collect(adapter.stream(flashStep(m1, { sessionId: 'M5', tools: [readTool] })))
  assert.equal(finishOf(second).reason.kind, 'stop', 'second attempt delivers instead of looping infinitely')
  assert.equal(textOf(second), 'Second broken worker reply.')
  assert.deepEqual(lifecycle().map(e => e.op), ['new', 'close', 'new', 'close'], 'still retires broken worker after exhausted recovery')

  const m2 = [...m1, assistantFrom('a1', second), user('u2', 'try again')]
  const third = await collect(adapter.stream(flashStep(m2, { sessionId: 'M5', tools: [readTool] })))
  assert.equal(finishOf(third).reason.kind, 'stop')
  assert.equal(textOf(third), 'Later turn gets a fresh worker.')
})

test('M6 no false positives when no DSH tools were advertised or when gen_metadata is healthy', { timeout: 60_000 }, async () => {
  const { adapter, lifecycle } = makeRuntime({
    plan: [
      { gen: GEN_MISSING_MCP, text: 'No tools requested.' },
    ],
  })
  const chunks = await collect(adapter.stream(flashStep([sys, user('u1', 'just chat')], { sessionId: 'M6', tools: [] })))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(textOf(chunks), 'No tools requested.')
  assert.deepEqual(lifecycle().map(e => e.op), ['new'], 'no reset when tools=[]')
})
