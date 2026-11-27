import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  addKey,
  addModel,
  applyUsage,
  blendedPrice,
  computeCost,
  createUsageTap,
  deleteKey,
  deriveBlendedRate,
  disableKey,
  effectiveModels,
  enableKey,
  exhaust,
  extractUsageDoc,
  forwardableHeaders,
  affinityOf,
  isKeyExhausted,
  isUsable,
  keyPriorityOf,
  keyWeightOf,
  leastLoaded,
  rememberAffinity,
  maskKey,
  MistralAdapter,
  nextKeyId,
  normalizeModelEntry,
  normalizeUsage,
  pickNext,
  presetForModel,
  priceFor,
  publicState,
  poolSite,
  isLoopbackSite,
  aliasOf,
  modelPrice,
  removeModel,
  resetModels,
  resolvePrice,
  resolveMaxRequestImages,
  streamDirectResponses,
  rebase,
  migratePricing,
  probeBilling,
  probeAllBilling,
  billingBalance,
  billingDueAt,
  sumUsageCost,
  updateKey,
  updateKeySchedule,
  updateModel,
  BILLING_TRUST_MS,
  BILLING_REFRESH_MS,
  BILLING_BLIND_MS,
  DEFAULT_CNY_PER_USD,
  DEFAULT_MODELS,
  PRICING_VERSION,
  remainingUsd,
  selectKey,
} from '../lib/index.js'

const key = (id, extra = {}) => ({
  id,
  account: `${id}@example.com`,
  key: `mstrl_test_${id}_0000`,
  faceUsd: 30,
  usedUsd: 0,
  status: 'active',
  tokens: { input: 0, output: 0, cached: 0 },
  requests: 0,
  ...extra,
})

test('maskKey keeps the provider prefix only', () => {
  assert.equal(maskKey('mstrl_0123456789abcdef0123456789abcdef_test'), 'mstrl_…test')
  assert.equal(maskKey('short'), '****')
})

test('computeCost bills cached tokens at their own rate', () => {
  const price = { in: 2, out: 8, cached: 0.5 }
  const { usd, priced } = computeCost({ input: 1_000_000, cached: 400_000, output: 100_000 }, price)
  assert.equal(priced, true)
  assert.equal(usd, (600_000 * 2 + 400_000 * 0.5 + 100_000 * 8) / 1_000_000)
})

test('computeCost reports an unpriced model instead of inventing a price', () => {
  assert.deepEqual(computeCost({ input: 10, output: 10 }, null), { usd: 0, priced: false })
  assert.deepEqual(computeCost({ input: 10, output: 10 }, {}), { usd: 0, priced: false })
})

test('blendedPrice turns a per-token rate into a per-million table', () => {
  const price = blendedPrice(0.000002)
  assert.equal(price.in, 2)
  assert.equal(price.out, 2)
  assert.equal(computeCost({ input: 500_000, output: 0 }, price).usd, 1)
})

test('applyUsage accumulates tokens, requests and spend', () => {
  const record = key('a')
  applyUsage(record, { input: 1000, output: 100, cached: 0 }, { in: 1, out: 2 })
  assert.equal(record.tokens.input, 1000)
  assert.equal(record.requests, 1)
  assert.equal(record.usedUsd, (1000 * 1 + 100 * 2) / 1_000_000)
  applyUsage(record, { input: 0, output: 0 }, null)
  assert.equal(record.unpriced, true)
})

test('remainingUsd clamps at zero and returns null without a face value', () => {
  assert.equal(remainingUsd({ faceUsd: 30, usedUsd: 12 }), 18)
  assert.equal(remainingUsd({ faceUsd: 30, usedUsd: 42 }), 0)
  assert.equal(remainingUsd({ faceUsd: 0, usedUsd: 1 }), null)
})

test('isUsable respects status and an exhausted balance', () => {
  assert.equal(isUsable(key('a')), true)
  assert.equal(isUsable(key('a', { status: 'exhausted' })), false)
  assert.equal(isUsable(key('a', { usedUsd: 30 })), false)
  assert.equal(isUsable(key('a', { faceUsd: 0, usedUsd: 999 })), true)
  assert.equal(isUsable(null), false)
})

test('pickNext round-robins and skips unusable keys', () => {
  const keys = [key('a'), key('b', { status: 'exhausted' }), key('c')]
  assert.equal(pickNext(keys, 'a').id, 'c')
  assert.equal(pickNext(keys, 'c').id, 'a')
  assert.equal(pickNext([key('a', { status: 'exhausted' })], 'a'), null)
  assert.equal(pickNext([], 'a'), null)
})

test('selectKey adopts the first usable key when the cursor is dead', () => {
  const store = { currentId: 'b', keys: [key('a'), key('b', { status: 'exhausted' })] }
  assert.equal(selectKey(store).id, 'a')
  assert.equal(store.currentId, 'a')
})

test('exhaust marks the key and moves the cursor', () => {
  const store = { currentId: 'a', keys: [key('a'), key('b')] }
  const next = exhaust(store, store.keys[0], '402')
  assert.equal(next.id, 'b')
  assert.equal(store.currentId, 'b')
  assert.equal(store.keys[0].status, 'exhausted')
  assert.equal(store.keys[0].lastError, '402')
})

test('isKeyExhausted distinguishes quota from a plain rate limit', () => {
  assert.equal(isKeyExhausted(401, ''), true)
  assert.equal(isKeyExhausted(402, '{}'), true)
  assert.equal(isKeyExhausted(403, ''), true)
  assert.equal(isKeyExhausted(429, '{"message":"insufficient credits"}'), true)
  assert.equal(isKeyExhausted(429, '{"message":"rate limit exceeded, retry in 1s"}'), true)
  assert.equal(isKeyExhausted(429, '{"message":"too many requests"}'), false)
  assert.equal(isKeyExhausted(500, 'boom'), false)
})

test('normalizeUsage understands both API shapes', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 2 }), { input: 5, output: 2, cached: 0 })
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }),
    { input: 9, output: 3, cached: 4 },
  )
  assert.equal(normalizeUsage({}), null)
  assert.equal(normalizeUsage(null), null)
})

test('extractUsageDoc reads the responses envelope', () => {
  const hit = extractUsageDoc({ response: { model: 'm', usage: { input_tokens: 1, output_tokens: 2 } } })
  assert.equal(hit.model, 'm')
  assert.equal(hit.usage.input, 1)
  assert.equal(extractUsageDoc({ hello: 1 }), null)
})

test('createUsageTap parses SSE and de-duplicates the final total', () => {
  const seen = []
  const tap = createUsageTap((hit) => seen.push(hit))
  tap.push('event: response.output_text.delta\ndata: {"delta":"hi"}\n\n')
  tap.push('event: response.completed\ndata: {"response":{"model":"m","usage":{"input_tokens":10,"output_tokens":4}}}\n\n')
  tap.push('event: response.completed\ndata: {"response":{"model":"m","usage":{"input_tokens":10,"output_tokens":4}}}\n\n')
  tap.end()
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].usage, { input: 10, output: 4, cached: 0 })
})

test('createUsageTap parses a whole JSON body once', () => {
  const seen = []
  const tap = createUsageTap((hit) => seen.push(hit))
  tap.expectJson()
  tap.push('{"model":"m","usage":{"input_tokens":3,')
  tap.push('"output_tokens":1}}')
  tap.end()
  assert.equal(seen.length, 1)
})

test('forwardableHeaders drops hop-by-hop headers and swaps the credential', () => {
  const headers = forwardableHeaders(
    { host: '127.0.0.1:28401', authorization: 'Bearer old', 'content-length': '3', 'x-keep': 'yes' },
    'new',
  )
  assert.equal(headers.host, undefined)
  assert.equal(headers['content-length'], undefined)
  assert.equal(headers.authorization, 'Bearer new')
  assert.equal(headers['x-keep'], 'yes')
  assert.equal(headers['accept-encoding'], 'identity')
})

test('priceFor tolerates provider prefixes', () => {
  assert.deepEqual(priceFor({ m: { in: 1 } }, 'provider/m'), { in: 1 })
  assert.equal(priceFor({}, 'm'), null)
})

