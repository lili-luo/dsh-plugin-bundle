import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
  apply,
  eligibleKeysForMode,
  keyKindOf,
  publicState,
  selectKey,
} from '../lib/index.js'
import {
  VibeAcpRuntime,
  buildVibeChildEnv,
  prepareRunnerVibeHome,
  reapOrphanVibeProcesses,
  resolveModelSpec,
  resolveVibeEffort,
  vibeProgrammaticNames,
} from '../lib/acp-runtime.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_VIBE_ACP = join(HERE, 'fake-vibe-acp.mjs')
chmodSync(FAKE_VIBE_ACP, 0o755)

const makeKey = (id, faceUsd, extra = {}) => ({
  id,
  account: `${id}@example.com`,
  key: `mstrl_test_${id}_0000`,
  faceUsd,
  usedUsd: 0,
  status: 'active',
  tokens: { input: 0, output: 0, cached: 0 },
  requests: 0,
  ...extra,
})

function makeMockCtx() {
  const listeners = new Map()
  let cleanup
  return {
    logger: { info() {}, warn() {}, error() {} },
    get() { return undefined },
    effect(fn) {
      cleanup = fn()
      return () => cleanup?.()
    },
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {
        const idx = list.indexOf(fn)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    runWaterfall(event, options, terminal) {
      const list = listeners.get(event) ?? []
      const dispatch = (idx) => (idx < list.length ? list[idx](options, () => dispatch(idx + 1)) : terminal())
      return dispatch(0)
    },
    async dispose() {
      await cleanup?.()
    },
  }
}

async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

test('keyKindOf and eligibleKeysForMode separate $300 Vibe and $30 Studio pools', () => {
  const studio = makeKey('s1', 30)
  const vibe = makeKey('v1', 300)
  const explicit = makeKey('x1', 30, { kind: 'vibe' })
  assert.equal(keyKindOf(studio), 'studio')
  assert.equal(keyKindOf(vibe), 'vibe')
  assert.equal(keyKindOf(explicit), 'vibe')

  const keys = [studio, vibe]
  assert.deepEqual(eligibleKeysForMode(keys, { mode: 'acp' }).map((k) => k.id), ['v1'])

  // If all Vibe keys are exhausted, ACP mode must NOT silently fall back to $30 Studio keys.
  assert.deepEqual(
    eligibleKeysForMode([studio, makeKey('v1', 300, { status: 'exhausted' })], { mode: 'acp' }),
    [],
  )

  // Before 2026-12-01 UTC under auto scope, direct mode keeps all keys eligible.
  assert.deepEqual(
    eligibleKeysForMode(keys, { mode: 'direct', directKeyScope: 'auto', nowMs: Date.parse('2026-11-24T00:00:00Z') }).map((k) => k.id),
    ['s1', 'v1'],
  )
  // On/after 2026-12-01 UTC under auto scope, direct mode isolates to $30 Studio keys.
  assert.deepEqual(
    eligibleKeysForMode(keys, { mode: 'direct', directKeyScope: 'auto', nowMs: Date.parse('2026-12-01T00:00:00Z') }).map((k) => k.id),
    ['s1'],
  )
})

test('selectKey namespaces affinity per mode so toggling modes never cross-pins', () => {
  const store = {
    currentId: 's1',
    affinity: {},
    keys: [makeKey('s1', 30), makeKey('v1', 300)],
  }
  const acpKey = selectKey(store, 'h:conv-1', { mode: 'acp' })
  assert.equal(acpKey.id, 'v1')
  const directKey = selectKey(store, 'h:conv-1', { mode: 'direct', directKeyScope: 'studio' })
  assert.equal(directKey.id, 's1')
  assert.equal(store.affinity['acp:h:conv-1'], 'v1')
  assert.equal(store.affinity['direct:h:conv-1'], 's1')
})

test('prepareRunnerVibeHome writes isolated VIBE_HOME with positive auto_compact_threshold and dsh-bridge agent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vibe-home-prep-'))
  const sourceHome = join(home, 'src-vibe')
  await mkdir(sourceHome, { recursive: true })
  await writeFile(join(sourceHome, 'model_catalog_cache.json'), '{"models":[]}', 'utf8')

  const vibeHome = join(home, 'runner-vibe')
  const { spec, resolvedEffort } = prepareRunnerVibeHome({
    vibeHome,
    upstream: 'https://api.mistral.ai',
    modelId: 'zai-glm-5-3',
    effort: 'xhigh',
    serverName: 'dsh_abcd1234',
    sourceVibeHome: sourceHome,
  })
  assert.equal(spec.alias, 'zai-glm-5-3')
  assert.equal(resolvedEffort, 'max')
  const toml = await readFile(join(vibeHome, 'config.toml'), 'utf8')
  assert.match(toml, /default_agent = "dsh-bridge"/)
  assert.match(toml, /bypass_tool_permissions = true/)
  assert.match(toml, /enabled_tools = \["dsh_abcd1234_\*"\]/)
  assert.match(toml, /auto_compact_threshold = 950000/)
  assert.match(toml, /preserve_api_base = true/)
  assert.equal(await readFile(join(vibeHome, 'model_catalog_cache.json'), 'utf8'), '{"models":[]}')
  const agentToml = await readFile(join(vibeHome, 'agents', 'dsh-bridge.toml'), 'utf8')
  assert.match(agentToml, /system_prompt_id = "dsh_bridge"/)

  const medSpec = resolveModelSpec('mistral-medium-latest')
  assert.equal(medSpec.maxContextLength, 262_144)
  assert.deepEqual(medSpec.thinkingLevels, ['off', 'high'])
  assert.equal(medSpec.supportsImages, true)

  const devSpec = resolveModelSpec('devstral-latest')
  assert.equal(devSpec.maxContextLength, 262_144)
  assert.deepEqual(devSpec.thinkingLevels, ['off'])
  assert.equal(devSpec.supportsImages, false)

  const codestralHome = join(home, 'runner-codestral')
  const { spec: codeSpec, resolvedEffort: codeEffort } = prepareRunnerVibeHome({
    vibeHome: codestralHome,
    upstream: 'https://api.mistral.ai',
    modelId: 'codestral-latest',
    effort: 'high',
    serverName: 'dsh_code',
    sourceVibeHome: sourceHome,
  })
  assert.deepEqual(codeSpec.thinkingLevels, ['off'])
  assert.equal(codeSpec.supportsImages, false)
  assert.equal(codeEffort, 'off')
  const codeToml = await readFile(join(codestralHome, 'config.toml'), 'utf8')
  assert.match(codeToml, /alias = "codestral-latest"[\s\S]*thinking = "off"[\s\S]*thinking_levels = \["off"\][\s\S]*supports_images = false[\s\S]*max_context_length = 256000[\s\S]*auto_compact_threshold = 230400/)
})

