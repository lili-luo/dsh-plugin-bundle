/**
 * Host half of dsh-mistral-pool.
 *
 * Runs a loopback HTTP proxy that the `mistral` provider points at
 * (`baseURL: http://127.0.0.1:28401/v1`). The proxy swaps in the pool's
 * current key on every request, streams the response back untouched, and
 * tees the body to read the token `usage` each response reports.
 *
 * Rotation is reactive first: an upstream 401/402/403 (or a 429 carrying a
 * quota message) means "this key cannot serve", so it is marked and the same
 * request is replayed with the next active key. Proactive rotation happens
 * when the locally estimated spend has reached the key's face value.
 *
 * Balance is an estimate: this deployment exposes no credit figure to an API
 * key (`GET /v1/billing/subscription` answers with the plan only, and
 * `/v1/billing/usage` is not routed), so the only exact signal we get from the
 * API is the 402. Everything else is tokens x a local price table.
 *
 * The price basis comes from DSH's own ledger, which carries two traps:
 * its `cost` column is **CNY**, not USD, and its rows are keyed per upstream
 * site — traffic through this proxy is recorded under the proxy's loopback
 * origin, so pricing it with rates taken from direct `api.mistral.ai` rows
 * mixes in another model's tariff. Both are handled in {@link deriveBlendedRate}.
 *
 * @module dsh-mistral-pool
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, rename, chmod, mkdir, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { REQUEST_IMAGE_MAX_BYTES, VibeAcpRuntime } from './acp-runtime.js'
import { DEFAULT_MODELS, MODEL_PRESETS, MistralAdapter, effectiveModels, normalizeModelEntry, presetForModel, resolveMaxRequestImages } from './adapter.js'
import { streamDirectResponses } from './direct-stream.js'

export { DEFAULT_MODELS, MODEL_PRESETS, MistralAdapter, effectiveModels, normalizeModelEntry, presetForModel, resolveMaxRequestImages } from './adapter.js'
export { buildResponsesPayload, streamDirectResponses } from './direct-stream.js'
export {
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_REQUEST_IMAGES,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  IMAGE_OFFLOAD_REQUIRED_CODE,
} from './image-budget.js'

/** Cordis plugin name and default provider metadata. */
export const name = 'dsh-mistral-pool'
export const DEFAULT_PROVIDER = 'mistral-vibe'
export const DEFAULT_DISPLAY_NAME = 'Mistral Vibe'

/** Default loopback port the proxy listens on. */
export const DEFAULT_PORT = 28401
/** Upstream origin the proxy forwards to. */
export const DEFAULT_UPSTREAM = 'https://api.mistral.ai'
/** Store file name inside the DSH home. */
export const STORE_FILE = 'mistral-pool.json'

/**
 * CNY per USD used to read DSH's ledger.
 *
 * The ledger prices domestic providers in RMB and converts USD-priced entries
 * at estimate time, so every `cost` it stores is CNY. The billing plugin's own
 * fallback is 6.79 when its live rate endpoint is unavailable; override with
 * `cnyPerUsd` in the store when the rate moves.
 */
export const DEFAULT_CNY_PER_USD = 6.79

/**
 * Store schema version for the price basis. Version 1 read the ledger's CNY
 * `cost` as USD and priced the whole pool with rates derived from the direct
 * `api.mistral.ai` site, inflating the total by roughly an order of magnitude
 * (see {@link deriveBlendedRate}). Version 2 converts the currency and scopes
 * the rates to the proxy's own site; {@link migratePricing} rebases once.
 */
export const PRICING_VERSION = 2

/**
 * Ledger model name -> the id the API reports. The billing plugin keys its
 * catalog by provider model (hyphens turned into dots for versioned names),
 * while the API echoes the catalog id, so a single pool shares two vocabularies.
 * Unknown ids fall through to their own name, which still matches when the
 * ledger uses the same spelling.
 */
export const MODEL_ALIASES = {
  'deepseek-v4-1-flash-1017': 'flash',
  'deepseek-v4.1-flash-1017': 'flash',
  'deepseek-v4.1-flash': 'flash',
  'deepseek-v4-flash': 'flash',
  'deepseek-flash': 'flash',
  'zai-glm-5-3': 'glm-5.3',
  'zai-glm-5-3-flash': 'glm-5.3-flash',
  'zai-glm-5-2': 'glm',
}

/** Resolve the DSH home exactly as the other local plugins do. */
export function resolveDshHome(customHome) {
  const raw =
    typeof customHome === 'string' && customHome.trim() !== ''
      ? customHome.trim()
      : typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
        ? process.env.DSH_HOME.trim()
        : join(homedir(), '.dsh')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2))
  return resolve(raw)
}

function loadSchemastery() {
  const candidates = [
    import.meta.url,
    join(resolveDshHome(), 'profiles', 'web', 'package.json'),
    join(process.cwd(), 'package.json'),
  ]
  for (const base of candidates) {
    try {
      const req = createRequire(base)
      const mod = req('@deepseek-ai/schemastery')
      return mod?.default ?? mod
    } catch {
      /* try next resolution root */
    }
  }
  return null
}

function maybeVolatile(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema
}

const z = loadSchemastery()

/** Cordis schema when `@deepseek-ai/schemastery` is available in the host profile. */
export const Config = z
  ? z.object({
      provider: z.string().default(DEFAULT_PROVIDER),
      displayName: maybeVolatile(z.string().default(DEFAULT_DISPLAY_NAME)),
      home: z.string().default(''),
      vibeCommand: z.string().default(''),
    })
  : undefined

/** Empty pool, used when no store exists yet. */
export function emptyStore() {
  return {
    version: 1,
    mode: 'acp',
    directKeyScope: 'auto',
    port: DEFAULT_PORT,
    upstream: DEFAULT_UPSTREAM,
    pricing: {},
    currentId: null,
    affinity: {},
    keys: [],
    // 0 = never priced; a new store has nothing to rebase, so this stays behind
    // PRICING_VERSION and the one-shot migration is a no-op over an empty pool.
    pricingVersion: 0,
  }
}

/** UTC timestamp when Mistral starts counting third-party Vibe key usage against the $30 API pool. */
export const DIRECT_API_CUTOFF_MS = Date.parse('2026-12-01T00:00:00Z')

/** Classify a pool key as `$300` Vibe or `$30` Studio.
 * Explicit `keyRecord.kind` wins; otherwise face values >= $100 are Vibe keys.
 */
export function keyKindOf(keyRecord) {
  if (keyRecord?.kind === 'vibe' || keyRecord?.kind === 'studio') return keyRecord.kind
  return Number(keyRecord?.faceUsd ?? 0) >= 100 ? 'vibe' : 'studio'
}

/** Integer priority for a key (higher number = higher priority, default 0). */
export function keyPriorityOf(keyRecord) {
  const n = Number(keyRecord?.priority)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** Positive routing weight for a key within the same priority tier (default 1). */
export function keyWeightOf(keyRecord) {
  const n = Number(keyRecord?.weight)
  return Number.isFinite(n) && n > 0 ? n : 1
}

function parsePriorityInput(value, fallback = 0) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < -9999 || n > 9999) {
    throw makeInputError('优先级必须为整数', 400)
  }
  return n
}

function parseWeightInput(value, fallback = 1) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 10000) {
    throw makeInputError('权重必须为大于 0 的数字', 400)
  }
  return Math.round(n * 1e4) / 1e4
}

/** Generate the next sequential key id (`key-01`, `key-02`, ...), avoiding collisions. */
export function nextKeyId(keys) {
  const list = Array.isArray(keys) ? keys : []
  const taken = new Set(list.map((k) => k?.id).filter(Boolean))
  let maxNum = 0
  for (const item of list) {
    const match = /^key-(\d+)$/.exec(String(item?.id ?? ''))
    if (match) {
      const n = Number(match[1])
      if (Number.isFinite(n) && n > maxNum) maxNum = n
    }
  }
  let next = maxNum + 1
  while (taken.has(`key-${String(next).padStart(2, '0')}`)) next += 1
  return `key-${String(next).padStart(2, '0')}`
}

function makeInputError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Validate and append a new key record into `store.keys`.
 * Throws an Error with `.status` (400 or 409) on invalid or duplicate input.
 */
export function addKey(store, input = {}) {
  const rawKey = String(input?.key ?? '').trim()
  if (!rawKey) throw makeInputError('API Key 不能为空', 400)
  if (/\s/.test(rawKey)) throw makeInputError('API Key 不能包含空白字符', 400)

  const existing = Array.isArray(store?.keys) ? store.keys : []
  const dup = existing.find((k) => k?.key === rawKey)
  if (dup) {
    throw makeInputError(
      `该 API Key 已存在于池中（${dup.id}${dup.account ? ` · ${dup.account}` : ''}）`,
      409,
    )
  }

  let explicitKind = ''
  if (input?.kind !== undefined && input?.kind !== null && input?.kind !== '') {
    if (input.kind !== 'vibe' && input.kind !== 'studio') {
      throw makeInputError('类型仅支持 vibe 或 studio', 400)
    }
    explicitKind = input.kind
  }

  let faceUsd
  if (input?.faceUsd !== undefined && input?.faceUsd !== null && String(input.faceUsd).trim() !== '') {
    faceUsd = Number(input.faceUsd)
    if (!Number.isFinite(faceUsd) || faceUsd < 0) {
      throw makeInputError('面值必须为非负数字', 400)
    }
  } else {
    faceUsd = explicitKind === 'studio' ? 30 : 300
  }

  const resolvedKind = explicitKind || (faceUsd >= 100 ? 'vibe' : 'studio')

  let usedUsd = 0
  if (input?.usedUsd !== undefined && input?.usedUsd !== null && String(input.usedUsd).trim() !== '') {
    usedUsd = Number(input.usedUsd)
    if (!Number.isFinite(usedUsd) || usedUsd < 0) {
      throw makeInputError('已用金额必须为非负数字', 400)
    }
  }

  const priority = parsePriorityInput(input?.priority, 0)
  const weight = parseWeightInput(input?.weight, 1)

  const record = {
    id: nextKeyId(existing),
    kind: resolvedKind,
    account: String(input?.account ?? '').trim(),
    memo: String(input?.memo ?? '').trim(),
    key: rawKey,
    faceUsd: Math.round(faceUsd * 1e4) / 1e4,
    usedUsd: Math.round(usedUsd * 1e8) / 1e8,
    priority,
    weight,
    tokens: { input: 0, output: 0, cached: 0 },
    models: {},
    requests: 0,
    status: 'active',
    lastError: '',
    lastUsedAt: 0,
    exhaustedAt: 0,
    unpriced: false,
  }

  store.keys ??= []
  store.keys.push(record)
  if (input?.setCurrent === true) {
    store.currentId = record.id
  }
  return record
}

/**
 * Remove a key record from `store.keys`, releasing its pinned conversations and
 * clearing `store.currentId` when the active key is deleted.
 */
export function deleteKey(store, id) {
  const list = Array.isArray(store?.keys) ? store.keys : []
  const idx = list.findIndex((k) => k?.id === id)
  if (idx < 0) throw makeInputError('unknown key', 404)

  const [removed] = list.splice(idx, 1)
  if (store?.affinity && typeof store.affinity === 'object') {
    for (const [affinityKey, pinnedId] of Object.entries(store.affinity)) {
      if (pinnedId === removed.id) delete store.affinity[affinityKey]
    }
  }
  if (store?.currentId === removed.id) {
    store.currentId = null
  }
  return removed
}

/** Enable a key record (restoring an exhausted or disabled key back to active). */
export function enableKey(store, id) {
  const record = (Array.isArray(store?.keys) ? store.keys : []).find((k) => k?.id === id)
  if (!record) throw makeInputError('unknown key', 404)
  record.status = 'active'
  record.exhaustedAt = 0
  record.lastError = ''
  return record
}

/** Disable a key record manually, releasing pinned conversations and clearing currentId if needed. */
export function disableKey(store, id) {
  const record = (Array.isArray(store?.keys) ? store.keys : []).find((k) => k?.id === id)
  if (!record) throw makeInputError('unknown key', 404)
  record.status = 'disabled'
  if (store?.affinity && typeof store.affinity === 'object') {
    for (const [affinityKey, pinnedId] of Object.entries(store.affinity)) {
      if (pinnedId === record.id) delete store.affinity[affinityKey]
    }
  }
  if (store?.currentId === record.id) {
    store.currentId = null
  }
  return record
}