test('deriveBlendedRate converts the ledger\'s CNY cost into USD', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-rate-'))
  await writeFile(
    join(home, '.dsh-usage-stats.json'),
    JSON.stringify({
      byDayModelsSite: {
        '2026-11-19': {
          flash: { 'site:https://api.mistral.ai': { calls: 2, cost: 6.79, input: 400_000, output: 100_000 } },
          other: { 'direct:opencode-go': { calls: 9, cost: 50, input: 900_000, output: 100_000 } },
        },
      },
    }),
  )
  const rate = await deriveBlendedRate(home)
  assert.equal(rate.samples, 2)
  assert.equal(rate.cnyPerUsd, DEFAULT_CNY_PER_USD)
  // ¥6.79 over 500k effective tokens is ¥13.58/M = $2/M at 6.79 CNY/USD.
  assert.equal(rate.usdPerToken, 2 / 1_000_000)
  assert.equal(rate.cnyPerToken, 13.58 / 1_000_000)
})

test('deriveBlendedRate prices pool traffic from the proxy site, not the upstream one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-site-'))
  const own = poolSite(28401)
  await writeFile(
    join(home, '.dsh-usage-stats.json'),
    JSON.stringify({
      byDayModelsSite: {
        '2026-11-19': {
          // Cheap model through the proxy: ¥1/M effective.
          flash: { [own]: { calls: 100, cost: 1, input: 1_000_000, output: 0 } },
          // Expensive model called directly, outside the pool.
          'glm-5.3': { 'site:https://api.mistral.ai': { calls: 1, cost: 100, input: 1_000_000, output: 0 } },
        },
      },
    }),
  )
  const rate = await deriveBlendedRate(home, { port: 28401 })
  // Only the direct row would have produced ¥100/M; the proxy row is what counts.
  assert.equal(rate.site, own)
  assert.equal(rate.samples, 100)
  assert.equal(rate.usdPerToken, 1 / DEFAULT_CNY_PER_USD / 1_000_000)
  // The direct row still shows up as its own model rate, unused for this site.
  assert.equal(rate.models.flash.usdPerToken, 1 / DEFAULT_CNY_PER_USD / 1_000_000)
})

test('deriveBlendedRate keeps the pool rows when the proxy port changed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-port-'))
  await writeFile(
    join(home, '.dsh-usage-stats.json'),
    JSON.stringify({
      byDayModelsSite: {
        '2026-11-19': {
          flash: { 'site:http://127.0.0.1:28401': { calls: 10, cost: 1, input: 1_000_000, output: 0 } },
          'glm-5.3': { 'site:https://api.mistral.ai': { calls: 1, cost: 100, input: 1_000_000, output: 0 } },
        },
      },
    }),
  )
  // The proxy moved to 28555; the ledger still labels its rows with the old port.
  const rate = await deriveBlendedRate(home, { port: 28555 })
  assert.equal(rate.site, 'site:http://127.0.0.1:28401')
  assert.equal(rate.usdPerToken, 1 / DEFAULT_CNY_PER_USD / 1_000_000)
  assert.ok(isLoopbackSite('site:http://127.0.0.1:28401'))
  assert.ok(isLoopbackSite('site:http://localhost:8080'))
  assert.ok(!isLoopbackSite('site:https://api.mistral.ai'))
  assert.ok(!isLoopbackSite('direct:opencode-go'))
})

test('deriveBlendedRate keeps per-model rates apart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-models-'))
  const own = poolSite(28401)
  await writeFile(
    join(home, '.dsh-usage-stats.json'),
    JSON.stringify({
      byDayModelsSite: {
        '2026-11-19': {
          flash: { [own]: { calls: 10, cost: 1, input: 1_000_000, output: 0 } },
          'glm-5.3': { [own]: { calls: 5, cost: 10, input: 1_000_000, output: 0 } },
        },
      },
    }),
  )
  const rate = await deriveBlendedRate(home, { port: 28401 })
  const flash = rate.models.flash.usdPerToken
  const glm = rate.models['glm-5.3'].usdPerToken
  assert.ok(glm > flash * 9)
  assert.equal(rate.models.flash.samples, 10)
  assert.equal(rate.models['glm-5.3'].samples, 5)
})

test('deriveBlendedRate returns null without priced pool traffic', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-rate-empty-'))
  assert.equal(await deriveBlendedRate(home), null)
  await writeFile(join(home, '.dsh-usage-stats.json'), '{"byDayModelsSite":{}}')
  assert.equal(await deriveBlendedRate(home), null)
})