test('buildVibeChildEnv strips ambient secrets and sets VIBE_HOME and MISTRAL_API_KEY', () => {
  const env = buildVibeChildEnv({
    vibeHome: '/tmp/vibe-iso',
    apiKey: 'mstrl_secret',
    base: { PATH: '/usr/bin', MISTRAL_API_KEY: 'ambient', DEEPSEEK_API_KEY: 'leak', HTTPS_PROXY: 'http://127.0.0.1:7890' },
  })
  assert.equal(env.VIBE_HOME, '/tmp/vibe-iso')
  assert.equal(env.MISTRAL_API_KEY, 'mstrl_secret')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(resolveVibeEffort('minimal', ['low', 'high']), 'low')
  const names = vibeProgrammaticNames([{ name: 'read' }, { name: 'web-search' }, { name: '1tool' }])
  assert.equal(names.get('read'), 'read')
  assert.equal(names.get('web-search'), 'web_search')
  assert.equal(names.get('1tool'), '_1tool')
})

test('apply wires llm/stream waterfall, set-mode toggle, and Vibe key pool routing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-mode-'))
  const port = 28561
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      billingProbe: false,
      port,
      upstream: 'https://api.mistral.ai',
      currentId: 's1',
      keys: [makeKey('s1', 30), makeKey('v1', 300)],
    }),
  )
  const ctx = makeMockCtx()
  apply(ctx, { home, vibeCommand: FAKE_VIBE_ACP, sourceVibeHome: join(home, 'no-src') })
  await new Promise((r) => setTimeout(r, 150))

  try {
    // 1. Non-mistral providers always fall through via next().
    let nextCalled = 0
    const otherChunks = await collect(
      ctx.runWaterfall('llm/stream', { provider: 'opencode-go', model: 'glm-5.3', messages: [] }, async function* () {
        nextCalled += 1
        yield { type: 'finish', reason: { kind: 'stop' } }
      }),
    )
    assert.equal(nextCalled, 1)
    assert.equal(otherChunks.at(-1).reason.kind, 'stop')

    // 2. Mistral in ACP mode runs through fake-vibe-acp using the $300 Vibe key (v1).
    const acpChunks = await collect(
      ctx.runWaterfall('llm/stream', {
        provider: 'mistral',
        model: 'zai-glm-5-3',
        reasoningEffort: 'max',
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      }, async function* () {
        throw new Error('direct next() should not run in ACP mode')
      }),
    )
    const textChunk = acpChunks.find((c) => c.type === 'text-delta')
    assert.ok(textChunk)
    assert.match(textChunk.text, /key=0000:model=zai-glm-5-3:has_ctx=true:body=hello/)
    const usageChunk = acpChunks.find((c) => c.type === 'usage')
    assert.deepEqual(usageChunk.usage, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 })

    // 3. State reports ACP mode, liveSessions >= 1, and aligned currentId = v1.
    let stateRes = await fetch(`http://127.0.0.1:${port}/__pool/state`, { headers: { 'x-dsh-pool': '1' } })
    let state = await stateRes.json()
    assert.equal(state.mode, 'acp')
    assert.equal(state.currentId, 'v1')
    assert.equal(state.acp.liveSessions, 1)

    // 4. Switching to direct mode evicts idle ACP sessions and delegates mistral via next().
    stateRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set-mode', mode: 'direct' }),
    })
    state = await stateRes.json()
    assert.equal(state.mode, 'direct')
    assert.equal(state.acp.liveSessions, 0)

    let directNext = 0
    await collect(
      ctx.runWaterfall('llm/stream', {
        provider: 'mistral',
        model: 'zai-glm-5-3',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }, async function* () {
        directNext += 1
        yield { type: 'finish', reason: { kind: 'stop' } }
      }),
    )
    assert.equal(directNext, 1)
  } finally {
    await ctx.dispose()
  }
})

