// Contract tests for the route-health intervention level (`degradeAction`).
//
// The default level (`truncation`) only refuses an Argon step whose billed
// input was cut to the 128K ceiling, the one signal that proves the model did
// not see the request. Speed, cache-granularity, and thinking-depth signals
// are recorded and shown, but the answer or tool call is delivered and the
// tool call still goes through the harness's own permissions. `observe` never
// refuses. Whatever the level, one user turn gets at most four automatic
// re-answers across all of its tool steps.
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

/**
 * Runtime over the scripted fake agent. `plan` is handed to the fake through
 * `FAKE_AGY_PLAN`: the n-th `session/prompt` of the child process answers with
 * the n-th entry, so a test scripts the exact attempt sequence of one request
 * across sessions and retries.
 */
function makeRuntime({ config: configExtra = {}, host = {}, plan, env: envExtra = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-policy-test-'))
  const log = join(home, 'prompts.jsonl')
  const lifecycleFile = join(home, 'lifecycle.jsonl')
  const config = {
    provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
    // The machine account is an ordinary list entry that reuses this Mac's login.
    accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
    contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
    longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000, ...configExtra,
  }
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
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
    ...host,
  })
  runtimes.push(runtime)
  const readJsonl = file => existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return {
    home,
    runtime,
    prompts: () => readJsonl(log),
    /** ACP session/new, session/load, and session/close in arrival order. */
    lifecycle: () => readJsonl(lifecycleFile),
    adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true),
  }
}

after(async () => { for (const runtime of runtimes) await runtime.dispose() })

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (id, content) => ({ id, role: 'assistant', content, source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' } })
const tool = (id, callId, text) => ({ id, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId } })
const bash = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }
const readFile = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
/** Collect one step until it fails; the chunks streamed before the failure stay inspectable. */
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
const reasoningOf = chunks => chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
const callsOf = chunks => chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call').map(c => c.block)
const assistantFrom = (id, chunks) => assistant(id, chunks.filter(c => c.type === 'block-end').map(c => c.block))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
/** The reroll continuation the plugin sends inside a warm ACP session. */
const NOTICE = '[HARNESS_NOTICE]'
const HISTORY = /<dsh_history>/

// gen_metadata fixtures: a 0-thought fallback answer under high effort (+7:
// shallow thought, block cache, fast decode), a truncated 128K thinking answer
// (+7: context truncation, block cache), a fallback tool step (+3), and two
// healthy answers the fingerprint must never flag.
const DEGRADED_NO_THOUGHT = { cwmEstTokens: 32_736, inputTokens: 3_437, cachedReadTokens: 18_432, outputTokens: 276, thoughtTokens: 0, textOutTokens: 276, ttftSeconds: 2.06, streamSeconds: 1.16 }
const DEGRADED_WITH_THOUGHT = { cwmEstTokens: 378_421, inputTokens: 3_069, cachedReadTokens: 124_928, outputTokens: 90, thoughtTokens: 1_120, textOutTokens: 75, ttftSeconds: 3.1, streamSeconds: 0.4 }
const DEGRADED_TOOL = { cwmEstTokens: 32_000, inputTokens: 21_451, cachedReadTokens: 0, outputTokens: 73, thoughtTokens: 0, textOutTokens: 73, ttftSeconds: 3.78, streamSeconds: 0.06 }
const HEALTHY_TEXT = { cwmEstTokens: 385_000, inputTokens: 4_999, cachedReadTokens: 380_062, outputTokens: 420, thoughtTokens: 1_102, textOutTokens: 318, ttftSeconds: 13.4, streamSeconds: 6.2 }
const HEALTHY_TOOL = { cwmEstTokens: 32_500, inputTokens: 4_110, cachedReadTokens: 21_453, outputTokens: 180, thoughtTokens: 920, textOutTokens: 40, ttftSeconds: 11.2, streamSeconds: 1.1 }

const argonStep = (messages, extra = {}) => ({
  provider: 'antigravity', model: 'gemini-4-argon', reasoningEffort: 'high', messages, ...extra,
})