test('probeBilling reads the subscription balance and skips usage when it has one', async () => {
  const calls = []
  const server = createServer((req, res) => {
    calls.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ plan_name: 'PRO', credit_balance: 293.81, monthly_budget: 300, currency: 'USD' }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const hit = await probeBilling({ key: 'mstrl_x_1' }, { upstream: `http://127.0.0.1:${server.address().port}` })
    assert.equal(hit.source, 'subscription')
    assert.equal(hit.plan, 'PRO')
    assert.equal(hit.creditUsd, 293.81)
    assert.equal(hit.monthlyBudgetUsd, 300)
    assert.equal(calls.length, 1, 'a credit figure means the usage endpoint is not needed')
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('probeBilling falls back to the usage endpoint when the plan carries no credit', async () => {
  const calls = []
  const server = createServer((req, res) => {
    calls.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url.startsWith('/v1/billing/usage')) {
      res.end(JSON.stringify({ currency: 'USD', data: [{ total_cost: 1.5 }, { total_cost: 2.25 }] }))
      return
    }
    res.end(JSON.stringify({ plan_name: 'INDIVIDUAL', payg_enabled: false, enterprise: false }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const hit = await probeBilling({ key: 'mstrl_x_1' }, { upstream: `http://127.0.0.1:${server.address().port}` })
    assert.equal(hit.source, 'subscription+usage')
    assert.equal(hit.plan, 'INDIVIDUAL')
    assert.equal(hit.paygEnabled, false)
    // The plan-only answer must not be read as a zero balance.
    assert.equal(hit.creditUsd, null)
    assert.equal(hit.monthToDateUsd, 3.75)
    assert.equal(calls.length, 2)
    assert.match(calls[1], /start_date=\d{4}-\d{2}-01/)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('probeBilling reports nothing when both endpoints are missing', async () => {
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"message":"no Route matched with those values"}')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    assert.equal(await probeBilling({ key: 'mstrl_x_1' }, { upstream: `http://127.0.0.1:${server.address().port}` }), null)
    assert.equal(await probeBilling({ key: '' }), null)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('probeBilling records a plan even when the deployment is blind to credits', async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/v1/billing/usage')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"message":"no Route matched with those values"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ plan_name: 'INDIVIDUAL', payg_enabled: false }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const hit = await probeBilling({ key: 'mstrl_x_1' }, { upstream: `http://127.0.0.1:${server.address().port}` })
    assert.equal(hit.plan, 'INDIVIDUAL')
    assert.equal(hit.creditUsd, null)
    assert.match(hit.error, /usage 404/)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('billingBalance trusts a fresh official figure and ignores a stale one', () => {
  const fresh = key('a', { official: { creditUsd: 12.5, at: Date.now() } })
  assert.equal(billingBalance(fresh), 12.5)
  const stale = key('b', { official: { creditUsd: 12.5, at: Date.now() - BILLING_TRUST_MS - 1 } })
  assert.equal(billingBalance(stale), null)
  assert.equal(billingBalance(key('c', { official: { creditUsd: null, at: Date.now() } })), null)
  assert.equal(billingBalance(key('d')), null)
  // A negative wallet is reported as empty, not negative.
  assert.equal(billingBalance(key('e', { official: { creditUsd: -0.4, at: Date.now() } })), 0)
})

test('an official balance drives routing and publicState, and probing never kills a key', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ plan_name: 'PRO', credit_balance: 0 }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const store = { keys: [key('a'), key('b')], currentId: 'a', affinity: {}, pricing: {} }
    const result = await probeAllBilling(store, { upstream: `http://127.0.0.1:${server.address().port}` })
    assert.equal(result.probed, 2)
    assert.equal(result.credits, 2)
    assert.equal(store.billing.credits, 2)
    // Probing writes the figure but must not change the key's own status.
    assert.equal(store.keys[0].status, 'active')
    assert.equal(store.keys[0].official.creditUsd, 0)
    // A zero wallet is not routable, and publicState says why.
    assert.equal(isUsable(store.keys[0]), false)
    const state = publicState(store)
    assert.equal(state.keys[0].balanceSource, 'official')
    assert.equal(state.keys[0].remainingUsd, 0)
    assert.equal(state.keys[0].usedUsd, 30)
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('billingDueAt backs off while the deployment exposes no balance', () => {
  assert.equal(billingDueAt({}), 0, 'never probed is due immediately')
  const at = Date.now()
  // Blind endpoint: six hours between attempts, not thirty minutes.
  assert.equal(billingDueAt({ billing: { at, credits: 0 } }), at + BILLING_BLIND_MS)
  // Balance coming back: normal cadence.
  assert.equal(billingDueAt({ billing: { at, credits: 3 } }), at + BILLING_REFRESH_MS)
})

test('publicState exposes the probe summary and per-key provenance', async () => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/v1/billing/usage')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ plan_name: 'INDIVIDUAL' }))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const store = { keys: [key('a')], currentId: 'a', affinity: {}, pricing: {} }
    await probeAllBilling(store, { upstream: `http://127.0.0.1:${server.address().port}` })
    const state = publicState(store)
    assert.equal(state.billing.probed, 1)
    assert.equal(state.billing.credits, 0)
    assert.deepEqual(state.billing.plans, ['INDIVIDUAL'])
    assert.equal(state.keys[0].balanceSource, 'estimate')
    assert.equal(state.keys[0].official.plan, 'INDIVIDUAL')
  } finally {
    await new Promise((done) => server.close(done))
  }
})

test('sumUsageCost tolerates the several documented row shapes', () => {
  assert.equal(sumUsageCost({ data: [{ total_cost: 1 }, { total_cost: 2 }] }), 3)
  assert.equal(sumUsageCost([{ cost: 1.5 }]), 1.5)
  assert.equal(sumUsageCost({ data: [] }), null)
  assert.equal(sumUsageCost({ data: [{ input_tokens: 10 }] }), null)
})

test('aliasOf bridges the API model id and the ledger model name', () => {
  assert.equal(aliasOf('zai-glm-5-3'), 'glm-5.3')
  assert.equal(aliasOf('deepseek-v4-1-flash-1017'), 'flash')
  assert.equal(aliasOf('zai-glm-5-3-flash'), 'glm-5.3-flash')
  // Unknown ids fall through so a ledger that uses the same spelling still hits.
  assert.equal(aliasOf('mistral-large-4'), 'mistral-large-4')
  assert.equal(aliasOf(''), '')
})

test('resolvePrice prefers the user table, then the model, then the blend', () => {
  const store = {
    pricing: {},
    rates: {
      usdPerToken: 1e-6,
      models: { flash: { usdPerToken: 2e-7 }, 'glm-5.3': { usdPerToken: 4e-6 } },
    },
  }
  assert.equal(resolvePrice(store, 'zai-glm-5-3').in, 4)
  assert.ok(Math.abs(resolvePrice(store, 'deepseek-v4-1-flash-1017').in - 0.2) < 1e-9)
  assert.equal(resolvePrice(store, 'unheard-of').in, 1)
  assert.equal(
    resolvePrice({ ...store, pricing: { 'zai-glm-5-3': { in: 9 } } }, 'zai-glm-5-3').in,
    9,
  )
  assert.equal(modelPrice({ models: {} }, 'flash'), null)
})

test('rebase re-prices every key from its tokens and is idempotent', () => {
  const store = {
    pricing: {},
    rates: { usdPerToken: 1e-6, models: { flash: { usdPerToken: 1e-6 } } },
    keys: [
      // Priced at the old, inflated rate.
      key('a', { usedUsd: 172.36, tokens: { input: 1_000_000, output: 0, cached: 0 } }),
      key('b', { usedUsd: 8.64, tokens: { input: 0, output: 1_000_000, cached: 0 } }),
      // Per-model buckets re-price per model instead of by the blend.
      key('c', {
        usedUsd: 50,
        tokens: { input: 2_000_000, output: 0, cached: 0 },
        models: {
          'zai-glm-5-3': { input: 1_000_000, output: 0, cached: 0, requests: 1, usd: 0 },
          'deepseek-v4-1-flash-1017': { input: 1_000_000, output: 0, cached: 0, requests: 1, usd: 0 },
        },
      }),
    ],
  }
  store.rates.models['glm-5.3'] = { usdPerToken: 4e-6 }
  const total = rebase(store)
  assert.equal(store.keys[0].usedUsd, 1)
  assert.equal(store.keys[1].usedUsd, 1)
  // 1M tokens on glm (4e-6) + 1M on flash (1e-6).
  assert.equal(store.keys[2].usedUsd, 5)
  assert.equal(total, 7)
  assert.equal(store.pricingVersion, PRICING_VERSION)
  const again = rebase(store)
  assert.equal(again, 7, 'rebasing twice must not move the numbers')
})

test('migratePricing rebases once and never without a rate', () => {
  const store = {
    pricing: {},
    keys: [key('a', { usedUsd: 172.36, tokens: { input: 1_000_000, output: 0, cached: 0 } })],
  }
  // No rate yet: keep the old number rather than zeroing the balance.
  assert.equal(migratePricing(store), false)
  assert.equal(store.keys[0].usedUsd, 172.36)

  store.rates = { usdPerToken: 1e-6, models: { flash: { usdPerToken: 1e-6 } } }
  assert.equal(migratePricing(store), true)
  assert.equal(store.keys[0].usedUsd, 1)
  assert.equal(store.pricingVersion, PRICING_VERSION)
  // Second load is a no-op.
  store.keys[0].usedUsd = 123
  assert.equal(migratePricing(store), false)
  assert.equal(store.keys[0].usedUsd, 123)
})

test('publicState never leaks a full key', () => {
  const state = publicState({
    port: 1,
    upstream: 'u',
    currentId: 'a',
    keys: [{ ...key('a'), key: 'mstrl_secret_secret_1234' }],
  })
  assert.equal(state.keys[0].masked.includes('secret_secret'), false)
  assert.equal(state.keys[0].current, true)
})

/** Boot the plugin against a fake upstream and return a client bound to it. */
async function bootPool({ upstreamBody, upstreamStatus = 200, headers = {} }) {
  const upstreamHits = []
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      upstreamHits.push({ url: req.url, authorization: req.headers.authorization, body })
      res.writeHead(upstreamStatus, { 'content-type': headers.contentType ?? 'text/event-stream', ...headers.extra })
      res.end(upstreamBody)
    })
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const upstreamPort = upstream.address().port

  const home = await mkdtemp(join(tmpdir(), 'pool-int-'))
  const port = 28501
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      port,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      pricing: {},
      currentId: 'a',
      keys: [key('a'), key('b')],
    }),
  )
  const ctx = {
    effect(fn) { this._cleanup = fn() },
    logger: { info() {}, warn() {} },
    get() { return undefined },
  }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  return {
    port,
    hits: upstreamHits,
    close: async () => {
      ctx._cleanup?.()
      await new Promise((done) => upstream.close(done))
    },
  }
}

test('proxy rotates past a quota error and forwards the next key', async () => {
  const pool = await bootPool({
    upstreamBody:
      'event: response.completed\ndata: {"response":{"model":"m","usage":{"input_tokens":1000,"output_tokens":500}}}\n\n',
    headers: { contentType: 'text/event-stream' },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${pool.port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
      body: JSON.stringify({ model: 'm', stream: true }),
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.match(text, /response\.completed/)
    assert.equal(pool.hits.length, 1)
    assert.equal(pool.hits[0].authorization, 'Bearer mstrl_test_a_0000')
  } finally {
    await pool.close()
  }
})

test('proxy prices a call by the model that answered and records it per model', async () => {
  const upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'zai-glm-5-3', usage: { prompt_tokens: 1000, completion_tokens: 0 } }))
    })
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const home = await mkdtemp(join(tmpdir(), 'pool-price-'))
  const port = 28559
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      port,
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      currentId: 'a',
      keys: [key('a')],
    }),
  )
  // 68 CNY over 1M effective tokens on this proxy's site = $10.015/M at 6.79.
  await writeFile(
    join(home, '.dsh-usage-stats.json'),
    JSON.stringify({
      byDayModelsSite: {
        '2026-11-19': {
          'glm-5.3': { [`site:http://127.0.0.1:${port}`]: { calls: 1, cost: 68, input: 1_000_000, output: 0 } },
        },
      },
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 200))
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'zai-glm-5-3', input: 'hi' }),
    })
    assert.equal(res.status, 200)
    await res.text()
    // Usage lands in memory first and the store write is debounced at 800 ms.
    await new Promise((done) => setTimeout(done, 1_200))
    const store = JSON.parse(await readFile(join(home, 'mistral-pool.json'), 'utf8'))
    const record = store.keys[0]
    assert.equal(record.tokens.input, 1000)
    // The API id is aliased to the ledger name, so the model's own rate is used.
    assert.equal(record.models['zai-glm-5-3'].input, 1000)
    assert.ok(Math.abs(record.usedUsd - 0.010015) < 1e-6, `usedUsd=${record.usedUsd}`)
  } finally {
    ctx._cleanup?.()
    await new Promise((done) => upstream.close(done))
  }
})

