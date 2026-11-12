/**
 * Plugin configuration. Fields marked volatile are live settings: the Web
 * settings surface edits them through the profile patch and the next request
 * reads the new value without restarting the plugin.
 * @module dsh-llm-antigravity-acp/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'] as const
/** One Antigravity reasoning effort. */
export type Effort = typeof EFFORTS[number]

/** One declared account of the pool. */
export interface AccountProfile {
  /** Directory key under the pool root. Empty asks the pool to assign one and save it back. */
  id: string
  /** Optional remark shown in the settings card. Empty shows as untitled. */
  displayName: string
  /** Absolute account root; empty uses `<plugin home>/accounts/<id>`. */
  home: string
  /** Disabled accounts keep their files and login but receive no traffic. */
  enabled: boolean
  /** Extra environment for this account's CLI processes, such as a dedicated `HTTPS_PROXY`. */
  env: Record<string, string>
  /** Context-window override in tokens. `0` follows the provider default. */
  contextWindow: number
  /**
   * Keep this machine's own login, `$HOME`, and keychain. Such an entry is
   * always enabled and its id defaults to `default`.
   */
  system?: boolean
  /**
   * Fine-grained subset of the provider's visible families. Empty inherits the
   * provider allowlist; the effective set is always
   * `provider ∩ account`, so this can only narrow what the provider offers.
   */
  visibleModels: string[]
  /** Scheduling priority (`1..999`, default `1`); smaller values take precedence (`1` beats `2`). */
  priority?: number
  /** Scheduling weight (`1..100`, default `1`); distributes load proportionally within the same priority tier. */
  weight?: number
}

/**
 * What the route-health fingerprint may do with a Gemini 4 flagship (Argon or
 * Carbon) step it flags:
 * - `observe`: record and display the verdict only; never refuse an answer or a tool call.
 * - `truncation`: refuse and re-answer only when the billed input was cut to the
 *   128K ceiling (`context_truncated`), the one signal that proves the model did
 *   not see the request; speed, cache-granularity, and shallow-thought signals
 *   are recorded only.
 * - `legacy`: refuse and re-answer on any degraded verdict (score >= 3), the
 *   behavior before 0.4.1.
 */
export const DEGRADE_ACTIONS = ['observe', 'truncation', 'legacy'] as const
/** One route-health intervention level. */
export type DegradeAction = typeof DEGRADE_ACTIONS[number]

/**
 * How the plugin runs the Antigravity ACP agent:
 * - `bridge`: launch `agy acp --agent dsh-bridge`, disabling built-in tools and
 *   identity so DSH owns the system prompt and every tool call.
 * - `native`: launch `agy acp` with its native identity and built-in workspace
 *   tools (`read_file`, `edit_file`, `write_file`, `run_command`, etc.) in the
 *   session working directory, exposing non-overlapping DSH tools on MCP.
 */
export const ENGINE_MODES = ['bridge', 'native'] as const
/** One Antigravity ACP agent engine mode. */
export type EngineMode = typeof ENGINE_MODES[number]

/** Validated plugin configuration. */
export interface Config {
  /** Provider route id shown in the model picker. */
  provider: string
  /** Presentation-only provider group alias; empty uses Antigravity. */
  displayName: Volatile<string>
  /** Presentation-only names keyed by canonical model id. */
  modelDisplayNames: Volatile<Record<string, string>>
  /** Absolute path of the `agy` executable; empty resolves `~/.local/bin/agy`, then `agy` on PATH. */
  command: string
  /** Isolated Antigravity home for ACP sessions; empty uses `$DSH_HOME/cache/antigravity-acp`. */
  home: string
  /**
   * Every account of the pool, the machine account included as the entry with
   * `system: true`. The list is the only truth: no entry means no machine
   * account.
   */
  accounts: AccountProfile[]
  /**
   * Shape version of the stored configuration, migrated at plugin load. `0`
   * means the stored file predates the account list and still needs migration.
   */
  configVersion: Volatile<number>
  /**
   * Model families offered in the picker, as a subset of what the CLI
   * advertises. Empty offers every advertised family.
   */
  visibleModels: string[]
  /** Declared context window in tokens; 0 selects 1,048,576 for an unlocked binary and 256,000 otherwise. */
  contextWindow: Volatile<number>
  /** Effort applied when a request carries none. */
  defaultEffort: Volatile<Effort>
  /** Check the binary with the local context-unlock script before starting ACP, and apply it when needed. */
  autoPatch: boolean
  /** Context-unlock script; empty uses `~/.gemini/antigravity/tools/agy-patch.py`. */
  patchScript: string
  /** Maximum concurrent ACP sessions kept alive across conversations, subagents, and auxiliary calls. */
  maxLiveSessions: number
  /** Idle time after which an inactive ACP session is closed. */
  idleSessionTtlMs: number
  /** Window that groups parallel tool calls into one DSH step. */
  parkSettleMs: number
  /** Settle delay in ms after a cold-session `session/set_config_option` switch before sending `session/prompt`. */
  coldSwitchSettleMs: number
  /** SSE keepalive interval for parked tool calls. */
  keepAliveMs: number
  /** Delay in ms before a parked tool call returns a still-running relay notice to refresh cache TTL before agy's 180s MCP deadline. */
  relayAfterMs: number
  /** Automatic continuations after an output-length stop (long decode). */
  longDecodeContinuations: Volatile<number>
  /** Start the ACP process and read the model catalog at plugin load. */
  warmup: boolean
  /** Minimum interval between quota refreshes through `agy -p /usage`. */
  quotaTtlMs: number
  /** Intervention level of the Gemini 4 flagship (Argon / Carbon) route-health fingerprint; see {@link DEGRADE_ACTIONS}. */
  degradeAction: Volatile<DegradeAction>
  /** Agent engine mode (`bridge` or `native`); see {@link ENGINE_MODES}. */
  engineMode: Volatile<EngineMode>
}