const TRUNCATED_TOOL = { ...DEGRADED_WITH_THOUGHT, outputTokens: 60, textOutTokens: 20 }

test('P1 by default a fast zero-thought answer is delivered on the first attempt and stays on record', { timeout: 60_000 }, async () => {
  const { adapter, prompts, runtime } = makeRuntime({
    plan: [{ gen: DEGRADED_NO_THOUGHT, text: 'Quota display fixed.' }],
  })
  const step = await failedStep(adapter.stream(argonStep([sys, user('u1', 'fix the quota display')], { sessionId: 'P1', tools: [bash] })))
  assert.equal(step.error, undefined, `no refusal for a speed/cache/thinking verdict: ${step.error?.message}`)
  assert.equal(finishOf(step.chunks).reason.kind, 'stop')
  assert.equal(textOf(step.chunks), 'Quota display fixed.')
  assert.equal(prompts().length, 1, 'no re-answer prompt')
  const health = runtime.sessionHealthFor('P1')
  assert.equal(health?.degraded, true, 'the verdict is still shown')
  assert.equal(health?.interceptedSteps, 0, 'nothing was refused')
})

test('P2 by default a flagged first tool call in a cold session reaches the harness instead of being cancelled', { timeout: 60_000 }, async () => {
  const { adapter, prompts, lifecycle, runtime } = makeRuntime({
    plan: [{ gen: DEGRADED_TOOL, tool: { name: 'bash', args: { command: 'ls' } }, text: '' }],
  })
  const step = await failedStep(adapter.stream(argonStep([sys, user('u1', 'list the workspace')], { sessionId: 'P2', tools: [bash] })))
  assert.equal(step.error, undefined, `the tool gate must not kill the step: ${step.error?.message}`)
  assert.equal(finishOf(step.chunks).reason.kind, 'tool-calls')
  const calls = callsOf(step.chunks)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' })
  assert.equal(prompts().length, 1)
  assert.equal(lifecycle().filter(e => e.op === 'new').length, 1, 'no replacement session')
  assert.equal(runtime.sessionHealthFor('P2')?.degraded, true, 'the gate verdict is recorded')
})

test('P3 by default a 128K-truncated answer is still refused and re-answered', { timeout: 60_000 }, async () => {
  const { adapter, prompts } = makeRuntime({
    plan: [
      { gen: DEGRADED_WITH_THOUGHT, thought: 'Checking the handler.', text: 'Truncated answer.' },
      { gen: HEALTHY_TEXT, thought: 'Read the full request.', text: 'Full answer.' },
    ],
  })
  const messages = [sys, user('u1', 'where is the quota handler')]
  const first = await failedStep(adapter.stream(argonStep(messages, { sessionId: 'P3' })))
  assert.equal(first.error?.code, 'DEGRADED_ROUTE', 'context truncation proves the model did not see the request')
  const second = await collect(adapter.stream(argonStep(messages, { sessionId: 'P3' })))
  assert.equal(textOf(second), 'Full answer.')
  assert.equal(prompts().length, 2)
})

test('P4 by default a 128K-truncated tool call is refused before it runs', { timeout: 60_000 }, async () => {
  const { adapter } = makeRuntime({
    plan: [
      { gen: HEALTHY_TEXT, thought: 'Ready.', text: 'Ready.' },
      { gen: TRUNCATED_TOOL, tool: { name: 'bash', args: { command: 'make clean' } }, text: '' },
    ],
  })
  const warm = await collect(adapter.stream(argonStep([sys, user('u1', 'hi')], { sessionId: 'P4', tools: [bash] })))
  const gated = await failedStep(adapter.stream(argonStep([sys, user('u1', 'hi'), assistantFrom('a1', warm), user('u2', 'clean the build')], { sessionId: 'P4', tools: [bash] })))
  assert.equal(gated.error?.code, 'DEGRADED_ROUTE')
  assert.deepEqual(callsOf(gated.chunks), [], 'the truncated tool call never reaches the harness')
})