test('proxy marks a key dead on 402 and replays with the next one', async () => {
  let call = 0
  const upstream = createServer((req, res) => {
    call += 1
    if (call === 1) {
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end('{"message":"insufficient credits"}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"usage":{"input_tokens":10,"output_tokens":2}}\n\n')
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const home = await mkdtemp(join(tmpdir(), 'pool-rotate-'))
  const port = 28502
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      port,
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      currentId: 'a',
      keys: [key('a'), key('b')],
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer x' } })
    assert.equal(res.status, 200)
    await res.text()
    const store = JSON.parse(await readFile(join(home, 'mistral-pool.json'), 'utf8'))
    assert.equal(store.keys[0].status, 'exhausted')
    assert.equal(store.currentId, 'b')
  } finally {
    ctx._cleanup?.()
    await new Promise((done) => upstream.close(done))
  }
})

test('createUsageTap folds a stream that repeats a running total into one call', () => {
  // Mistral repeats a growing total on every frame; each frame used to be
  // billed, turning one call into ~4.7 calls in the ledger.
  const seen = []
  const tap = createUsageTap((hit) => seen.push(hit))
  tap.push('event: message\ndata: {"model":"m","usage":{"input_tokens":1000,"output_tokens":1}}\n\n')
  tap.push('event: message\ndata: {"model":"m","usage":{"input_tokens":1000,"output_tokens":50}}\n\n')
  tap.push('event: message\ndata: {"model":"m","usage":{"input_tokens":1000,"output_tokens":120}}\n\n')
  tap.end()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].usage.output, 120)
})

test('blendedPrice bills cached input at the discount', () => {
  const price = blendedPrice(0.000002)
  assert.equal(price.cached, 0.2)
  assert.equal(computeCost({ input: 1_000_000, cached: 1_000_000, output: 0 }, price).usd, 0.2)
  assert.equal(computeCost({ input: 1_000_000, cached: 0, output: 0 }, price).usd, 2)
})

test('deriveBlendedRate prices cached input at the discount', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-rate-cached-'))
  await writeFile(
    join(home, '.dsh-usage-stats.json'),
    JSON.stringify({
      byDayModelsSite: {
        '2026-11-19': {
          m: {
            'site:https://api.mistral.ai': {
              calls: 1,
              cost: 2,
              input: 1_000_000,
              cacheHit: 900_000,
              cacheMiss: 100_000,
              output: 0,
            },
          },
        },
      },
    }),
  )
  const rate = await deriveBlendedRate(home)
  // ¥2 over 190k effective tokens (100k miss + 90k cached at the 10% discount).
  assert.equal(rate.usdPerToken, 2 / DEFAULT_CNY_PER_USD / 190_000)
})

test('priceFor falls back to published mistral tariffs', () => {
  assert.deepEqual(priceFor({}, 'mistral-large-latest'), { in: 2, out: 6, cached: 0.2 })
  assert.deepEqual(priceFor({}, 'provider/codestral-2508'), { in: 0.3, out: 0.9, cached: 0.03 })
  assert.deepEqual(priceFor({}, 'devstral-latest'), { in: 0.4, out: 2, cached: 0.04 })
  assert.equal(priceFor({}, 'some-unknown-model'), null)
  // The store's own table still wins over the published tariff.
  assert.deepEqual(priceFor({ 'mistral-large': { in: 9 } }, 'mistral-large'), { in: 9 })
})

test('affinityOf prefers an explicit session header', () => {
  assert.equal(affinityOf({ 'x-dsh-session': 'abc' }, Buffer.from('{}')), 'h:abc')
  assert.equal(affinityOf({ 'x-session-id': ' s2 ' }, null), 'h:s2')
})

test('affinityOf keeps hashing a conversation to the same id as it grows', () => {
  const first = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Fix the billing bug.' },
    ],
  })
  const later = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Fix the billing bug.' },
      { role: 'assistant', content: 'Looking into it.' },
      { role: 'user', content: 'Any update?' },
    ],
  })
  const a = affinityOf({}, Buffer.from(first))
  const b = affinityOf({}, Buffer.from(later))
  assert.match(a, /^p:[0-9a-f]{16}$/)
  assert.equal(a, b)
})

test('affinityOf separates two different conversations', () => {
  const one = JSON.stringify({ messages: [{ role: 'user', content: 'alpha task' }] })
  const two = JSON.stringify({ messages: [{ role: 'user', content: 'beta task' }] })
  assert.notEqual(affinityOf({}, Buffer.from(one)), affinityOf({}, Buffer.from(two)))
  assert.equal(affinityOf({}, Buffer.from('not json')), '')
})

test('selectKey pins a conversation to one key across turns', () => {
  const store = { currentId: 'a', affinity: {}, keys: [key('a'), key('b'), key('c')] }
  const first = selectKey(store, 'p:session1')
  const second = selectKey(store, 'p:session1')
  const third = selectKey(store, 'p:session1')
  assert.equal(first.id, second.id)
  assert.equal(second.id, third.id)
  assert.equal(store.affinity['p:session1'], first.id)
})

test('selectKey spreads new conversations across usable keys', () => {
  const store = { currentId: 'a', affinity: {}, keys: [key('a'), key('b'), key('c')] }
  const used = new Set()
  for (const id of ['s1', 's2', 's3']) used.add(selectKey(store, id).id)
  assert.equal(used.size, 3, 'each conversation should land on a different key')
})

test('selectKey keeps pinning while other conversations grow', () => {
  const store = { currentId: 'a', affinity: {}, keys: [key('a'), key('b')] }
  const s1 = selectKey(store, 's1').id
  selectKey(store, 's2')
  selectKey(store, 's3')
  assert.equal(selectKey(store, 's1').id, s1)
})

test('exhaust only releases the conversations pinned to the dead key', () => {
  const store = { currentId: 'a', affinity: {}, keys: [key('a'), key('b'), key('c')] }
  const a1 = selectKey(store, 's1').id
  const a2 = selectKey(store, 's2').id
  const a3 = selectKey(store, 's3').id
  const dead = store.keys.find((k) => k.id === a1)
  exhaust(store, dead, 'test')
  const pins = Object.values(store.affinity)
  assert.equal(pins.includes(a1), false, 'pins on the dead key are released')
  assert.equal(pins.includes(a2), true, 'other conversations keep their key')
  assert.equal(pins.includes(a3), true, 'other conversations keep their key')
})

test('selectKey reassigns a released conversation to a live key', () => {
  const store = { currentId: 'a', affinity: {}, keys: [key('a'), key('b')] }
  const first = selectKey(store, 's1').id
  exhaust(store, store.keys.find((k) => k.id === first), 'test')
  const again = selectKey(store, 's1')
  assert.notEqual(again.id, first)
  assert.equal(again.status, 'active')
})

test('rememberAffinity evicts the oldest pin past the cap', () => {
  const store = { currentId: 'a', affinity: {}, keys: [key('a')] }
  for (let i = 0; i < 205; i += 1) rememberAffinity(store, `s${i}`, 'a')
  const pins = Object.keys(store.affinity)
  assert.equal(pins.length, 200)
  assert.equal(store.affinity.s0, undefined)
  assert.equal(store.affinity.s204, 'a')
})

test('publicState reports how many conversations a key serves', () => {
  const store = { currentId: 'a', affinity: { s1: 'a', s2: 'a', s3: 'b' }, keys: [key('a'), key('b')] }
  const state = publicState(store)
  assert.equal(state.keys.find((k) => k.id === 'a').sessions, 2)
  assert.equal(state.keys.find((k) => k.id === 'b').sessions, 1)
})

test('nextKeyId increments sequentially and avoids collisions', () => {
  assert.equal(nextKeyId([]), 'key-01')
  assert.equal(nextKeyId([{ id: 'key-01' }, { id: 'key-12' }]), 'key-13')
  assert.equal(nextKeyId([{ id: 'key-09' }, { id: 'key-10' }]), 'key-11')
})

