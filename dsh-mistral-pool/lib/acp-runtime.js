/**
 * Process, session, and turn orchestration for driving Mistral Vibe (`vibe-acp`)
 * as the ACP execution path of `dsh-mistral-pool`.
 *
 * Each active conversation owns an isolated `$DSH_HOME/cache/mistral-vibe-acp/runners/<tag>`
 * workspace (`VIBE_HOME` + scratch `cwd`), talks to `vibe-acp` over stdio JSON-RPC 2.0,
 * and exposes DSH tools through {@link McpBridge} over loopback Streamable HTTP.
 *
 * Built-in Vibe tools are denied via `enabled_tools` so every tool call flows
 * back through DSH's own permission and execution pipeline, while Vibe's
 * `run_typescript` executes with `bypass_tool_permissions = true` (zero
 * `session/request_permission` round-trips). Long-running DSH tools exceeding
 * `relayAfterMs` (45s, safely under Vibe's 60s `run_typescript` limit) hand
 * back a `[DSH_RELAY]` token so the model resumes waiting via `dsh_await_result`.
 * @module dsh-mistral-pool/acp-runtime
 */

import { execFileSync, spawn as spawnNodeChild } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { freemem, homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { JsonRpcClosedError, JsonRpcPeer, JsonRpcRemoteError } from './jsonrpc.js'
import { McpBridge } from './mcp-bridge.js'
import { presetForModel, resolveMaxRequestImages } from './adapter.js'
import {
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  countRetainedImages,
  formatOffloadedImagePlaceholder,
  isImageLimitUpstreamError,
  reactiveImageOffloadCount,
  requiredOffloadForRoles,
} from './image-budget.js'

export const DEFAULT_IDLE_SESSION_TTL_MS = 480_000
export const DEFAULT_SUBAGENT_SESSION_TTL_MS = 45_000
export const LOW_MEMORY_BYTES = 1.5 * 1024 * 1024 * 1024
export const LOW_MEMORY_IDLE_TTL_MS = 60_000
export const SWEEP_INTERVAL_MS = 15_000
export const DEFAULT_MAX_LIVE_SESSIONS = 8
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 8
export const DEFAULT_MAX_IDLE_MS = 900_000
export const DEFAULT_ADMISSION_TIMEOUT_MS = 30_000
export const DEFAULT_PARK_SETTLE_MS = 150
export const DEFAULT_CANCEL_SETTLE_MS = 5_000
export const DEFAULT_RETIRE_GRACE_MS = 2_000
export const DEFAULT_RETIRE_FINAL_WAIT_MS = 2_000
export const DEFAULT_RELAY_AFTER_MS = 45_000
export const DEFAULT_MCP_WARMUP_WAIT_MS = 3_000
export const DEFAULT_GLOBAL_ACP_RESIDENT_SOFT_LIMIT = 8
export const REPLAY_BUDGET_BYTES = 512 * 1024
export const MAX_REPLAY_BYTES = 1024 * 1024
export const MAX_TOOL_RESULT_TEXT_BYTES = 256 * 1024
export const REQUEST_IMAGE_MAX_BYTES = 7 * 1024 * 1024
export const AWAIT_TOOL_NAME = 'dsh_await_result'

const GLOBAL_COORDINATOR_KEY = Symbol.for('dsh.acp.residentCoordinator.v1')
const COMMAND_RESOLVE_RETRY_MS = 60_000
const BRIDGE_KEEPALIVE_MS = 15_000
const MAX_KEY_ATTEMPTS = 6
const EMPTY_INPUT_CONTINUATION = 'Continue the task from the latest tool results above.'
const EFFORT_ORDER = ['off', 'low', 'medium', 'high', 'max']

const KNOWN_MODELS = {
  'zai-glm-5-3': {
    name: 'zai-glm-5-3',
    alias: 'zai-glm-5-3',
    displayName: 'GLM 5.3 (Mistral Hosted)',
    thinkingLevels: ['low', 'high', 'max'],
    supportsImages: false,
    maxContextLength: 1_048_576,
    autoCompactThreshold: 950_000,
  },
  'zai-glm-5-3-flash': {
    name: 'zai-glm-5-3-flash',
    alias: 'zai-glm-5-3-flash',
    displayName: 'GLM 5.3 Flash (Mistral Hosted)',
    thinkingLevels: ['low', 'high', 'max'],
    supportsImages: true,
    maxContextLength: 1_048_576,
    autoCompactThreshold: 950_000,
  },
  'deepseek-v4-1-flash-1017': {
    name: 'deepseek-v4-1-flash-1017',
    alias: 'deepseek-v4-1-flash-1017',
    displayName: 'DeepSeek V4.1 Flash 1017',
    thinkingLevels: ['off', 'low', 'high', 'max'],
    supportsImages: true,
    maxContextLength: 1_048_576,
    autoCompactThreshold: 950_000,
  },
  'mistral-large-4': {
    name: 'mistral-large-4-0',
    alias: 'mistral-large-4',
    displayName: 'Mistral Large 4',
    thinkingLevels: ['low', 'medium', 'high'],
    supportsImages: true,
    maxContextLength: 1_048_576,
    autoCompactThreshold: 950_000,
  },
  'mistral-large-4-0': {
    name: 'mistral-large-4-0',
    alias: 'mistral-large-4-0',
    displayName: 'Mistral Large 4',
    thinkingLevels: ['low', 'medium', 'high'],
    supportsImages: true,
    maxContextLength: 1_048_576,
    autoCompactThreshold: 950_000,
  },
  'mistral-vibe-cli-latest': {
    name: 'mistral-vibe-cli-latest',
    alias: 'mistral-vibe-cli-latest',
    displayName: 'Mistral Medium 3.5',
    thinkingLevels: ['off', 'high'],
    supportsImages: true,
    maxContextLength: 262_144,
    autoCompactThreshold: 240_000,
  },
  'mistral-medium-latest': {
    name: 'mistral-medium-latest',
    alias: 'mistral-medium-latest',
    displayName: 'Mistral Medium 3.5',
    thinkingLevels: ['off', 'high'],
    supportsImages: true,
    maxContextLength: 262_144,
    autoCompactThreshold: 240_000,
  },
}

const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
]

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function digestValue(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function delay(ms, signal) {
  if (ms <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    timer.unref?.()
    if (signal?.aborted) {
      clearTimeout(timer)
      resolve(false)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class AsyncQueue {
  constructor() {
    this.items = []
    this.waiters = []
  }

  push(item) {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter(true)
    }
    this.items.push(item)
  }

  shift() {
    return this.items.shift()
  }

  peek() {
    return this.items[0]
  }

  wait(signal, timeoutMs) {
    if (this.items.length > 0) return Promise.resolve(true)
    if (signal?.aborted) return Promise.resolve(false)
    if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      let timer
      let settled = false
      const settle = (ok) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const idx = this.waiters.indexOf(onPush)
        if (idx >= 0) this.waiters.splice(idx, 1)
        resolve(ok)
      }
      const onPush = () => settle(true)
      const onAbort = () => settle(false)
      this.waiters.push(onPush)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => settle(false), timeoutMs)
        timer.unref?.()
      }
    })
  }
}

class KeyedMutex {
  constructor() {
    this.tails = new Map()
  }

  async acquire(key, timeoutMs, signal) {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const gate = deferred()
    const nextTail = prev.then(() => gate.promise, () => gate.promise)
    this.tails.set(key, nextTail)

    const acquired = await Promise.race([
      prev.then(() => true, () => true),
      delay(timeoutMs, signal).then(() => false),
    ])
    if (!acquired) {
      gate.resolve()
      if (this.tails.get(key) === nextTail) this.tails.delete(key)
      throw new AcpError(
        signal?.aborted ? 'Request aborted' : `Timed out waiting for conversation lock (${timeoutMs}ms)`,
        signal?.aborted ? 'ABORTED' : 'TIMEOUT',
      )
    }
    let released = false
    return () => {
      if (released) return
      released = true
      gate.resolve()
      if (this.tails.get(key) === nextTail) this.tails.delete(key)
    }
  }
}

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit)
    this.used = 0
    this.waiters = []
    this.disposed = false
  }

  async acquire(timeoutMs, signal) {
    if (this.disposed || signal?.aborted) return false
    if (this.used < this.limit) {
      this.used += 1
      return true
    }
    return new Promise((resolve) => {
      let timer
      let done = false
      const entry = {
        grant: () => {
          if (done) return
          done = true
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.used += 1
          resolve(true)
        },
        cancel: () => {
          if (done) return
          done = true
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          const idx = this.waiters.indexOf(entry)
          if (idx >= 0) this.waiters.splice(idx, 1)
          resolve(false)
        },
      }
      const onAbort = () => entry.cancel()
      this.waiters.push(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs > 0) {
        timer = setTimeout(() => entry.cancel(), timeoutMs)
        timer.unref?.()
      }
    })
  }

  release() {
    this.used = Math.max(0, this.used - 1)
    while (this.waiters.length > 0 && this.used < this.limit && !this.disposed) {
      const next = this.waiters.shift()
      next.grant()
    }
  }

  dispose() {
    this.disposed = true
    while (this.waiters.length > 0) {
      this.waiters.shift().cancel()
    }
  }
}

/** Error carrying a DSH-compatible `code` and optional `failure` snapshot. */
export class AcpError extends Error {
  /**
   * @param {string} message - diagnostic message.
   * @param {string} code - DSH `LlmFailure.code`.
   * @param {{ status?: number, providerRetryAfterMs?: number, offloadImages?: number, cause?: unknown }} [extra] - optional metadata.
   */
  constructor(message, code, extra = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined)
    this.name = 'AcpError'
    this.code = code
    this.failure = {
      message,
      code,
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      ...(extra.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: extra.providerRetryAfterMs } : {}),
      ...(code === IMAGE_OFFLOAD_REQUIRED_CODE && Number.isSafeInteger(extra.offloadImages) && extra.offloadImages > 0
        ? { offloadImages: extra.offloadImages }
        : {}),
    }
  }
}