test('ACP mode rotates past 402 Vibe key exhaustion without consuming $30 Studio keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-acp-failover-'))
  const port = 28562
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      billingProbe: false,
      port,
      upstream: 'https://api.mistral.ai',
      currentId: 'v1',
      keys: [
        makeKey('s1', 30),
        makeKey('v1', 300, { key: 'mstrl_dead_v1' }),
        makeKey('v2', 300, { key: 'mstrl_good_v2' }),
      ],
    }),
  )
  const ctx = makeMockCtx()
  apply(ctx, { home, vibeCommand: FAKE_VIBE_ACP, sourceVibeHome: join(home, 'no-src') })
  await new Promise((r) => setTimeout(r, 120))

  try {
    const chunks = await collect(
      ctx.runWaterfall('llm/stream', {
        provider: 'mistral',
        model: 'deepseek-v4-1-flash-1017',
        sessionId: 'sess-failover',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'test failover' }] }],
      }, async function* () {}),
    )
    const textChunk = chunks.find((c) => c.type === 'text-delta')
    assert.match(textChunk.text, /key=d_v2/)
    assert.equal(chunks.at(-1).reason.kind, 'stop')

    const saved = JSON.parse(await readFile(join(home, 'mistral-pool.json'), 'utf8'))
    assert.equal(saved.keys.find((k) => k.id === 'v1').status, 'exhausted')
    assert.equal(saved.keys.find((k) => k.id === 's1').status, 'active')

    // Exhaust v2 too -> should throw/yield QUOTA rather than burning s1 ($30 Studio).
    saved.keys.find((k) => k.id === 'v2').status = 'exhausted'
    await writeFile(join(home, 'mistral-pool.json'), JSON.stringify(saved))
    await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reload' }),
    })

    const failChunks = await collect(
      ctx.runWaterfall('llm/stream', {
        provider: 'mistral',
        model: 'deepseek-v4-1-flash-1017',
        sessionId: 'sess-failover-2',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'still failing' }] }],
      }, async function* () {}),
    )
    assert.equal(failChunks.at(-1).reason.kind, 'error')
    assert.equal(failChunks.at(-1).reason.failure.code, 'QUOTA')
  } finally {
    await ctx.dispose()
  }
})