test('addKey validates inputs, defaults faceUsd/kind, and rejects duplicates', () => {
  const store = { currentId: null, keys: [] }
  const vibe = addKey(store, { key: 'mstrl_alpha_1111', account: 'a@example.com', memo: 'Pro' })
  assert.equal(vibe.id, 'key-01')
  assert.equal(vibe.faceUsd, 300)
  assert.equal(vibe.kind, 'vibe')
  assert.equal(vibe.status, 'active')
  assert.equal(store.currentId, null)

  const studio = addKey(store, { key: 'mstrl_beta_2222', kind: 'studio', setCurrent: true })
  assert.equal(studio.id, 'key-02')
  assert.equal(studio.faceUsd, 30)
  assert.equal(studio.kind, 'studio')
  assert.equal(store.currentId, 'key-02')

  const unpriced = addKey(store, { key: 'mstrl_zero_3333', faceUsd: 0, kind: 'studio' })
  assert.equal(unpriced.faceUsd, 0)
  assert.equal(unpriced.kind, 'studio')

  assert.throws(() => addKey(store, { key: '   ' }), (e) => e.status === 400)
  assert.throws(() => addKey(store, { key: 'mstrl_bad key_4444' }), (e) => e.status === 400)
  assert.throws(() => addKey(store, { key: 'mstrl_alpha_1111' }), (e) => e.status === 409)
  assert.throws(() => addKey(store, { key: 'mstrl_neg_5555', faceUsd: -1 }), (e) => e.status === 400)
  assert.throws(() => addKey(store, { key: 'mstrl_badkind_6666', kind: 'other' }), (e) => e.status === 400)
})

test('POST /__pool/action add-key persists masked state, aligns cursor, and blocks duplicates', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-add-key-'))
  const port = 28561
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      port,
      upstream: 'http://127.0.0.1:1',
      currentId: null,
      keys: [key('01', { status: 'exhausted', faceUsd: 300 })],
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'add-key',
        key: 'mstrl_new_secret_abcd',
        account: 'fresh@example.com',
        memo: 'Pro',
        faceUsd: 300,
      }),
    })
    assert.equal(res.status, 200)
    const state = await res.json()
    assert.equal(state.keys.length, 2)
    const added = state.keys[1]
    assert.equal(added.account, 'fresh@example.com')
    assert.equal(added.memo, 'Pro')
    assert.equal(added.faceUsd, 300)
    assert.equal(added.kind, 'vibe')
    assert.equal(added.masked, 'mstrl_…abcd')
    assert.equal(JSON.stringify(state).includes('mstrl_new_secret_abcd'), false)
    assert.equal(state.currentId, added.id)

    const disk = JSON.parse(await readFile(join(home, 'mistral-pool.json'), 'utf8'))
    assert.equal(disk.keys.length, 2)
    assert.equal(disk.keys[1].key, 'mstrl_new_secret_abcd')

    const dupRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add-key', key: 'mstrl_new_secret_abcd' }),
    })
    assert.equal(dupRes.status, 409)

    const dashHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    assert.match(dashHtml, /\+ 新增 Key/)
    assert.match(dashHtml, /action:'add-key'/)
    assert.match(dashHtml, /data-act="delete-key"/)
    assert.doesNotMatch(dashHtml, /清零/)
    assert.doesNotMatch(dashHtml, /重算/)
    assert.doesNotMatch(dashHtml, /同步官方/)
  } finally {
    await ctx._cleanup?.()
  }
})

test('deleteKey removes key, clears pinned affinity and currentId, and throws 404 when missing', () => {
  const store = {
    currentId: 'key-01',
    affinity: { s1: 'key-01', s2: 'key-02', s3: 'key-01' },
    keys: [key('key-01'), key('key-02')],
  }
  const removed = deleteKey(store, 'key-01')
  assert.equal(removed.id, 'key-01')
  assert.equal(store.keys.length, 1)
  assert.equal(store.keys[0].id, 'key-02')
  assert.equal(store.currentId, null)
  assert.deepEqual(store.affinity, { s2: 'key-02' })

  assert.throws(() => deleteKey(store, 'missing'), (e) => e.status === 404)
})

test('POST /__pool/action delete-key persists removal and aligns currentId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-del-key-'))
  const port = 28562
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      port,
      upstream: 'http://127.0.0.1:1',
      currentId: 'a',
      affinity: { s1: 'a', s2: 'b' },
      keys: [key('a', { faceUsd: 300 }), key('b', { faceUsd: 300 })],
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    const res1 = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete-key', id: 'a' }),
    })
    assert.equal(res1.status, 200)
    const state1 = await res1.json()
    assert.equal(state1.keys.length, 1)
    assert.equal(state1.keys[0].id, 'b')
    assert.equal(state1.currentId, 'b')

    const disk1 = JSON.parse(await readFile(join(home, 'mistral-pool.json'), 'utf8'))
    assert.equal(disk1.keys.length, 1)
    assert.deepEqual(disk1.affinity, { s2: 'b' })

    const res2 = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete-key', id: 'b' }),
    })
    assert.equal(res2.status, 200)
    const state2 = await res2.json()
    assert.equal(state2.keys.length, 0)
    assert.equal(state2.currentId, null)

    const res404 = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete-key', id: 'b' }),
    })
    assert.equal(res404.status, 404)
  } finally {
    await ctx._cleanup?.()
  }
})

test('enableKey and disableKey toggle status, clear errors, and release affinity', () => {
  const store = {
    currentId: 'a',
    affinity: { s1: 'a', s2: 'b' },
    keys: [
      key('a', { status: 'active' }),
      key('b', { status: 'exhausted', exhaustedAt: 123, lastError: '402' }),
    ],
  }
  const off = disableKey(store, 'a')
  assert.equal(off.status, 'disabled')
  assert.equal(store.currentId, null)
  assert.deepEqual(store.affinity, { s2: 'b' })

  const on = enableKey(store, 'b')
  assert.equal(on.status, 'active')
  assert.equal(on.exhaustedAt, 0)
  assert.equal(on.lastError, '')

  assert.throws(() => disableKey(store, 'missing'), (e) => e.status === 404)
  assert.throws(() => enableKey(store, 'missing'), (e) => e.status === 404)
})

test('POST /__pool/action enable and disable persist state and update dashboard labels', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-toggle-key-'))
  const port = 28563
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      port,
      upstream: 'http://127.0.0.1:1',
      currentId: 'a',
      affinity: { s1: 'a' },
      keys: [
        key('a', { faceUsd: 300, status: 'active' }),
        key('b', { faceUsd: 300, status: 'exhausted', lastError: '401' }),
      ],
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    const disRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'disable', id: 'a' }),
    })
    assert.equal(disRes.status, 200)
    const disState = await disRes.json()
    assert.equal(disState.keys.find((k) => k.id === 'a').status, 'disabled')
    assert.equal(disState.currentId, null)

    const enRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'enable', id: 'b' }),
    })
    assert.equal(enRes.status, 200)
    const enState = await enRes.json()
    assert.equal(enState.keys.find((k) => k.id === 'b').status, 'active')
    assert.equal(enState.keys.find((k) => k.id === 'b').lastError, '')
    assert.equal(enState.currentId, 'b')

    const dashHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    assert.match(dashHtml, /已启用/)
    assert.match(dashHtml, /已停用/)
    assert.match(dashHtml, /额度耗尽/)
    assert.match(dashHtml, /data-act="disable"/)
    assert.match(dashHtml, /data-act="enable"/)
    assert.match(dashHtml, /id="f-priority"/)
    assert.match(dashHtml, /id="f-weight"/)
    assert.doesNotMatch(dashHtml, /标记用完/)
  } finally {
    await ctx._cleanup?.()
  }
})

test('priority and weight control addKey, updateKeySchedule, selectKey, and pickNext', () => {
  assert.equal(keyPriorityOf({}), 0)
  assert.equal(keyWeightOf({}), 1)

  const store = { currentId: null, affinity: {}, keys: [] }
  const low = addKey(store, { key: 'mstrl_low_1111', priority: 1, weight: 1 })
  const highHeavy = addKey(store, { key: 'mstrl_high_h_2222', priority: 10, weight: 3 })
  const highLight = addKey(store, { key: 'mstrl_high_l_3333', priority: 10, weight: 1 })

  assert.throws(() => addKey(store, { key: 'mstrl_badp_4444', priority: 1.5 }), (e) => e.status === 400)
  assert.throws(() => addKey(store, { key: 'mstrl_badw_5555', weight: 0 }), (e) => e.status === 400)
  assert.throws(() => addKey(store, { key: 'mstrl_badw_6666', weight: -2 }), (e) => e.status === 400)

  // Higher priority tier strictly wins over lower tier
  const hits = new Map()
  for (const s of ['c1', 'c2', 'c3', 'c4']) {
    const picked = selectKey(store, s)
    assert.equal(picked.priority, 10)
    hits.set(picked.id, (hits.get(picked.id) ?? 0) + 1)
  }
  assert.equal(hits.get(highHeavy.id), 3)
  assert.equal(hits.get(highLight.id), 1)
  assert.equal(hits.get(low.id) ?? 0, 0)

  // pickNext stays inside the highest usable priority tier
  assert.equal(pickNext(store.keys, highHeavy.id).id, highLight.id)
  assert.equal(pickNext(store.keys, highLight.id).id, highHeavy.id)

  // Exhausting all high-priority keys fails over to the lower priority tier
  exhaust(store, highHeavy, '402')
  exhaust(store, highLight, '402')
  assert.equal(selectKey(store, 'c5').id, low.id)

  updateKeySchedule(store, low.id, { priority: 20, weight: 2.5 })
  assert.equal(low.priority, 20)
  assert.equal(low.weight, 2.5)
  assert.throws(() => updateKeySchedule(store, low.id, { weight: 0 }), (e) => e.status === 400)
  assert.throws(() => updateKeySchedule(store, 'missing', { priority: 1 }), (e) => e.status === 404)
})