/** Update priority and/or weight of an existing key record. */
export function updateKeySchedule(store, id, input = {}) {
  const record = (Array.isArray(store?.keys) ? store.keys : []).find((k) => k?.id === id)
  if (!record) throw makeInputError('unknown key', 404)
  if (input?.priority !== undefined && input?.priority !== null && String(input.priority).trim() !== '') {
    record.priority = parsePriorityInput(input.priority, keyPriorityOf(record))
  }
  if (input?.weight !== undefined && input?.weight !== null && String(input.weight).trim() !== '') {
    record.weight = parseWeightInput(input.weight, keyWeightOf(record))
  }
  return record
}

/** Update any editable fields of an existing key record (account, memo, faceUsd, kind, priority, weight, optional key). */
export function updateKey(store, id, input = {}) {
  const list = Array.isArray(store?.keys) ? store.keys : []
  const record = list.find((k) => k?.id === id)
  if (!record) throw makeInputError('unknown key', 404)

  if (input?.key !== undefined && input?.key !== null && String(input.key).trim() !== '') {
    const rawKey = String(input.key).trim()
    if (/\s/.test(rawKey)) throw makeInputError('API Key 不能包含空白字符', 400)
    const dup = list.find((k) => k?.id !== record.id && k?.key === rawKey)
    if (dup) {
      throw makeInputError(
        `该 API Key 已存在于池中（${dup.id}${dup.account ? ` · ${dup.account}` : ''}）`,
        409,
      )
    }
    record.key = rawKey
  }

  if (input?.account !== undefined) {
    record.account = String(input.account ?? '').trim()
  }
  if (input?.memo !== undefined) {
    record.memo = String(input.memo ?? '').trim()
  }
  if (input?.kind !== undefined && input?.kind !== null && input?.kind !== '') {
    if (input.kind !== 'vibe' && input.kind !== 'studio') {
      throw makeInputError('类型仅支持 vibe 或 studio', 400)
    }
    record.kind = input.kind
  }
  if (input?.faceUsd !== undefined && input?.faceUsd !== null && String(input.faceUsd).trim() !== '') {
    const face = Number(input.faceUsd)
    if (!Number.isFinite(face) || face < 0) {
      throw makeInputError('面值必须为非负数字', 400)
    }
    record.faceUsd = Math.round(face * 1e4) / 1e4
  }
  if (input?.priority !== undefined && input?.priority !== null && String(input.priority).trim() !== '') {
    record.priority = parsePriorityInput(input.priority, keyPriorityOf(record))
  }
  if (input?.weight !== undefined && input?.weight !== null && String(input.weight).trim() !== '') {
    record.weight = parseWeightInput(input.weight, keyWeightOf(record))
  }
  return record
}

/** Add a model entry to `store.models`, cloning defaults first if uncustomized. */
export function addModel(store, input = {}) {
  const id = String(input?.id ?? '').trim()
  if (!id) throw makeInputError('模型 ID 不能为空', 400)
  if (/\s/.test(id)) throw makeInputError('模型 ID 不能包含空白字符', 400)

  const current = effectiveModels(store)
  if (current.some((m) => m.id === id)) {
    throw makeInputError(`模型 ${id} 已存在于目录中`, 409)
  }
  const entry = normalizeModelEntry({ ...input, id })
  store.models = [...current, entry]
  return entry
}

/** Remove a model entry from `store.models`. */
export function removeModel(store, modelId) {
  const id = String(modelId ?? '').trim()
  if (!id) throw makeInputError('unknown model', 404)
  const current = effectiveModels(store)
  const idx = current.findIndex((m) => m.id === id)
  if (idx < 0) throw makeInputError('unknown model', 404)
  const [removed] = current.splice(idx, 1)
  store.models = current
  return removed
}

/** Update capabilities or display name of an existing model entry in `store.models`. */
export function updateModel(store, modelId, input = {}) {
  const id = String(modelId ?? '').trim()
  if (!id) throw makeInputError('unknown model', 404)
  const current = effectiveModels(store)
  const idx = current.findIndex((m) => m.id === id)
  if (idx < 0) throw makeInputError('unknown model', 404)

  const existing = current[idx]
  const next = { ...existing }

  if (input?.name !== undefined) {
    next.name = String(input.name ?? '').trim() || existing.id
  }
  if (input?.contextWindow !== undefined && input?.contextWindow !== null && String(input.contextWindow).trim() !== '') {
    const cw = Number(input.contextWindow)
    if (!Number.isInteger(cw) || cw <= 0) throw makeInputError('上下文窗口必须为正整数', 400)
    next.contextWindow = cw
  }
  if (input?.maxTokens !== undefined && input?.maxTokens !== null && String(input.maxTokens).trim() !== '') {
    const mt = Number(input.maxTokens)
    if (!Number.isInteger(mt) || mt <= 0) throw makeInputError('最大输出 token 数必须为正整数', 400)
    next.maxTokens = mt
  }
  if (input?.input !== undefined) {
    if (!Array.isArray(input.input)) throw makeInputError('输入类型格式无效', 400)
    const filtered = input.input.filter((item) => item === 'text' || item === 'image')
    if (filtered.length === 0) throw makeInputError('至少选择一种输入类型', 400)
    next.input = [...new Set(filtered)]
  }
  if (Array.isArray(input?.efforts)) {
    next.efforts = input.efforts
  }
  if (input?.maxRequestImages !== undefined) {
    if (input.maxRequestImages === null || String(input.maxRequestImages).trim() === '') {
      delete next.maxRequestImages
    } else {
      const mri = Number(input.maxRequestImages)
      if (!Number.isInteger(mri) || mri <= 0) throw makeInputError('单次请求图片上限必须为正整数', 400)
      next.maxRequestImages = mri
    }
  }

  const normalized = normalizeModelEntry(next)
  current[idx] = normalized
  store.models = current
  return normalized
}

/** Reset custom `store.models` back to `DEFAULT_MODELS`. */
export function resetModels(store) {
  delete store.models
  return effectiveModels(store)
}

/**
 * Fetch available model IDs from upstream `GET /v1/models` using usable keys
 * in the pool (trying up to 3 active keys on auth/quota rejection).
 */