function toFailure(error, signal) {
  if (signal?.aborted) {
    return { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } }
  }
  if (error instanceof AcpError) {
    return {
      kind: error.code === 'ABORTED' ? 'aborted' : 'error',
      failure: error.failure,
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'PROVIDER_ERROR'
  return { kind: code === 'ABORTED' ? 'aborted' : 'error', failure: { message, code } }
}

/**
 * Shared global ACP resident coordinator (`Symbol.for('dsh.acp.residentCoordinator.v1')`)
 * matching `dsh-llm-codebuddy-acp` and `dsh-llm-cursor-acp`.
 */
function residentCoordinator() {
  const g = globalThis
  let state = g[GLOBAL_COORDINATOR_KEY]
  if (!state) {
    state = { providers: new Map() }
    g[GLOBAL_COORDINATOR_KEY] = state
  }
  return state
}

function registerResidentProvider(id, hooks) {
  const state = residentCoordinator()
  state.providers.set(id, hooks)
  return () => { state.providers.delete(id) }
}

function rebalanceGlobalResidents(softLimit = DEFAULT_GLOBAL_ACP_RESIDENT_SOFT_LIMIT) {
  const state = residentCoordinator()
  let total = 0
  for (const hooks of state.providers.values()) total += hooks.countLive()
  let evicted = 0
  while (total > softLimit) {
    let bestHooks
    let oldest = Number.POSITIVE_INFINITY
    for (const hooks of state.providers.values()) {
      const candidate = hooks.oldestIdleAt()
      if (candidate !== undefined && candidate < oldest) {
        oldest = candidate
        bestHooks = hooks
      }
    }
    if (!bestHooks || !bestHooks.evictOldestIdle()) break
    total -= 1
    evicted += 1
  }
  return evicted
}

/** Resolve the `vibe-acp` executable path. */
export function resolveVibeBinary(configured = '', options = {}) {
  const exists = options.exists ?? existsSync
  const trimmed = typeof configured === 'string' ? configured.trim() : ''
  if (trimmed.length > 0) {
    if (!isAbsolute(trimmed)) throw new Error(`mistral-vibe-acp: vibeCommand must be an absolute path, got ${trimmed}`)
    if (!exists(trimmed)) throw new Error(`mistral-vibe-acp: configured vibe-acp binary not found at ${trimmed}`)
    return trimmed
  }
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const candidates = []
  if (platform === 'win32') {
    candidates.push(join(home, '.local', 'bin', 'vibe-acp.exe'))
    candidates.push(join(home, '.cargo', 'bin', 'vibe-acp.exe'))
    for (const dir of (env.PATH ?? '').split(';')) {
      const p = dir.trim()
      if (!p) continue
      candidates.push(join(p, 'vibe-acp.exe'), join(p, 'vibe-acp.cmd'))
    }
  } else {
    candidates.push(
      join(home, '.local', 'bin', 'vibe-acp'),
      '/opt/homebrew/bin/vibe-acp',
      '/usr/local/bin/vibe-acp',
      join(home, '.cargo', 'bin', 'vibe-acp'),
    )
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (dir) candidates.push(join(dir, 'vibe-acp'))
    }
  }
  const found = candidates.find((p) => exists(p))
  if (!found) {
    throw new AcpError(
      '未找到本机 vibe-acp 可执行文件，请先安装 mistral-vibe（uv tool install mistral-vibe）或在设置中指定绝对路径。',
      'AUTH',
    )
  }
  return found
}

function memoizeCommandResolver() {
  let cached
  return (configured) => {
    const key = typeof configured === 'string' ? configured.trim() : ''
    if (cached && cached.key === key) {
      if (cached.value) return cached.value
      if (Date.now() - cached.at < COMMAND_RESOLVE_RETRY_MS && cached.error) throw cached.error
    }
    try {
      const value = resolveVibeBinary(key)
      cached = { key, value, at: Date.now() }
      return value
    } catch (error) {
      cached = { key, value: '', error, at: Date.now() }
      throw error
    }
  }
}

/** Build a scrubbed child environment for `vibe-acp` with `VIBE_HOME` and `MISTRAL_API_KEY`. */
export function buildVibeChildEnv({ vibeHome, apiKey, extraEnv = {}, base = process.env, platform = process.platform }) {
  const keep = new Set(CHILD_ENV_ALLOWLIST)
  const keepUpper = new Set(CHILD_ENV_ALLOWLIST.map((k) => k.toUpperCase()))
  const env = {}
  for (const key of Object.keys(base)) {
    const allowed = platform === 'win32' ? keepUpper.has(key.toUpperCase()) : keep.has(key)
    if (!allowed) env[key] = undefined
  }
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (base[key] !== undefined) env[key] = base[key]
  }
  env.HOME = homedir()
  if (platform === 'win32') env.USERPROFILE = homedir()
  for (const [k, v] of Object.entries(extraEnv)) {
    if (typeof v === 'string') env[k] = v
  }
  env.VIBE_HOME = vibeHome
  env.MISTRAL_API_KEY = apiKey
  return env
}

/** Map a requested DSH reasoning effort to the nearest Vibe-supported effort for `modelId`. */
export function resolveModelSpec(modelId, modelEntry) {
  const raw = String(modelId || 'zai-glm-5-3').trim()
  const maxRequestImages = resolveMaxRequestImages(raw, modelEntry)
  if (KNOWN_MODELS[raw]) return { ...KNOWN_MODELS[raw], maxRequestImages }
  const preset = presetForModel(raw)
  if (preset) {
    const mappedEfforts = []
    for (const level of preset.efforts ?? []) {
      const normalized = level === 'minimal' ? 'low' : level === 'xhigh' ? 'max' : level
      if (EFFORT_ORDER.includes(normalized) && !mappedEfforts.includes(normalized)) {
        mappedEfforts.push(normalized)
      }
    }
    const thinkingLevels = mappedEfforts.length > 0 ? mappedEfforts : ['off']
    const maxContextLength = Number(preset.contextWindow) > 0 ? Math.trunc(Number(preset.contextWindow)) : 1_048_576
    const autoCompactThreshold = Math.max(4_000, Math.floor(maxContextLength * 0.9))
    return {
      name: raw,
      alias: raw,
      displayName: preset.name || raw,
      thinkingLevels,
      supportsImages: Array.isArray(preset.input) ? preset.input.includes('image') : true,
      maxContextLength,
      autoCompactThreshold,
      maxRequestImages,
    }
  }
  return {
    name: raw,
    alias: raw,
    displayName: raw,
    thinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
    supportsImages: true,
    maxContextLength: 1_048_576,
    autoCompactThreshold: 950_000,
    maxRequestImages,
  }
}

/** Map a DSH reasoning effort to the nearest level supported by the model spec. */
export function resolveVibeEffort(requested, supportedLevels) {
  const levels = Array.isArray(supportedLevels) && supportedLevels.length > 0 ? supportedLevels : ['high']
  let normalized = typeof requested === 'string' ? requested.trim().toLowerCase() : ''
  if (normalized === 'minimal') normalized = 'low'
  if (normalized === 'xhigh') normalized = 'max'
  if (!normalized) normalized = levels.includes('high') ? 'high' : levels[levels.length - 1]
  if (levels.includes(normalized)) return normalized
  const targetIdx = EFFORT_ORDER.indexOf(normalized)
  if (targetIdx < 0) return levels[levels.length - 1]
  let best = levels[0]
  let bestDist = Infinity
  for (const candidate of levels) {
    const dist = Math.abs(EFFORT_ORDER.indexOf(candidate) - targetIdx)
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}

/** Normalize an upstream URL into the `/v1` `api_base` expected by Vibe's Mistral provider. */
export function resolveMistralApiBase(upstream) {
  const clean = String(upstream || 'https://api.mistral.ai').trim().replace(/\/+$/, '')
  return clean.endsWith('/v1') ? clean : `${clean}/v1`
}

/** Compute Vibe's deterministic `programmatic_name` mapping from `_mcp_naming.py`. */
export function vibeGroupName(serverName) {
  const normalized = String(serverName || 'dsh').replace(/[^A-Za-z0-9_$]/g, '_') || '_'
  return `mcp_${normalized}`
}

/** Map DSH tool names to Vibe TypeScript property identifiers (`_mcp_naming._tool_names`). */
export function vibeProgrammaticNames(tools) {
  const rawNames = [...new Set((tools ?? []).map((t) => String(t.name)))].sort()
  const normalizeId = (val) => {
    let s = String(val || '').replace(/[^A-Za-z0-9_$]/g, '_') || '_'
    if (/^[0-9]/.test(s)) s = `_${s}`
    return s
  }
  const isIdentifier = (val) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(val)
  const candidates = new Map(rawNames.map((r) => [r, normalizeId(r)]))
  const counts = new Map()
  for (const c of candidates.values()) counts.set(c, (counts.get(c) ?? 0) + 1)
  const used = new Set()
  const result = new Map()
  for (const raw of rawNames) {
    const candidate = candidates.get(raw)
    if (isIdentifier(raw) && raw === candidate) {
      result.set(raw, raw)
      used.add(raw)
      continue
    }
    if ((counts.get(candidate) ?? 0) === 1 && !used.has(candidate)) {
      result.set(raw, candidate)
      used.add(candidate)
      continue
    }
    const digest = createHash('sha256').update(raw, 'utf8').digest('hex')
    let len = 8
    while (len <= digest.length) {
      const next = `${candidate}_${digest.slice(0, len)}`
      if (!used.has(next)) {
        result.set(raw, next)
        used.add(next)
        break
      }
      len += 1
    }
  }
  return result
}

/** Normalize a DSH `ToolSchema.parameters` into a JSON Schema object Vibe accepts. */
export function normalizeToolInputSchema(parameters) {
  if (!isRecord(parameters)) return { type: 'object', properties: {} }
  return { ...parameters, type: 'object', properties: isRecord(parameters.properties) ? parameters.properties : {} }
}

function summarizeParams(schema) {
  const props = isRecord(schema?.properties) ? Object.entries(schema.properties) : []
  if (props.length === 0) return '{}'
  const req = new Set(Array.isArray(schema?.required) ? schema.required : [])
  const items = props.slice(0, 8).map(([name, def]) => {
    const t = typeof def?.type === 'string' ? def.type : 'any'
    return `${name}${req.has(name) ? '*' : ''}: ${t}`
  })
  if (props.length > 8) items.push(`+${props.length - 8} more`)
  return `{ ${items.join(', ')} }`
}

/** Render the compact `<dsh_tool_catalog>` block telling the model exact `run_typescript` call paths. */
export function formatToolCatalog(tools, serverName) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const group = vibeGroupName(serverName)
  const names = vibeProgrammaticNames(tools)
  const lines = [
    '<dsh_tool_catalog>',
    `Use \`run_typescript\` to call harness tools under \`tools.${group}.<name>(args)\`. Return the value you want back from \`run_typescript\`.`,
  ]
  for (const tool of tools) {
    const prog = names.get(tool.name) ?? tool.name
    const desc = String(tool.description || '').replace(/\s+/g, ' ').trim().slice(0, 140)
    const params = summarizeParams(tool.inputSchema)
    lines.push(`- tools.${group}.${prog}(${params})${desc ? ` — ${desc}` : ''}`)
  }
  lines.push('</dsh_tool_catalog>')
  return lines.join('\n')
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ''))
}