test('POST /__pool/action set-schedule updates priority/weight and promotes currentId', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-sched-'))
  const port = 28564
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      port,
      upstream: 'http://127.0.0.1:1',
      currentId: 'a',
      keys: [
        key('a', { faceUsd: 300, priority: 0, weight: 1 }),
        key('b', { faceUsd: 300, priority: 0, weight: 1 }),
      ],
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set-schedule', id: 'b', priority: 5, weight: 3 }),
    })
    assert.equal(res.status, 200)
    const state = await res.json()
    const b = state.keys.find((k) => k.id === 'b')
    assert.equal(b.priority, 5)
    assert.equal(b.weight, 3)
    assert.equal(state.currentId, 'b')

    const disk = JSON.parse(await readFile(join(home, 'mistral-pool.json'), 'utf8'))
    assert.equal(disk.keys.find((k) => k.id === 'b').priority, 5)
    assert.equal(disk.keys.find((k) => k.id === 'b').weight, 3)

    const dashHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    assert.match(dashHtml, /data-act="edit-key"/)
    assert.match(dashHtml, /编辑/)
  } finally {
    await ctx._cleanup?.()
  }
})

test('updateKey validates and mutates account, memo, faceUsd, kind, priority, weight, and key', () => {
  const store = {
    keys: [
      key('a', { faceUsd: 300, kind: 'vibe', priority: 0, weight: 1 }),
      key('b', { key: 'mstrl_existing_9999' }),
    ],
  }
  const updated = updateKey(store, 'a', {
    account: 'renamed@example.com',
    memo: 'Team',
    faceUsd: 30,
    kind: 'studio',
    priority: 8,
    weight: 2.5,
    key: 'mstrl_rotated_8888',
  })
  assert.equal(updated.account, 'renamed@example.com')
  assert.equal(updated.memo, 'Team')
  assert.equal(updated.faceUsd, 30)
  assert.equal(updated.kind, 'studio')
  assert.equal(updated.priority, 8)
  assert.equal(updated.weight, 2.5)
  assert.equal(updated.key, 'mstrl_rotated_8888')

  assert.throws(() => updateKey(store, 'a', { key: 'bad key' }), (e) => e.status === 400)
  assert.throws(() => updateKey(store, 'a', { key: 'mstrl_existing_9999' }), (e) => e.status === 409)
  assert.throws(() => updateKey(store, 'a', { faceUsd: -1 }), (e) => e.status === 400)
  assert.throws(() => updateKey(store, 'a', { kind: 'bad' }), (e) => e.status === 400)
  assert.throws(() => updateKey(store, 'a', { priority: 1.2 }), (e) => e.status === 400)
  assert.throws(() => updateKey(store, 'a', { weight: 0 }), (e) => e.status === 400)
  assert.throws(() => updateKey(store, 'missing', { account: 'x' }), (e) => e.status === 404)
})

test('POST /__pool/action update-key persists full edits and masks secret', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pool-update-key-'))
  const port = 28565
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      port,
      upstream: 'http://127.0.0.1:1',
      currentId: 'a',
      keys: [
        key('a', { faceUsd: 300, priority: 0, weight: 1 }),
        key('b', { faceUsd: 300, priority: 0, weight: 1 }),
      ],
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'update-key',
        id: 'b',
        account: 'vip@example.com',
        memo: 'VIP',
        faceUsd: 300,
        kind: 'vibe',
        priority: 9,
        weight: 4,
        key: 'mstrl_vip_secret_7777',
      }),
    })
    assert.equal(res.status, 200)
    const state = await res.json()
    assert.equal(JSON.stringify(state).includes('mstrl_vip_secret_7777'), false)
    const b = state.keys.find((k) => k.id === 'b')
    assert.equal(b.account, 'vip@example.com')
    assert.equal(b.memo, 'VIP')
    assert.equal(b.priority, 9)
    assert.equal(b.weight, 4)
    assert.equal(b.masked, 'mstrl_…7777')
    assert.equal(state.currentId, 'b')

    const disk = JSON.parse(await readFile(join(home, 'mistral-pool.json'), 'utf8'))
    assert.equal(disk.keys.find((k) => k.id === 'b').key, 'mstrl_vip_secret_7777')
  } finally {
    await ctx._cleanup?.()
  }
})

test('POST /__pool/action sync-quota probes only the requested faceUsd group', async () => {
  const seenAuth = []
  const upstream = createServer((req, res) => {
    seenAuth.push(req.headers.authorization)
    if (req.url === '/v1/billing/subscription') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ plan_name: 'PRO', credit_balance: 275.5 }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))

  const home = await mkdtemp(join(tmpdir(), 'pool-sync-quota-'))
  const port = 28566
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      port,
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      currentId: 'v1',
      keys: [
        key('v1', { faceUsd: 300, key: 'mstrl_vibe_only_1111' }),
        key('s1', { faceUsd: 30, key: 'mstrl_studio_skip_2222' }),
      ],
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    seenAuth.length = 0
    const res = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'sync-quota', faceUsd: 300 }),
    })
    assert.equal(res.status, 200)
    const state = await res.json()
    assert.deepEqual(seenAuth, ['Bearer mstrl_vibe_only_1111'])
    const v1 = state.keys.find((k) => k.id === 'v1')
    const s1 = state.keys.find((k) => k.id === 's1')
    assert.equal(v1.remainingUsd, 275.5)
    assert.equal(v1.balanceSource, 'official')
    assert.equal(s1.balanceSource, 'estimate')
  } finally {
    await ctx._cleanup?.()
    await new Promise((done) => upstream.close(done))
  }
})