export async function discoverUpstreamModels(store, options = {}) {
  const upstream = String(options.upstream ?? store?.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, '')
  const candidates = (Array.isArray(store?.keys) ? store.keys : []).filter(isUsable)
  if (candidates.length === 0) {
    throw makeInputError('池中没有可用的 Key，请先在「Mistral Key 池」添加并启用 Key', 400)
  }

  let lastError = null
  for (const candidate of candidates.slice(0, 3)) {
    try {
      const timeoutSignal = AbortSignal.timeout(Number(options.timeoutMs ?? 8_000))
      const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal
      const res = await fetch(`${upstream}/v1/models`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${candidate.key}`,
          accept: 'application/json',
        },
        signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        lastError = makeInputError(`上游返回 HTTP ${res.status}: ${text.slice(0, 120)}`, res.status >= 400 && res.status < 500 ? 400 : 502)
        if (isKeyExhausted(res.status, text)) continue
        throw lastError
      }
      const doc = await res.json()
      const rows = Array.isArray(doc?.data) ? doc.data : []
      return rows
        .map((m) => {
          const id = String(m?.id ?? '').trim()
          if (!id) return null
          const preset = presetForModel(id)
          const vision = m?.capabilities?.vision
          const input = typeof vision === 'boolean'
            ? (vision ? ['text', 'image'] : ['text'])
            : (preset?.input ? [...preset.input] : ['text', 'image'])
          return {
            id,
            name: String(m?.name ?? '').trim() || preset?.name || id,
            contextWindow: Number(m?.max_context_length) || preset?.contextWindow,
            maxTokens: preset?.maxTokens,
            input,
            efforts: preset?.efforts ? [...preset.efforts] : undefined,
            ownedBy: String(m?.owned_by ?? ''),
          }
        })
        .filter(Boolean)
    } catch (error) {
      if (error?.status && error.status !== 401 && error.status !== 402 && error.status !== 403) {
        throw error
      }
      lastError = error
    }
  }
  throw lastError ?? makeInputError('无法从上游拉取模型目录', 502)
}

/**
 * Filter usable keys eligible for the active transport mode.
 *
 * - Without `mode`: every usable key is eligible (backwards-compatible default).
 * - `acp`: only usable `$300` Vibe keys when the store holds any Vibe key; falls
 *   back to all usable keys only if the pool has zero Vibe keys configured.
 * - `direct`: when `directKeyScope` is `'studio'`, or `'auto'` on/after
 *   2026-12-01 UTC, restricts to `$30` Studio keys (if any exist) so API calls
 *   do not cross-exhaust `$300` Vibe keys on the same account.
 */
export function eligibleKeysForMode(keys, options = {}) {
  const list = Array.isArray(keys) ? keys : []
  const mode = options?.mode
  if (!mode) return list.filter(isUsable)
  if (mode === 'acp') {
    const hasVibe = list.some((k) => keyKindOf(k) === 'vibe')
    return list.filter((k) => (!hasVibe || keyKindOf(k) === 'vibe') && isUsable(k))
  }
  const scope = options.directKeyScope ?? 'auto'
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const studioOnly = scope === 'studio' || (scope === 'auto' && nowMs >= DIRECT_API_CUTOFF_MS)
  if (studioOnly && list.some((k) => keyKindOf(k) === 'studio')) {
    return list.filter((k) => keyKindOf(k) === 'studio' && isUsable(k))
  }
  return list.filter(isUsable)
}

/** Mask a key for display: provider prefix plus the last four characters. */
export function maskKey(key) {
  const raw = String(key ?? '')
  if (raw.length <= 8) return '****'
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`
}

/**
 * Cached prompt tokens are billed far below fresh input (Mistral charges about
 * a tenth). Costing them at the input rate inflates a cache-heavy session by an
 * order of magnitude, so every estimate in this plugin applies this discount.
 */
export const CACHED_DISCOUNT = 0.1

/**
 * Published Mistral list prices, in USD per million tokens. `store.pricing`
 * overrides these; they exist so a pool with no configured table still
 * estimates from real tariffs instead of a blended average that a single
 * expensive model can skew.
 */
export const DEFAULT_PRICING = {
  'mistral-large': { in: 2, out: 6, cached: 0.2 },
  'mistral-medium': { in: 0.4, out: 2, cached: 0.04 },
  'mistral-small': { in: 0.2, out: 0.6, cached: 0.02 },
  'codestral': { in: 0.3, out: 0.9, cached: 0.03 },
  'devstral-medium': { in: 0.4, out: 2, cached: 0.04 },
  'devstral-small': { in: 0.1, out: 0.3, cached: 0.01 },
  'devstral': { in: 0.4, out: 2, cached: 0.04 },
  'pixtral-large': { in: 2, out: 6, cached: 0.2 },
  'open-mistral-nemo': { in: 0.15, out: 0.15, cached: 0.015 },
  'magistral-medium': { in: 2, out: 5, cached: 0.2 },
  'magistral-small': { in: 0.5, out: 1.5, cached: 0.05 },
}

/**
 * Cost of one call, in USD, from a local per-million-token price table.
 * Cached prompt tokens are billed separately when the table names a cached
 * rate; without one they fall back to the input rate. Unknown models cost
 * nothing and are reported as unpriced instead of silently over-reporting.
 */
export function computeCost(usage, price) {
  if (!price || !usage) return { usd: 0, priced: false }
  const hasRate = ['in', 'out', 'cached'].some((field) => Number(price[field] ?? 0) > 0)
  if (!hasRate) return { usd: 0, priced: false }
  const input = Number(usage.input ?? 0) || 0
  const cached = Math.min(Number(usage.cached ?? 0) || 0, input)
  const output = Number(usage.output ?? 0) || 0
  const inputRate = Number(price.in ?? 0) || 0
  const cachedRate = price.cached === undefined ? inputRate : Number(price.cached) || 0
  const outputRate = Number(price.out ?? 0) || 0
  const usd = ((input - cached) * inputRate + cached * cachedRate + output * outputRate) / 1_000_000
  return { usd, priced: true }
}

/** Fold one call's usage into a key record; returns the mutated record. */
export function applyUsage(keyRecord, usage, price, model) {
  const out = keyRecord.tokens ?? { input: 0, output: 0, cached: 0 }
  const input = Number(usage?.input ?? 0) || 0
  const output = Number(usage?.output ?? 0) || 0
  const cached = Number(usage?.cached ?? 0) || 0
  out.input += input
  out.output += output
  out.cached += cached
  keyRecord.tokens = out
  keyRecord.requests = (keyRecord.requests ?? 0) + 1
  keyRecord.lastUsedAt = Date.now()
  const { usd, priced } = computeCost(usage, price)
  if (priced) keyRecord.usedUsd = Number(((keyRecord.usedUsd ?? 0) + usd).toFixed(8))
  else keyRecord.unpriced = true
  // Per-model buckets keep a key's spend attributable after the fact: a single
  // blended rate cannot separate a cheap cache-heavy model from an expensive
  // one, and rebasing needs something better than the sum of tokens.
  if (model) {
    const buckets = (keyRecord.models ??= {})
    const bucket = (buckets[model] ??= { input: 0, output: 0, cached: 0, requests: 0, usd: 0 })
    bucket.input += input
    bucket.output += output
    bucket.cached += cached
    bucket.requests += 1
    if (priced) bucket.usd = Number((bucket.usd + usd).toFixed(8))
  }
  return keyRecord
}

/** Remaining face value, or null when the key carries no declared budget. */
export function remainingUsd(keyRecord) {
  const face = Number(keyRecord?.faceUsd ?? 0)
  if (!(face > 0)) return null
  return Math.max(0, face - (Number(keyRecord?.usedUsd ?? 0) || 0))
}

/**
 * Whether a key can serve a request right now.
 *
 * An official balance wins over the estimate when one is available: the local
 * figure is only as good as the price table, while the upstream knows the real
 * wallet. A hard 402 still rotates regardless — this is a routing preference,
 * not the source of truth.
 */
export function isUsable(keyRecord) {
  if (!keyRecord) return false
  if (keyRecord.status !== 'active') return false
  const official = billingBalance(keyRecord)
  if (official !== null) return official > 0
  const left = remainingUsd(keyRecord)
  return left === null || left > 0
}

/**
 * Next key to use, starting after `fromId` and wrapping around, so a pool of
 * equally good keys is consumed in round-robin order instead of hammering the
 * first one until it dies.
 */
export function pickNext(keys, fromId) {
  const list = Array.isArray(keys) ? keys : []
  const usable = list.filter(isUsable)
  if (usable.length === 0) return null
  const maxPriority = Math.max(...usable.map(keyPriorityOf))
  const start = Math.max(0, list.findIndex((k) => k.id === fromId))
  for (let step = 1; step <= list.length; step += 1) {
    const candidate = list[(start + step) % list.length]
    if (isUsable(candidate) && keyPriorityOf(candidate) === maxPriority) return candidate
  }
  return null
}

/** First usable key in the highest-priority tier, used when the store has no current id yet. */
export function pickFirst(keys) {
  const list = Array.isArray(keys) ? keys : []
  const usable = list.filter(isUsable)
  if (usable.length === 0) return null
  const maxPriority = Math.max(...usable.map(keyPriorityOf))
  return usable.find((k) => keyPriorityOf(k) === maxPriority) ?? null
}

/** How many conversations a store keeps pinned before evicting the oldest. */
export const MAX_AFFINITY = 200

/** Largest request body parsed for a conversation prefix; bigger bodies are hashed by slice. */
export const AFFINITY_PARSE_MAX_BYTES = 64 * 1024

/**
 * Stable id for the conversation behind a request.
 *
 * Prompt caching is per key and per prefix, so a chat only keeps its cache if
 * every turn lands on the same key. An explicit session header wins; otherwise
 * the conversation prefix (system message plus first turn) is hashed, which
 * stays constant while the chat grows and separates different conversations.
 *
 * A body larger than {@link AFFINITY_PARSE_MAX_BYTES} skips parsing and hashes
 * its leading bytes instead (`q:` ids), so a multi-megabyte request does not pay
 * for a `JSON.parse` the upstream is about to repeat.
 * @param headers - incoming request headers.
 * @param body - the buffered request body.
 * @returns the conversation id, or `''` when the body carries no prefix.
 */
export function affinityOf(headers, body) {
  for (const name of ['x-dsh-session', 'x-session-id', 'x-conversation-id', 'x-affinity']) {
    const value = headers?.[name]
    if (typeof value === 'string' && value.trim() !== '') return `h:${value.trim()}`
  }
  if (!body || body.length === 0) return ''
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  if (bytes.length > AFFINITY_PARSE_MAX_BYTES) {
    // The leading bytes are the stable part of a chat (system message and the
    // earliest turns), so hashing them keeps one conversation on one key
    // without parsing megabytes of JSON on every request.
    return `q:${createHash('sha1').update(bytes.subarray(0, AFFINITY_PARSE_MAX_BYTES)).digest('hex').slice(0, 16)}`
  }
  try {
    const doc = JSON.parse(bytes.toString('utf8'))
    const messages = Array.isArray(doc.messages)
      ? doc.messages
      : Array.isArray(doc.input)
        ? doc.input
        : Array.isArray(doc.prompt)
          ? doc.prompt
          : []
    const parts = []
    for (const message of messages.slice(0, 2)) {
      if (typeof message === 'string') parts.push(message)
      else if (typeof message?.content === 'string') parts.push(message.content)
      else if (Array.isArray(message?.content)) {
        parts.push(message.content.map((part) => part?.text ?? '').join(''))
      }
    }
    const prefix = parts.join('\u0000').slice(0, 2000)
    if (prefix === '') return ''
    return `p:${createHash('sha1').update(prefix).digest('hex').slice(0, 16)}`
  } catch {
    return ''
  }
}

/** Pin one conversation to one key, evicting the oldest pin past the cap. */
export function rememberAffinity(store, affinity, keyId) {
  if (!affinity) return
  store.affinity ??= {}
  delete store.affinity[affinity]
  store.affinity[affinity] = keyId
  const pins = Object.keys(store.affinity)
  for (const stale of pins.slice(0, Math.max(0, pins.length - MAX_AFFINITY))) delete store.affinity[stale]
}

/** Conversation count per key, for spreading new chats across the pool. */
function affinityLoad(map) {
  const load = Object.create(null)
  for (const id of Object.values(map ?? {})) load[id] = (load[id] ?? 0) + 1
  return load
}

/**
 * Usable key carrying the fewest weighted pinned conversations in the highest
 * available priority tier. Higher priority always wins while usable; within the
 * same priority, `load / weight` distributes new chats proportionally to weight.
 */
export function leastLoaded(keys, map, preferId) {
  const usable = (Array.isArray(keys) ? keys : []).filter(isUsable)
  if (usable.length === 0) return null
  const maxPriority = Math.max(...usable.map(keyPriorityOf))
  const pool = usable.filter((k) => keyPriorityOf(k) === maxPriority)
  const load = affinityLoad(map)
  const scoreOf = (k) => (load[k.id] ?? 0) / keyWeightOf(k)
  let best = pool[0]
  for (const key of pool) {
    const sKey = scoreOf(key)
    const sBest = scoreOf(best)
    if (sKey + 1e-9 < sBest || (Math.abs(sKey - sBest) <= 1e-9 && keyWeightOf(key) > keyWeightOf(best))) {
      best = key
    }
  }
  if (preferId) {
    const preferred = pool.find((key) => key.id === preferId)
    if (
      preferred &&
      scoreOf(preferred) <= scoreOf(best) + 1e-9 &&
      keyWeightOf(preferred) >= keyWeightOf(best)
    ) {
      return preferred
    }
  }
  return best
}

/**
 * Whether an upstream failure means "this key is out", as opposed to a
 * transient error that the same key could survive.
 * 401/402/403 are unambiguous; 429 counts only when the body says so, because
 * a plain rate limit is shared across the whole account and rotating would
 * just burn another key's budget for nothing.
 */
export function isKeyExhausted(status, bodyText) {
  if (status === 401 || status === 402 || status === 403) return true
  if (status === 429) {
    const text = String(bodyText ?? '').toLowerCase()
    return /insufficient|quota|credit|balance|exceeded/.test(text)
  }
  return false
}

/** Normalize the several usage shapes Mistral returns into one record. */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const input = raw.input_tokens ?? raw.prompt_tokens
  const output = raw.output_tokens ?? raw.completion_tokens
  if (typeof input !== 'number' && typeof output !== 'number') return null
  const cached =
    raw.input_tokens_details?.cached_tokens ??
    raw.prompt_tokens_details?.cached_tokens ??
    raw.cache_read_input_tokens ??
    0
  return {
    input: Number(input ?? 0) || 0,
    output: Number(output ?? 0) || 0,
    cached: Number(cached ?? 0) || 0,
  }
}

/**
 * Pull `{model, usage}` out of one JSON document: a whole non-streamed body,
 * or one SSE event. Both the chat and responses shapes nest usage under the
 * response object.
 */
export function extractUsageDoc(doc) {
  if (!doc || typeof doc !== 'object') return null
  const candidates = [doc, doc.response, doc.data]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const usage = normalizeUsage(candidate.usage)
    if (usage) return { model: candidate.model ?? doc.model ?? null, usage }
  }
  return null
}

/**
 * Incremental tap over a response body. SSE frames are parsed line by line;
 * a JSON body is held until the stream ends and parsed once.
 *
 * Streams repeat a running total rather than sending one final figure, so the
 * tap keeps only the newest usage record and reports it once when the body
 * ends. Emitting per frame would fold one call into the ledger several times
 * over — the bug that made a $4.40 account read as $128.
 */
export function createUsageTap(onUsage) {
  let buffer = ''
  let jsonBuffer = ''
  let isJson = false
  let pending = null
  const absorb = (doc) => {
    const hit = extractUsageDoc(doc)
    if (hit) pending = hit
  }
  return {
    expectJson() {
      isJson = true
    },
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (isJson) {
        jsonBuffer += text
        if (jsonBuffer.length > 4_000_000) jsonBuffer = jsonBuffer.slice(-2_000_000)
        return
      }
      buffer += text
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try {
              absorb(JSON.parse(payload))
            } catch {
              /* keep-alive comments and truncated frames are not fatal */
            }
          }
        }
        index = buffer.indexOf('\n')
      }
      if (buffer.length > 1_000_000) buffer = ''
    },
    end() {
      if (isJson && jsonBuffer.trim() !== '') {
        try {
          absorb(JSON.parse(jsonBuffer))
        } catch {
          /* a body that is not JSON cannot report usage */
        }
      }
      if (!isJson && buffer.trim() !== '') {
        const line = buffer.trim()
        if (line.startsWith('data:')) {
          try {
            absorb(JSON.parse(line.slice(5).trim()))
          } catch {
            /* ignore */
          }
        }
      }
      buffer = ''
      jsonBuffer = ''
      if (pending) {
        const hit = pending
        pending = null
        onUsage(hit)
      }
    },
  }
}

/**
 * The `site` label DSH writes for traffic that came through this proxy: the
 * provider's `baseURL` is the loopback origin, so the ledger keys those rows by
 * it rather than by the upstream host.
 */
export function poolSite(port) {
  return `site:http://127.0.0.1:${Number(port) || DEFAULT_PORT}`
}

/**
 * Whether a ledger site label is this proxy rather than a real upstream.
 *
 * The label embeds the provider's `baseURL`, so it carries the port the proxy
 * listened on at the time — and that can change without the ledger following.
 * Matching the loopback shape keeps the pool's own rows in scope across a port
 * change, which otherwise silently falls back to the upstream tariff and
 * re-introduces the very mix-up this module exists to avoid.
 */
export function isLoopbackSite(site) {
  return /^site:https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(site ?? ''))
}

/** Resolve a model id to the name the billing ledger prices it under. */
export function aliasOf(model) {
  const raw = String(model ?? '').trim()
  if (raw === '') return ''
  return MODEL_ALIASES[raw] ?? MODEL_ALIASES[raw.toLowerCase()] ?? raw
}