function tomlStringArray(items) {
  return `[${items.map(tomlString).join(', ')}]`
}

function buildModelsToml(spec) {
  const entries = new Map()
  for (const item of [
    KNOWN_MODELS['zai-glm-5-3'],
    KNOWN_MODELS['zai-glm-5-3-flash'],
    KNOWN_MODELS['deepseek-v4-1-flash-1017'],
    KNOWN_MODELS['mistral-large-4'],
    KNOWN_MODELS['mistral-medium-latest'],
    KNOWN_MODELS['mistral-vibe-cli-latest'],
    spec,
  ]) {
    entries.set(item.alias, item)
  }
  return [...entries.values()]
    .map((m) => {
      const defaultThinking = m.thinking
        ?? (m.thinkingLevels.includes('high') ? 'high' : (m.thinkingLevels[m.thinkingLevels.length - 1] ?? 'off'))
      return [
        '[[models]]',
        `name = ${tomlString(m.name)}`,
        `provider = "mistral"`,
        `alias = ${tomlString(m.alias)}`,
        `display_name = ${tomlString(m.displayName)}`,
        `thinking = ${tomlString(defaultThinking)}`,
        `thinking_levels = ${tomlStringArray(m.thinkingLevels)}`,
        `supports_images = ${m.supportsImages ? 'true' : 'false'}`,
        `max_context_length = ${m.maxContextLength}`,
        `auto_compact_threshold = ${m.autoCompactThreshold}`,
      ].join('\n')
    })
    .join('\n\n')
}

/** Write isolated `VIBE_HOME` config, custom `dsh-bridge` agent profile, and cached discovery files. */
export function prepareRunnerVibeHome({ vibeHome, upstream, modelId, effort, serverName, sourceVibeHome = join(homedir(), '.vibe') }) {
  mkdirSync(vibeHome, { recursive: true, mode: 0o700 })
  mkdirSync(join(vibeHome, 'prompts'), { recursive: true })
  mkdirSync(join(vibeHome, 'agents'), { recursive: true })

  for (const cacheFile of ['model_catalog_cache.json', 'whoami_cache.json', 'managed_config_cache.json']) {
    const src = join(sourceVibeHome, cacheFile)
    const dst = join(vibeHome, cacheFile)
    if (existsSync(src) && !existsSync(dst)) {
      try { copyFileSync(src, dst) } catch { /* cache copy is best-effort */ }
    }
  }

  const group = vibeGroupName(serverName || 'dsh_bridge')
  const bridgePrompt = [
    'You are the model backend of a DeepSeek Harness (DSH) session. DSH owns the conversation, tools, and permissions.',
    `All DSH tools are exposed through \`run_typescript\` on \`tools.${group}.<tool>(args)\`. Built-in local Vibe tools (read_file, write_file, edit, bash, skill) are disabled/denied and must not be called.`,
    'If a tool returns a `[DSH_RELAY]` notice indicating it is still running in DSH, do NOT call the original tool again; immediately call `await tools.' + group + '.' + AWAIT_TOOL_NAME + '({ call_id })` to await its completion.',
    'The first prompt opens with `<dsh_context>` (complete system prompt and tool catalog) and optional `<dsh_history>` (earlier turns). Continue from the latest user or tool input without repeating finished work.',
  ].join('\n')
  writeFileSync(join(vibeHome, 'prompts', 'dsh_bridge.md'), `${bridgePrompt}\n`, 'utf8')

  writeFileSync(
    join(vibeHome, 'agents', 'dsh-bridge.toml'),
    [
      'display_name = "DSH Bridge"',
      'description = "DeepSeek Harness model backend"',
      'safety = "yolo"',
      'system_prompt_id = "dsh_bridge"',
    ].join('\n') + '\n',
    'utf8',
  )

  const baseSpec = resolveModelSpec(modelId)
  const resolvedEffort = resolveVibeEffort(effort, baseSpec.thinkingLevels)
  const spec = { ...baseSpec, thinking: resolvedEffort }
  const apiBase = resolveMistralApiBase(upstream)
  const enabledList = serverName ? [`${serverName}_*`] : ['__dsh_no_tools__']

  const configToml = [
    `active_model = ${tomlString(spec.alias)}`,
    'default_agent = "dsh-bridge"',
    'bypass_tool_permissions = true',
    'enable_auto_approve = true',
    `enabled_tools = ${tomlStringArray(enabledList)}`,
    'enable_subagents = false',
    'enable_background_processes = false',
    'include_project_context = false',
    'include_prompt_detail = false',
    'include_commit_signature = false',
    'enable_telemetry = false',
    'enable_update_checks = false',
    '',
    '[experiments]',
    'enable = false',
    '',
    '[session_logging]',
    'enabled = true',
    'generate_titles = false',
    '',
    '[[providers]]',
    'name = "mistral"',
    `api_base = ${tomlString(apiBase)}`,
    'api_key_env_var = "MISTRAL_API_KEY"',
    'backend = "mistral"',
    'preserve_api_base = true',
    '',
    buildModelsToml(spec),
    '',
  ].join('\n')

  const configPath = join(vibeHome, 'config.toml')
  writeFileSync(configPath, configToml, 'utf8')
  try { chmodSync(configPath, 0o600) } catch { /* best-effort */ }
  return { spec, resolvedEffort }
}

/** Whether an ACP error represents an unusable / exhausted API key rather than a transient error. */
export function isAcpKeyExhausted(error) {
  if (error instanceof JsonRpcRemoteError) {
    if (error.rpc.code === -32000) return true
    if (error.rpc.code === -31001) return false
    const msg = String(error.rpc.message || '')
    if (error.rpc.code === -31002) {
      return /api[\s_-]?key|invalid.*key|unauth|401|403/i.test(msg)
    }
    return /\b(?:401|402|403)\b|insufficient|quota|credit|balance|billing|payment[\s_-]*required|(?:quota|usage[\s_-]*limit|budget)[\s_-]*exceeded/i.test(msg)
  }
  const msg = String(error?.message ?? error ?? '')
  return /\b(?:401|402|403)\b|insufficient|quota|credit|balance|billing|payment[\s_-]*required/i.test(msg)
}

function mapAcpError(error) {
  if (error instanceof AcpError) return error
  if (error instanceof JsonRpcRemoteError) {
    const code = error.rpc.code
    const msg = error.rpc.message || 'Vibe ACP request failed'
    if (code === -32000) return new AcpError(msg, 'AUTH')
    if (code === -31001) return new AcpError(msg, 'RATE_LIMIT', { status: 429 })
    if (code === -31004) return new AcpError(msg, 'CONTEXT_WINDOW_EXCEEDED')
    if (code === -31005) return new AcpError(msg, 'REFUSAL')
    if (code === -31007 || code === -31008) {
      if (code === -31007 && /too many images/i.test(msg)) {
        return new AcpError(
          `Mistral Vibe ACP (vibe-acp) 单条消息最多支持 8 张图片，请分批发送（每次 ≤ 8 张），或在「设置 → Mistral Key 池」切换为直连模式。(${msg})`,
          'INVALID_REQUEST',
        )
      }
      return new AcpError(msg, 'INVALID_REQUEST')
    }
    if (code === -31002) {
      return new AcpError(msg, /api[\s_-]?key|unauth/i.test(msg) ? 'AUTH' : 'PROVIDER_ERROR')
    }
    if (isAcpKeyExhausted(error)) return new AcpError(msg, 'QUOTA', { status: 402 })
    return new AcpError(msg, 'PROVIDER_ERROR')
  }
  if (error instanceof JsonRpcClosedError) {
    return new AcpError(error.message, 'TRANSPORT')
  }
  const msg = error instanceof Error ? error.message : String(error)
  if (/timeout|timed out/i.test(msg)) return new AcpError(msg, 'TIMEOUT')
  return new AcpError(msg, 'PROVIDER_ERROR', { cause: error })
}

function splitSystem(options) {
  const parts = []
  if (typeof options.system === 'string' && options.system.length > 0) parts.push(options.system)
  let index = 0
  const messages = Array.isArray(options.messages) ? options.messages : []
  for (const msg of messages) {
    if (msg?.role !== 'system') break
    parts.push(textOf(msg.content))
    index += 1
  }
  return { system: parts.filter(Boolean).join('\n\n'), messages: messages.slice(index) }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
}

function sanitizeTranscript(text) {
  return String(text ?? '')
    .replaceAll('<dsh_context>', '<dsh_·context>')
    .replaceAll('<dsh_history>', '<dsh_·history>')
    .replaceAll('</dsh', '<dsh_·')
}