test('model catalog helpers manage models and actions persist/discover via /__pool/action', async () => {
  const store = { keys: [key('a', { faceUsd: 300 })] }
  const defaults = effectiveModels(store)
  assert.equal(defaults.length, DEFAULT_MODELS.length)
  assert.equal(defaults.length, 9)
  for (const id of [
    'zai-glm-5-3',
    'zai-glm-5-3-flash',
    'deepseek-v4-1-flash-1017',
    'mistral-large-4',
    'mistral-medium-latest',
    'mistral-small-latest',
    'devstral-latest',
    'codestral-latest',
    'magistral-medium-latest',
  ]) {
    assert.ok(defaults.some((m) => m.id === id), `default catalog should include ${id}`)
  }

  const added = addModel(store, { id: 'pixtral-large-latest', name: 'Pixtral Large' })
  assert.equal(added.id, 'pixtral-large-latest')
  assert.equal(effectiveModels(store).length, DEFAULT_MODELS.length + 1)
  assert.throws(() => addModel(store, { id: 'pixtral-large-latest' }), (e) => e.status === 409)
  assert.throws(() => addModel(store, { id: 'bad id' }), (e) => e.status === 400)

  removeModel(store, 'pixtral-large-latest')
  assert.equal(effectiveModels(store).length, DEFAULT_MODELS.length)
  assert.throws(() => removeModel(store, 'missing'), (e) => e.status === 404)

  resetModels(store)
  assert.equal(store.models, undefined)

  const upstream = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mistral-medium-2508', name: 'Mistral Medium', max_context_length: 128000 }] }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))

  const home = await mkdtemp(join(tmpdir(), 'pool-models-action-'))
  const port = 28567
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'acp',
      billingProbe: false,
      port,
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      currentId: 'a',
      keys: [key('a', { faceUsd: 300 })],
    }),
  )
  const ctx = { effect(fn) { this._cleanup = fn() }, logger: { info() {}, warn() {} }, get() { return undefined } }
  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    const addRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add-model', id: 'mistral-medium-2508', name: 'Mistral Medium' }),
    })
    assert.equal(addRes.status, 200)
    const addState = await addRes.json()
    assert.equal(addState.modelsCustomized, true)
    assert.ok(addState.models.some((m) => m.id === 'mistral-medium-2508'))

    const fetchRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'fetch-models' }),
    })
    assert.equal(fetchRes.status, 200)
    const fetchState = await fetchRes.json()
    assert.equal(fetchState.discovered[0].id, 'mistral-medium-2508')

    const remRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove-model', modelId: 'mistral-medium-2508' }),
    })
    assert.equal(remRes.status, 200)
    const remState = await remRes.json()
    assert.equal(remState.models.some((m) => m.id === 'mistral-medium-2508'), false)

    const resetRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reset-models' }),
    })
    assert.equal(resetRes.status, 200)
    const resetState = await resetRes.json()
    assert.equal(resetState.modelsCustomized, false)
    assert.equal(resetState.models.length, DEFAULT_MODELS.length)

    // Preset auto-fill for newly added models without user entering context/maxTokens/input
    const large = normalizeModelEntry({ id: 'mistral-large-4' })
    assert.equal(large.contextWindow, 1_048_576)
    assert.equal(large.maxTokens, 262_144)
    assert.deepEqual(large.input, ['text', 'image'])
    const glm = normalizeModelEntry({ id: 'zai-glm-5-3' })
    assert.deepEqual(glm.input, ['text'])
    const codestral = normalizeModelEntry({ id: 'codestral-latest' })
    assert.equal(codestral.contextWindow, 256_000)
    assert.equal(codestral.maxTokens, 8_192)
    assert.deepEqual(codestral.input, ['text'])
    const devstral = normalizeModelEntry({ id: 'devstral-latest' })
    assert.equal(devstral.contextWindow, 262_144)
    assert.equal(devstral.maxTokens, 262_144)
    const vibeCli = presetForModel('mistral-vibe-cli-latest')
    assert.equal(vibeCli.contextWindow, 262_144)
    assert.equal(vibeCli.maxTokens, 131_072)

    // Specific versioned/labs/open presets must not be shadowed by broader family prefixes
    assert.deepEqual(
      { c: presetForModel('mistral-medium-2505').contextWindow, e: presetForModel('mistral-medium-2505').efforts },
      { c: 131_072, e: [] },
    )
    assert.deepEqual(
      { c: presetForModel('mistral-medium-2508').contextWindow, e: presetForModel('mistral-medium-2508').efforts },
      { c: 262_144, e: [] },
    )
    assert.deepEqual(
      { c: presetForModel('mistral-small-2506').contextWindow, m: presetForModel('mistral-small-2506').maxTokens },
      { c: 128_000, m: 16_384 },
    )
    assert.deepEqual(
      { c: presetForModel('labs-devstral-small-2512').contextWindow, i: presetForModel('labs-devstral-small-2512').input },
      { c: 256_000, i: ['text', 'image'] },
    )
    assert.deepEqual(
      { c: presetForModel('labs-leanstral-1-5-1').contextWindow, e: presetForModel('labs-leanstral-1-5-1').efforts },
      { c: 262_144, e: ['off', 'high'] },
    )
    assert.equal(presetForModel('ministral-3b-latest').contextWindow, 131_072)
    assert.equal(presetForModel('open-mixtral-8x22b').contextWindow, 64_000)
    assert.equal(presetForModel('zai-glm-5-3-flash-vibe-free').contextWindow, 262_144)

    // update-model updates capabilities and persists
    const updRes = await fetch(`http://127.0.0.1:${port}/__pool/action`, {
      method: 'POST',
      headers: { 'x-dsh-pool': '1', 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'update-model',
        modelId: 'zai-glm-5-3',
        name: 'GLM 5.3 Custom',
        contextWindow: 512000,
        maxTokens: 64000,
        input: ['text', 'image'],
      }),
    })
    assert.equal(updRes.status, 200)
    const updState = await updRes.json()
    const edited = updState.models.find((m) => m.id === 'zai-glm-5-3')
    assert.equal(edited.name, 'GLM 5.3 Custom')
    assert.equal(edited.contextWindow, 512000)
    assert.equal(edited.maxTokens, 64000)
    assert.deepEqual(edited.input, ['text', 'image'])
    assert.throws(() => updateModel({ keys: [] }, 'zai-glm-5-3', { input: [] }), (e) => e.status === 400)
  } finally {
    await ctx._cleanup?.()
    await new Promise((done) => upstream.close(done))
  }
})

test('MistralAdapter registers provider mistral-vibe and streams responses in direct mode', async () => {
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      assert.equal(parsed.model, 'deepseek-v4-1-flash-1017')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"think "}\n\n')
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello "}\n\n')
      res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"bash","arguments":""}}\n\n')
      res.write('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"cmd\\":\\"pwd\\"}"}\n\n')
      res.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"bash","arguments":"{\\"cmd\\":\\"pwd\\"}"}}\n\n')
      res.write('event: response.completed\ndata: {"type":"response.completed","response":{"model":"deepseek-v4-1-flash-1017","usage":{"input_tokens":120,"output_tokens":30,"input_tokens_details":{"cached_tokens":20}}}}\n\n')
      res.end()
    })
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))

  const home = await mkdtemp(join(tmpdir(), 'pool-adapter-direct-'))
  const port = 28568
  await writeFile(
    join(home, 'mistral-pool.json'),
    JSON.stringify({
      version: 1,
      mode: 'direct',
      billingProbe: false,
      port,
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      currentId: 's1',
      keys: [key('s1', { faceUsd: 30 })],
    }),
  )

  const registered = { configurable: [], adapters: new Map() }
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      this._cleanups ??= []
      this._cleanups.push(cleanup)
      return cleanup
    },
    logger: { info() {}, warn() {} },
    get() { return undefined },
    llm: {
      registerConfigurableProviders(entries) {
        registered.configurable.push(...entries)
        return () => {}
      },
      registerAdapter(providers, adapter) {
        for (const p of providers) registered.adapters.set(p, adapter)
        return () => {}
      },
    },
  }

  apply(ctx, { home })
  await new Promise((done) => setTimeout(done, 150))
  try {
    assert.equal(registered.configurable.length, 1)
    assert.equal(registered.configurable[0].provider, 'mistral-vibe')
    assert.equal(registered.configurable[0].settingsNs, 'dsh-mistral-pool')
    assert.deepEqual(registered.configurable[0].nativeAuth, { env: [], oauth: true })

    const adapter = registered.adapters.get('mistral-vibe')
    assert.ok(adapter instanceof MistralAdapter)
    const models = await adapter.listModels('mistral-vibe')
    assert.equal(models.length, DEFAULT_MODELS.length)
    const resolved = await adapter.resolveModel('mistral-vibe', 'deepseek-v4-1-flash-1017')
    assert.equal(resolved.context.contextWindow, 1_048_576)
    assert.ok(resolved.reasoning.efforts.some((e) => e.id === 'xhigh'))

    const chunks = []
    for await (const c of adapter.stream({
      provider: 'mistral-vibe',
      model: 'deepseek-v4-1-flash-1017',
      reasoningEffort: 'high',
      sessionId: 'sess-direct-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'run pwd' }] }],
    })) {
      chunks.push(c)
    }

    assert.equal(chunks.find((c) => c.type === 'reasoning-delta').text, 'think ')
    assert.equal(chunks.find((c) => c.type === 'text-delta').text, 'hello ')
    const toolEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    assert.equal(toolEnd.block.name, 'bash')
    assert.equal(toolEnd.block.arguments, '{"cmd":"pwd"}')
    assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, {
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 20,
      totalTokens: 150,
    })
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')

    await new Promise((done) => setTimeout(done, 150))
    const state = await (await fetch(`http://127.0.0.1:${port}/__pool/state`, { headers: { 'x-dsh-pool': '1' } })).json()
    assert.equal(state.keys[0].requests, 1)
    assert.equal(state.keys[0].tokens.input, 120)
  } finally {
    for (const c of ctx._cleanups ?? []) await c?.()
    await new Promise((done) => upstream.close(done))
  }
})