test('ACP mode bridges parked tool calls, parallel batches, long-tool relay, and incremental turns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-acp-tools-'))
  const port = 28563
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      billingProbe: false,
      port,
      upstream: 'https://api.mistral.ai',
      currentId: 'v1',
      pricing: { 'zai-glm-5-3-flash': { in: 1, out: 4, cached: 0.1 } },
      keys: [makeKey('v1', 300)],
    }),
  )
  const ctx = makeMockCtx()
  apply(ctx, {
    home,
    vibeCommand: FAKE_VIBE_ACP,
    sourceVibeHome: join(home, 'no-src'),
    relayAfterMs: 80,
    parkSettleMs: 40,
  })
  await new Promise((r) => setTimeout(r, 120))

  try {
    const tools = [
      { name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'grep', description: 'Search text', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ]
    const msg1 = { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'TRIGGER_TOOL' }] }

    // Step 1: receives tool-call finish and partial disjoint usage.
    const step1 = await collect(
      ctx.runWaterfall('llm/stream', {
        provider: 'mistral',
        model: 'zai-glm-5-3-flash',
        sessionId: 'sess-tools',
        tools,
        messages: [msg1],
      }, async function* () {}),
    )
    assert.equal(step1.at(-1).reason.kind, 'tool-calls')
    const callBlock = step1.find((c) => c.type === 'block-end' && c.block.type === 'tool-call').block
    assert.equal(callBlock.name, 'read')
    assert.deepEqual(step1.find((c) => c.type === 'usage').usage, { inputTokens: 100, outputTokens: 15, cacheReadTokens: 20 })

    // Delay > relayAfterMs (80ms) so fake-vibe-acp receives [DSH_RELAY] and calls dsh_await_result!
    await new Promise((r) => setTimeout(r, 140))

    // Step 2: deliver tool result, triggers dsh_await_result resolution and final answer.
    const a1 = { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'mistral', model: 'zai-glm-5-3-flash' }, content: [callBlock] }
    const t1 = { id: 't1', role: 'tool', source: { kind: 'tool', callId: callBlock.id }, toolCallId: callBlock.id, content: [{ type: 'text', text: 'FILE_BODY' }] }
    const step2 = await collect(
      ctx.runWaterfall('llm/stream', {
        provider: 'mistral',
        model: 'zai-glm-5-3-flash',
        sessionId: 'sess-tools',
        tools,
        messages: [msg1, a1, t1],
      }, async function* () {}),
    )
    assert.equal(step2.at(-1).reason.kind, 'stop')
    assert.equal(step2.find((c) => c.type === 'text-delta').text, 'tool:relayed:FILE_BODY')
    assert.deepEqual(step2.find((c) => c.type === 'usage').usage, { inputTokens: 80, outputTokens: 12, cacheReadTokens: 120 })

    // Step 3 (Turn 2 incremental reuse): skip model's own assistant message, preserve turn=2.
    const a2 = { id: 'a2', role: 'assistant', source: { kind: 'model', provider: 'mistral', model: 'zai-glm-5-3-flash' }, content: [{ type: 'text', text: 'tool:relayed:FILE_BODY' }] }
    const msg2 = { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'TRIGGER_PARALLEL' }] }
    const step3 = await collect(
      ctx.runWaterfall('llm/stream', {
        provider: 'mistral',
        model: 'zai-glm-5-3-flash',
        sessionId: 'sess-tools',
        tools,
        messages: [msg1, a1, t1, a2, msg2],
      }, async function* () {}),
    )
    assert.equal(step3.at(-1).reason.kind, 'tool-calls')
    const parallelCalls = step3.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call').map((c) => c.block)
    assert.equal(parallelCalls.length, 2)

    const a3 = { id: 'a3', role: 'assistant', source: { kind: 'model', provider: 'mistral', model: 'zai-glm-5-3-flash' }, content: parallelCalls }
    const t2 = { id: 't2', role: 'tool', source: { kind: 'tool', callId: parallelCalls[0].id }, toolCallId: parallelCalls[0].id, content: [{ type: 'text', text: 'A' }] }
    const t3 = { id: 't3', role: 'tool', source: { kind: 'tool', callId: parallelCalls[1].id }, toolCallId: parallelCalls[1].id, content: [{ type: 'text', text: 'B' }] }
    const step4 = await collect(
      ctx.runWaterfall('llm/stream', {
        provider: 'mistral',
        model: 'zai-glm-5-3-flash',
        sessionId: 'sess-tools',
        tools,
        messages: [msg1, a1, t1, a2, msg2, a3, t2, t3],
      }, async function* () {}),
    )
    assert.equal(step4.at(-1).reason.kind, 'stop')
    assert.equal(step4.find((c) => c.type === 'text-delta').text, 'parallel:A+B')
  } finally {
    await ctx.dispose()
  }
})