function formatFileHandleText(ref, readonlyPath) {
  const id = String(ref?.attachmentId ?? '')
  const short = id.startsWith('sha256:') ? id.slice(7, 15) : id.slice(0, 8)
  const name = JSON.stringify(String(ref?.name ?? 'file'))
  const bytes = Number(ref?.bytes ?? 0)
  const identity = `File ${name} (${bytes} bytes, sha256:${short})`
  if (!readonlyPath) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${JSON.stringify(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it.]`
}

function textOnlyImageFallback(ref) {
  const id = String(ref?.attachmentId ?? '')
  const short = id.startsWith('sha256:') ? id.slice(7, 15) : id.slice(0, 8)
  return `[image omitted because this model accepts text only; attachment sha256:${short}]`
}

function renderBlocks(content, resolveFilePath, resolveImagePath) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(String(block.text))
        break
      case 'image':
        if (block.offloaded === true) {
          parts.push(formatOffloadedImagePlaceholder(block.attachment, resolveImagePath?.(block.attachment)))
        } else {
          parts.push(`[image ${block.attachment?.attachmentId ?? 'unknown'}]`)
        }
        break
      case 'file':
        parts.push(formatFileHandleText(block.attachment, resolveFilePath?.(block.attachment)))
        break
      case 'tool-addition':
        parts.push(`[tool added: ${block.toolName}]`)
        break
      case 'tool-removal':
        parts.push(`[tool removed: ${block.toolName}]`)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

function renderTranscript(messages, resolveFilePath, resolveImagePath) {
  const lines = []
  for (const msg of messages) {
    if (!msg) continue
    switch (msg.role) {
      case 'user':
        lines.push(`<user>\n${renderBlocks(msg.content, resolveFilePath, resolveImagePath)}\n</user>`)
        break
      case 'assistant': {
        const text = renderBlocks((msg.content ?? []).filter((b) => b?.type !== 'tool-call' && b?.type !== 'reasoning'), resolveFilePath, resolveImagePath)
        if (text) lines.push(`<assistant>\n${text}\n</assistant>`)
        for (const block of msg.content ?? []) {
          if (block?.type === 'tool-call') {
            lines.push(`<tool_call id="${block.id}" name="${block.name}">\n${block.arguments}\n</tool_call>`)
          }
        }
        break
      }
      case 'tool':
        lines.push(`<tool_result id="${msg.toolCallId}"${msg.isError ? ' error="true"' : ''}>\n${renderBlocks(msg.content, resolveFilePath, resolveImagePath)}\n</tool_result>`)
        break
      case 'developer': {
        const text = renderBlocks(msg.content, resolveFilePath, resolveImagePath)
        if (text) lines.push(`<harness_notice>\n${text}\n</harness_notice>`)
        break
      }
      case 'system':
        lines.push(`<system_update>\n${renderBlocks(msg.content, resolveFilePath, resolveImagePath)}\n</system_update>`)
        break
      default:
        break
    }
  }
  return sanitizeTranscript(lines.join('\n\n'))
}

function contextBlock(system, tools, serverName) {
  const catalog = formatToolCatalog(tools, serverName)
  const parts = [
    'You are the primary model of a DeepSeek Harness (DSH) session. DSH owns the conversation, tools, and permissions.',
    tools.length > 0
      ? `Execute DSH tools inside \`run_typescript\` via \`tools.${vibeGroupName(serverName)}.<name>(args)\`. Built-in local Vibe tools (read_file, write_file, edit, bash, skill) are denied.`
      : 'No tools are provided for this request. Answer directly without calling tools.',
  ]
  if (catalog) parts.push(catalog)
  if (system) parts.push(system)
  return `<dsh_context>\n${parts.join('\n\n')}\n</dsh_context>\n\n`
}

async function toPromptBlocks(messages, supportsImages, resolveImage, resolveFilePath, resolveImagePath) {
  const blocks = []
  for (const msg of messages) {
    if (!msg) continue
    if (msg.role === 'user') {
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }]
      for (const block of content) {
        if (block?.type === 'text') {
          if (block.text) blocks.push({ type: 'text', text: String(block.text) })
        } else if (block?.type === 'image' && block.offloaded !== true) {
          if (!supportsImages) {
            blocks.push({ type: 'text', text: textOnlyImageFallback(block.attachment) })
          } else {
            const img = await resolveImage?.(block)
            if (img) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType })
            else blocks.push({ type: 'text', text: `[image ${block.attachment?.attachmentId ?? 'unknown'} unavailable]` })
          }
        } else {
          const text = renderBlocks([block], resolveFilePath, resolveImagePath)
          if (text) blocks.push({ type: 'text', text })
        }
      }
    } else {
      const rendered = renderTranscript([msg], resolveFilePath, resolveImagePath)
      if (rendered) blocks.push({ type: 'text', text: rendered })
      if (msg.role === 'tool' && supportsImages && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type !== 'image' || block.offloaded === true) continue
          const img = await resolveImage?.(block)
          if (img) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType })
        }
      }
    }
  }
  return blocks
}

async function buildReplayPrompt({ system, tools, serverName, history, input, supportsImages, resolveImage, resolveFilePath, resolveImagePath, budgetBytes = REPLAY_BUDGET_BYTES }) {
  const header = contextBlock(system, tools, serverName)
  const rawInputBlocks = await toPromptBlocks(input, supportsImages, resolveImage, resolveFilePath, resolveImagePath)
  const inputBlocks = rawInputBlocks.length > 0 ? rawInputBlocks : [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }]
  const headerBytes = Buffer.byteLength(header, 'utf8')
  const inputBytes = inputBlocks.reduce((n, b) => n + Buffer.byteLength(b.type === 'text' ? b.text : b.data, 'utf8'), 0)
  const remaining = Math.min(budgetBytes, MAX_REPLAY_BYTES) - headerBytes - inputBytes
  if (remaining < 0) {
    throw new AcpError('Prompt replay exceeds ACP replay budget; trigger compaction first.', 'CONTEXT_WINDOW_EXCEEDED')
  }
  if (!history || history.length === 0) {
    return [{ type: 'text', text: header }, ...inputBlocks]
  }
  const kept = []
  let used = 0
  let omitted = 0
  const reserve = 128
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const chunk = renderTranscript([history[i]], resolveFilePath, resolveImagePath)
    const bytes = Buffer.byteLength(chunk, 'utf8') + 2
    if (used + bytes + reserve <= remaining) {
      kept.unshift(chunk)
      used += bytes
    } else {
      omitted = i + 1
      break
    }
  }
  const notice = omitted > 0 ? `[${omitted} earlier message(s) omitted to fit replay budget]\n\n` : ''
  const historyText = kept.length > 0 ? `<dsh_history>\n${notice}${kept.join('\n\n')}\n</dsh_history>\n\n` : notice
  return [{ type: 'text', text: `${header}${historyText}` }, ...inputBlocks]
}

function trailingSplit(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { history: [], input: [] }
  let cut = messages.length - 1
  while (cut > 0 && messages[cut]?.role === 'tool' && messages[cut - 1]?.role === 'tool') {
    cut -= 1
  }
  if (messages[cut]?.role === 'user') {
    return { history: messages.slice(0, cut), input: messages.slice(cut) }
  }
  return { history: messages.slice(0, cut), input: messages.slice(cut) }
}

function digestMessage(msg) {
  return digestValue({
    role: msg?.role,
    id: msg?.id,
    toolCallId: msg?.toolCallId,
    isError: msg?.isError,
    content: msg?.content,
  })
}

function messageIds(messages) {
  return messages.map((m) => (typeof m?.id === 'string' ? m.id : ''))
}

function historyPrefixIntact(conv, messages) {
  if (!Array.isArray(conv.knownDigests) || conv.knownDigests.length > messages.length) return false
  for (let i = 0; i < conv.knownDigests.length; i += 1) {
    if (digestMessage(messages[i]) !== conv.knownDigests[i]) return false
  }
  return true
}

function toBridgeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return []
  return tools.map((t) => ({
    name: String(t.name),
    description: String(t.description ?? ''),
    inputSchema: normalizeToolInputSchema(t.parameters),
  }))
}

function truncateToolText(text, maxBytes = MAX_TOOL_RESULT_TEXT_BYTES) {
  const buf = Buffer.from(String(text ?? ''), 'utf8')
  if (buf.length <= maxBytes) return buf.toString('utf8')
  const clipped = buf.subarray(0, maxBytes).toString('utf8')
  return `${clipped}\n\n[truncated ${buf.length - maxBytes} bytes by dsh-mistral-pool ACP bridge]`
}

async function formatToolResult(msg, supportsImages, resolveImage, resolveFilePath, resolveImagePath) {
  const content = []
  let textBytes = 0
  for (const block of msg.content ?? []) {
    if (!block) continue
    if (block.type === 'text') {
      const remaining = Math.max(0, MAX_TOOL_RESULT_TEXT_BYTES - textBytes)
      const txt = remaining > 0 ? truncateToolText(block.text, remaining) : ''
      if (txt) {
        textBytes += Buffer.byteLength(txt, 'utf8')
        content.push({ type: 'text', text: txt })
      }
    } else if (block.type === 'image' && block.offloaded !== true && supportsImages) {
      const img = await resolveImage?.(block)
      if (img) content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
      else content.push({ type: 'text', text: `[image ${block.attachment?.attachmentId ?? 'unknown'} unavailable]` })
    } else {
      const txt = renderBlocks([block], resolveFilePath, resolveImagePath)
      if (txt) content.push({ type: 'text', text: txt })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: msg.isError ? 'Tool failed.' : 'OK' })
  return { content, isError: msg.isError === true }
}

/** One active ACP turn spanning 1+ DSH tool-loop steps. */
class AcpTurn {
  constructor(sessionTag, generation) {
    this.sessionTag = sessionTag
    this.generation = generation
    this.events = new AsyncQueue()
    this.pendingCalls = new Map()
    this.calls = new Map()
    this.finished = false
    this.settled = false
    this.produced = false
    this.nextCall = 0
    this.reportedUsage = { prompt: 0, output: 0, cached: 0 }
    this.latestUsage = { prompt: 0, output: 0, cached: 0 }
  }

  park(name, args) {
    const call = {
      id: `vm_${this.sessionTag}_${this.generation}_${++this.nextCall}`,
      name,
      argumentsJson: JSON.stringify(args ?? {}),
      turn: this,
      result: deferred(),
    }
    this.calls.set(call.id, call)
    this.events.push({ kind: 'park', call })
    return call
  }