function makeImgBlock(id, offloaded = false) {
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

test('resolveMaxRequestImages resolves per-model presets and custom overrides', () => {
  assert.equal(resolveMaxRequestImages('deepseek-v4-1-flash-1017'), 20)
  assert.equal(resolveMaxRequestImages('pixtral-large-latest'), 8)
  assert.equal(resolveMaxRequestImages('pixtral-12b-2409'), 8)
  assert.equal(resolveMaxRequestImages('deepseek-v4-1-flash-1017', { maxRequestImages: 12 }), 12)

  const pixtral = normalizeModelEntry({ id: 'pixtral-large-latest' })
  assert.equal(pixtral.maxRequestImages, 8)
  const flash = normalizeModelEntry({ id: 'deepseek-v4-1-flash-1017' })
  assert.equal(flash.maxRequestImages, undefined)

  const store = { keys: [key('a', { faceUsd: 300 })] }
  const updated = updateModel(store, 'deepseek-v4-1-flash-1017', { maxRequestImages: 15 })
  assert.equal(updated.maxRequestImages, 15)
  const cleared = updateModel(store, 'deepseek-v4-1-flash-1017', { maxRequestImages: null })
  assert.equal(cleared.maxRequestImages, undefined)
  assert.throws(() => updateModel(store, 'deepseek-v4-1-flash-1017', { maxRequestImages: 0 }), (e) => e.status === 400)
})

test('streamDirectResponses enforces image count/byte budgets, aligns tool images, and recovers from 400/3051', async () => {
  const seenPayloads = []
  let upstreamMode = 'ok'
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      seenPayloads.push(parsed)
      if (upstreamMode === '3051') {
        res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'req_3051' })
        res.end(JSON.stringify({ error: { code: '3051', message: 'Invalid argument: too many images' } }))
        return
      }
      if (upstreamMode === '429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '12', 'x-request-id': 'req_429' })
        res.end(JSON.stringify({ error: { message: 'Rate limited' } }))
        return
      }
      if (upstreamMode === '500') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Upstream down' } }))
        return
      }
      if (upstreamMode === '401') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n')
      res.write('event: response.completed\ndata: {"type":"response.completed","response":{"model":"deepseek-v4-1-flash-1017","usage":{"input_tokens":10,"output_tokens":2}}}\n\n')
      res.end()
    })
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))

  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`
  const resolveImage = async () => ({ data: 'AAAA', mimeType: 'image/png' })
  const collect = async (iter) => {
    const out = []
    for await (const item of iter) out.push(item)
    return out
  }

  try {
    // 1. 20 user images pass without offload.
    const msg20 = [{ role: 'user', content: Array.from({ length: 20 }, (_, i) => makeImgBlock(`i${i}`)) }]
    const ok20 = await collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: msg20 }, { baseUrl, resolveImage }))
    assert.equal(ok20.at(-1).reason.kind, 'stop')
    assert.equal(seenPayloads.at(-1).input[0].content.filter((p) => p.type === 'input_image').length, 20)

    // 2. 21st user image triggers IMAGE_OFFLOAD_REQUIRED (quantum 4) before any fetch/image read.
    let readCalls = 0
    const msg21 = [{ role: 'user', content: Array.from({ length: 21 }, (_, i) => makeImgBlock(`i${i}`)) }]
    await assert.rejects(
      async () => collect(streamDirectResponses(
        { model: 'deepseek-v4-1-flash-1017', messages: msg21 },
        { baseUrl, resolveImage: async () => { readCalls += 1; return { data: 'AAAA', mimeType: 'image/png' } } },
      )),
      (err) => err.code === 'IMAGE_OFFLOAD_REQUIRED'
        && err.failure?.code === 'IMAGE_OFFLOAD_REQUIRED'
        && err.failure?.offloadImages === 4,
    )
    assert.equal(readCalls, 0)

    // 3. Marking 4 oldest offloaded succeeds on retry with 17 input_image + 4 placeholders (with/without read-only path).
    const msg21Offloaded = [{
      role: 'user',
      content: Array.from({ length: 21 }, (_, i) => makeImgBlock(`i${i}`, i < 4)),
    }]
    await collect(streamDirectResponses(
      { model: 'deepseek-v4-1-flash-1017', messages: msg21Offloaded },
      { baseUrl, resolveImage, resolveImagePath: (ref) => `/ro/attachments/${ref.name}` },
    ))
    const lastParts = seenPayloads.at(-1).input[0].content
    assert.equal(lastParts.filter((p) => p.type === 'input_image').length, 17)
    const pathPlaceholders = lastParts.filter(
      (p) => p.type === 'input_text' && p.text.includes('Normalized copy (read-only;') && p.text.includes('/ro/attachments/i0.png'),
    )
    assert.equal(pathPlaceholders.length, 1)
    assert.equal(
      lastParts.filter((p) => p.type === 'input_text' && p.text.includes('image omitted to fit request image limits') && p.text.includes('64x64px, image/png')).length,
      4,
    )

    // Without resolveImagePath, falls back cleanly to no-path placeholder.
    await collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: msg21Offloaded }, { baseUrl, resolveImage }))
    assert.ok(
      seenPayloads.at(-1).input[0].content.some(
        (p) => p.type === 'input_text' && p.text.includes('No local normalized image path is available'),
      ),
    )

    // 4. Surface alignment: 3 un-offloaded tool images before 21 user images -> offloadImages === 7.
    const alignedMsgs = [
      { role: 'tool', toolCallId: 'c1', content: [makeImgBlock('t0'), makeImgBlock('t1'), makeImgBlock('t2')] },
      { role: 'user', content: Array.from({ length: 21 }, (_, i) => makeImgBlock(`u${i}`)) },
    ]
    await assert.rejects(
      async () => collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: alignedMsgs }, { baseUrl, resolveImage })),
      (err) => err.code === 'IMAGE_OFFLOAD_REQUIRED' && err.failure?.offloadImages === 7,
    )

    // 5. Base64 byte budget triggers IMAGE_OFFLOAD_REQUIRED.
    const smallMsgs = [{ role: 'user', content: [makeImgBlock('b0'), makeImgBlock('b1'), makeImgBlock('b2')] }]
    await assert.rejects(
      async () => collect(streamDirectResponses(
        { model: 'deepseek-v4-1-flash-1017', messages: smallMsgs },
        { baseUrl, maxRequestImageBytes: 10, resolveImage: async () => ({ data: '123456', mimeType: 'image/png' }) },
      )),
      (err) => err.code === 'IMAGE_OFFLOAD_REQUIRED' && err.failure?.offloadImages === 2,
    )

    // 6. Reactive HTTP 400 / code 3051 with >= 2 images -> IMAGE_OFFLOAD_REQUIRED (no key exhaustion).
    upstreamMode = '3051'
    const nineMsgs = [{ role: 'user', content: Array.from({ length: 9 }, (_, i) => makeImgBlock(`r${i}`)) }]
    await assert.rejects(
      async () => collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: nineMsgs }, { baseUrl, resolveImage })),
      (err) => err.code === 'IMAGE_OFFLOAD_REQUIRED' && err.failure?.offloadImages === 4,
    )

    // Reactive 3051 with only 1 image must NOT trigger image offload.
    const oneMsg = [{ role: 'user', content: [makeImgBlock('single')] }]
    await assert.rejects(
      async () => collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: oneMsg }, { baseUrl, resolveImage })),
      (err) => err.code === 'PROVIDER_ERROR' && err.failure?.code === 'PROVIDER_ERROR' && err.failure?.status === 400,
    )

    // 7. Structured failure propagation for 429, 500, 401, and TRANSPORT.
    upstreamMode = '429'
    await assert.rejects(
      async () => collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { baseUrl })),
      (err) => err.code === 'RATE_LIMIT'
        && err.failure?.code === 'RATE_LIMIT'
        && err.failure?.status === 429
        && err.failure?.providerRetryAfterMs === 12_000
        && err.failure?.requestId === 'req_429',
    )

    upstreamMode = '500'
    await assert.rejects(
      async () => collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { baseUrl })),
      (err) => err.code === 'SERVER' && err.failure?.code === 'SERVER' && err.failure?.status === 500,
    )

    upstreamMode = '401'
    await assert.rejects(
      async () => collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { baseUrl })),
      (err) => err.code === 'AUTH' && err.failure?.code === 'AUTH' && err.failure?.status === 401,
    )

    await new Promise((done) => upstream.close(done))
    await assert.rejects(
      async () => collect(streamDirectResponses({ model: 'deepseek-v4-1-flash-1017', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, { baseUrl })),
      (err) => err.code === 'TRANSPORT' && err.failure?.code === 'TRANSPORT',
    )
    return
  } finally {
    if (upstream.listening) await new Promise((done) => upstream.close(done))
  }
})