test('ACP permission defense, cancellation, lifecycle TTLs, global coordinator, and orphan reaping', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-acp-life-'))
  const cacheDir = join(home, 'cache-vibe')
  await mkdir(join(cacheDir, 'runners', 'stale-runner'), { recursive: true })
  await writeFile(
    join(cacheDir, 'live-pids.json'),
    JSON.stringify([
      { pid: 44444, cmd: FAKE_VIBE_ACP, runnerDir: 'x' },
      { pid: 55555, cmd: '/usr/bin/other-app', runnerDir: 'y' },
    ]),
  )
  const killed = []
  const reaped = reapOrphanVibeProcesses(cacheDir, {
    platform: 'darwin',
    listProcesses: () => `  44444     1 node ${FAKE_VIBE_ACP}\n  55555     1 /usr/bin/other-app\n  66666   100 node ${FAKE_VIBE_ACP}\n`,
    killPid: (pid) => killed.push(pid),
  })
  assert.equal(reaped, 1)
  assert.deepEqual(killed, [44444])

  const runtime = new VibeAcpRuntime({
    dshHome: home,
    cacheDir,
    sourceVibeHome: join(home, 'no-src'),
    getUpstream: () => 'https://api.mistral.ai',
    getVibeCommand: () => FAKE_VIBE_ACP,
    selectVibeKey: () => makeKey('v1', 300),
    exhaustKey: () => {},
    recordUsage: () => {},
    isSubagentSession: (sid) => sid.startsWith('sub-'),
    idleSessionTtlMs: 500,
    subagentSessionTtlMs: 30,
    globalSoftLimit: 2,
  })

  try {
    // 0 boot processes
    assert.equal(runtime.status().liveSessions, 0)

    // Defense-in-depth permission check
    const permChunks = await collect(runtime.stream({
      provider: 'mistral',
      model: 'zai-glm-5-3',
      sessionId: 'main-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'TRIGGER_PERMISSION' }] }],
    }))
    assert.equal(permChunks.find((c) => c.type === 'text-delta').text, 'perm:reject_once/allow_once')

    // Auxiliary request (purpose='title') retires immediately on completion
    await collect(runtime.stream({
      provider: 'mistral',
      model: 'zai-glm-5-3',
      sessionId: 'main-1',
      purpose: 'title',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }],
    }))
    assert.equal(runtime.status().liveSessions, 1)

    // Subagent expires faster than main session
    await collect(runtime.stream({
      provider: 'mistral',
      model: 'zai-glm-5-3',
      sessionId: 'sub-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'sub work' }] }],
    }))
    assert.equal(runtime.status().liveSessions, 2)
    await new Promise((r) => setTimeout(r, 60))
    runtime.sweep(Date.now())
    assert.equal(runtime.status().liveSessions, 1)

    // Global soft limit (2) evicts oldest idle session when 3rd spawns
    await collect(runtime.stream({
      provider: 'mistral',
      model: 'zai-glm-5-3',
      sessionId: 'main-2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'm2' }] }],
    }))
    await collect(runtime.stream({
      provider: 'mistral',
      model: 'zai-glm-5-3',
      sessionId: 'main-3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'm3' }] }],
    }))
    assert.ok(runtime.status().liveSessions <= 2)

    // AbortSignal sends session/cancel and ends with aborted
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 120)
    const cancelChunks = await collect(runtime.stream({
      provider: 'mistral',
      model: 'zai-glm-5-3',
      sessionId: 'main-cancel',
      signal: ac.signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'TRIGGER_SLOW_HANG' }] }],
    }))
    assert.equal(cancelChunks.at(-1).reason.kind, 'aborted')
  } finally {
    await runtime.dispose()
  }
})

test('settings client renders mode switch card and triggers set-mode action', async () => {
  const clientCode = await readFile(join(HERE, '..', 'lib', 'client.js'), 'utf8')
  let captured = null
  runInNewContext(clientCode, {
    __ModuleLoader__: { load: (m) => { captured = m } },
    console,
  })
  assert.ok(captured)

  const state = publicState(
    { mode: 'acp', directKeyScope: 'auto', currentId: 'v1', affinity: {}, keys: [makeKey('v1', 300), makeKey('s1', 30)] },
    { available: true, liveSessions: 2, activeTurns: 0 },
  )
  let stateIdx = 0
  const fakeReact = {
    createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children }),
    useState: (init) => {
      stateIdx += 1
      return [stateIdx === 1 ? state : (typeof init === 'function' ? init() : init), () => {}]
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
  }
  let sectionComponent
  let providerCardComponent = null
  const plugin = captured.factory((id) => {
    assert.equal(id, 'react')
    return fakeReact
  })
  plugin.apply({
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject: (_, reg) => reg(),
      register: (opts, comp) => {
        if (opts.name === 'settings.section') sectionComponent = comp
        if (opts.name === 'settings.models.provider-card' && opts.key === 'dsh-mistral-pool') providerCardComponent = comp
        return () => {}
      },
    },
  })
  assert.equal(providerCardComponent, null, 'plugin should leave settings.models.provider-card empty for compact single-row card')
  const renderTree = (node) => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(renderTree).join('')
    if (typeof node.tag === 'function') return renderTree(node.tag(node.props))
    return `<${node.tag}>${renderTree(node.children)}</${node.tag}>`
  }
  const rendered = renderTree(sectionComponent())
  assert.match(rendered, /ACP \(vibe-acp\)/)
  assert.match(rendered, /直连 \(HTTP API\)/)
  assert.match(rendered, /vibe-acp 就绪 · 2 会话/)
  assert.match(rendered, /当前路由池/)
  assert.match(rendered, /\+ 新增 Key/)
  assert.doesNotMatch(rendered, />\+ 新增</)
  assert.match(rendered, /刷新/)
  assert.match(rendered, /已启用/)
  assert.match(rendered, /编辑/)
  assert.match(rendered, /停用/)
  assert.match(rendered, /删除/)
  assert.match(rendered, /模型目录/)
  assert.match(rendered, /1M 上下文/)
  assert.match(rendered, /128K 输出/)
  assert.match(rendered, /256K 输出/)
  assert.match(rendered, /文本 \/ 图片/)
  assert.match(rendered, /仅文本/)
  assert.match(rendered, /获取可用模型/)
  assert.match(rendered, /\+ 添加模型/)
  assert.match(rendered, /deepseek-v4-1-flash-1017/)
  assert.match(rendered, /mistral-medium-latest/)
  assert.match(rendered, /mistral-small-latest/)
  assert.match(rendered, /devstral-latest/)
  assert.match(rendered, /codestral-latest/)
  assert.match(rendered, /magistral-medium-latest/)
  assert.doesNotMatch(rendered, /恢复/)
  assert.doesNotMatch(rendered, /用完/)
  assert.doesNotMatch(rendered, /校准/)
  assert.doesNotMatch(rendered, /清零/)
  assert.doesNotMatch(rendered, /重算/)
  assert.doesNotMatch(rendered, /同步官方/)
})