  recordUsageSnapshot({ prompt, output, cached }) {
    const p = Math.max(this.latestUsage.prompt, Number(prompt ?? 0) || 0)
    const o = Math.max(this.latestUsage.output, Number(output ?? 0) || 0)
    const c = Math.max(this.latestUsage.cached, Number(cached ?? 0) || 0)
    this.latestUsage = { prompt: p, output: o, cached: Math.min(c, p) }
  }

  consumeUsageDelta() {
    const totalInput = Math.max(0, this.latestUsage.prompt - this.reportedUsage.prompt)
    const output = Math.max(0, this.latestUsage.output - this.reportedUsage.output)
    const cached = Math.min(totalInput, Math.max(0, this.latestUsage.cached - this.reportedUsage.cached))
    this.reportedUsage = { ...this.latestUsage }
    if (totalInput === 0 && output === 0 && cached === 0) return null
    return { totalInput, uncachedInput: Math.max(0, totalInput - cached), output, cached }
  }

  onUpdate(update) {
    if (!isRecord(update)) return
    const kind = update.sessionUpdate
    if (kind === 'usage_update') {
      const meta = isRecord(update._meta) ? update._meta : {}
      if (typeof meta.promptTokens === 'number' || typeof meta.completionTokens === 'number') {
        this.recordUsageSnapshot({
          prompt: meta.promptTokens,
          output: meta.completionTokens,
          cached: meta.cachedTokens,
        })
      }
      return
    }
    const text = update.content?.type === 'text' ? String(update.content.text ?? '') : ''
    if (!text) return
    if (kind === 'agent_message_chunk') this.events.push({ kind: 'text', text })
    else if (kind === 'agent_thought_chunk') this.events.push({ kind: 'thought', text })
  }

  abandon(reason) {
    for (const call of this.calls.values()) {
      call.result.resolve({ content: [{ type: 'text', text: reason }], isError: true })
    }
    this.pendingCalls.clear()
  }
}

function readLivePidsFile(file) {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function makeWritableTree(dir) {
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      chmodSync(dir, 0o700)
      for (const entry of readdirSync(dir)) {
        makeWritableTree(join(dir, entry))
      }
    } else {
      chmodSync(dir, 0o600)
    }
  } catch { /* best-effort */ }
}

/** Remove a runner directory, restoring write permissions if Vibe locked plugin cache dirs read-only. */
function removeRunnerDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    makeWritableTree(dir)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

function writeLivePidsFile(file, entries) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch { /* best-effort pid tracking */ }
}

/**
 * Reap orphan `vibe-acp` processes (`PPID === 1`) recorded in `live-pids.json`
 * after an ungraceful host crash or SIGKILL, and clean stale runner directories.
 */
export function reapOrphanVibeProcesses(cacheDir, options = {}) {
  const platform = options.platform ?? process.platform
  const livePidsFile = join(cacheDir, 'live-pids.json')
  const recorded = readLivePidsFile(livePidsFile)
  let reaped = 0

  if (platform !== 'win32' && recorded.length > 0) {
    let psOutput = ''
    try {
      psOutput = options.listProcesses
        ? options.listProcesses()
        : execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 2_000 })
    } catch {
      psOutput = ''
    }
    const procs = new Map()
    for (const line of psOutput.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!m) continue
      procs.set(Number(m[1]), { ppid: Number(m[2]), cmd: m[3] ?? '' })
    }
    const killPid = options.killPid ?? ((pid) => process.kill(pid, 'SIGTERM'))
    for (const entry of recorded) {
      const pid = Number(entry?.pid)
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue
      const proc = procs.get(pid)
      if (!proc || proc.ppid !== 1) continue
      if (!proc.cmd.includes('vibe-acp')) continue
      try {
        killPid(pid)
        reaped += 1
      } catch { /* already gone */ }
    }
  }

  writeLivePidsFile(livePidsFile, [])
  const runnersRoot = join(cacheDir, 'runners')
  if (existsSync(runnersRoot)) {
    try {
      for (const name of readdirSync(runnersRoot)) {
        removeRunnerDir(join(runnersRoot, name))
      }
    } catch { /* best-effort cleanup */ }
  }
  return reaped
}

/** Runtime owning `vibe-acp` child processes, loopback MCP bridge, and conversation sessions. */
export class VibeAcpRuntime {
  /**
   * @param {{
   *   dshHome: string,
   *   cacheDir?: string,
   *   getUpstream: () => string,
   *   getVibeCommand?: () => string,
   *   selectVibeKey: (affinity: string) => Promise<Record<string, any> | null> | Record<string, any> | null,
   *   exhaustKey: (keyRecord: Record<string, any>, reason: string) => Promise<void> | void,
   *   recordUsage: (keyRecord: Record<string, any>, model: string, usage: { input: number, output: number, cached: number }) => void,
   *   spawnSubprocess?: (opts: { argv: string[], cwd: string, env: Record<string, string | undefined>, graceMs: number }) => any,
   *   resolveImage?: (block: any) => Promise<{ data: string, mimeType: string } | undefined>,
   *   resolveFilePath?: (ref: any) => string | undefined,
   *   isSubagentSession?: (sessionId: string) => boolean,
   *   log?: { info?: (msg: string) => void, warn?: (msg: string) => void },
   *   sourceVibeHome?: string,
   *   maxLiveSessions?: number,
   *   maxConcurrentRequests?: number,
   *   idleSessionTtlMs?: number,
   *   subagentSessionTtlMs?: number,
   *   maxIdleMs?: number,
   *   parkSettleMs?: number,
   *   relayAfterMs?: number,
   *   mcpWarmupWaitMs?: number,
   *   admissionTimeoutMs?: number,
   *   cancelSettleMs?: number,
   *   retireGraceMs?: number,
   *   retireFinalWaitMs?: number,
   *   globalSoftLimit?: number,
   * }} host
   */
  constructor(host) {
    this.host = host
    this.cacheDir = host.cacheDir ?? join(host.dshHome, 'cache', 'mistral-vibe-acp')
    this.runnersRoot = join(this.cacheDir, 'runners')
    this.livePidsFile = join(this.cacheDir, 'live-pids.json')
    this.resolveCommand = memoizeCommandResolver()
    this.requestSlots = new Semaphore(host.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS)
    this.residentSlots = new Semaphore(host.maxLiveSessions ?? DEFAULT_MAX_LIVE_SESSIONS)
    this.mutex = new KeyedMutex()
    this.conversations = new Map()
    this.tenants = new Map()
    this.mcpListWaiters = new Map()
    this.retirements = new Set()
    this.livePids = new Map()
    this.disposed = false
    this.instanceId = `mistral-vibe-acp:${randomBytes(4).toString('hex')}`

    mkdirSync(this.runnersRoot, { recursive: true })
    const reaped = reapOrphanVibeProcesses(this.cacheDir)
    if (reaped > 0) host.log?.info?.(`mistral-pool: reaped ${reaped} orphan vibe-acp process(es)`)

    this.bridge = new McpBridge(
      {
        listTools: (tenantKey) => this.#listTools(tenantKey),
        callTool: (req) => this.#callTool(req),
        onToolsListed: (tenantKey) => {
          const waiter = this.mcpListWaiters.get(tenantKey)
          if (waiter) {
            this.mcpListWaiters.delete(tenantKey)
            waiter.resolve(true)
          }
        },
      },
      {
        keepAliveMs: BRIDGE_KEEPALIVE_MS,
        log: (msg) => host.log?.info?.(`mistral-pool: ${msg}`),
      },
    )

    this.unregisterCoordinator = registerResidentProvider(this.instanceId, {
      countLive: () => this.#countLive(),
      oldestIdleAt: () => this.#oldestIdleAt(),
      evictOldestIdle: () => this.#evictOldestIdle(),
    })

    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweeper.unref?.()
  }

  /** Current runtime summary for settings UI and `/__pool/state`. */
  status() {
    let binary = ''
    let available = false
    try {
      binary = this.resolveCommand(this.host.getVibeCommand?.() ?? '')
      available = Boolean(binary)
    } catch {
      available = false
    }
    let activeTurns = 0
    for (const conv of this.conversations.values()) {
      if (conv.turn && !conv.turn.finished && !conv.turn.settled) activeTurns += 1
    }
    return {
      available,
      binary,
      liveSessions: this.#countLive(),
      activeTurns,
      conversations: this.conversations.size,
    }
  }

  /** Retire all idle conversations immediately (e.g. when switching back to Direct mode). */
  evictIdleSessions() {
    let evicted = 0
    for (const [key, conv] of [...this.conversations.entries()]) {
      if (conv.turn && !conv.turn.finished && !conv.turn.settled) continue
      if (conv.runner || conv.sessionId) evicted += 1
      this.#resetSession(conv)
      this.conversations.delete(key)
    }
    return evicted
  }

  /** Sweep idle conversations based on role-tiered TTLs and memory pressure. */
  sweep(now = Date.now()) {
    const lowMem = freemem() < LOW_MEMORY_BYTES
    const mainTtl = lowMem ? Math.min(this.host.idleSessionTtlMs ?? DEFAULT_IDLE_SESSION_TTL_MS, LOW_MEMORY_IDLE_TTL_MS) : (this.host.idleSessionTtlMs ?? DEFAULT_IDLE_SESSION_TTL_MS)
    const subTtl = this.host.subagentSessionTtlMs ?? DEFAULT_SUBAGENT_SESSION_TTL_MS

    for (const [key, conv] of [...this.conversations.entries()]) {
      if (conv.turn && !conv.turn.finished && !conv.turn.settled) continue
      const ttl = conv.isAuxiliary ? 0 : conv.isSubagent ? subTtl : mainTtl
      if (now - conv.lastUsed >= ttl) {
        this.#resetSession(conv)
        this.conversations.delete(key)
      }
    }
    rebalanceGlobalResidents(this.host.globalSoftLimit ?? DEFAULT_GLOBAL_ACP_RESIDENT_SOFT_LIMIT)
  }

