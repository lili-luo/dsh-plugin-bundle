// Contract tests for the model / thinking-level selection handshake.
//
// The plugin may only record a model or a thinking level as applied after the
// agent's own `configOptions` read-back reports it. An agent that keeps
// reporting another value must fail the step with `INVALID_MODEL_CONFIG`
// before any `session/prompt` is sent, and the next step must try the switch
// again instead of trusting a cached value. A value the agent later moves on
// its own (announced through `config_option_update`) is switched back before
// the next prompt, while a session whose read-back already matches is not
// written again.
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

function makeRuntime({ env: envExtra = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-config-confirm-'))
  const log = join(home, 'prompts.jsonl')
  const configLog = join(home, 'config.jsonl')
  const config = {
    provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
    accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
    contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
    longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000, coldSwitchSettleMs: 0,
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], {
        cwd,
        env: { ...process.env, FAKE_AGY_LOG: log, FAKE_AGY_CONFIG_LOG: configLog, ...envExtra },
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
  })
  runtimes.push(runtime)
  const readJsonl = file => existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return {
    runtime,
    prompts: () => readJsonl(log),
    configWrites: () => readJsonl(configLog),
    adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true),
  }
}

after(async () => { for (const runtime of runtimes) await runtime.dispose() })

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (id, text) => ({ id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' } })

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
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const argonStep = (messages, extra = {}) => ({
  provider: 'antigravity', model: 'gemini-4-argon', reasoningEffort: 'high', messages, ...extra,
})

test('S1 a thinking level the agent never reports fails with INVALID_MODEL_CONFIG before any prompt', { timeout: 60_000 }, async () => {
  const { adapter, prompts, configWrites } = makeRuntime({ env: { FAKE_AGY_STUCK_LEVEL: 'medium' } })
  const first = await failedStep(adapter.stream(argonStep([sys, user('u1', 'hello')], { sessionId: 'S1' })))
  assert.ok(first.error !== undefined, 'a level that never sticks must fail the step')
  assert.equal(first.error.code, 'INVALID_MODEL_CONFIG', `stable code for an unapplied selection: ${first.error?.code}`)
  assert.ok(first.error.message.startsWith('[模型参数未生效]'), `labeled message: ${first.error.message}`)
  assert.match(first.error.message, /high/, 'the message names the requested level')
  assert.match(first.error.message, /medium/, 'the message names the level the agent reports')
  assert.equal(prompts().length, 0, 'no prompt is sent under an unconfirmed level')
  const levelWrites = configWrites().filter(w => w.configId === 'thought_level')
  assert.ok(levelWrites.length >= 1 && levelWrites.length <= 3, `bounded write attempts: ${levelWrites.length}`)

  const before = configWrites().filter(w => w.configId === 'thought_level').length
  const second = await failedStep(adapter.stream(argonStep([sys, user('u1', 'hello')], { sessionId: 'S1' })))
  assert.equal(second.error?.code, 'INVALID_MODEL_CONFIG', 'the next step is still refused')
  assert.ok(configWrites().filter(w => w.configId === 'thought_level').length > before, 'the next step writes the level again instead of trusting a cached value')
  assert.equal(prompts().length, 0)
})

test('S2 a model the agent never reports fails with INVALID_MODEL_CONFIG before any prompt', { timeout: 60_000 }, async () => {
  const { adapter, prompts } = makeRuntime({ env: { FAKE_AGY_STUCK_MODEL: 'gemini-3.8-flash' } })
  const first = await failedStep(adapter.stream(argonStep([sys, user('u1', 'hello')], { sessionId: 'S2' })))
  assert.equal(first.error?.code, 'INVALID_MODEL_CONFIG', `stable code for an unapplied model: ${first.error?.code}`)
  assert.match(first.error.message, /gemini-4-argon/, 'the message names the requested model')
  assert.equal(prompts().length, 0, 'no prompt is sent under an unconfirmed model')
})

test('S3 a confirmed selection is written once and every prompt runs under it', { timeout: 60_000 }, async () => {
  const { adapter, prompts, configWrites } = makeRuntime()
  const one = await collect(adapter.stream(argonStep([sys, user('u1', 'hello')], { sessionId: 'S3' })))
  assert.ok(textOf(one).length > 0)
  const writesAfterFirst = configWrites().length
  assert.ok(writesAfterFirst >= 1, 'the cold session is switched once')
  const two = await collect(adapter.stream(argonStep([sys, user('u1', 'hello'), assistant('a1', textOf(one)), user('u2', 'again')], { sessionId: 'S3' })))
  assert.ok(textOf(two).length > 0)
  assert.equal(configWrites().length, writesAfterFirst, 'a read-back that already matches is not written again')
  assert.deepEqual(prompts().map(p => [p.model, p.level]), [['gemini-4-argon', 'high'], ['gemini-4-argon', 'high']])
})

test('S4 a level the agent moves on its own is switched back before the next prompt', { timeout: 60_000 }, async () => {
  const { adapter, prompts, configWrites } = makeRuntime({ env: { FAKE_AGY_DRIFT_LEVEL: 'medium' } })
  const one = await collect(adapter.stream(argonStep([sys, user('u1', 'hello')], { sessionId: 'S4' })))
  const levelWritesAfterFirst = configWrites().filter(w => w.configId === 'thought_level').length
  await collect(adapter.stream(argonStep([sys, user('u1', 'hello'), assistant('a1', textOf(one)), user('u2', 'again')], { sessionId: 'S4' })))
  assert.ok(configWrites().filter(w => w.configId === 'thought_level').length > levelWritesAfterFirst, 'the drifted level is written again')
  assert.deepEqual(prompts().map(p => p.level), ['high', 'high'], 'both prompts run under the requested level')
})
