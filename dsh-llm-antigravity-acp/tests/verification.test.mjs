// Google account verification (Cloud Code 403 VALIDATION_REQUIRED): URL validation,
// multi-endpoint precedence, QuotaReader behavior without `agy /usage` fallback,
// AUTH mapping, legacy provider transcript ownership, multi-account failover, and
// automatic single-account recovery after browser verification completes.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  inspectCloudCodeAccount,
  parseVerificationRequired,
  VerificationRequiredError,
} from '../lib/cloudcode.js'
import { QuotaReader } from '../lib/quota.js'
import { isOwnMessage } from '../lib/acp-session.js'
import { AntigravityRuntime, mapError } from '../lib/runtime.js'
import { AntigravityAdapter } from '../lib/adapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
const runtimes = []

const VERIFY_URL = 'https://accounts.google.com/v3/signin/continue?plt=EXAMPLE&flowName=GlifWebSignIn'

// Payload observed from `v1internal:retrieveUserQuotaSummary` while Google asks for verification.
const VALIDATION_BODY = {
  error: {
    code: 403,
    message: 'Verify your account to continue.',
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'VALIDATION_REQUIRED',
        domain: 'cloudcode-pa.googleapis.com',
        metadata: {
          validation_error_message: 'Verify your account to continue.',
          validation_url_link_text: 'Verify your account',
          validation_url: VERIFY_URL,
          validation_learn_more_url: 'https://support.google.com/accounts?p=al_alert',
        },
      },
      {
        '@type': 'type.googleapis.com/google.rpc.Help',
        links: [
          { description: 'Learn more', url: 'https://support.google.com/accounts?p=al_alert' },
          { description: 'Verify your account', url: VERIFY_URL },
        ],
      },
    ],
  },
}

const VALIDATION_NO_URL = {
  error: {
    code: 403,
    message: 'Verify your account to continue.',
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'VALIDATION_REQUIRED',
      },
    ],
  },
}

function writeTokenFile(appDir, email = 'user@example.com', accessToken = 'tok') {
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'antigravity-oauth-token'), JSON.stringify({
    id_token_email: email,
    token: { access_token: accessToken, refresh_token: 'refresh', expiry: new Date(Date.now() + 3_600_000).toISOString() },
  }))
}

function accountLayout() {
  const root = mkdtempSync(join(tmpdir(), 'agy-verify-'))
  const appDir = join(root, 'agy')
  writeTokenFile(appDir)
  return {
    id: 'acc-1', label: '', root, declaredHome: '', homeDir: join(root, 'home'), geminiDir: root, appDir,
    workspace: join(root, 'ws'), logFile: join(root, 'acp.log'), env: {}, contextWindow: 0,
    visibleModels: [], enabled: true, system: false,
  }
}

/** Cloud Code transport where only the quota summary demands verification. */
function transport(verify) {
  return async (url) => {
    if (url.endsWith(':loadCodeAssist')) return { status: 200, body: { cloudaicompanionProject: 'proj-1', currentTier: { id: 'free-tier' } } }
    if (url.endsWith(':retrieveUserQuotaSummary')) return verify ? { status: 403, body: VALIDATION_BODY } : { status: 200, body: { groups: [] } }
    if (url.endsWith(':fetchAvailableModels')) return { status: 200, body: { models: {} } }
    throw new Error(`unexpected ${url}`)
  }
}

function makeAccount(id, { withToken = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), `agy-verify-rt-${id}-`))
  const geminiDir = join(root, 'gemini')
  if (withToken) writeTokenFile(join(geminiDir, 'agy'), `${id}@example.com`, `tok-${id}`)
  return {
    root,
    homeDir: join(root, 'home'),
    profile: { id, displayName: `${id} account`, home: root, enabled: true, env: {} },
  }
}