test('P5 observe never refuses, even a 128K-truncated answer', { timeout: 60_000 }, async () => {
  const { adapter, prompts, runtime } = makeRuntime({
    config: { degradeAction: 'observe' },
    plan: [{ gen: DEGRADED_WITH_THOUGHT, thought: 'Checking the handler.', text: 'Delivered as is.' }],
  })
  const step = await failedStep(adapter.stream(argonStep([sys, user('u1', 'where is the quota handler')], { sessionId: 'P5' })))
  assert.equal(step.error, undefined)
  assert.equal(textOf(step.chunks), 'Delivered as is.')
  assert.equal(prompts().length, 1)
  assert.equal(runtime.sessionHealthFor('P5')?.degraded, true, 'observation still records the verdict')
})

test('P6 one user turn shares one re-answer budget across its tool steps', { timeout: 120_000 }, async () => {
  const { adapter, prompts } = makeRuntime({
    config: { degradeAction: 'legacy' },
    plan: [
      { gen: DEGRADED_NO_THOUGHT, text: '第一次。' },
      { gen: DEGRADED_NO_THOUGHT, text: '第二次。' },
      // The tool step runs in the session the second re-answer escaped into; that
      // turn ended on its tool call, so the result is delivered as a new prompt.
      { gen: HEALTHY_TOOL, thought: 'Inspecting.', tool: { name: 'bash', args: { command: 'ls' } }, text: '' },
      { gen: DEGRADED_NO_THOUGHT, text: '第三次。' },
      { gen: DEGRADED_NO_THOUGHT, text: '第四次。' },
      { gen: DEGRADED_NO_THOUGHT, text: '第五次照样交付。' },
    ],
  })
  const messages = [sys, user('u1', 'inspect and report')]
  const stepA = () => adapter.stream(argonStep(messages, { sessionId: 'P6', tools: [bash] }))
  assert.equal((await failedStep(stepA())).error?.code, 'DEGRADED_ROUTE', 're-answer 1 of the turn')
  assert.equal((await failedStep(stepA())).error?.code, 'DEGRADED_ROUTE', 're-answer 2 of the turn')
  const toolStep = await collect(stepA())
  assert.equal(finishOf(toolStep).reason.kind, 'tool-calls')
  const [call] = callsOf(toolStep)

  const withResult = [...messages, assistantFrom('a1', toolStep), tool('t1', call.id, 'two files')]
  const stepB = () => adapter.stream(argonStep(withResult, { sessionId: 'P6', tools: [bash] }))
  assert.equal((await failedStep(stepB())).error?.code, 'DEGRADED_ROUTE', 're-answer 3 of the turn')
  assert.equal((await failedStep(stepB())).error?.code, 'DEGRADED_ROUTE', 're-answer 4 of the turn')
  const delivered = await failedStep(stepB())
  assert.equal(delivered.error, undefined, `the fifth flagged attempt of the same user turn is delivered: ${delivered.error?.message}`)
  assert.equal(textOf(delivered.chunks), '第五次照样交付。')
  assert.equal(prompts().length, 6, 'one prompt per attempt')
})

const carbonStep = (messages, extra = {}) => ({
  provider: 'antigravity', model: 'gemini-4-carbon', reasoningEffort: 'high', messages, ...extra,
})
const CARBON_ENV = { FAKE_AGY_EXTRA_MODELS: 'gemini-4-carbon' }

test('P7 a 128K-truncated Gemini 4 Carbon answer is refused and re-answered like Argon', { timeout: 60_000 }, async () => {
  const { adapter, prompts, runtime } = makeRuntime({
    env: CARBON_ENV,
    plan: [
      { gen: DEGRADED_WITH_THOUGHT, thought: 'Checking the handler.', text: 'Truncated answer.' },
      { gen: HEALTHY_TEXT, thought: 'Read the full request.', text: 'Full answer.' },
    ],
  })
  const messages = [sys, user('u1', 'where is the quota handler')]
  const first = await failedStep(adapter.stream(carbonStep(messages, { sessionId: 'P7' })))
  assert.equal(first.error?.code, 'DEGRADED_ROUTE', 'Carbon truncation is intercepted')
  assert.equal(prompts()[0].model, 'gemini-4-carbon')
  const second = await collect(adapter.stream(carbonStep(messages, { sessionId: 'P7' })))
  assert.equal(textOf(second), 'Full answer.')
  assert.equal(prompts().length, 2)
  assert.equal(runtime.sessionHealthFor('P7')?.interceptedSteps, 1, 'the pill counts the Carbon re-answer')
})