  /** Dispose runtime, retire every runner, close MCP bridge, and unregister coordinator. */
  async dispose() {
    this.disposed = true
    clearInterval(this.sweeper)
    this.unregisterCoordinator?.()
    this.requestSlots.dispose()
    this.residentSlots.dispose()
    for (const conv of this.conversations.values()) {
      conv.turn?.abandon('The Mistral ACP pool was unloaded.')
      this.#resetSession(conv)
    }
    this.conversations.clear()
    this.tenants.clear()
    for (const waiter of this.mcpListWaiters.values()) waiter.resolve(false)
    this.mcpListWaiters.clear()
    await Promise.allSettled([...this.retirements])
    await this.bridge.close()
  }

  /** Stream one DSH `LlmRuntime` call through `vibe-acp`. */
  async * stream(options) {
    const signal = options.signal
    const aborted = () => signal?.aborted === true
    if (aborted()) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
      return
    }

    const declaredPurpose = typeof options.purpose === 'string' && options.purpose.length > 0 ? options.purpose : 'main'
    const isAuxiliary = declaredPurpose !== 'main' || !options.sessionId
    const isSubagent = Boolean(!isAuxiliary && options.sessionId && this.host.isSubagentSession?.(options.sessionId))
    const convKey = isAuxiliary
      ? `aux|${options.sessionId ?? randomBytes(6).toString('hex')}|${declaredPurpose}|${randomBytes(4).toString('hex')}`
      : `${options.sessionId}|${declaredPurpose}`