function makeRuntime({ accounts = [], verifyAccounts = [], cloudCodeTransport } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agy-verify-runtime-'))
  const verifyHomes = new Set(verifyAccounts.map(entry => entry.homeDir))
  const warnings = []
  const config = {
    provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
    accounts: accounts.map(entry => entry.profile),
    contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
    maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
    longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000,
  }
  const runtime = new AntigravityRuntime({
    config,
    spawnAcp: (argv, cwd, env) => {
      const childEnv = { ...process.env, ...env }
      delete childEnv.FAKE_AGY_FAIL
      childEnv.FAKE_AGY_LOG = join(env?.HOME ?? home, 'prompts.jsonl')
      if (env?.HOME !== undefined && verifyHomes.has(env.HOME)) childEnv.FAKE_AGY_FAIL = 'verify'
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
    runCommand: async (argv) => {
      if (argv.includes('--version')) return { code: 0, stdout: 'fake-agy 0.0.1', stderr: '' }
      if (argv.includes('find-generic-password')) return { code: 1, stdout: '', stderr: 'not found' }
      return { code: 0, stdout: '{}', stderr: '' }
    },
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: { info: () => undefined, warn: message => { warnings.push(message) } },
    onModelsChanged: () => undefined,
    cloudCodeTransport,
  })
  runtimes.push(runtime)
  const prompts = (entry) => {
    const file = join(entry.homeDir, 'prompts.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }
  return { runtime, warnings, prompts, adapter: new AntigravityAdapter(runtime, 'Antigravity', () => true) }
}

after(async () => { for (const runtime of runtimes) await runtime.dispose() })

const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

async function rejectionOf(iterable) {
  try {
    await collect(iterable)
  } catch (error) {
    return error
  }
  assert.fail('the step resolved instead of failing')
}

test('parseVerificationRequired extracts Google verification URLs and rejects non-Google or support links', () => {
  assert.deepEqual(parseVerificationRequired(VALIDATION_BODY), { message: 'Verify your account to continue.', verificationUrl: VERIFY_URL })
  assert.equal(parseVerificationRequired(JSON.stringify(VALIDATION_BODY))?.verificationUrl, VERIFY_URL)
  assert.equal(parseVerificationRequired(`PERMISSION_DENIED VALIDATION_REQUIRED ${VERIFY_URL}"`)?.verificationUrl, VERIFY_URL)
  assert.equal(parseVerificationRequired({ error: { code: 403, message: 'The caller does not have permission' } }), undefined)

  const evilBody = {
    error: {
      code: 403,
      message: 'Verify your account to continue.',
      details: [{
        reason: 'VALIDATION_REQUIRED',
        metadata: { validation_url: 'https://evil.example.com/phish' },
      }],
    },
  }
  assert.deepEqual(parseVerificationRequired(evilBody), { message: 'Verify your account to continue.' })
})

test('inspectCloudCodeAccount prefers a 403 carrying validation_url and raises VerificationRequiredError even when models returns 200', async () => {
  await assert.rejects(
    inspectCloudCodeAccount({
      layout: accountLayout(),
      platform: 'linux',
      runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
      transport: async (url) => {
        if (url.endsWith(':loadCodeAssist')) return { status: 403, body: VALIDATION_NO_URL }
        if (url.endsWith(':retrieveUserQuotaSummary')) return { status: 403, body: VALIDATION_BODY }
        if (url.endsWith(':fetchAvailableModels')) return { status: 200, body: { models: {} } }
        throw new Error(`unexpected ${url}`)
      },
    }),
    (error) => error instanceof VerificationRequiredError && error.code === 'VALIDATION_REQUIRED' && error.verificationUrl === VERIFY_URL,
  )
})

test('QuotaReader reports verification demand instead of falling back to agy /usage', async () => {
  let agyRan = false
  const run = async () => { agyRan = true; return { code: 0, stdout: '{}', stderr: '' } }
  const layout = accountLayout()
  const pending = new QuotaReader(() => '/usr/bin/agy', run, 60_000, transport(true))
  const snapshot = await withPlatform('linux', () => pending.readFor('acc-1', {}, true, layout))
  assert.equal(snapshot.status, 'error')
  assert.equal(snapshot.verificationRequired, true)
  assert.equal(snapshot.verificationUrl, VERIFY_URL)
  assert.equal(agyRan, false)

  const fine = new QuotaReader(() => '/usr/bin/agy', run, 60_000, transport(false))
  const ok = await withPlatform('linux', () => fine.readFor('acc-1', {}, true, layout))
  assert.equal(ok.status, 'ok')
  assert.equal(ok.verificationRequired, undefined)
})

test('mapError classifies a verification demand as AUTH', () => {
  const mapped = mapError(new Error('Verify your account to continue.'))
  assert.equal(mapped.code, 'AUTH')
  assert.match(mapped.message, /Verify/)
})

test('isOwnMessage owns transcripts saved under both `antigravity` and `antigravity-acp`', () => {
  const said = (provider) => ({ role: 'assistant', source: { kind: 'model', provider } })
  assert.equal(isOwnMessage(said('antigravity'), 'antigravity', new Set()), true)
  assert.equal(isOwnMessage(said('antigravity-acp'), 'antigravity', new Set()), true)
  assert.equal(isOwnMessage(said('deepseek'), 'antigravity', new Set()), false)
})

test('AntigravityRuntime fails over away from an unverified account and skips it on subsequent steps', async () => {
  const a = makeAccount('a')
  const b = makeAccount('b')
  const { runtime, adapter, prompts } = makeRuntime({
    accounts: [a, b],
    verifyAccounts: [a],
    cloudCodeTransport: async (url, headers) => {
      const isA = headers.authorization === 'Bearer tok-a'
      if (url.endsWith(':loadCodeAssist')) return { status: 200, body: { cloudaicompanionProject: 'proj-1', currentTier: { id: 'free-tier' } } }
      if (url.endsWith(':retrieveUserQuotaSummary')) return isA ? { status: 403, body: VALIDATION_BODY } : { status: 200, body: { groups: [] } }
      if (url.endsWith(':fetchAvailableModels')) return { status: 200, body: { models: {} } }
      throw new Error(`unexpected ${url}`)
    },
  })

  await runtime.refreshAccountEmails()
  const beforeA = runtime.accounts().find(row => row.id === 'a')
  assert.equal(beforeA?.verificationRequired, true)
  assert.equal(beforeA?.verificationUrl, VERIFY_URL)

  // First turn skips `a` directly onto `b`.
  const first = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'V1',
    messages: [sys, user('u1', 'VERIFY step')],
  }))
  assert.equal(first.at(-1).reason.kind, 'stop')
  assert.equal(prompts(a).length, 0)
  assert.equal(prompts(b).length, 1)

  // Now simulate runtime prompt failover on a fresh pool where `a2` passed startup check and hits VERIFY at prompt time.
  let aNeedsVerify = false
  const a2 = makeAccount('a2')
  const b2 = makeAccount('b2')
  const rt2 = makeRuntime({
    accounts: [a2, b2],
    verifyAccounts: [a2],
    cloudCodeTransport: async (url, headers) => {
      const isA2 = headers.authorization === 'Bearer tok-a2'
      if (url.endsWith(':loadCodeAssist')) return { status: 200, body: { cloudaicompanionProject: 'proj-1', currentTier: { id: 'free-tier' } } }
      if (url.endsWith(':retrieveUserQuotaSummary')) return (isA2 && aNeedsVerify) ? { status: 403, body: VALIDATION_BODY } : { status: 200, body: { groups: [] } }
      if (url.endsWith(':fetchAvailableModels')) return { status: 200, body: { models: {} } }
      throw new Error(`unexpected ${url}`)
    },
  })
  await rt2.runtime.refreshAccountEmails()
  aNeedsVerify = true
  const step = await collect(rt2.adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'V2',
    messages: [sys, user('u1', 'VERIFY failover')],
  }))
  assert.equal(step.at(-1).reason.kind, 'stop')
  assert.equal(rt2.prompts(a2).length, 1)
  assert.equal(rt2.prompts(b2).length, 1)
  await rt2.runtime.quotaFor('a2', true)
  const rowA2 = rt2.runtime.accounts().find(row => row.id === 'a2')
  assert.equal(rowA2?.verificationRequired, true)
  assert.equal(rowA2?.verificationUrl, VERIFY_URL)

  // Subsequent turn goes straight to `b2` without prompting `a2` again.
  const followUp = await collect(rt2.adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'V2',
    messages: [sys, user('u1', 'VERIFY failover'), { id: 'as1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model', provider: 'antigravity', model: 'gemini-3.8-flash' } }, user('u2', 'next turn')],
  }))
  assert.equal(followUp.at(-1).reason.kind, 'stop')
  assert.equal(rt2.prompts(a2).length, 1)
  assert.equal(rt2.prompts(b2).length, 2)
})