test('settings client renders add-key form, empty-state add button, and inline delete confirm', async () => {
  const clientCode = await readFile(join(HERE, '..', 'lib', 'client.js'), 'utf8')
  let captured = null
  runInNewContext(clientCode, {
    __ModuleLoader__: { load: (m) => { captured = m } },
    console,
  })
  const emptyState = publicState({ mode: 'acp', directKeyScope: 'auto', currentId: null, affinity: {}, keys: [] })
  const populatedState = publicState({
    mode: 'acp',
    directKeyScope: 'auto',
    currentId: 'v1',
    affinity: {},
    keys: [
      makeKey('v1', 300),
      makeKey('v2', 300, { status: 'disabled' }),
      makeKey('v3', 300, { status: 'exhausted' }),
    ],
  })
  const makeHarness = (poolState, addTargetInit = null, confirmDeleteInit = null, editScheduleInit = null) => {
    let idx = 0
    const fakeReact = {
      createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children }),
      useState: (init) => {
        idx += 1
        if (idx === 1) return [poolState, () => {}]
        if (idx === 4) return [addTargetInit, () => {}]
        if (idx === 5) return [confirmDeleteInit, () => {}]
        if (idx === 6) return [editScheduleInit, () => {}]
        return [typeof init === 'function' ? init() : init, () => {}]
      },
      useCallback: (fn) => fn,
      useEffect: () => {},
    }
    let sectionComponent
    const plugin = captured.factory(() => fakeReact)
    plugin.apply({
      effect: (fn) => { fn(); return () => {} },
      slots: {
        inject: (_, reg) => reg(),
        register: (opts, comp) => { if (opts.name === 'settings.section') sectionComponent = comp; return () => {} },
      },
    })
    const renderTree = (node) => {
      if (node == null || typeof node === 'boolean') return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(renderTree).join('')
      if (typeof node.tag === 'function') return renderTree(node.tag(node.props))
      return `<${node.tag}>${renderTree(node.children)}</${node.tag}>`
    }
    return renderTree(sectionComponent())
  }

  const emptyRendered = makeHarness(emptyState, null)
  assert.match(emptyRendered, /池里还没有 key/)
  assert.match(emptyRendered, /\+ 新增 Key/)

  const openRendered = makeHarness(emptyState, { where: 'top', face: 300, kind: 'vibe' })
  assert.match(openRendered, /新增 Key/)
  assert.match(openRendered, /\$300 · Vibe \(ACP\)/)
  assert.match(openRendered, /\$30 · Studio \(直连\)/)
  assert.match(openRendered, /自定义/)
  assert.match(openRendered, /优先级（越大越优先）/)
  assert.match(openRendered, /权重（同优先级分流比例）/)
  assert.match(openRendered, /保存并继续/)
  assert.match(openRendered, /确认添加/)

  const confirmRendered = makeHarness(populatedState, null, 'v1')
  assert.match(confirmRendered, /已启用/)
  assert.match(confirmRendered, /已停用/)
  assert.match(confirmRendered, /额度耗尽/)
  assert.match(confirmRendered, /优先级 0 · 权重 1/)
  assert.match(confirmRendered, /确认删除/)
  assert.match(confirmRendered, /取消/)
  assert.doesNotMatch(confirmRendered, /待用|在用|已耗尽|恢复|用完/)

  const schedRendered = makeHarness(populatedState, null, null, 'v1')
  assert.match(schedRendered, /编辑 Key/)
  assert.match(schedRendered, /优先级（越大越优先）/)
  assert.match(schedRendered, /权重（同优先级分流比例）/)
  assert.match(schedRendered, /替换 API Key（选填，留空保持不变）/)
  assert.match(schedRendered, /保存修改/)
})

function makeAcpImage(id, offloaded = false) {
  return {
    type: 'image',
    attachment: {
      attachmentId: `sha256:${id.padEnd(64, '0')}`,
      name: `${id}.png`,
      mediaType: 'image/png',
      width: 64,
      height: 64,
      bytes: 128,
    },
    ...(offloaded ? { offloaded: true } : {}),
  }
}