    let releaseKey
    let releaseRequest
    let conv
    try {
      releaseKey = await this.mutex.acquire(convKey, this.host.maxIdleMs ?? DEFAULT_MAX_IDLE_MS, signal)
      if (aborted()) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
        return
      }
      if (!await this.requestSlots.acquire(this.host.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS, signal)) {
        if (aborted() || this.disposed) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
          return
        }
        throw new AcpError('Mistral ACP request concurrency limit reached.', 'MAX_SESSIONS')
      }
      releaseRequest = () => this.requestSlots.release()

      if (!this.bridge.listening) await this.bridge.start()
      conv = this.conversations.get(convKey)
      if (!conv) {
        conv = {
          key: convKey,
          tag: randomBytes(6).toString('hex'),
          dshSessionId: options.sessionId,
          purpose: declaredPurpose,
          isAuxiliary,
          isSubagent,
          runner: undefined,
          sessionId: undefined,
          tenantKey: undefined,
          serverName: undefined,
          fingerprint: undefined,
          activeTools: [],
          toolNames: new Set(),
          knownIds: undefined,
          knownDigests: undefined,
          issuedIds: new Set(),
          toolCalls: new Map(),
          turn: undefined,
          turnGeneration: 0,
          keyRecord: undefined,
          model: undefined,
          effort: undefined,
          lastUsed: Date.now(),
        }
        this.conversations.set(convKey, conv)
      }
      conv.lastUsed = Date.now()

      const split = splitSystem(options)
      const tools = toBridgeTools(options.tools)
      conv.activeTools = tools
      conv.toolNames = new Set(tools.map((t) => t.name))

      const modelEntry = this.host.getModelEntry?.(options.model)
      const modelSpec = resolveModelSpec(options.model, modelEntry)
      const effort = resolveVibeEffort(options.reasoningEffort, modelSpec.thinkingLevels)
      const countQuantum = Number.isSafeInteger(this.host.imageOffloadCountQuantum) && this.host.imageOffloadCountQuantum > 0
        ? this.host.imageOffloadCountQuantum
        : DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM

      if (modelSpec.supportsImages) {
        const offloadImages = requiredOffloadForRoles(
          split.messages,
          { maxImages: modelSpec.maxRequestImages, countQuantum },
          { sentRoles: ['user', 'tool'] },
        )
        if (offloadImages > 0) {
          if (conv.turn) {
            this.#dropTurn(conv, 'Image budget exceeded; offloading oldest images.')
          }
          throw new AcpError(
            `Mistral ACP request images exceed the limit of ${modelSpec.maxRequestImages}; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
            IMAGE_OFFLOAD_REQUIRED_CODE,
            { offloadImages },
          )
        }
      }

      // Path 1: Resume a parked turn waiting on DSH tool execution.
      if (conv.turn && conv.turn.pendingCalls.size > 0) {
        const sameFingerprint = conv.fingerprint === this.#fingerprint(split.system, tools, options.model, effort)
        const alive = Boolean(conv.sessionId && conv.runner?.alive)
        if (sameFingerprint && alive && historyPrefixIntact(conv, split.messages)) {
          const delivered = await this.#deliverResults(conv, split.messages, modelSpec.supportsImages)
          if (delivered) {
            conv.knownIds = messageIds(split.messages)
            conv.knownDigests = split.messages.map(digestMessage)
            const activeTurn = conv.turn
            try {
              yield* this.#pump(conv, options, signal)
              return
            } catch (error) {
              if (aborted()) {
                conv.turn = undefined
                this.#resetSession(conv)
                yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
                return
              }
              const offloadErr = this.#maybeImageOffloadError(error, activeTurn, split.messages, modelSpec)
              if (offloadErr) {
                conv.turn = undefined
                this.#resetSession(conv)
                throw offloadErr
              }
              const mapped = mapAcpError(error)
              conv.turn = undefined
              this.#resetSession(conv)
              throw mapped
            }
          }
        }
        this.#dropTurn(conv, 'Conversation or configuration changed while tool was pending; rebuilding ACP session.')
      } else if (conv.turn) {
        this.#dropTurn(conv, 'Superseded by newer request.')
      }

      // Path 2: New prompt (or incremental turn on an existing idle session) with pre-output failover.
      let attempt = 0
      while (attempt < MAX_KEY_ATTEMPTS) {
        attempt += 1
        if (aborted()) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
          return
        }
        const affinity = conv.dshSessionId ? `h:${conv.dshSessionId}` : `p:${conv.tag}`
        if (!conv.keyRecord || conv.keyRecord.status !== 'active') {
          this.#resetSession(conv)
        }
        const selectedKey = (conv.keyRecord && conv.keyRecord.status === 'active')
          ? conv.keyRecord
          : await this.host.selectVibeKey(affinity)
        if (!selectedKey) {
          throw new AcpError('dsh-mistral-pool (ACP): 没有可用的 $300 Vibe Key（可用 key 已耗尽或停用）。', 'QUOTA', { status: 402 })
        }

        const fingerprint = this.#fingerprint(split.system, tools, options.model, effort)
        const plan = this.#planPrompt(conv, fingerprint, split.messages, selectedKey.id, options.provider)

        if (plan.rebuild) {
          this.#resetSession(conv)
          conv.keyRecord = selectedKey
          conv.model = options.model
          conv.effort = effort
          conv.fingerprint = fingerprint
          await this.#openSession(conv, options.model, effort, tools, selectedKey, signal)
        }

        const blocks = plan.rebuild
          ? await buildReplayPrompt({
              system: split.system,
              tools,
              serverName: conv.serverName,
              history: plan.history,
              input: plan.input,
              supportsImages: modelSpec.supportsImages,
              resolveImage: this.host.resolveImage,
              resolveFilePath: this.host.resolveFilePath,
              resolveImagePath: this.host.resolveImagePath,
            })
          : await toPromptBlocks(plan.input, modelSpec.supportsImages, this.host.resolveImage, this.host.resolveFilePath, this.host.resolveImagePath)
        const promptBlocks = blocks.length > 0 ? blocks : [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }]

        conv.knownIds = messageIds(split.messages)
        conv.knownDigests = split.messages.map(digestMessage)
        conv.toolCalls.clear()
        const turn = new AcpTurn(conv.tag, ++conv.turnGeneration)
        conv.turn = turn
        this.#startPrompt(conv, turn, promptBlocks)

        try {
          yield* this.#pump(conv, options, signal)
          return
        } catch (error) {
          if (aborted()) {
            conv.turn = undefined
            this.#resetSession(conv)
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
            return
          }
          if (!turn.produced && isAcpKeyExhausted(error) && attempt < MAX_KEY_ATTEMPTS) {
            const msg = error instanceof Error ? error.message : String(error)
            this.host.log?.warn?.(`mistral-pool (ACP): key ${selectedKey.id} exhausted (${msg.slice(0, 160)}); rotating`)
            await this.host.exhaustKey(selectedKey, msg)
            conv.turn = undefined
            this.#resetSession(conv)
            continue
          }
          const offloadErr = this.#maybeImageOffloadError(error, turn, split.messages, modelSpec)
          if (offloadErr) {
            conv.turn = undefined
            this.#resetSession(conv)
            throw offloadErr
          }
          const mapped = mapAcpError(error)
          if (isAcpKeyExhausted(error)) {
            await this.host.exhaustKey(selectedKey, mapped.message)
          }
          conv.turn = undefined
          this.#resetSession(conv)
          throw mapped
        }
      }
    } catch (error) {
      const reason = toFailure(error, signal)
      yield { type: 'finish', reason }
    } finally {
      releaseRequest?.()
      releaseKey?.()
      if (conv) {
        conv.lastUsed = Date.now()
        if (conv.isAuxiliary && (!conv.turn || conv.turn.finished || conv.turn.settled)) {
          this.#resetSession(conv)
          this.conversations.delete(convKey)
        }
      }
    }
  }

  #maybeImageOffloadError(error, turn, messages, modelSpec) {
    if (!modelSpec?.supportsImages || turn?.produced) return null
    if (error instanceof JsonRpcRemoteError && error.rpc.code === -31007) return null
    const rawMsg = error instanceof JsonRpcRemoteError
      ? String(error.rpc.message || '')
      : (error instanceof Error ? error.message : String(error ?? ''))
    let rawData = ''
    if (error instanceof JsonRpcRemoteError && error.rpc?.data !== undefined) {
      try {
        rawData = typeof error.rpc.data === 'string' ? error.rpc.data : JSON.stringify(error.rpc.data)
      } catch {
        rawData = ''
      }
    }
    const retainedCount = countRetainedImages(messages, { roles: ['user', 'tool'] })
    if (!isImageLimitUpstreamError({ message: rawMsg, bodyText: rawData, sentImageCount: retainedCount })) {
      return null
    }
    const countQuantum = Number.isSafeInteger(this.host.imageOffloadCountQuantum) && this.host.imageOffloadCountQuantum > 0
      ? this.host.imageOffloadCountQuantum
      : DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM
    const offloadImages = reactiveImageOffloadCount(messages, {
      sentRoles: ['user', 'tool'],
      errorText: `${rawMsg}\n${rawData}`,
      countQuantum,
    })
    if (offloadImages <= 0) return null
    return new AcpError(
      `Mistral ACP upstream rejected request images (${rawMsg.slice(0, 180)}); ${offloadImages} oldest image(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { status: 400, offloadImages },
    )
  }

  #fingerprint(system, tools, model, effort) {
    return digestValue({ system, tools, model, effort })
  }

  #isOwnMessage(conv, message, provider = 'mistral') {
    if (!message) return false
    if (message.role === 'assistant') {
      return message.source?.kind === 'model' && message.source?.provider === provider
    }
    if (message.role === 'tool') {
      return conv.issuedIds.has(message.toolCallId)
    }
    return false
  }

  #planPrompt(conv, fingerprint, messages, keyId, provider) {
    const reusable = Boolean(
      !conv.isAuxiliary
      && conv.sessionId
      && conv.runner?.alive
      && conv.keyRecord?.id === keyId
      && conv.fingerprint === fingerprint
      && historyPrefixIntact(conv, messages),
    )
    if (reusable) {
      let rest = messages.slice(conv.knownDigests.length)
      let skip = 0
      while (skip < rest.length && this.#isOwnMessage(conv, rest[skip], provider)) skip += 1
      rest = rest.slice(skip)
      if (rest.length > 0 && rest.every((m) => m?.role === 'user' || m?.role === 'developer' || m?.role === 'system')) {
        return { rebuild: false, history: [], input: rest }
      }
    }
    return { rebuild: true, ...trailingSplit(messages) }
  }

  #countLive() {
    let n = 0
    for (const conv of this.conversations.values()) {
      if (conv.runner?.alive) n += 1
    }
    return n
  }

  #oldestIdleAt() {
    let oldest
    for (const conv of this.conversations.values()) {
      if (!conv.runner?.alive) continue
      if (conv.turn && !conv.turn.finished && !conv.turn.settled) continue
      if (oldest === undefined || conv.lastUsed < oldest) oldest = conv.lastUsed
    }
    return oldest
  }

  #evictOldestIdle() {
    let best
    for (const conv of this.conversations.values()) {
      if (!conv.runner?.alive) continue
      if (conv.turn && !conv.turn.finished && !conv.turn.settled) continue
      if (!best || conv.lastUsed < best.lastUsed) best = conv
    }
    if (!best) return false
    this.#resetSession(best)
    this.conversations.delete(best.key)
    return true
  }

  async #openSession(conv, modelId, effort, tools, keyRecord, signal) {
    if (!await this.residentSlots.acquire(this.host.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS, signal)) {
      throw new AcpError('Mistral ACP resident session limit reached.', 'MAX_SESSIONS')
    }
    let permitHeld = true
    try {
      const binary = this.resolveCommand(this.host.getVibeCommand?.() ?? '')
      const runnerDir = join(this.runnersRoot, `${conv.tag}-${randomBytes(3).toString('hex')}`)
      const vibeHome = join(runnerDir, 'vibe_home')
      const workDir = join(runnerDir, 'work')
      mkdirSync(workDir, { recursive: true })

      const serverName = `dsh_${randomBytes(4).toString('hex')}`
      const tenantKey = randomBytes(12).toString('hex')
      const secret = this.bridge.mountSession(tenantKey)
      conv.serverName = serverName
      conv.tenantKey = tenantKey
      this.tenants.set(tenantKey, conv)

      prepareRunnerVibeHome({
        vibeHome,
        upstream: this.host.getUpstream(),
        modelId,
        effort,
        serverName: tools.length > 0 ? serverName : '',
        sourceVibeHome: this.host.sourceVibeHome,
      })

      const env = buildVibeChildEnv({ vibeHome, apiKey: keyRecord.key })
      const runner = this.#spawnRunner(binary, workDir, runnerDir, env, conv)
      conv.runner = runner
      permitHeld = false

      rebalanceGlobalResidents(this.host.globalSoftLimit ?? DEFAULT_GLOBAL_ACP_RESIDENT_SOFT_LIMIT)

      await runner.peer.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'zed', version: '0.1.0' },
        },
        { signal, timeoutMs: 20_000 },
      )

      const mcpWaiter = tools.length > 0 ? deferred() : undefined
      if (mcpWaiter) this.mcpListWaiters.set(tenantKey, mcpWaiter)

      const mcpServers = tools.length > 0
        ? [{
            type: 'http',
            name: serverName,
            url: `${this.bridge.url}/${tenantKey}`,
            headers: [{ name: 'Authorization', value: `Bearer ${secret}` }],
          }]
        : []

      const created = await runner.peer.request(
        'session/new',
        { cwd: workDir, mcpServers },
        { signal, timeoutMs: 25_000 },
      )
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new AcpError('vibe-acp session/new returned no sessionId', 'PROVIDER_ERROR')
      }
      conv.sessionId = sessionId

      if (mcpWaiter) {
        await Promise.race([
          mcpWaiter.promise,
          delay(this.host.mcpWarmupWaitMs ?? DEFAULT_MCP_WARMUP_WAIT_MS, signal),
        ])
        this.mcpListWaiters.delete(tenantKey)
      }
    } catch (error) {
      if (permitHeld) this.residentSlots.release()
      this.#resetSession(conv)
      throw error
    }
  }

  #spawnRunner(binary, cwd, runnerDir, env, conv) {
    const graceMs = this.host.retireGraceMs ?? DEFAULT_RETIRE_GRACE_MS
    let pid
    let stdin
    let stdout
    let exited
    let terminateFn
    let stderrTailFn

    const sp = typeof this.host.getSubprocess === 'function' ? this.host.getSubprocess() : undefined
    if (typeof this.host.spawnSubprocess === 'function' || typeof sp?.spawn === 'function') {
      const handle = typeof this.host.spawnSubprocess === 'function'
        ? this.host.spawnSubprocess({ argv: [binary], cwd, env, graceMs })
        : sp.spawn({
            argv: [binary],
            cwd,
            env,
            graceMs,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
          })
      stdin = handle.stdin
      stdout = handle.stdout
      pid = handle.pid
      exited = handle.done.then(
        (outcome) => ({ code: outcome?.exitCode ?? null, signal: outcome?.signal ?? null }),
        (error) => ({ code: null, signal: error instanceof Error ? error.message : String(error) }),
      )
      terminateFn = () => handle.terminate()
      stderrTailFn = () => handle.collected?.stderr?.readFrom?.(0)?.text ?? ''
    } else {
      const child = spawnNodeChild(binary, [], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      stdin = child.stdin
      stdout = child.stdout
      pid = child.pid
      let stderrBuf = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk).slice(-8192)
      })
      exited = new Promise((resolve) => {
        child.once('exit', (code, sig) => resolve({ code, signal: sig }))
        child.once('error', (err) => resolve({ code: null, signal: err.message }))
      })
      terminateFn = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        try { child.kill('SIGTERM') } catch { /* gone */ }
        const settled = await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)])
        if (!settled) {
          try { child.kill('SIGKILL') } catch { /* gone */ }
          await Promise.race([exited, delay(this.host.retireFinalWaitMs ?? DEFAULT_RETIRE_FINAL_WAIT_MS)])
        }
      }
      stderrTailFn = () => stderrBuf
    }

    if (typeof pid === 'number' && pid > 1) {
      this.livePids.set(pid, { pid, cmd: binary, runnerDir })
      writeLivePidsFile(this.livePidsFile, [...this.livePids.values()])
    }

    const runner = {
      alive: true,
      released: false,
      retiring: false,
      runnerDir,
      pid,
      peer: undefined,
      exited,
      terminate: terminateFn,
      stderrTail: stderrTailFn,
    }

    runner.peer = new JsonRpcPeer(stdout, stdin, {
      onNotification: (method, params) => {
        if (method === 'session/update' && conv.turn) {
          conv.turn.onUpdate(params?.update)
        }
      },
      onRequest: (method, params) => {
        if (method === 'session/request_permission') {
          return this.#handlePermission(conv, params)
        }
        throw new JsonRpcRemoteError(method, { code: -32601, message: `Method not found: ${method}` })
      },
      onClose: (err) => {
        runner.alive = false
        if (conv.turn && !conv.turn.finished && !conv.turn.settled) {
          const tail = runner.stderrTail?.()
          const detail = tail ? `${err.message} (${tail.slice(-300).trim()})` : err.message
          conv.turn.events.push({ kind: 'error', error: new JsonRpcClosedError(detail) })
        }
      },
    })

    exited.finally(() => {
      runner.alive = false
      if (typeof pid === 'number') {
        this.livePids.delete(pid)
        writeLivePidsFile(this.livePidsFile, [...this.livePids.values()])
      }
      if (!runner.released) {
        runner.released = true
        this.residentSlots.release()
      }
      removeRunnerDir(runnerDir)
    })

    return runner
  }

  #handlePermission(conv, params) {
    const options = Array.isArray(params?.options) ? params.options : []
    const allowOption = options.find((o) => o?.kind === 'allow_once' || o?.optionId === 'allow_once')
      ?? options.find((o) => o?.kind === 'allow_always')
    const rejectOption = options.find((o) => o?.kind === 'reject_once' || o?.optionId === 'reject_once')
      ?? options.find((o) => String(o?.kind ?? '').startsWith('reject'))

    const toolCall = params?.toolCall ?? {}
    const title = String(toolCall.title ?? '')
    const rawName = String(toolCall._meta?.toolName ?? toolCall.name ?? '')
    const prefix = conv.serverName ? `${conv.serverName}_` : ''
    const groupPrefix = conv.serverName ? `${vibeGroupName(conv.serverName)}` : ''
    const allowed = Boolean(
      rawName === 'run_typescript'
      || rawName === 'search_tool_functions'
      || (prefix && rawName.startsWith(prefix))
      || (groupPrefix && (rawName.includes(groupPrefix) || title.includes(groupPrefix)))
      || (conv.turn && conv.turn.pendingCalls.size > 0),
    )

    if (allowed && allowOption) {
      return { outcome: { outcome: 'selected', optionId: allowOption.optionId } }
    }
    if (rejectOption) {
      return { outcome: { outcome: 'selected', optionId: rejectOption.optionId } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }

  #startPrompt(conv, turn, blocks) {
    const runner = conv.runner
    const sessionId = conv.sessionId
    void runner.peer
      .request('session/prompt', { sessionId, prompt: blocks })
      .then(
        (result) => {
          turn.settled = true
          if (result?.usage) {
            turn.recordUsageSnapshot({
              prompt: result.usage.inputTokens,
              output: result.usage.outputTokens,
              cached: result.usage.cachedReadTokens,
            })
          }
          turn.events.push({ kind: 'done', result: result ?? { stopReason: 'end_turn' } })
        },
        (error) => {
          turn.settled = true
          turn.events.push({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) })
        },
      )
  }

  async #deliverResults(conv, messages, supportsImages) {
    const turn = conv.turn
    const pending = turn.pendingCalls
    if (pending.size === 0 || messages.length < pending.size) return false
    const trailing = messages.slice(-pending.size)
    if (!trailing.every((m) => m?.role === 'tool' && pending.has(m.toolCallId))) return false
    for (const msg of trailing) {
      const call = pending.get(msg.toolCallId)
      pending.delete(msg.toolCallId)
      const result = await formatToolResult(msg, supportsImages, this.host.resolveImage, this.host.resolveFilePath, this.host.resolveImagePath)
      call.result.resolve(result)
    }
    return true
  }

  #dropTurn(conv, reason) {
    if (!conv.turn) return
    conv.turn.abandon(reason)
    conv.turn = undefined
    this.#resetSession(conv)
  }

  #resetSession(conv) {
    if (conv.tenantKey) {
      this.bridge.revokeSession(conv.tenantKey)
      this.tenants.delete(conv.tenantKey)
      const waiter = this.mcpListWaiters.get(conv.tenantKey)
      if (waiter) {
        this.mcpListWaiters.delete(conv.tenantKey)
        waiter.resolve(false)
      }
      conv.tenantKey = undefined
    }
    const runner = conv.runner
    const sessionId = conv.sessionId
    conv.runner = undefined
    conv.sessionId = undefined
    conv.serverName = undefined
    conv.fingerprint = undefined
    conv.knownIds = undefined
    conv.knownDigests = undefined
    conv.issuedIds.clear()
    conv.keyRecord = undefined
    conv.model = undefined
    conv.effort = undefined
    if (runner) this.#retireRunner(runner, sessionId)
  }

  #retireRunner(runner, sessionId) {
    if (runner.retiring) return
    runner.retiring = true
    const job = (async () => {
      try {
        if (sessionId && runner.alive && !runner.peer.isClosed) {
          await Promise.race([
            runner.peer.request('session/close', { sessionId }, { timeoutMs: 1_500 }).catch(() => undefined),
            delay(1_500),
          ])
        }
      } finally {
        runner.peer.close(new JsonRpcClosedError('ACP runner retired'))
        await runner.terminate()
      }
    })()
    this.retirements.add(job)
    job.finally(() => this.retirements.delete(job))
  }

  #listTools(tenantKey) {
    const conv = this.tenants.get(tenantKey)
    if (!conv) return []
    const tools = [...conv.activeTools]
    if (tools.length > 0 && !tools.some((t) => t.name === AWAIT_TOOL_NAME)) {
      tools.push({
        name: AWAIT_TOOL_NAME,
        description: 'Await the result of an in-progress DSH tool call after receiving a [DSH_RELAY] notice.',
        inputSchema: {
          type: 'object',
          properties: { call_id: { type: 'string', description: 'The call_id from the [DSH_RELAY] message.' } },
          required: ['call_id'],
        },
      })
    }
    return tools
  }

  async #callTool({ tenantKey, name, arguments: args, signal }) {
    const conv = this.tenants.get(tenantKey)
    const turn = conv?.turn
    if (!conv || !turn || turn.finished || turn.settled) {
      return { content: [{ type: 'text', text: 'The DSH turn is no longer active.' }], isError: true }
    }

    const relayMs = this.host.relayAfterMs ?? DEFAULT_RELAY_AFTER_MS
    let call
    if (name === AWAIT_TOOL_NAME) {
      const callId = typeof args?.call_id === 'string' ? args.call_id : ''
      call = turn.calls.get(callId)
      if (!call) {
        return {
          content: [{ type: 'text', text: `Unknown call_id "${callId}". Do not fabricate call IDs.` }],
          isError: true,
        }
      }
    } else {
      if (!conv.toolNames.has(name)) {
        return { content: [{ type: 'text', text: `Unknown DSH tool "${name}".` }], isError: true }
      }
      call = turn.park(name, args)
    }

    const settled = await Promise.race([
      call.result.promise.then((res) => ({ kind: 'result', res })),
      delay(relayMs, signal).then((ok) => ({ kind: ok ? 'relay' : 'aborted' })),
    ])

    if (settled.kind === 'result') return settled.res
    if (settled.kind === 'aborted') {
      return { content: [{ type: 'text', text: 'Tool call aborted by ACP disconnect.' }], isError: true }
    }

    const group = vibeGroupName(conv.serverName || 'dsh')
    return {
      content: [{
        type: 'text',
        text: `[DSH_RELAY] Tool "${call.name}" (call_id: "${call.id}") is still executing in DSH. Do NOT invoke "${call.name}" again. Immediately call \`await tools.${group}.${AWAIT_TOOL_NAME}({ call_id: "${call.id}" })\` to wait for its result.`,
      }],
      isError: false,
    }
  }

  async * #pump(conv, options, signal) {
    const turn = conv.turn
    const maxIdleMs = this.host.maxIdleMs ?? DEFAULT_MAX_IDLE_MS
    const parkSettleMs = this.host.parkSettleMs ?? DEFAULT_PARK_SETTLE_MS
    let index = 0
    let open

    const closeBlock = function* () {
      if (!open) return
      const block = open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text }
      yield { type: 'block-end', index: open.index, block }
      open = undefined
    }
    const appendBlock = function* (type, text) {
      if (open?.type !== type) {
        yield* closeBlock()
        open = { index: index++, type, text: '' }
        yield { type: 'block-start', index: open.index, blockType: type }
      }
      open.text += text
      yield type === 'text'
        ? { type: 'text-delta', index: open.index, text }
        : { type: 'reasoning-delta', index: open.index, text }
    }
    const emitStepUsage = function* (host, keyRecord, model) {
      const delta = turn.consumeUsageDelta()
      if (!delta) return
      if (keyRecord) {
        host.recordUsage(keyRecord, model, {
          input: delta.totalInput,
          output: delta.output,
          cached: delta.cached,
        })
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: delta.uncachedInput,
          outputTokens: delta.output,
          ...(delta.totalInput > 0 || delta.cached > 0 ? { cacheReadTokens: delta.cached } : {}),
        },
      }
    }

    for (;;) {
      const ready = await turn.events.wait(signal, maxIdleMs)
      if (!ready) {
        if (signal?.aborted) {
          if (conv.sessionId && conv.runner?.alive) {
            conv.runner.peer.notify('session/cancel', { sessionId: conv.sessionId })
          }
          turn.abandon('Request aborted by DSH.')
          yield* closeBlock()
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
          this.#resetSession(conv)
          conv.turn = undefined
          return
        }
        turn.abandon('Timed out waiting for Vibe ACP progress.')
        this.#resetSession(conv)
        conv.turn = undefined
        throw new AcpError(`Vibe ACP timed out after ${maxIdleMs}ms without progress`, 'TIMEOUT')
      }

      const event = turn.events.shift()
      switch (event.kind) {
        case 'thought':
          turn.produced = true
          yield* appendBlock('reasoning', event.text)
          break
        case 'text':
          turn.produced = true
          yield* appendBlock('text', event.text)
          break
        case 'park': {
          turn.produced = true
          yield* closeBlock()
          const batch = [event.call]
          while (await turn.events.wait(signal, parkSettleMs)) {
            const next = turn.events.peek()
            if (next?.kind !== 'park') break
            turn.events.shift()
            batch.push(next.call)
          }
          for (const call of batch) {
            const blockIndex = index++
            turn.pendingCalls.set(call.id, call)
            conv.issuedIds.add(call.id)
            yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: blockIndex, id: call.id, name: call.name, argumentsDelta: call.argumentsJson }
            yield {
              type: 'block-end',
              index: blockIndex,
              block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.argumentsJson },
            }
          }
          yield* emitStepUsage(this.host, conv.keyRecord, options.model)
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        case 'done': {
          turn.finished = true
          yield* closeBlock()
          const stop = event.result?.stopReason ?? 'end_turn'
          if (stop === 'end_turn' && !turn.produced) {
            throw new AcpError('Mistral Vibe ACP ended turn without output', 'EMPTY_RESPONSE')
          }
          yield* emitStepUsage(this.host, conv.keyRecord, options.model)
          if (stop === 'end_turn') {
            yield { type: 'finish', reason: { kind: 'stop' } }
          } else if (stop === 'max_tokens') {
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
          } else if (stop === 'cancelled') {
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Vibe ACP cancelled the turn', code: 'ABORTED' } } }
          } else if (stop === 'refusal') {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Mistral Vibe refused the request', code: 'REFUSAL' } } }
          } else {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: `Vibe ACP stopped: ${stop}`, code: 'PROVIDER_ERROR' } } }
          }
          conv.turn = undefined
          return
        }
        case 'error':
          turn.finished = true
          yield* closeBlock()
          throw event.error
      }
    }
  }
}
