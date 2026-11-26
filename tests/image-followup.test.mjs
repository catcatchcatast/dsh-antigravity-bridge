
// Simulated ACP/MCP assertions for inline images in DSH tool-result follow-ups.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { AcpTurn } from '../lib/conversation.js'
import { inputPrompt } from '../lib/history.js'
import { AntigravityRuntime } from '../lib/runtime.js'

const runtimes = []
const IMAGE_A = 'image-a-bytes'
const IMAGE_B = 'image-b-bytes'
const image = id => ({
  type: 'image',
  attachment: { attachmentId: id, mediaType: 'image/png', width: 64, height: 64, bytes: 128 },
})
const text = value => ({ type: 'text', text: value })

function makeRuntime() {
  const runtime = new AntigravityRuntime({
    config: {
      provider: 'antigravity', displayName: 'Antigravity', command: '', home: '', accounts: [],
      contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: '',
      maxLiveSessions: 4, idleSessionTtlMs: 600_000, parkSettleMs: 50, keepAliveMs: 1_000,
      longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000, engineMode: 'bridge',
    },
    spawnAcp: () => { throw new Error('unused by protocol simulation') },
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    readImage: async block => block.attachment.attachmentId === 'image-a' ? { data: IMAGE_A, mimeType: 'image/png' }
      : block.attachment.attachmentId === 'image-b' ? { data: IMAGE_B, mimeType: 'image/png' }
        : undefined,
    canReadImages: () => true,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  runtimes.push(runtime)
  return runtime
}

function pendingTurn({ finished = false } = {}) {
  const turn = new AcpTurn('image-followup', false)
  turn.finished = finished
  let result
  turn.pendingCalls.set('call-image', {
    id: 'call-image', name: 'job_output', argumentsJson: '{}',
    result: { resolve: value => { result = value }, reject: () => undefined },
  })
  return { turn, result: () => result }
}

function messageText(blocks) {
  return blocks.map(block => block.type === 'text' ? block.text : `\n[image:${block.data}]\n`).join('')
}

after(async () => { for (const runtime of runtimes) await runtime.dispose() })

test('developer and tool messages preserve image/text order; offline and offloaded attachments stay legible', async () => {
  const dev = {
    id: 'dev-1', role: 'developer',
    content: [text('developer before'), image('image-a'), text('developer after')],
  }
  const tool = {
    id: 'tool-1', role: 'tool', toolCallId: 'call-1', isError: true,
    content: [text('tool before'), image('image-b'), text('tool after')],
  }
  const blocks = await inputPrompt([dev, tool], async block => block.attachment.attachmentId === 'image-a'
    ? { data: IMAGE_A, mimeType: 'image/png' }
    : { data: IMAGE_B, mimeType: 'image/png' })
  const ordered = blocks.map(block => block.type === 'image' ? `IMAGE:${block.data}` : block.text)
  assert.deepEqual(ordered, [
    '<harness_notice>\ndeveloper before\n',
    `IMAGE:${IMAGE_A}`,
    '\ndeveloper after\n</harness_notice>',
    '\n\n',
    '<tool_result id="call-1" error="true">\ntool before\n',
    `IMAGE:${IMAGE_B}`,
    '\ntool after\n</tool_result>',
  ])

  let resolverCalls = 0
  const offline = await inputPrompt([{
    id: 'dev-offline', role: 'developer',
    content: [text('offline before'), image('missing-image'), text('offline after'), { ...image('offloaded-image'), offloaded: true }],
  }], async () => { resolverCalls++; return undefined })
  assert.equal(resolverCalls, 1, 'offloaded attachments are not read from local storage')
  const offlineText = messageText(offline)
  assert.ok(offlineText.indexOf('offline before') < offlineText.indexOf('[image missing-image unavailable]'))
  assert.ok(offlineText.indexOf('[image missing-image unavailable]') < offlineText.indexOf('offline after'))
  assert.ok(offlineText.includes('[image offloaded-image (offloaded)]'))
  assert.ok(!offline.some(block => block.type === 'image'))
})

test('live tool-result MCP continuation preserves two follow-up images and keeps result paging notice', async () => {
  const runtime = makeRuntime()
  const { turn, result } = pendingTurn()
  const conv = {
    turn, engineMode: 'bridge', sessionId: undefined,
    advertisedToolNames: new Set(), knownTools: new Map(), reportedToolCalls: new Map(),
  }
  const longText = `full job log start\n${'log line with retained context\n'.repeat(600)}full job log end`
  const messages = [
    { id: 'tool-result', role: 'tool', toolCallId: 'call-image', content: [text(longText)] },
    { id: 'developer-followup', role: 'developer', content: [text('developer before image A'), image('image-a'), text('developer after image A')] },
    { id: 'user-followup', role: 'user', content: [text('user before image B'), image('image-b'), text('user after image B')] },
  ]
  const resumed = await runtime.deliverResults(conv, {}, messages, {}, [])
  assert.equal(resumed, true)
  const delivered = result()
  assert.ok(delivered)
  assert.equal(delivered.isError, undefined)
  assert.ok(delivered.content.some(block => block.type === 'text' && block.text.includes('tool_result_page:')), 'ordinary long-result paging remains available')
  const images = delivered.content.filter(block => block.type === 'image')
  assert.deepEqual(images, [
    { type: 'image', data: IMAGE_A, mimeType: 'image/png' },
    { type: 'image', data: IMAGE_B, mimeType: 'image/png' },
  ])
  const retry = messageText(turn.retryInput)
  assert.match(retry, /^<tool_result id="call-image">/)
  assert.ok(retry.includes('tool_result_page:'))
  assert.equal(retry.replace('<tool_result id="call-image">\n', '').replace('\n</tool_result>', ''), messageText(delivered.content))
  const wire = messageText(delivered.content)
  assert.ok(wire.indexOf('developer before image A') < wire.indexOf(`[image:${IMAGE_A}]`))
  assert.ok(wire.indexOf(`[image:${IMAGE_A}]`) < wire.indexOf('developer after image A'))
  assert.ok(wire.indexOf('developer after image A') < wire.indexOf('user before image B'))
  assert.ok(wire.indexOf('user before image B') < wire.indexOf(`[image:${IMAGE_B}]`))
  assert.ok(wire.indexOf(`[image:${IMAGE_B}]`) < wire.indexOf('user after image B'))
})

test('a finished tool turn recovers ordered tool/developer images in the next ACP prompt', async () => {
  const runtime = makeRuntime()
  const { turn } = pendingTurn({ finished: true })
  const conv = {
    turn, engineMode: 'bridge', sessionId: 'recovered-session', promptGen: 0,
    advertisedToolNames: new Set(), knownTools: new Map(), reportedToolCalls: new Map(),
  }
  const messages = [
    { id: 'tool-result', role: 'tool', toolCallId: 'call-image', content: [text('tool before image A'), image('image-a'), text('tool after image A')] },
    { id: 'developer-followup', role: 'developer', content: [text('developer before image B'), image('image-b'), text('developer after image B')] },
  ]
  let captured
  const proc = { prompt: async (_session, blocks) => { captured = blocks; return { stopReason: 'end_turn' } } }
  const resumed = await runtime.deliverResults(conv, { layout: { geminiDir: 'unused' } }, messages, proc, [])
  assert.equal(resumed, true)
  await conv.promptSettled
  assert.ok(captured)
  const sequence = captured.map(block => block.type === 'image' ? `IMAGE:${block.data}` : block.text)
  assert.deepEqual(sequence, [
    '<tool_result id="call-image">\ntool before image A\n',
    `IMAGE:${IMAGE_A}`,
    '\ntool after image A\n</tool_result>',
    '\n\n',
    '<harness_notice>\ndeveloper before image B\n',
    `IMAGE:${IMAGE_B}`,
    '\ndeveloper after image B\n</harness_notice>',
  ])
})

for (const reply of ['stream', 'direct']) {
  test(`tool-result continuation keeps a pending ${reply} 429 and never starts a second prompt`, async () => {
    const runtime = makeRuntime()
    const { turn } = pendingTurn()
    const conv = { turn, engineMode: 'bridge', sessionId: 'limited', promptGen: 0,
      advertisedToolNames: new Set(), knownTools: new Map(), reportedToolCalls: new Map() }
    const call = Promise.withResolvers()
    let prompts = 0, cancels = 0
    const proc = { prompt() { prompts++; return call.promise }, cancel() { cancels++; call.resolve({ stopReason: 'cancelled' }) } }
    runtime.startPrompt(conv, proc, [text('fixture')])
    if (reply === 'direct') call.reject(new Error('HTTP 429, request_id=toolcase'))
    else turn.onUpdate({ sessionUpdate: 'agent_message_chunk', content: text('⚠ API error (attempt 1): HTTP 429, request_id=toolcase\n') })
    await conv.promptSettled
    const result = [{ id: 'result', role: 'tool', toolCallId: 'call-image', content: [text('late tool output')] }]
    assert.equal(await runtime.deliverResults(conv, {}, result, proc, []), true)
    assert.equal(conv.turn, turn)
    assert.equal(turn.events.peek().error.failure.requestId, 'toolcase')
    assert.equal(prompts, 1)
    assert.equal(cancels, reply === 'stream' ? 1 : 0)
  })
}

for (const finished of [false,true]) {
  test('parallel results keep the intermediate instruction and picture in order, finished='+finished, async () => {
    const runtime=makeRuntime(), turn=new AcpTurn('interleaved',false)
    turn.finished=finished
    const groups=new Map(), rendered=[]
    for(const id of ['right','left']) turn.pendingCalls.set(id,{id,name:'read',result:{resolve:r=>groups.set(id,r.content)}})
    const conv={turn,engineMode:'bridge',sessionId:'fixture',promptGen:0,advertisedToolNames:new Set(),knownTools:new Map(),reportedToolCalls:new Map()}
    const result=(id,label)=>({role:'tool',id,toolCallId:id,content:[text(label)]})
    const messages=[result('left','RESULT_LEFT'),{role:'developer',id:'between',content:[text('NOTE_PRE'),image('image-a'),text('NOTE_POST')]},result('right','RESULT_RIGHT')]
    const proc={prompt:async(_s,blocks)=>{rendered.push(...blocks);return {stopReason:'end_turn'}}}
    assert.equal(await runtime.deliverResults(conv,{layout:{geminiDir:'unused'}},messages,proc,[]),true)
    if (!finished) {
      assert.match(messageText(groups.get('left')), /NOTE_PRE/)
      assert.doesNotMatch(messageText(groups.get('right')), /NOTE_PRE/)
      rendered.push(...groups.get('left'),...groups.get('right'))
    }
    await conv.promptSettled
    const wire=messageText(rendered)
    const labels=['RESULT_LEFT','NOTE_PRE',IMAGE_A,'NOTE_POST','RESULT_RIGHT']
    assert.deepEqual(labels.map(x=>wire.indexOf(x)),labels.map(x=>wire.indexOf(x)).sort((a,b)=>a-b))
    for (const x of labels) assert.equal(wire.split(x).length,2)
  })
}

test('the installed attachment reader preserves siblings when one image read throws', async () => {
  let runtime
  const warnings=[]
  const good={data:Buffer.from('pixel'),mediaType:'image/png'}
  const ctx={get:()=>({readImageRequest:async ref=>{
    if(ref.attachmentId==='broken') throw Error('offline fixture')
    return good
  }}),logger:{warn:line=>warnings.push(line)},fiber:{},effect(){},inject(){},
    llm:{registerConfigurableProviders(){},registerAdapter(){}},plugin(_klass,params){runtime=params.runtime}}
  apply(ctx,{...makeRuntime().host.config,configVersion:2,accounts:[],warmup:false})
  runtimes.push(runtime)
  const blocks=await inputPrompt([{role:'user',id:'img',content:[text('before'),image('broken'),image('good'),text('after')]}],runtime.host.readImage)
  assert.deepEqual(blocks,[text('before'),text('[image broken unavailable]'),{type:'image',data:good.data.toString('base64'),mimeType:'image/png'},text('after')])
  assert.ok(warnings.some(w=>w.includes('broken') && w.includes('offline fixture')))
})