test('ACP mode enforces 20-image budget across turns/tool screenshots, recovers from 3051, and surfaces -31007 guidance', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-acp-images-'))
  const exhaustedKeys = []
  const runtime = new VibeAcpRuntime({
    dshHome: home,
    cacheDir: join(home, 'cache-vibe'),
    sourceVibeHome: join(home, 'no-src'),
    getUpstream: () => 'https://api.mistral.ai',
    getVibeCommand: () => FAKE_VIBE_ACP,
    selectVibeKey: () => makeKey('v1', 300),
    exhaustKey: (k, reason) => exhaustedKeys.push({ id: k.id, reason }),
    recordUsage: () => {},
    resolveImage: async () => ({ data: 'AAAA', mimeType: 'image/png' }),
    resolveImagePath: (ref) => `/ro/acp/${ref.name}`,
  })

  try {
    // 1. 20 images across 5 user turns (4 each, respecting vibe-acp <= 8/msg) succeed.
    const history20 = []
    for (let t = 0; t < 5; t += 1) {
      history20.push({
        id: `u${t}`,
        role: 'user',
        source: { kind: 'user' },
        content: [
          ...Array.from({ length: 4 }, (_, j) => makeAcpImage(`t${t}i${j}`)),
          { type: 'text', text: `ECHO_IMAGE_COUNT:turn${t}` },
        ],
      })
      const chunks = await collect(runtime.stream({
        provider: 'mistral-vibe',
        model: 'deepseek-v4-1-flash-1017',
        sessionId: 'sess-img-turns',
        messages: [...history20],
      }))
      assert.equal(chunks.at(-1).reason.kind, 'stop')
      const reply = chunks.find((c) => c.type === 'text-delta').text
      assert.match(reply, /imgs=4/)
      history20.push({
        id: `a${t}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'mistral-vibe', model: 'deepseek-v4-1-flash-1017' },
        content: [{ type: 'text', text: reply }],
      })
    }

    // 2. 21st image triggers IMAGE_OFFLOAD_REQUIRED (offloadImages === 4).
    const history21 = [
      ...history20,
      {
        id: 'u5',
        role: 'user',
        source: { kind: 'user' },
        content: [makeAcpImage('t5i0'), { type: 'text', text: 'ECHO_IMAGE_COUNT:turn5' }],
      },
    ]
    const over21 = await collect(runtime.stream({
      provider: 'mistral-vibe',
      model: 'deepseek-v4-1-flash-1017',
      sessionId: 'sess-img-turns',
      messages: history21,
    }))
    assert.equal(over21.at(-1).reason.kind, 'error')
    assert.equal(over21.at(-1).reason.failure.code, 'IMAGE_OFFLOAD_REQUIRED')
    assert.equal(over21.at(-1).reason.failure.offloadImages, 4)

    // 3. After marking the first 4 images offloaded, retry rebuilds session with read-only paths and succeeds.
    const retried21 = history21.map((m, idx) => (idx === 0
      ? { ...m, content: m.content.map((b) => (b.type === 'image' ? { ...b, offloaded: true } : b)) }
      : idx === history21.length - 1
        ? { ...m, content: m.content.map((b) => (b.type === 'text' ? { ...b, text: 'ECHO_IMAGE_COUNT:ECHO_RO_PATH:turn5' } : b)) }
        : m))
    const ok21 = await collect(runtime.stream({
      provider: 'mistral-vibe',
      model: 'deepseek-v4-1-flash-1017',
      sessionId: 'sess-img-turns',
      messages: retried21,
    }))
    assert.equal(ok21.at(-1).reason.kind, 'stop')
    const ok21Text = ok21.find((c) => c.type === 'text-delta').text
    assert.match(ok21Text, /has_ctx=true:imgs=1:ro=\/ro\/acp\/t0i0\.png/)

    // 4. Parked tool-result screenshot exceeding 20 triggers IMAGE_OFFLOAD_REQUIRED and preserves fresh tool screenshot on rebuild.
    const tools = [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
    const toolMsgs = [
      { id: 'tu0', role: 'user', source: { kind: 'user' }, content: [...Array.from({ length: 8 }, (_, i) => makeAcpImage(`tu0_${i}`)), { type: 'text', text: 'go' }] },
      { id: 'ta0', role: 'assistant', source: { kind: 'model', provider: 'mistral-vibe', model: 'deepseek-v4-1-flash-1017' }, content: [{ type: 'text', text: 'ok' }] },
      { id: 'tu1', role: 'user', source: { kind: 'user' }, content: [...Array.from({ length: 8 }, (_, i) => makeAcpImage(`tu1_${i}`)), { type: 'text', text: 'go2' }] },
      { id: 'ta1', role: 'assistant', source: { kind: 'model', provider: 'mistral-vibe', model: 'deepseek-v4-1-flash-1017' }, content: [{ type: 'text', text: 'ok2' }] },
      { id: 'tu2', role: 'user', source: { kind: 'user' }, content: [...Array.from({ length: 4 }, (_, i) => makeAcpImage(`tu2_${i}`)), { type: 'text', text: 'ECHO_IMAGE_COUNT:TRIGGER_TOOL_SCREENSHOT' }] },
    ]
    const stepTool = await collect(runtime.stream({
      provider: 'mistral-vibe',
      model: 'deepseek-v4-1-flash-1017',
      sessionId: 'sess-img-tool',
      tools,
      messages: toolMsgs,
    }))
    assert.equal(stepTool.at(-1).reason.kind, 'tool-calls')
    const callBlock = stepTool.find((c) => c.type === 'block-end' && c.block.type === 'tool-call').block
    const toolStepWith21 = [
      ...toolMsgs,
      { id: 'ta2', role: 'assistant', source: { kind: 'model', provider: 'mistral-vibe', model: 'deepseek-v4-1-flash-1017' }, content: [callBlock] },
      { id: 'tt2', role: 'tool', source: { kind: 'tool', callId: callBlock.id }, toolCallId: callBlock.id, content: [makeAcpImage('shot_new'), { type: 'text', text: 'shot_ok' }] },
    ]
    const toolOver = await collect(runtime.stream({
      provider: 'mistral-vibe',
      model: 'deepseek-v4-1-flash-1017',
      sessionId: 'sess-img-tool',
      tools,
      messages: toolStepWith21,
    }))
    assert.equal(toolOver.at(-1).reason.kind, 'error')
    assert.equal(toolOver.at(-1).reason.failure.code, 'IMAGE_OFFLOAD_REQUIRED')
    assert.equal(toolOver.at(-1).reason.failure.offloadImages, 4)

    // Mark oldest 4 in tu0 offloaded -> rebuild sends trailing tool screenshot cleanly.
    const toolRetried = toolStepWith21.map((m, idx) => {
      if (idx !== 0) return m
      let off = 0
      return {
        ...m,
        content: m.content.map((b) => (b.type === 'image' && off++ < 4 ? { ...b, offloaded: true } : b)),
      }
    })
    const toolResumed = await collect(runtime.stream({
      provider: 'mistral-vibe',
      model: 'deepseek-v4-1-flash-1017',
      sessionId: 'sess-img-tool',
      tools,
      messages: toolRetried,
    }))
    assert.equal(toolResumed.at(-1).reason.kind, 'stop')
    assert.match(toolResumed.find((c) => c.type === 'text-delta').text, /imgs=1/)

    // 5. Reactive upstream 400 / code 3051 -> IMAGE_OFFLOAD_REQUIRED without exhausting key.
    const reactive3051 = await collect(runtime.stream({
      provider: 'mistral-vibe',
      model: 'deepseek-v4-1-flash-1017',
      sessionId: 'sess-3051',
      messages: [{
        id: 'r1',
        role: 'user',
        source: { kind: 'user' },
        content: [...Array.from({ length: 6 }, (_, i) => makeAcpImage(`r${i}`)), { type: 'text', text: 'TRIGGER_UPSTREAM_3051' }],
      }],
    }))
    assert.equal(reactive3051.at(-1).reason.kind, 'error')
    assert.equal(reactive3051.at(-1).reason.failure.code, 'IMAGE_OFFLOAD_REQUIRED')
    assert.equal(reactive3051.at(-1).reason.failure.offloadImages, 4)

    // 6. vibe-acp -31007 (single-message 8-image limit) -> INVALID_REQUEST with actionable guidance, no key exhaustion.
    const tooManyLocal = await collect(runtime.stream({
      provider: 'mistral-vibe',
      model: 'deepseek-v4-1-flash-1017',
      sessionId: 'sess-31007',
      messages: [{
        id: 'l1',
        role: 'user',
        source: { kind: 'user' },
        content: [...Array.from({ length: 10 }, (_, i) => makeAcpImage(`l${i}`)), { type: 'text', text: 'TRIGGER_VIBE_TOO_MANY_IMAGES' }],
      }],
    }))
    assert.equal(tooManyLocal.at(-1).reason.kind, 'error')
    assert.equal(tooManyLocal.at(-1).reason.failure.code, 'INVALID_REQUEST')
    assert.match(tooManyLocal.at(-1).reason.failure.message, /8 张图片/)
    assert.match(tooManyLocal.at(-1).reason.failure.message, /直连模式/)
    assert.equal(exhaustedKeys.length, 0)
  } finally {
    await runtime.dispose()
  }
})