/**
 * Derive the pool's price basis from DSH's own usage ledger.
 *
 * Mistral publishes no credit balance to an API key, but DSH already prices
 * every call it makes, so the ledger is the closest thing to the real tariff we
 * can read locally — provided two things are read correctly:
 *
 * 1. **Currency.** The ledger's `cost` is CNY: its catalog prices domestic
 *    providers in RMB and converts USD entries at estimate time. Treating it as
 *    USD overstates spend by the exchange rate.
 * 2. **Site.** Rows are keyed per upstream site. Rates derived from direct
 *    `api.mistral.ai` rows describe whatever ran outside the pool; pricing the
 *    proxy's traffic with them charges a cheap cache-heavy model at an expensive
 *    model's tariff. Only the proxy's own site describes pool traffic, and the
 *    fallback to the upstream site keeps a ledger without proxy rows working.
 *
 * Per-model rates come back alongside the blend, so a call is priced by the
 * model that actually served it instead of by the pool-wide average.
 *
 * @returns {Promise<{usdPerToken:number,cnyPerToken:number,cnyPerUsd:number,
 *   samples:number,site:string,models:Record<string,{usdPerToken:number,samples:number}>}|null>}
 *   null when the ledger has no priced traffic for this pool.
 */
export async function deriveBlendedRate(dshHome, options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT) || DEFAULT_PORT
  const cnyPerUsd = Number(options.cnyPerUsd ?? DEFAULT_CNY_PER_USD) || DEFAULT_CNY_PER_USD
  const upstreamHost = (() => {
    try {
      return new URL(options.upstream ?? DEFAULT_UPSTREAM).host
    } catch {
      return 'api.mistral.ai'
    }
  })()
  let stats
  try {
    stats = JSON.parse(await readFile(join(dshHome, '.dsh-usage-stats.json'), 'utf8'))
  } catch {
    return null
  }

  const rows = []
  const byDayModelsSite = stats?.byDayModelsSite
  if (byDayModelsSite && typeof byDayModelsSite === 'object') {
    for (const models of Object.values(byDayModelsSite)) {
      if (!models || typeof models !== 'object') continue
      for (const [model, sites] of Object.entries(models)) {
        if (!sites || typeof sites !== 'object') continue
        for (const [site, entry] of Object.entries(sites)) {
          if (!entry || typeof entry !== 'object') continue
          rows.push({ model, site, entry })
        }
      }
    }
  }

  const own = poolSite(port)
  const loopback = rows.filter((row) => isLoopbackSite(row.site))
  const exact = loopback.filter((row) => row.site === own)
  const fromUpstream = rows.filter((row) => row.site.startsWith('site:') && row.site.includes(upstreamHost))
  const chosen = exact.length > 0 ? exact : loopback.length > 0 ? loopback : fromUpstream
  if (chosen.length === 0) return null
  const site = chosen[0].site

  const perModel = Object.create(null)
  let cost = 0
  let tokens = 0
  let samples = 0
  for (const { model, entry } of chosen) {
    const entryCost = Number(entry.cost ?? 0) || 0
    const input = Number(entry.input ?? 0) || 0
    const output = Number(entry.output ?? 0) || 0
    const cacheHit = Math.min(Number(entry.cacheHit ?? 0) || 0, input)
    const cacheMiss = Math.max(0, input - cacheHit)
    // Effective tokens bill cached input at the discount, matching
    // computeCost so both sides of the estimate share one unit.
    const effective = cacheMiss + output + cacheHit * CACHED_DISCOUNT
    if (entryCost <= 0 || effective <= 0) continue
    const calls = Number(entry.calls ?? 0) || 0
    cost += entryCost
    tokens += effective
    samples += calls
    const bucket = (perModel[model] ??= { cost: 0, tokens: 0, samples: 0 })
    bucket.cost += entryCost
    bucket.tokens += effective
    bucket.samples += calls
  }
  if (tokens <= 0 || cost <= 0) return null

  const models = {}
  for (const [model, bucket] of Object.entries(perModel)) {
    if (bucket.tokens <= 0 || bucket.cost <= 0) continue
    models[model] = { usdPerToken: bucket.cost / cnyPerUsd / bucket.tokens, samples: bucket.samples }
  }
  return {
    usdPerToken: cost / cnyPerUsd / tokens,
    cnyPerToken: cost / tokens,
    cnyPerUsd,
    samples,
    site,
    models,
  }
}

/**
 * Per-model price table derived from the ledger, shaped for {@link computeCost}.
 * Null for a model the ledger has not priced yet, which lets the caller fall
 * back to the pool-wide blend.
 */
export function modelPrice(rates, model) {
  const alias = aliasOf(model)
  if (alias === '') return null
  const hit = rates?.models?.[alias] ?? rates?.models?.[model]
  if (!hit || !(Number(hit.usdPerToken) > 0)) return null
  return blendedPrice(hit.usdPerToken)
}

/**
 * Price one call: the user's own table wins, then the model's own ledger rate,
 * then the pool-wide blend for a model the ledger has not seen.
 */
export function resolvePrice(store, model) {
  return priceFor(store?.pricing, model) ?? modelPrice(store?.rates, model) ?? blendedPrice(store?.rates?.usdPerToken)
}

/** How often the pool re-reads the official balance, when the upstream has one. */
export const BILLING_REFRESH_MS = 30 * 60 * 1000
/** Per-request cap for a billing probe; a slow billing endpoint must not stall the pool. */
export const BILLING_TIMEOUT_MS = 8_000
/** An official figure older than this is treated as stale and ignored. */
export const BILLING_TRUST_MS = 24 * 60 * 60 * 1000
/**
 * Re-check interval when the deployment answered but exposed no balance at all.
 * A blind endpoint does not become less blind every half hour; six hours still
 * picks a newly deployed field up on the same day without hammering it.
 */
export const BILLING_BLIND_MS = 6 * 60 * 60 * 1000

/** First finite number among `names`, or null. Never invents a zero. */
function numberField(doc, names) {
  for (const name of names) {
    if (doc?.[name] === null || doc?.[name] === undefined) continue
    const value = Number(doc[name])
    if (Number.isFinite(value)) return value
  }
  return null
}

/** First non-empty string among `names`, or ''. */
function stringField(doc, names) {
  for (const name of names) {
    if (typeof doc?.[name] === 'string' && doc[name] !== '') return doc[name]
  }
  return ''
}

/**
 * Fold a daily usage payload into a month-to-date cost.
 *
 * The documented shape is `{ data: [{ total_cost, input_tokens, ... }] }`;
 * other relay builds answer with a bare array or a flat object, so every
 * plausible row shape is accepted and an empty payload returns null rather than
 * pretending the month cost nothing.
 */
export function sumUsageCost(doc) {
  const rows = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc) ? doc : []
  let cost = 0
  let seen = false
  for (const row of rows) {
    const value = numberField(row, ['total_cost', 'cost', 'amount', 'usd', 'total'])
    if (value === null) continue
    cost += value
    seen = true
  }
  return seen ? cost : null
}

/**
 * Read the official plan and balance for one key, when the upstream exposes it.
 *
 * Two documented endpoints are tried, in the order that costs a request only
 * when it can still add information:
 *
 * 1. `GET /v1/billing/subscription` — plan, prepaid `credit_balance`, budget.
 * 2. `GET /v1/billing/usage` — month-to-date cost per day. Only called when the
 *    first answer carried no credit figure, so a deployment that implements
 *    subscription properly is asked exactly once.
 *
 * This deployment answers (1) with the plan only and 404s (2), so the returned
 * record is explicitly partial: `creditUsd === null` means "no official balance
 * available", which the pool treats as "fall back to the estimate". Nothing is
 * ever inferred from a missing field, and a failed probe never marks a key.
 *
 * @returns {Promise<{at:number,source:string,plan:string,paygEnabled:boolean|null,
 *   currency:string,creditUsd:number|null,monthlyBudgetUsd:number|null,
 *   monthToDateUsd:number|null,error:string}|null>} null when no endpoint answered.
 */
export async function probeBilling(keyRecord, options = {}) {
  if (!keyRecord?.key) return null
  const upstream = String(options.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, '')
  const timeoutMs = Number(options.timeoutMs ?? BILLING_TIMEOUT_MS)
  const now = options.now instanceof Date ? options.now : new Date()
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  const today = now.toISOString().slice(0, 10)
  const request = async (path) => {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal
      const response = await fetch(`${upstream}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${keyRecord.key}`, accept: 'application/json' },
        signal,
      })
      if (!response.ok) return { status: response.status, doc: null }
      const text = await response.text()
      if (text.trim() === '') return { status: response.status, doc: null }
      return { status: response.status, doc: JSON.parse(text) }
    } catch {
      return { status: 0, doc: null }
    }
  }

  const record = {
    at: Date.now(),
    source: '',
    plan: '',
    paygEnabled: null,
    enterprise: null,
    currency: 'USD',
    creditUsd: null,
    monthlyBudgetUsd: null,
    monthToDateUsd: null,
    error: '',
  }

  const subscription = await request('/v1/billing/subscription')
  if (subscription.doc) {
    record.source = 'subscription'
    record.plan = stringField(subscription.doc, ['plan_name', 'plan', 'name'])
    if (typeof subscription.doc.payg_enabled === 'boolean') record.paygEnabled = subscription.doc.payg_enabled
    if (typeof subscription.doc.enterprise === 'boolean') record.enterprise = subscription.doc.enterprise
    record.currency = stringField(subscription.doc, ['currency']) || record.currency
    record.creditUsd = numberField(subscription.doc, ['credit_balance', 'credits', 'balance', 'remaining_credits', 'credit'])
    record.monthlyBudgetUsd = numberField(subscription.doc, ['monthly_budget', 'monthly_limit', 'budget'])
  } else if (subscription.status) {
    record.error = `subscription ${subscription.status}`
  }

  if (record.creditUsd === null) {
    const usage = await request(`/v1/billing/usage?start_date=${monthStart}&end_date=${today}`)
    const cost = usage.doc ? sumUsageCost(usage.doc) : null
    if (cost !== null) {
      record.monthToDateUsd = cost
      record.source = record.source === 'subscription' ? 'subscription+usage' : 'usage'
      record.currency = stringField(usage.doc, ['currency']) || record.currency
    } else if (usage.status) {
      record.error = [record.error, `usage ${usage.status}`].filter(Boolean).join('; ')
    }
  }

  if (record.source === '') return null
  return record
}

/**
 * Official remaining balance for a key, or null when there is none to trust.
 *
 * A figure older than {@link BILLING_TRUST_MS} is ignored: a stale zero would
 * park a topped-up key forever, and a stale positive would keep routing to a
 * key that is already dry.
 */
export function billingBalance(keyRecord, nowMs = Date.now()) {
  const official = keyRecord?.official
  if (!official || official.creditUsd === null || official.creditUsd === undefined) return null
  if (nowMs - (Number(official.at) || 0) > BILLING_TRUST_MS) return null
  const credit = Number(official.creditUsd)
  return Number.isFinite(credit) ? Math.max(0, credit) : null
}

/**
 * Probe every key in the pool.
 *
 * Sequential on purpose: a billing endpoint is not a bulk API, and a burst of
 * twelve parallel calls is the fastest way to get throttled. Failures are
 * per-key and silent — probing must never change a key's status.
 *
 * @returns {Promise<{probed:number,credits:number,plans:string[]}>}
 */
export async function probeAllBilling(store, options = {}) {
  const keys = Array.isArray(store?.keys) ? store.keys : []
  const plans = new Set()
  let credits = 0
  for (const record of keys) {
    if (options.signal?.aborted) break
    const probed = await probeBilling(record, options)
    if (!probed) continue
    record.official = probed
    if (probed.plan) plans.add(probed.plan)
    if (probed.creditUsd !== null) credits += 1
  }
  store.billing = { at: Date.now(), probed: keys.length, credits, plans: [...plans] }
  return { probed: keys.length, credits, plans: [...plans] }
}

/**
 * Probe billing for a specific subset of keys (e.g. one face-value group)
 * with bounded concurrency and update `store.billing` across all keys.
 */
