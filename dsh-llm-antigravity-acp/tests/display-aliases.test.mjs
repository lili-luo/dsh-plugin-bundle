import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AntigravityRuntime } from '../lib/runtime.js'
import { AntigravityAdapter } from '../lib/adapter.js'
import { AntigravityRemote, parseConfigureRequest } from '../lib/remote.js'

function fixture(extra = {}) {
  const runtime = new AntigravityRuntime({
    config: {
      provider: 'antigravity',
      displayName: 'Antigravity',
      modelDisplayNames: {},
      home: mkdtempSync(join(tmpdir(), 'agy-aliases-')),
      accounts: [],
      visibleModels: [],
      defaultEffort: 'high',
      contextWindow: 0,
      longDecodeContinuations: 3,
      idleSessionTtlMs: 600_000,
      keepAliveMs: 15_000,
      quotaTtlMs: 120_000,
      ...extra,
    },
    log: { info() {}, warn() {} },
    onModelsChanged() {},
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  runtime.catalog.observe([{ id: 'model', category: 'model', currentValue: 'gemini-4-argon', options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }] }])
  return { runtime, adapter: new AntigravityAdapter(runtime, 'Antigravity', () => false) }
}

test('aliases change presentation consistently without touching route, catalog or generation options', async () => {
  const { runtime, adapter } = fixture()
  try {
    const original = await adapter.resolveModel('antigravity', 'gemini-4-argon')
    runtime.configure(parseConfigureRequest({ displayName: ' My Google ', modelDisplayNames: { 'gemini-4-argon': ' My Reasoner ' } }))
    assert.deepEqual(adapter.providerInfo('antigravity'), { id: 'antigravity', name: 'My Google' })
    const models = await adapter.listModels('antigravity')
    assert.equal(models[0].id, 'gemini-4-argon')
    assert.equal(models[0].name, 'My Reasoner')
    assert.deepEqual(await adapter.resolveModel('antigravity', 'gemini-4-argon'), { ...original, name: 'My Reasoner' })
    assert.equal(runtime.catalog.find('gemini-4-argon').name, original.name, 'discovered names stay canonical')
    const request = { provider: 'antigravity', model: 'gemini-4-argon', reasoningEffort: 'high' }
    runtime.stream = (options) => { assert.equal(options, request); return [] }
    adapter.stream(request)
    runtime.configure({ contextWindow: 256_000 })
    assert.equal((await adapter.listModels('antigravity'))[0].name, 'My Reasoner', 'unrelated patches preserve names')
    runtime.configure(parseConfigureRequest({ displayName: '', modelDisplayNames: {} }))
    assert.equal(adapter.providerInfo('antigravity').name, 'Antigravity')
    assert.equal((await adapter.listModels('antigravity'))[0].name, original.name)
  } finally { await runtime.dispose() }
})

test('configure persists aliases and a new runtime restores them including undiscovered models', async () => {
  const { runtime } = fixture()
  const ctx = new Context(), stored = {}
  ctx.provide('settings', { writable: true, update: async (ns, patch) => { assert.equal(ns, 'llm-antigravity-acp'); Object.assign(stored, patch) } })
  const remote = new AntigravityRemote(ctx, { runtime, settingsNs: 'llm-antigravity-acp' })
  let reopened
  try {
    const status = await remote.configure({ displayName: 'My Google', modelDisplayNames: { 'gemini-4-argon': 'Reasoner', 'offline-model': 'Offline' } })
    assert.equal(status.displayName, 'My Google')
    assert.equal(status.modelDisplayNames['offline-model'], 'Offline')
    reopened = fixture(stored)
    assert.equal(reopened.adapter.providerInfo('antigravity').name, 'My Google')
    assert.equal((await reopened.adapter.listModels('antigravity'))[0].name, 'Reasoner')
    assert.equal(reopened.runtime.status().modelDisplayNames['offline-model'], 'Offline')
    await assert.rejects(remote.configure({ modelDisplayNames: { bad: 'line\nbreak' } }), /display|name/i)
    assert.equal(runtime.status().modelDisplayNames['gemini-4-argon'], 'Reasoner')
  } finally { await runtime.dispose(); await reopened?.runtime.dispose() }
})

test('a refused persistence never applies a misleading live alias', async () => {
  const { runtime, adapter } = fixture()
  const ctx = new Context()
  ctx.provide('settings', { writable: true, update: async () => { throw new Error('read-only profile') } })
  const remote = new AntigravityRemote(ctx, { runtime, settingsNs: 'llm-antigravity-acp' })
  try {
    await assert.rejects(remote.configure({ displayName: 'Not saved' }), /read-only/)
    assert.equal(adapter.providerInfo('antigravity').name, 'Antigravity')
  } finally { await runtime.dispose() }
})

test('aliases do not widen visibility or leak mutable status maps', async () => {
  const { runtime, adapter } = fixture()
  try {
    runtime.configure({ modelDisplayNames: { 'gemini-4-argon': 'Reasoner', absent: 'Hidden' }, visibleModels: ['absent'] })
    assert.deepEqual(await adapter.listModels('antigravity'), [])
    const status = runtime.status()
    status.modelDisplayNames['gemini-4-argon'] = 'Mutated'
    assert.equal(runtime.modelDisplayName('gemini-4-argon', 'fallback'), 'Reasoner')
    runtime.configure({ visibleModels: [] })
    assert.equal((await adapter.listModels('antigravity'))[0].name, 'Reasoner')
  } finally { await runtime.dispose() }
})

test('alias wire validation trims, clears blanks and treats prototype-like keys as data', () => {
  const parsed = parseConfigureRequest({ displayName: '  ', modelDisplayNames: JSON.parse('{"__proto__":"Safe","constructor":"Name","empty":"  "}') })
  assert.equal(parsed.displayName, '')
  assert.equal(Object.getPrototypeOf(parsed.modelDisplayNames), null)
  assert.equal(parsed.modelDisplayNames.__proto__, 'Safe')
  assert.equal(Object.hasOwn(parsed.modelDisplayNames, 'empty'), false)
  for (const value of [[], null, 1, { a: 1 }, { '': 'Name' }, { a: 'x'.repeat(81) }, { a: 'a\u007fb' }]) {
    assert.throws(() => parseConfigureRequest({ modelDisplayNames: value }))
  }
  for (const value of [null, 1, 'x'.repeat(81), 'x\ny']) assert.throws(() => parseConfigureRequest({ displayName: value }))
})