test('P8 a flagged Carbon tool call outside the truncation level reaches the harness and stays on record', { timeout: 60_000 }, async () => {
  const { adapter, runtime } = makeRuntime({
    env: CARBON_ENV,
    plan: [{ gen: DEGRADED_TOOL, tool: { name: 'bash', args: { command: 'ls' } }, text: '' }],
  })
  const step = await failedStep(adapter.stream(carbonStep([sys, user('u1', 'list the workspace')], { sessionId: 'P8', tools: [bash] })))
  assert.equal(step.error, undefined, `the Carbon gate must not kill the step: ${step.error?.message}`)
  assert.equal(finishOf(step.chunks).reason.kind, 'tool-calls')
  const health = runtime.sessionHealthFor('P8')
  assert.equal(health?.degraded, true, 'the Carbon gate verdict is published')
  assert.equal(health?.model, 'gemini-4-carbon')
})

test('P9 configure switches degradeAction live without a restart', { timeout: 120_000 }, async () => {
  const { adapter, prompts, runtime } = makeRuntime({
    plan: [
      { gen: DEGRADED_WITH_THOUGHT, thought: 'Checking.', text: 'Observed as is.' },
      { gen: DEGRADED_NO_THOUGHT, text: 'Refused under legacy.' },
      { gen: HEALTHY_TEXT, thought: 'Re-read.', text: 'Legacy re-answer.' },
    ],
  })
  assert.equal(runtime.status().degradeAction, 'truncation', 'the schema default applies until changed')
  assert.equal(runtime.configure({ degradeAction: 'observe' }).degradeAction, 'observe')
  const observed = await failedStep(adapter.stream(argonStep([sys, user('u1', 'first question')], { sessionId: 'P9' })))
  assert.equal(observed.error, undefined, 'observe delivers even a truncated answer')
  assert.equal(textOf(observed.chunks), 'Observed as is.')

  assert.equal(runtime.configure({ degradeAction: 'legacy' }).degradeAction, 'legacy')
  const messages = [sys, user('u1', 'first question'), assistantFrom('a1', observed.chunks), user('u2', 'second question')]
  const refused = await failedStep(adapter.stream(argonStep(messages, { sessionId: 'P9' })))
  assert.equal(refused.error?.code, 'DEGRADED_ROUTE', 'legacy refuses a speed/thinking verdict on the very next step')
  const reanswered = await collect(adapter.stream(argonStep(messages, { sessionId: 'P9' })))
  assert.equal(textOf(reanswered), 'Legacy re-answer.')
  assert.equal(prompts().length, 3)
})

test('P10 a volatile degradeAction config field is read on every verdict', { timeout: 60_000 }, async () => {
  let level = 'observe'
  const { adapter, runtime } = makeRuntime({
    config: { degradeAction: { get: () => level } },
    plan: [
      { gen: DEGRADED_WITH_THOUGHT, thought: 'Checking.', text: 'Observed.' },
      { gen: DEGRADED_WITH_THOUGHT, thought: 'Checking.', text: 'Truncated again.' },
    ],
  })
  assert.equal(runtime.status().degradeAction, 'observe')
  const first = await failedStep(adapter.stream(argonStep([sys, user('u1', 'q1')], { sessionId: 'P10' })))
  assert.equal(first.error, undefined)
  level = 'truncation'
  assert.equal(runtime.status().degradeAction, 'truncation', 'the settings write is visible without a restart')
  const second = await failedStep(adapter.stream(argonStep([sys, user('u1', 'q1'), assistantFrom('a1', first.chunks), user('u2', 'q2')], { sessionId: 'P10' })))
  assert.equal(second.error?.code, 'DEGRADED_ROUTE')
})