export async function probeKeysBilling(store, targetKeys, options = {}) {
  const list = Array.isArray(targetKeys) ? targetKeys : []
  const probeOpts = { ...options, timeoutMs: options.timeoutMs ?? 4_000 }
  const concurrency = Math.min(3, Math.max(1, list.length))
  let cursor = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < list.length && !options.signal?.aborted) {
      const record = list[cursor++]
      if (!record) continue
      const probed = await probeBilling(record, probeOpts)
      if (probed) record.official = probed
    }
  })
  await Promise.all(workers)

  const allKeys = Array.isArray(store?.keys) ? store.keys : []
  const plans = new Set()
  let credits = 0
  for (const k of allKeys) {
    if (k?.official?.plan) plans.add(k.official.plan)
    if (billingBalance(k) !== null) credits += 1
  }
  store.billing = { at: Date.now(), probed: list.length, credits, plans: [...plans] }
  return { probed: list.length, credits, plans: [...plans] }
}

/**
 * When the next automatic probe is due.
 *
 * Fast cadence while official figures are actually coming back, slow one while
 * the deployment is blind — a failing-or-empty endpoint costs twelve requests
 * per attempt, and nothing about it improves on a half-hour clock.
 *
 * @returns {number} epoch ms; 0 means "never probed, due now".
 */
export function billingDueAt(store) {
  const billing = store?.billing
  if (!billing) return 0
  const found = Number(billing.credits) > 0
  return (Number(billing.at) || 0) + (found ? BILLING_REFRESH_MS : BILLING_BLIND_MS)
}

/**
 * Re-price every key from its recorded tokens under the current basis.
 *
 * Used once by {@link migratePricing} to undo the CNY-as-USD era, and available
 * on demand when the tariff changes. Keys with per-model buckets re-price per
 * model; older records only carry a token total, so they are re-priced with the
 * pool-wide blend — the best attribution their data allows.
 *
 * @returns {number} the rebased total, in USD.
 */
export function rebase(store) {
  const rates = store?.rates ?? {}
  let total = 0
  for (const key of store?.keys ?? []) {
    let usd = 0
    let priced = false
    const buckets = key.models && typeof key.models === 'object' ? Object.entries(key.models) : []
    if (buckets.length > 0) {
      for (const [model, bucket] of buckets) {
        const price = priceFor(store.pricing, model) ?? modelPrice(rates, model) ?? blendedPrice(rates.usdPerToken)
        if (!price) continue
        const cost = computeCost({ input: bucket.input, output: bucket.output, cached: bucket.cached }, price)
        if (!cost.priced) continue
        usd += cost.usd
        priced = true
        bucket.usd = Number(cost.usd.toFixed(8))
      }
    } else {
      const price = blendedPrice(rates.usdPerToken)
      if (price) {
        const cost = computeCost(key.tokens ?? {}, price)
        if (cost.priced) {
          usd = cost.usd
          priced = true
        }
      }
    }
    if (!priced) continue
    key.usedUsd = Number(usd.toFixed(8))
    key.unpriced = false
    total += key.usedUsd
  }
  store.pricingVersion = PRICING_VERSION
  return total
}

/**
 * One-shot migration off the CNY-as-USD basis. Only runs when a rate is
 * actually available, so a missing ledger degrades to "keep the old numbers"
 * instead of zeroing every balance.
 *
 * @returns {boolean} whether the store was rewritten.
 */
export function migratePricing(store) {
  const version = Number(store?.pricingVersion ?? 1) || 1
  if (version >= PRICING_VERSION) return false
  if (!(Number(store?.rates?.usdPerToken ?? 0) > 0)) return false
  if (!Array.isArray(store.keys) || store.keys.length === 0) {
    store.pricingVersion = PRICING_VERSION
    return true
  }
  rebase(store)
  return true
}

/** Build a per-million price entry from a blended rate, for computeCost. */
export function blendedPrice(rate) {
  if (!rate || !(rate > 0)) return null
  const perMillion = rate * 1_000_000
  return { in: perMillion, out: perMillion, cached: perMillion * CACHED_DISCOUNT }
}

/**
 * Load the pool store, creating an empty one on first run.
 *
 * A truncated or hand-edited file must not brick the proxy: the unreadable copy
 * is kept beside the store as `<name>.corrupt` and the pool restarts empty.
 * @param dshHome - DSH home directory holding the store file.
 * @returns the loaded store.
 */
export async function loadStore(dshHome) {
  const file = join(dshHome, STORE_FILE)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const fresh = emptyStore()
    await saveStore(dshHome, fresh)
    return fresh
  }
  try {
    const parsed = JSON.parse(raw)
    return {
      ...emptyStore(),
      ...parsed,
      mode: parsed.mode === 'direct' ? 'direct' : 'acp',
      directKeyScope: parsed.directKeyScope === 'studio' || parsed.directKeyScope === 'all' ? parsed.directKeyScope : 'auto',
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
    }
  } catch {
    // Keep the bytes for inspection, then start from a clean store so the
    // proxy still binds instead of failing every request on a parse error.
    await copyFile(file, `${file}.corrupt`).catch(() => {})
    const fresh = emptyStore()
    await saveStore(dshHome, fresh)
    return fresh
  }
}

/** Monotonic counter giving every save its own temporary file name. */
let saveSeq = 0
/** Tail of the write queue; every save waits for the one before it. */
let saveQueue = Promise.resolve()

/**
 * Persist the pool store atomically with owner-only permissions.
 *
 * The JSON snapshot is taken synchronously, so later mutations of `store` never
 * leak into this write, and saves are serialized through {@link saveQueue} with
 * a unique temporary name. Overlapping writers therefore cannot rename each
 * other's file away or land a stale snapshot on top of a newer one.
 * @param dshHome - DSH home directory holding the store file.
 * @param store - the state to snapshot now.
 * @returns resolves once this snapshot is on disk.
 */