function maybeVolatile<T>(schema: T): T {
  const candidate = schema as { volatile?: () => T }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  provider: z.string().default('antigravity'),
  displayName: maybeVolatile(z.string().default('Antigravity')),
  modelDisplayNames: maybeVolatile(z.dict(z.string()).default({})),
  command: z.string().default(''),
  home: z.string().default(''),
  contextWindow: maybeVolatile(z.number().step(1).min(0).default(0)),
  accounts: maybeVolatile(z.array(z.object({
    id: z.string().default(''),
    displayName: z.string().default(''),
    home: z.string().default(''),
    enabled: z.boolean().default(true),
    env: z.dict(z.string()).default({}),
    contextWindow: z.number().step(1).min(0).max(1_048_576).default(0),
    system: z.boolean().default(false),
    visibleModels: z.array(z.string()).default([]),
    priority: z.number().step(1).min(1).max(999).default(1),
    weight: z.number().step(1).min(1).max(100).default(1),
  })).default([])),
  configVersion: maybeVolatile(z.number().step(1).min(0).default(0)),
  visibleModels: maybeVolatile(z.array(z.string()).default([])),
  defaultEffort: maybeVolatile(z.union(EFFORTS).default('high')),
  autoPatch: z.boolean().default(true),
  patchScript: z.string().default(''),
  maxLiveSessions: z.number().step(1).min(1).max(64).default(16),
  idleSessionTtlMs: z.number().step(1).min(10_000).default(30 * 60_000),
  parkSettleMs: z.number().step(1).min(0).max(5_000).default(250),
  coldSwitchSettleMs: z.number().step(1).min(0).max(2_000).default(80),
  keepAliveMs: z.number().step(1).min(1_000).default(15_000),
  relayAfterMs: z.number().step(1).min(5_000).max(165_000).default(85_000),
  longDecodeContinuations: maybeVolatile(z.number().step(1).min(0).max(16).default(3)),
  warmup: z.boolean().default(true),
  quotaTtlMs: z.number().step(1).min(5_000).default(120_000),
  degradeAction: maybeVolatile(z.union(DEGRADE_ACTIONS).default('truncation')),
  engineMode: maybeVolatile(z.union(ENGINE_MODES).default('bridge')),
  // The published schemastery declarations type `.volatile()` fields as plain values.
}) as unknown as z<Config>

/**
 * Read the current value of one possibly-volatile field.
 * @param value - plain value or volatile reference.
 * @returns the current value.
 */
export function current<T>(value: T | Volatile<T>): T {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

/**
 * Narrow an arbitrary effort id to an Antigravity effort.
 * @param value - requested effort id.
 * @returns the effort, or undefined when Antigravity does not offer it.
 */
export function asEffort(value: string | undefined): Effort | undefined {
  return (EFFORTS as readonly string[]).includes(value ?? '') ? value as Effort : undefined
}

/**
 * Narrow an arbitrary id to a route-health intervention level.
 * @param value - requested level id.
 * @returns the level, or undefined when it is not one of {@link DEGRADE_ACTIONS}.
 */
export function asDegradeAction(value: unknown): DegradeAction | undefined {
  return typeof value === 'string' && (DEGRADE_ACTIONS as readonly string[]).includes(value) ? value as DegradeAction : undefined
}

/**
 * Narrow an arbitrary id to an Antigravity ACP engine mode.
 * @param value - requested engine mode id.
 * @returns the engine mode, or undefined when it is not one of {@link ENGINE_MODES}.
 */
export function asEngineMode(value: unknown): EngineMode | undefined {
  return typeof value === 'string' && (ENGINE_MODES as readonly string[]).includes(value) ? value as EngineMode : undefined
}