test('single-account runtime throws AUTH when verification is required and auto-recovers once Cloud Code clears', async () => {
  let cloudVerify = false
  const a = makeAccount('solo')
  const { runtime, adapter, prompts } = makeRuntime({
    accounts: [a],
    verifyAccounts: [a],
    cloudCodeTransport: async (url) => {
      if (url.endsWith(':loadCodeAssist')) return { status: 200, body: { cloudaicompanionProject: 'proj-1', currentTier: { id: 'free-tier' } } }
      if (url.endsWith(':retrieveUserQuotaSummary')) return cloudVerify ? { status: 403, body: VALIDATION_BODY } : { status: 200, body: { groups: [] } }
      if (url.endsWith(':fetchAvailableModels')) return { status: 200, body: { models: {} } }
      throw new Error(`unexpected ${url}`)
    },
  })

  await runtime.refreshAccountEmails()
  cloudVerify = true

  const firstErr = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'SOLO1',
    messages: [sys, user('u1', 'VERIFY first')],
  }))
  assert.equal(firstErr.code, 'AUTH')
  assert.match(firstErr.message, /Verify your account/i)
  assert.equal(prompts(a).length, 1)

  // While Cloud Code still demands verification, the next request re-probes Cloud Code
  // and stays rejected with AUTH without hitting the ACP process again.
  const secondErr = await rejectionOf(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'SOLO1',
    messages: [sys, user('u2', 'second try')],
  }))
  assert.equal(secondErr.code, 'AUTH')
  assert.equal(prompts(a).length, 1)
  assert.equal(runtime.accounts().find(row => row.id === 'solo')?.verificationRequired, true)

  // Once the user finishes verification in browser (Cloud Code answers 200),
  // the next request clears the pending verification and succeeds.
  cloudVerify = false
  const recovered = await collect(adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    sessionId: 'SOLO1',
    messages: [sys, user('u3', 'recovered')],
  }))
  assert.equal(recovered.at(-1).reason.kind, 'stop')
  assert.equal(prompts(a).length, 2)
  assert.equal(runtime.accounts().find(row => row.id === 'solo')?.verificationRequired, undefined)
})

async function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}