export async function saveStore(dshHome, store) {
  const snapshot = `${JSON.stringify(store, null, 2)}\n`
  const run = saveQueue.catch(() => {}).then(async () => {
    const file = join(dshHome, STORE_FILE)
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${++saveSeq}.tmp`
    await writeFile(tmp, snapshot, 'utf8')
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  })
  saveQueue = run
  return run
}

/** Public view of the pool: masked keys, derived balances, no secrets. */
export function publicState(store, acpStatus = null, extra = {}) {
  const mode = store.mode === 'direct' ? 'direct' : 'acp'
  const directKeyScope = store.directKeyScope ?? 'auto'
  const currentId = store.currentId
  const sessions = affinityLoad(store.affinity)
  const rates = store.rates ?? {}
  const models = {}
  for (const [model, rate] of Object.entries(rates.models ?? {})) {
    models[model] = Number((Number(rate.usdPerToken) || 0) * 1_000_000)
  }
  return {
    providerId: extra.providerId || DEFAULT_PROVIDER,
    displayName: extra.displayName || DEFAULT_DISPLAY_NAME,
    models: effectiveModels(store),
    modelsCustomized: Array.isArray(store.models),
    mode,
    directKeyScope,
    acp: acpStatus,
    port: store.port,
    upstream: store.upstream,
    currentId,
    pricing: store.pricing ?? {},
    pricingVersion: Number(store.pricingVersion ?? 0) || 0,
    // Everything below is USD. `perMillionUsd` is the pool-wide effective rate;
    // `models` is the per-model effective rate the ledger priced that model at.
    blendedUsdPerToken: Number(rates.usdPerToken ?? store.blended?.usdPerToken ?? 0) || 0,
    blendedSamples: Number(rates.samples ?? store.blended?.samples ?? 0) || 0,
    billing: store.billing ? { ...store.billing } : null,
    rates: {
      perMillionUsd: (Number(rates.usdPerToken ?? 0) || 0) * 1_000_000,
      cnyPerUsd: Number(rates.cnyPerUsd ?? store.cnyPerUsd ?? DEFAULT_CNY_PER_USD),
      site: rates.site ?? '',
      samples: Number(rates.samples ?? 0) || 0,
      updatedAt: Number(rates.updatedAt ?? 0) || 0,
      models,
    },
    keys: (store.keys ?? []).map((key) => {
      const face = Number(key.faceUsd ?? 0) || 0
      const officialUsd = billingBalance(key)
      return {
        id: key.id,
        kind: keyKindOf(key),
        account: key.account ?? '',
        memo: key.memo ?? '',
        masked: maskKey(key.key),
        faceUsd: face,
        priority: keyPriorityOf(key),
        weight: keyWeightOf(key),
        // An official wallet figure re-anchors both numbers: the estimate is a
        // model, the credit balance is what the account actually spends.
        usedUsd:
          officialUsd !== null && face > 0 ? Math.max(0, face - officialUsd) : Number(key.usedUsd ?? 0) || 0,
        remainingUsd: officialUsd !== null ? officialUsd : key.unpriced ? null : remainingUsd(key),
        balanceSource: officialUsd !== null ? 'official' : 'estimate',
        tokens: key.tokens ?? { input: 0, output: 0, cached: 0 },
        models: key.models ?? {},
        requests: key.requests ?? 0,
        status: key.status ?? 'active',
        lastError: key.lastError ?? '',
        lastUsedAt: key.lastUsedAt ?? 0,
        exhaustedAt: key.exhaustedAt ?? 0,
        current: key.id === currentId,
        unpriced: Boolean(key.unpriced),
        sessions: sessions[key.id] ?? 0,
        official: key.official ?? null,
      }
    }),
  }
}

/** Mark one key unusable and move the cursor to the next usable one. */
export function exhaust(store, keyRecord, reason) {
  if (!keyRecord) return null
  keyRecord.status = 'exhausted'
  keyRecord.exhaustedAt = Date.now()
  keyRecord.lastError = String(reason ?? '').slice(0, 400)
  // Only the conversations pinned to this key move on; everyone else keeps
  // their key and their prompt cache.
  if (store.affinity) {
    for (const [affinity, id] of Object.entries(store.affinity)) {
      if (id === keyRecord.id) delete store.affinity[affinity]
    }
  }
  const next = pickNext(store.keys, keyRecord.id)
  store.currentId = next?.id ?? null
  return next
}

/**
 * Choose the key to serve a request.
 *
 * A conversation keeps the key it was pinned to, so its prompt cache survives
 * across turns. A conversation seen for the first time lands on the least
 * loaded usable key, which spreads parallel chats over the pool instead of
 * stacking them on one key.
 *
 * When `options.mode` is provided, candidates are scoped to that mode's key
 * pool (`$300` Vibe keys in `'acp'` mode; Studio keys on/after Dec 1 in
 * `'direct'` mode) and affinity pins are namespaced by mode so toggling modes
 * never pins a chat onto the wrong pool tier.
 */
export function selectKey(store, affinity, options) {
  const keys = store.keys ?? []
  const map = store.affinity ?? {}
  const mode = options?.mode
  const candidates = mode ? eligibleKeysForMode(keys, options) : keys.filter(isUsable)
  const pinKey = affinity ? (mode ? `${mode}:${affinity}` : affinity) : ''
  if (pinKey) {
    const pinned = candidates.find((k) => k.id === map[pinKey])
    if (pinned) return pinned
  }
  const chosen = leastLoaded(candidates, map, store.currentId)
  if (!chosen) return null
  store.currentId = chosen.id
  if (pinKey) rememberAffinity(store, pinKey, chosen.id)
  return chosen
}

/** Filter request headers down to what may be forwarded upstream. */
export function forwardableHeaders(headers, apiKey) {
  const blocked = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-length',
    'accept-encoding',
  ])
  const out = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (blocked.has(name.toLowerCase())) continue
    if (name.toLowerCase() === 'authorization') continue
    if (value === undefined) continue
    out[name] = value
  }
  out.authorization = `Bearer ${apiKey}`
  out['accept-encoding'] = 'identity'
  return out
}

/** Whether an origin may talk to the loopback admin surface. */
export function isAllowedOrigin(origin) {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  } catch {
    return false
  }
}

const DASHBOARD = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Mistral Key 池</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--line:#e6e6ea;--ink:#1c1c1e;--dim:#6b6b70;--ok:#12855b;--warn:#b25a00;--bad:#c22}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--card:#1e1e21;--line:#2c2c30;--ink:#ececf1;--dim:#9a9aa2}}
body{margin:0;padding:28px;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
h1{font-size:18px;margin:0 0 4px}p.sub{margin:0 0 18px;color:var(--dim);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
th{font-weight:600;color:var(--dim);font-size:12px;background:color-mix(in srgb,var(--card) 92%,var(--ink))}
tr:last-child td{border-bottom:0}
td.num{text-align:right}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--dim)}
button{font:inherit;padding:3px 9px;border-radius:7px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button:hover{border-color:var(--dim)}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;min-width:90px}
.bar>i{display:block;height:100%;background:var(--ok)}
.add-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:none}
.add-card.open{display:block}
.add-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.add-row input,.add-row select{font:inherit;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit}
.add-err{color:var(--bad);font-size:12px;margin-top:6px;min-height:16px}
</style></head><body>
<h1>Mistral Key 池</h1>
<p class="sub">
  <span style="display:inline-flex;gap:4px;margin-right:6px;vertical-align:middle">
    <button id="mode-acp" data-act="set-mode" data-mode="acp">ACP (vibe-acp)</button>
    <button id="mode-direct" data-act="set-mode" data-mode="direct">直连 (HTTP API)</button>
  </span>
  <span id="acp-status" class="muted"></span>
  <button id="toggle-add">+ 新增 Key</button></p>
<form id="add-card" class="add-card">
  <div class="add-row">
    <input id="f-key" type="password" placeholder="粘贴 API Key (如 mstrl_...)" style="flex:2 1 220px" autocomplete="off">
    <input id="f-face" type="number" min="0" step="any" value="300" placeholder="面值 USD" style="width:92px">
    <select id="f-kind">
      <option value="vibe">Vibe (ACP)</option>
      <option value="studio">Studio (直连)</option>
    </select>
    <input id="f-account" type="text" placeholder="账号 (选填)" style="flex:1 1 140px">
    <input id="f-memo" type="text" placeholder="备注 (选填)" style="width:100px">
    <input id="f-priority" type="number" step="1" value="0" placeholder="优先级" title="优先级（越大越优先）" style="width:76px">
    <input id="f-weight" type="number" min="0.1" step="any" value="1" placeholder="权重" title="权重（同优先级分流比例）" style="width:72px">
    <button type="submit">提交</button>
    <button type="button" id="cancel-add">取消</button>
  </div>
  <div id="add-err" class="add-err"></div>
</form>
<form id="edit-card" class="add-card">
  <input id="e-id" type="hidden">
  <div class="add-row">
    <input id="e-account" type="text" placeholder="账号 (选填)" style="flex:1 1 140px">
    <input id="e-memo" type="text" placeholder="备注 (选填)" style="width:96px">
    <input id="e-face" type="number" min="0" step="any" placeholder="面值 USD" style="width:86px">
    <select id="e-kind">
      <option value="vibe">Vibe (ACP)</option>
      <option value="studio">Studio (直连)</option>
    </select>
    <input id="e-priority" type="number" step="1" placeholder="优先级" title="优先级（越大越优先）" style="width:74px">
    <input id="e-weight" type="number" min="0.1" step="any" placeholder="权重" title="权重（同优先级分流比例）" style="width:72px">
    <input id="e-key" type="password" placeholder="替换 API Key（留空不改）" style="flex:1 1 180px" autocomplete="off">
    <button type="submit">保存</button>
    <button type="button" id="cancel-edit">取消</button>
  </div>
  <div id="edit-err" class="add-err"></div>
</form>
<div id="app">加载中…</div>
<script>
const esc=(s)=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
const fmt=(n)=>n==null?'—':'$'+Number(n).toFixed(2)
const pct=(k)=>k.faceUsd>0?Math.max(0,Math.min(1,(k.remainingUsd??0)/k.faceUsd)):0
const label=(k)=>k.status==='active'?'已启用':k.status==='disabled'?'已停用':'额度耗尽'
const tone=(k)=>k.status==='active'?'ok':k.status==='disabled'?'muted':'bad'
let lastState=null
async function call(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'x-dsh-pool':'1','content-type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
async function render(){
  const s=await call('/__pool/state')
  lastState=s
  const mode=s.mode==='direct'?'direct':'acp'
  const bAcp=document.getElementById('mode-acp');const bDir=document.getElementById('mode-direct')
  if(bAcp&&bDir){bAcp.style.borderColor=mode==='acp'?'var(--ok)':'';bAcp.style.color=mode==='acp'?'var(--ok)':'';bDir.style.borderColor=mode==='direct'?'var(--ok)':'';bDir.style.color=mode==='direct'?'var(--ok)':''}
  const acpEl=document.getElementById('acp-status')
  if(acpEl){acpEl.textContent=mode==='acp'?(s.acp?.available?'vibe-acp 就绪 · '+(s.acp.liveSessions||0)+' 会话':'未检测到 vibe-acp'):'HTTP 代理直连'}
  const rows=s.keys.map(k=>\`<tr>
    <td>\${esc(k.account||'—')} <span class="tag muted">\${k.kind==='vibe'?'Vibe':'Studio'}</span> <span class="tag muted">P\${k.priority??0} · W\${k.weight??1}</span>\${k.balanceSource==='official'?' <span class="tag ok" title="余额来自官方 billing 接口">官方</span>':''}<div class="muted" style="font-size:11px">\${esc(k.masked)}\${k.memo?' · '+esc(k.memo):''}</div></td>
    <td class="num">\${fmt(k.faceUsd)}</td>
    <td class="num">\${fmt(k.usedUsd)}</td>
    <td class="num">\${k.unpriced&&k.usedUsd===0?'<span class="muted">未定价</span>':fmt(k.remainingUsd)}</td>
    <td style="width:120px"><div class="bar"><i style="width:\${(pct(k)*100).toFixed(0)}%"></i></div></td>
    <td><span class="tag \${tone(k)}">\${label(k)}</span></td>
    <td class="num muted">\${k.requests} 次</td>
    <td><button data-id="\${esc(k.id)}" data-act="edit-key">编辑</button>
        \${k.status==='active'?\`<button data-id="\${esc(k.id)}" data-act="disable">停用</button>\`:\`<button data-id="\${esc(k.id)}" data-act="enable">启用</button>\`}
        <button data-id="\${esc(k.id)}" data-act="delete-key" class="bad">删除</button></td>
  </tr>\`).join('')
  document.getElementById('app').innerHTML='<table><thead><tr><th>账号</th><th class="num">面值</th><th class="num">已用(估)</th><th class="num">剩余(估)</th><th>进度</th><th>状态</th><th class="num">请求</th><th>操作</th></tr></thead><tbody>'+rows+'</tbody></table>'
}
const addCard=document.getElementById('add-card')
const addErr=document.getElementById('add-err')
const editCard=document.getElementById('edit-card')
const editErr=document.getElementById('edit-err')
document.getElementById('toggle-add').onclick=()=>{addCard.classList.toggle('open');editCard.classList.remove('open');addErr.textContent=''}
document.getElementById('cancel-add').onclick=()=>{addCard.classList.remove('open');addErr.textContent=''}
document.getElementById('cancel-edit').onclick=()=>{editCard.classList.remove('open');editErr.textContent=''}
document.getElementById('f-face').oninput=(e)=>{const v=Number(e.target.value);if(Number.isFinite(v))document.getElementById('f-kind').value=v>=100?'vibe':'studio'}
addCard.onsubmit=async(e)=>{
  e.preventDefault();addErr.textContent=''
  try{
    await call('/__pool/action',{
      action:'add-key',
      key:document.getElementById('f-key').value,
      faceUsd:document.getElementById('f-face').value,
      kind:document.getElementById('f-kind').value,
      account:document.getElementById('f-account').value,
      memo:document.getElementById('f-memo').value,
      priority:document.getElementById('f-priority').value,
      weight:document.getElementById('f-weight').value,
    })
    document.getElementById('f-key').value=''
    document.getElementById('f-account').value=''
    document.getElementById('f-memo').value=''
    document.getElementById('f-priority').value='0'
    document.getElementById('f-weight').value='1'
    addCard.classList.remove('open')
    await render()
  }catch(err){addErr.textContent=err.message||String(err)}
}
editCard.onsubmit=async(e)=>{
  e.preventDefault();editErr.textContent=''
  try{
    await call('/__pool/action',{
      action:'update-key',
      id:document.getElementById('e-id').value,
      account:document.getElementById('e-account').value,
      memo:document.getElementById('e-memo').value,
      faceUsd:document.getElementById('e-face').value,
      kind:document.getElementById('e-kind').value,
      priority:document.getElementById('e-priority').value,
      weight:document.getElementById('e-weight').value,
      key:document.getElementById('e-key').value,
    })
    document.getElementById('e-key').value=''
    editCard.classList.remove('open')
    await render()
  }catch(err){editErr.textContent=err.message||String(err)}
}
document.addEventListener('click',async(e)=>{const b=e.target.closest('button[data-act]');if(!b)return;
  if(b.dataset.act==='edit-key'){
    const item=(lastState?.keys||[]).find(x=>x.id===b.dataset.id);if(!item)return;
    document.getElementById('e-id').value=item.id
    document.getElementById('e-account').value=item.account||''
    document.getElementById('e-memo').value=item.memo||''
    document.getElementById('e-face').value=String(item.faceUsd??0)
    document.getElementById('e-kind').value=item.kind==='studio'?'studio':'vibe'
    document.getElementById('e-priority').value=String(item.priority??0)
    document.getElementById('e-weight').value=String(item.weight??1)
    document.getElementById('e-key').value=''
    editErr.textContent=''
    addCard.classList.remove('open')
    editCard.classList.add('open')
    return;
  }
  if(b.dataset.act==='delete-key'&&b.dataset.confirm!=='1'){
    b.dataset.confirm='1';b.textContent='确认删除';
    setTimeout(()=>{if(b.isConnected&&b.dataset.confirm==='1'){delete b.dataset.confirm;b.textContent='删除'}},3000);
    return;
  }
  await call('/__pool/action',{action:b.dataset.act,id:b.dataset.id,mode:b.dataset.mode});render()})
render();setInterval(render,15000)
</script></body></html>`

/** Send a JSON response. */
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

/** Read a request body with a hard cap. */
async function readBody(req, maxBytes = 32 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('payload too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Pick the price entry for a model id, tolerating provider prefixes. The
 * store's own table wins; published Mistral tariffs cover the rest by family
 * prefix, so a fresh install still estimates real prices instead of a blended
 * average that one model can skew.
 */
export function priceFor(pricing, model) {
  if (!model) return null
  const raw = String(model)
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  const table = pricing ?? {}
  if (table[raw]) return table[raw]
  if (table[tail]) return table[tail]
  const name = tail.toLowerCase()
  for (const [prefix, price] of Object.entries(DEFAULT_PRICING)) {
    if (name.startsWith(prefix)) return price
  }
  return null
}

/** Cordis plugin entry point. */
export function apply(ctx, config = {}) {
  const dshHome = resolveDshHome(config.home ?? process.env.DSH_HOME)
  const logger = typeof ctx.logger?.info === 'function' ? ctx.logger : null
  const providerId = (typeof config.provider === 'string' && config.provider.trim()) || DEFAULT_PROVIDER
  const getDisplayName = () => {
    const raw = typeof config.displayName?.get === 'function' ? config.displayName.get() : config.displayName
    return (typeof raw === 'string' && raw.trim()) || DEFAULT_DISPLAY_NAME
  }
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name
  let notifyModelsUpdated = () => {}
  const stateExtra = () => ({ providerId, displayName: getDisplayName() })

  let store = emptyStore()
  let ready = null
  let storeLoaded = false
  let saveTimer = null
  let startupTimer = null
  let disposed = false
  const lifecycleAbort = new AbortController()

  /** Keep `store.currentId` aligned with the active mode's highest-priority eligible key pool when possible. */
  const alignCurrentCursor = () => {
    const eligible = eligibleKeysForMode(store.keys, {
      mode: store.mode,
      directKeyScope: store.directKeyScope,
    })
    if (eligible.length === 0) return
    const maxPriority = Math.max(...eligible.map(keyPriorityOf))
    const topTier = eligible.filter((k) => keyPriorityOf(k) === maxPriority)
    if (!topTier.some((k) => k.id === store.currentId)) {
      const next = leastLoaded(topTier, store.affinity, store.currentId)
      if (next) store.currentId = next.id
    }
  }

  /**
   * Read the official balance for every key and persist it.
   *
   * Runs after startup and on a timer; the admin action triggers the same path.
   * A probe never marks a key and never throws into the request path.
   */
  let billingInFlight = null
  const probeBillingNow = (reason) => {
    if (disposed || store.billingProbe === false) return Promise.resolve(null)
    if (billingInFlight) return billingInFlight
    billingInFlight = (async () => {
      try {
        const result = await probeAllBilling(store, { upstream: store.upstream, signal: lifecycleAbort.signal })
        if (disposed) return null
        logger?.info?.(
          `mistral-pool: billing probe (${reason}) ${result.credits}/${result.probed} keys exposed a balance` +
            (result.plans.length > 0 ? `, plans: ${result.plans.join(', ')}` : ''),
        )
        await saveStore(dshHome, store).catch(() => {})
        return result
      } catch (error) {
        if (!disposed) logger?.warn?.(`mistral-pool: billing probe failed: ${error?.message ?? error}`)
        return null
      } finally {
        billingInFlight = null
      }
    })()
    return billingInFlight
  }

  const dirty = () => {
    if (disposed || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (disposed) return
      saveStore(dshHome, store).catch((error) => logger?.warn?.(`mistral-pool: save failed: ${error.message}`))
    }, 800)
    saveTimer.unref?.()
  }
  const ensure = () => {
    ready ??= loadStore(dshHome).then(async (loaded) => {
      store = loaded
      storeLoaded = true
      alignCurrentCursor()
      await refreshRate()
      // Re-price once off the old CNY-as-USD basis, then write through so the
      // corrected balances survive a crash instead of living only in memory.
      if (!disposed && migratePricing(store)) await saveStore(dshHome, store).catch(() => {})
      // The official balance is a nice-to-have: fetch it after the proxy is up
      // so a slow billing endpoint never delays the first request.
      if (!disposed && Date.now() >= billingDueAt(store)) {
        startupTimer = setTimeout(() => {
          startupTimer = null
          if (!disposed) void probeBillingNow('startup')
        }, 1_500)
        startupTimer.unref?.()
      }
      return loaded
    })
    return ready
  }

  const attachments = () => ctx.get?.('attachments')
  const subprocess = () => ctx.get?.('subprocess')
  const sessions = () => ctx.get?.('sessions')
  const fsService = () => ctx.get?.('fs')
  const resolveImagePath = (ref) => {
    const att = attachments()
    const fs = fsService()
    if (!att || typeof att.imageHostPath !== 'function') return undefined
    let hostPath
    try {
      hostPath = att.imageHostPath(ref)
    } catch {
      return undefined
    }
    if (!hostPath) return undefined
    return typeof fs?.processPathFromHostPath === 'function'
      ? fs.processPathFromHostPath(hostPath)
      : hostPath
  }

  const acpRuntime = new VibeAcpRuntime({
    dshHome,
    cacheDir: config.cacheDir,
    getUpstream: () => store.upstream ?? DEFAULT_UPSTREAM,
    getVibeCommand: () => config.vibeCommand ?? store.vibeCommand ?? '',
    getModelEntry: (modelId) => effectiveModels(store).find((m) => m.id === modelId),
    selectVibeKey: async (affinity) => {
      await ensure()
      const chosen = selectKey(store, affinity, { mode: 'acp' })
      if (chosen) dirty()
      return chosen
    },
    exhaustKey: async (keyRecord, reason) => {
      const target = store.keys.find((k) => k.id === keyRecord?.id) ?? keyRecord
      exhaust(store, target, reason)
      alignCurrentCursor()
      await saveStore(dshHome, store).catch(() => {})
    },
    recordUsage: (keyRecord, model, usage) => {
      const target = store.keys.find((k) => k.id === keyRecord?.id) ?? keyRecord
      if (!target) return
      applyUsage(target, usage, resolvePrice(store, model), model)
      dirty()
    },
    getSubprocess: () => subprocess(),
    resolveImage: async (block) => {
      const att = attachments()
      if (!att || typeof att.readImageRequest !== 'function') return undefined
      const ref = block.attachment
      const image = await att.readImageRequest(ref, {
        width: ref.width,
        height: ref.height,
        maxBytes: REQUEST_IMAGE_MAX_BYTES,
      })
      return { data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType }
    },
    resolveFilePath: (ref) => {
      const att = attachments()
      const fs = fsService()
      if (!att || typeof att.fileHostPath !== 'function') return undefined
      const hostPath = att.fileHostPath(ref)
      if (!hostPath) return undefined
      return typeof fs?.processPathFromHostPath === 'function'
        ? fs.processPathFromHostPath(hostPath)
        : hostPath
    },
    resolveImagePath,
    isSubagentSession: (sessionId) => {
      const header = sessions()?.get?.(sessionId)?.header
      return header?.origin === 'subagent' || header?.parentSession !== undefined
    },
    log: logger ?? undefined,
    sourceVibeHome: config.sourceVibeHome,
    maxLiveSessions: config.maxLiveSessions,
    maxConcurrentRequests: config.maxConcurrentRequests,
    idleSessionTtlMs: config.idleSessionTtlMs,
    subagentSessionTtlMs: config.subagentSessionTtlMs,
    maxIdleMs: config.maxIdleMs,
    parkSettleMs: config.parkSettleMs,
    relayAfterMs: config.relayAfterMs,
    mcpWarmupWaitMs: config.mcpWarmupWaitMs,
    admissionTimeoutMs: config.admissionTimeoutMs,
    cancelSettleMs: config.cancelSettleMs,
    retireGraceMs: config.retireGraceMs,
    retireFinalWaitMs: config.retireFinalWaitMs,
    globalSoftLimit: config.globalSoftLimit,
  })

  /** Re-derive the tariff from the DSH ledger; cheap and self-healing. */
  const refreshRate = async () => {
    const rate = await deriveBlendedRate(dshHome, {
      port: store.port,
      upstream: store.upstream,
      cnyPerUsd: store.cnyPerUsd,
    }).catch(() => null)
    if (!rate) return
    store.rates = { ...rate, updatedAt: Date.now() }
    // Kept for readers of the old field; both are USD per token.
    store.blended = { usdPerToken: rate.usdPerToken, samples: rate.samples, updatedAt: Date.now() }
    for (const key of store.keys ?? []) {
      if (key.unpriced && (key.tokens?.input ?? 0) + (key.tokens?.output ?? 0) === 0) key.unpriced = false
    }
    dirty()
  }

  /**
   * Replay one request against the pool until some key answers, or until the
   * pool is out of candidates. Replays are safe because nothing has been
   * written to the client yet: a failed attempt is fully buffered here.
   */
  const serve = async (req, res, body) => {
    await ensure()
    // One conversation keeps one key so its prompt cache keeps hitting.
    const affinity = affinityOf(req.headers, body)
    const maxAttempts = Math.max(1, Math.min(store.keys.length || 1, 8))
    let attempts = 0
    let lastStatus = 502
    let lastBody = ''
    while (attempts < maxAttempts) {
      attempts += 1
      const key = selectKey(store, affinity, {
        mode: 'direct',
        directKeyScope: store.directKeyScope ?? 'auto',
      })
      if (!key) {
        sendJson(res, 402, {
          error: {
            message: 'dsh-mistral-pool: no usable key left in the pool',
            type: 'insufficient_quota',
            code: 'pool_exhausted',
          },
        })
        return
      }
      const url = `${store.upstream ?? DEFAULT_UPSTREAM}${req.url}`
      const headers = forwardableHeaders(req.headers, key.key)
      let upstream
      try {
        upstream = await fetch(url, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          signal: AbortSignal.timeout(600_000),
        })
      } catch (error) {
        key.lastError = `network: ${error?.message ?? error}`.slice(0, 400)
        dirty()
        lastStatus = 502
        lastBody = key.lastError
        continue
      }

      if (upstream.status >= 200 && upstream.status < 300) {
        const contentType = upstream.headers.get('content-type') ?? ''
        const tap = createUsageTap(({ usage, model }) => {
          // Price by the model that actually answered: a pool-wide blend turns a
          // cheap cache-heavy model into an expensive one's bill.
          applyUsage(key, usage, resolvePrice(store, model), model)
          dirty()
        })
        if (contentType.includes('application/json')) tap.expectJson()
        const outHeaders = {}
        upstream.headers.forEach((value, name) => {
          if (name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding') return
          outHeaders[name] = value
        })
        res.writeHead(upstream.status, outHeaders)
        const node = Readable.fromWeb(upstream.body)
        node.on('data', (chunk) => {
          tap.push(chunk)
          res.write(chunk)
        })
        node.on('end', () => {
          tap.end()
          res.end()
          dirty()
        })
        node.on('error', (error) => {
          // The usage already seen is still real spend, so settle the tap
          // before dropping the client socket.
          tap.end()
          dirty()
          logger?.warn?.(`mistral-pool: stream error: ${error?.message ?? error}`)
          res.destroy()
        })
        return
      }

      const text = await upstream.text().catch(() => '')
      lastStatus = upstream.status
      lastBody = text
      if (isKeyExhausted(upstream.status, text)) {
        const next = exhaust(store, key, `${upstream.status}: ${text.slice(0, 200)}`)
        alignCurrentCursor()
        logger?.warn?.(`mistral-pool: key ${key.id} (${key.account}) unusable (${upstream.status}); next=${next?.id ?? 'none'}`)
        // Rotation must survive a crash, so this one writes through instead of
        // waiting for the debounce that ordinary usage updates rely on.
        await saveStore(dshHome, store).catch(() => {})
        continue
      }
      // Not a key problem: hand the upstream error back untouched.
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      })
      res.end(text)
      return
    }
    sendJson(res, lastStatus, {
      error: {
        message: `dsh-mistral-pool: every candidate key failed; last upstream said: ${lastBody.slice(0, 300)}`,
        type: 'pool_exhausted',
        code: 'pool_exhausted',
      },
    })
  }

  const handleAdmin = async (req, res, url) => {
    const origin = req.headers.origin
    const cors = {
      'access-control-allow-origin': isAllowedOrigin(origin) && origin ? origin : 'null',
      'access-control-allow-headers': 'x-dsh-pool, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      vary: 'origin',
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    if (req.headers['x-dsh-pool'] !== '1') {
      sendJson(res, 403, { error: 'missing x-dsh-pool header' }, cors)
      return
    }
    await ensure()
    if (url.pathname === '/__pool/state') {
      sendJson(res, 200, publicState(store, acpRuntime.status(), stateExtra()), cors)
      return
    }
    if (url.pathname === '/__pool/action' && req.method === 'POST') {
      let payload = {}
      try {
        payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}')
      } catch {
        sendJson(res, 400, { error: 'invalid json' }, cors)
        return
      }
      const keyRecord = store.keys.find((k) => k.id === payload.id)
      let discovered = null
      switch (payload.action) {
        case 'set-mode': {
          if (payload.mode !== 'acp' && payload.mode !== 'direct') {
            sendJson(res, 400, { error: 'mode must be acp or direct' }, cors)
            return
          }
          const prevMode = store.mode
          store.mode = payload.mode
          if (prevMode === 'acp' && store.mode === 'direct') {
            acpRuntime.evictIdleSessions()
          }
          alignCurrentCursor()
          break
        }
        case 'set-direct-scope': {
          if (payload.scope !== 'auto' && payload.scope !== 'studio' && payload.scope !== 'all') {
            sendJson(res, 400, { error: 'scope must be auto, studio, or all' }, cors)
            return
          }
          store.directKeyScope = payload.scope
          alignCurrentCursor()
          break
        }
        case 'set-current':
          if (!keyRecord) { sendJson(res, 404, { error: 'unknown key' }, cors); return }
          keyRecord.status = 'active'
          store.currentId = keyRecord.id
          break
        case 'mark-exhausted':
          if (!keyRecord) { sendJson(res, 404, { error: 'unknown key' }, cors); return }
          exhaust(store, keyRecord, 'manual')
          break
        case 'reactivate':
          if (!keyRecord) { sendJson(res, 404, { error: 'unknown key' }, cors); return }
          keyRecord.status = 'active'
          keyRecord.exhaustedAt = 0
          keyRecord.lastError = ''
          if (!store.currentId) store.currentId = keyRecord.id
          break
        case 'reset-stats':
          if (!keyRecord) { sendJson(res, 404, { error: 'unknown key' }, cors); return }
          keyRecord.usedUsd = 0
          keyRecord.tokens = { input: 0, output: 0, cached: 0 }
          keyRecord.models = {}
          keyRecord.requests = 0
          keyRecord.unpriced = false
          break
        case 'rebase': {
          // Re-price the whole pool from its recorded tokens under the current
          // basis; the escape hatch when the tariff or the exchange rate moves.
          await refreshRate()
          const total = rebase(store)
          logger?.info?.(`mistral-pool: rebased ${store.keys?.length ?? 0} keys to $${total.toFixed(2)}`)
          break
        }
        case 'probe-billing':
          // Best effort: keys whose upstream answers get a figure, the rest keep
          // the estimate. Nothing here may mark a key unusable.
          await probeBillingNow('manual')
          break
        case 'sync-quota': {
          await refreshRate()
          rebase(store)
          const hasFace = payload.faceUsd !== undefined && payload.faceUsd !== null && String(payload.faceUsd).trim() !== ''
          const targetFace = hasFace ? Number(payload.faceUsd) : null
          const targetKeys = hasFace && Number.isFinite(targetFace)
            ? (store.keys ?? []).filter((k) => (Number(k?.faceUsd) || 0) === targetFace)
            : (store.keys ?? [])
          if (store.billingProbe !== false && targetKeys.length > 0) {
            await probeKeysBilling(store, targetKeys, { upstream: store.upstream, signal: lifecycleAbort.signal }).catch(() => null)
          }
          break
        }
        case 'set-used': {
          // Mistral exposes the real allowance to a browser session only, so a
          // figure read off console.mistral.ai is the one exact anchor this
          // estimate can be corrected against.
          if (!keyRecord) { sendJson(res, 404, { error: 'unknown key' }, cors); return }
          const value = Number(payload.value)
          if (!Number.isFinite(value) || value < 0) {
            sendJson(res, 400, { error: 'value must be a non-negative number' }, cors)
            return
          }
          keyRecord.usedUsd = Math.round(value * 1e8) / 1e8
          keyRecord.unpriced = false
          break
        }
        case 'add-key': {
          let added
          try {
            added = addKey(store, payload)
          } catch (error) {
            sendJson(res, error?.status ?? 400, { error: error?.message ?? String(error) }, cors)
            return
          }
          if (payload.setCurrent !== true) alignCurrentCursor()
          logger?.info?.(`mistral-pool: added key ${added.id} (${maskKey(added.key)}, $${added.faceUsd}, ${added.kind})`)
          break
        }
        case 'delete-key': {
          let removed
          try {
            removed = deleteKey(store, payload.id)
          } catch (error) {
            sendJson(res, error?.status ?? 404, { error: error?.message ?? String(error) }, cors)
            return
          }
          alignCurrentCursor()
          acpRuntime.evictIdleSessions()
          logger?.info?.(`mistral-pool: deleted key ${removed.id} (${maskKey(removed.key)})`)
          break
        }
        case 'enable': {
          let record
          try {
            record = enableKey(store, payload.id)
          } catch (error) {
            sendJson(res, error?.status ?? 404, { error: error?.message ?? String(error) }, cors)
            return
          }
          alignCurrentCursor()
          logger?.info?.(`mistral-pool: enabled key ${record.id} (${maskKey(record.key)})`)
          break
        }
        case 'disable': {
          let record
          try {
            record = disableKey(store, payload.id)
          } catch (error) {
            sendJson(res, error?.status ?? 404, { error: error?.message ?? String(error) }, cors)
            return
          }
          alignCurrentCursor()
          acpRuntime.evictIdleSessions()
          logger?.info?.(`mistral-pool: disabled key ${record.id} (${maskKey(record.key)})`)
          break
        }
        case 'set-schedule': {
          let record
          try {
            record = updateKeySchedule(store, payload.id, payload)
          } catch (error) {
            sendJson(res, error?.status ?? 400, { error: error?.message ?? String(error) }, cors)
            return
          }
          alignCurrentCursor()
          logger?.info?.(`mistral-pool: updated schedule for ${record.id} (priority=${record.priority}, weight=${record.weight})`)
          break
        }
        case 'update-key': {
          const prevKey = keyRecord?.key
          const prevKind = keyRecord ? keyKindOf(keyRecord) : ''
          let record
          try {
            record = updateKey(store, payload.id, payload)
          } catch (error) {
            sendJson(res, error?.status ?? 400, { error: error?.message ?? String(error) }, cors)
            return
          }
          alignCurrentCursor()
          if (record.key !== prevKey || keyKindOf(record) !== prevKind) {
            acpRuntime.evictIdleSessions()
          }
          logger?.info?.(
            `mistral-pool: updated key ${record.id} (${maskKey(record.key)}, $${record.faceUsd}, ${keyKindOf(record)}, P${keyPriorityOf(record)}, W${keyWeightOf(record)})`,
          )
          break
        }
        case 'reload': {
          ready = null
          storeLoaded = false
          await ensure()
          break
        }
        case 'add-model': {
          try {
            addModel(store, payload)
          } catch (error) {
            sendJson(res, error?.status ?? 400, { error: error?.message ?? String(error) }, cors)
            return
          }
          notifyModelsUpdated()
          break
        }
        case 'remove-model': {
          try {
            removeModel(store, payload.modelId ?? payload.id)
          } catch (error) {
            sendJson(res, error?.status ?? 404, { error: error?.message ?? String(error) }, cors)
            return
          }
          notifyModelsUpdated()
          break
        }
        case 'update-model': {
          try {
            updateModel(store, payload.modelId ?? payload.id, payload)
          } catch (error) {
            sendJson(res, error?.status ?? 400, { error: error?.message ?? String(error) }, cors)
            return
          }
          notifyModelsUpdated()
          break
        }
        case 'reset-models': {
          resetModels(store)
          notifyModelsUpdated()
          break
        }
        case 'fetch-models': {
          try {
            discovered = await discoverUpstreamModels(store, {
              upstream: store.upstream,
              signal: lifecycleAbort.signal,
            })
          } catch (error) {
            sendJson(res, error?.status ?? 502, { error: error?.message ?? String(error) }, cors)
            return
          }
          sendJson(
            res,
            200,
            { ...publicState(store, acpRuntime.status(), stateExtra()), discovered },
            cors,
          )
          return
        }
        default:
          sendJson(res, 400, { error: `unknown action ${payload.action}` }, cors)
          return
      }
      await saveStore(dshHome, store)
      sendJson(res, 200, publicState(store, acpRuntime.status(), stateExtra()), cors)
      return
    }
    sendJson(res, 404, { error: 'not found' }, cors)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(DASHBOARD)
      return
    }
    if (url.pathname.startsWith('/__pool/')) {
      handleAdmin(req, res, url).catch((error) => {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      })
      return
    }
    if (url.pathname.startsWith('/v1')) {
      readBody(req)
        .then((body) => serve(req, res, body))
        .catch((error) => sendJson(res, 400, { error: String(error?.message ?? error) }))
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })

  const adapter = new MistralAdapter({
    getProviderId: () => providerId,
    getDisplayName,
    getModels: () => effectiveModels(store),
    getMode: () => (store.mode === 'direct' ? 'direct' : 'acp'),
    canReadImages: () => attachments() !== undefined,
    streamAcp: async function* (options) {
      await ensure()
      yield* acpRuntime.stream(options)
    },
    streamDirect: async function* (options) {
      await ensure()
      const port = Number(store.port ?? DEFAULT_PORT) || DEFAULT_PORT
      const att = attachments()
      const resolveImage = att && typeof att.readImageRequest === 'function'
        ? async (block) => {
            const ref = block.attachment
            const image = await att.readImageRequest(ref, {
              width: ref.width,
              height: ref.height,
              maxBytes: REQUEST_IMAGE_MAX_BYTES,
            })
            return { data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType }
          }
        : undefined
      const modelEntry = effectiveModels(store).find((m) => m.id === options?.model)
      yield* streamDirectResponses(options, {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        resolveImage,
        resolveImagePath,
        maxRequestImages: resolveMaxRequestImages(options?.model, modelEntry),
      })
    },
  })

  const wireLlm = (llmCtx) => {
    const llm = llmCtx?.llm ?? llmCtx?.get?.('llm')
    if (!llm) return
    notifyModelsUpdated = () => {
      llmCtx?.emit?.('llm/models-updated', providerId)
    }
    const registerAll = () => {
      const offConfigurable = typeof llm.registerConfigurableProviders === 'function'
        ? llm.registerConfigurableProviders([
            {
              provider: providerId,
              displayName: getDisplayName(),
              settingsNs,
              settingsPath: [],
              nativeAuth: { env: [], oauth: true },
            },
          ])
        : undefined
      const offAdapter = typeof llm.registerAdapter === 'function'
        ? llm.registerAdapter([providerId], adapter)
        : undefined
      return () => {
        if (typeof offAdapter === 'function') offAdapter()
        if (typeof offConfigurable === 'function') offConfigurable()
      }
    }
    if (typeof llmCtx.effect === 'function') {
      llmCtx.effect(registerAll, 'dsh-mistral-pool: register llm provider')
    } else {
      registerAll()
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], wireLlm)
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx.get?.('settings') ?? settingsCtx.settings
      if (typeof settings?.configure === 'function') {
        settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'dsh-mistral-pool: custom settings card')
      }
    })
  } else if (ctx.llm || ctx.get?.('llm')) {
    wireLlm(ctx)
  }

  const offStream = typeof ctx.on === 'function'
    ? ctx.on('llm/stream', (options, next) => {
        if (options?.provider !== 'mistral') return next()
        if (storeLoaded && store.mode === 'direct') return next()
        return (async function* () {
          await ensure()
          if (store.mode !== 'acp') {
            yield* next()
            return
          }
          yield* acpRuntime.stream(options)
        })()
      })
    : undefined

  ctx.effect(() => {
    ensure().then(() => {
      server.listen(store.port ?? DEFAULT_PORT, '127.0.0.1', () => {
        logger?.info?.(`mistral-pool: proxy listening on http://127.0.0.1:${store.port ?? DEFAULT_PORT}/v1 (mode=${store.mode}, provider=${providerId})`)
      })
    }).catch((error) => {
      // Without this the proxy silently never binds and every request fails on
      // the rejected `ready` promise.
      logger?.error?.(`mistral-pool: cannot start the proxy: ${error?.message ?? error}`)
    })
    server.on('error', (error) => logger?.warn?.(`mistral-pool: server error: ${error?.message ?? error}`))
    const rateTimer = setInterval(() => {
      refreshRate().catch(() => {})
      if (Date.now() >= billingDueAt(store)) void probeBillingNow('interval')
    }, 300_000)
    rateTimer.unref?.()
    return async () => {
      disposed = true
      lifecycleAbort.abort()
      if (typeof offStream === 'function') offStream()
      clearInterval(rateTimer)
      if (startupTimer) clearTimeout(startupTimer)
      if (saveTimer) clearTimeout(saveTimer)
      await acpRuntime.dispose().catch((error) => {
        logger?.warn?.(`mistral-pool: acp runtime dispose failed: ${error?.message ?? error}`)
      })
      // Flush the debounced state, then release the listener only after the
      // write settled and every keep-alive socket is gone: a reload must not
      // leave the port bound or a half-written store behind.
      await saveStore(dshHome, store).catch((error) => {
        logger?.warn?.(`mistral-pool: final save failed: ${error?.message ?? error}`)
      })
      if (server.listening) {
        server.closeAllConnections?.()
        await new Promise((resolveClose) => server.close(() => resolveClose()))
      }
    }
  }, 'dsh-mistral-pool: proxy server')
}

/** No service seams are required: the proxy owns its own loopback socket. */
export const inject = []
