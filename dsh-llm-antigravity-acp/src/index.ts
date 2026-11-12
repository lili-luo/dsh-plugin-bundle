/**
 * DeepSeek Harness primary-model provider for Google Antigravity.
 *
 * The plugin drives the locally installed, signed-in official CLI through its
 * Agent Client Protocol server (`agy acp`), exposes DSH tools to the agent
 * through a loopback MCP bridge, and registers the `antigravity` route with
 * the LLM service so Gemini and Claude models appear in the model picker
 * beside every other provider.
 * @module dsh-llm-antigravity-acp
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { accountVisibleModels } from './accounts.ts'
import { AntigravityAdapter } from './adapter.ts'
import type { AcpSpawner } from './acp-process.ts'
import { FALLBACK_MODELS } from './catalog.ts'
import { Config, current, type AccountProfile } from './config.ts'
import type { ImageResolver } from './history.ts'
import { CONFIG_VERSION, migrateConfig, normalizeAccounts, storedEqual, type MigrationResult } from './migrate.ts'
import type { CommandRunner } from './preflight.ts'
import { AntigravityRemote, registerRemote } from './remote.ts'
import { AntigravityRuntime } from './runtime.ts'

export { Config } from './config.ts'
export const name = 'llm-antigravity-acp'
export const inject = ['llm', 'subprocess']

/**
 * Read a configuration object as plain data, with every volatile field taken at
 * its current value, so the migration sees arrays and numbers instead of live
 * settings references.
 * @param config - validated configuration.
 * @returns a plain snapshot.
 */
function storedConfig(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) out[key] = current(value)
  return out
}

interface ImageStore {
  readImageRequest(ref: unknown, target: { width: number; height: number; maxBytes: number }, signal?: AbortSignal): Promise<{ data: Uint8Array; mediaType: string }>
}

const REQUEST_IMAGE_MAX_BYTES = 7 * 1024 * 1024

/** Settings surface the boot write-back needs; the card writes through the same one. */
interface SettingsWriter {
  writable?: boolean
  update?(ns: string, values: Record<string, unknown>): Promise<void>
}

/** What a boot write-back did. */
export type MigrationWriteOutcome = 'written' | 'skipped' | 'failed'

/** @param version - stored `configVersion`. @returns whether the file already declares the merged shape. */
function isCurrentShape(version: unknown): boolean {
  return typeof version === 'number' && Number.isFinite(version) && version >= CONFIG_VERSION
}

/**
 * Store the migrated configuration in the plugin's settings profile.
 *
 * Only the two volatile fields the migration touches are written, and only
 * when they still differ from what the profile holds, so a second start writes
 * nothing. A write that the host refuses stays in memory for this run: the
 * provider keeps working and the next start simply migrates again.
 * @param input.settings - settings service, when the host offers one.
 * @param input.namespace - plugin settings namespace, the one the card uses.
 * @param input.migrated - result of the boot migration.
 * @param input.accounts - account list the profile holds right now.
 * @param input.configVersion - `configVersion` the profile holds right now.
 * @param input.warn - logger for a write that could not be stored.
 * @returns whether the profile was written, skipped, or refused.
 */
export async function writeMigrationBack(input: {
  settings: SettingsWriter | undefined
  namespace: string
  migrated: MigrationResult
  accounts: unknown
  configVersion: unknown
  warn(message: string): void
}): Promise<MigrationWriteOutcome> {
  const { settings, migrated } = input
  if (!migrated.changed) return 'skipped'
  if (settings?.writable !== true || typeof settings.update !== 'function') return 'skipped'
  const values: Record<string, unknown> = {}
  if (Object.hasOwn(migrated.config, 'accounts') && !storedEqual(migrated.config.accounts, input.accounts)) {
    values.accounts = migrated.config.accounts
  }
  if (!storedEqual(migrated.config.configVersion, input.configVersion)) {
    values.configVersion = migrated.config.configVersion
  }
  if (Object.keys(values).length === 0) return 'skipped'
  try {
    await settings.update(input.namespace, values)
    return 'written'
  } catch (error) {
    input.warn(`antigravity-acp: could not store the migrated configuration: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}

/**
 * The account list as the runtime reads it.
 *
 * The stored setting stays a live reference, and this view normalizes it on
 * every read: a list edited in the settings page carries the merged shape at
 * once, and a file that already declares `configVersion` 2 never gets the
 * machine account it no longer lists.
 * @param config - validated configuration.
 * @param catalogIds - model ids the current catalog advertises.
 * @returns a view whose `get()` yields the normalized accounts.
 */
export function liveAccounts(
  config: Pick<Config, 'accounts' | 'configVersion' | 'visibleModels'>,
  catalogIds: readonly string[],
): { get(): AccountProfile[] } {
  return {
    get: () => normalizeAccounts(current(config.accounts), {
      modern: isCurrentShape(current(config.configVersion)),
      providerVisible: accountVisibleModels(current(config.visibleModels)),
      catalogIds,
    }) as unknown as AccountProfile[],
  }
}

/**
 * Plugin entry.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  const attachments = (): ImageStore | undefined => ctx.get('attachments') as ImageStore | undefined
  // Normalize the stored shape before anything reads it: the account list is
  // the only truth for the machine account, and an older file still carries the
  // retired `useSystemAccount` / `systemProfile` pair and per-account families.
  const catalogIds = FALLBACK_MODELS.map(model => model.id)
  const migrated = migrateConfig(storedConfig(config), catalogIds)
  for (const warning of migrated.warnings) ctx.logger.warn(warning)
  const runtimeConfig: Config = {
    ...(migrated.config as unknown as Config),
    // The account list travels as a live view, so the settings surface keeps
    // editing the same value the scheduler reads.
    accounts: liveAccounts(config, catalogIds) as unknown as AccountProfile[],
    // Live settings references must survive the migration: the settings card
    // writes them through the profile patch and the next read sees the change.
    contextWindow: config.contextWindow,
    defaultEffort: config.defaultEffort,
    longDecodeContinuations: config.longDecodeContinuations,
    visibleModels: config.visibleModels,
    degradeAction: config.degradeAction,
    engineMode: config.engineMode,
    displayName: config.displayName,
    modelDisplayNames: config.modelDisplayNames,
  }
  // Every account runs the CLI under its own `$HOME`, which is what keeps its
  // credential store separate; callers pass that overlay, and an omitted
  // overlay keeps the legacy behaviour of running under the real home.
  const systemEnv = { HOME: homedir() }

  const spawnAcp: AcpSpawner = (argv, cwd, env) => {
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
      graceMs: 5_000,
      env: env ?? systemEnv,
    })
    if (handle.stdin === undefined || handle.stdout === undefined) throw new Error('antigravity-acp: ACP process has no stdio pipes')
    return {
      stdin: handle.stdin,
      stdout: handle.stdout,
      exited: handle.done.then(
        outcome => ({ code: outcome.exitCode, signal: outcome.signal }),
        (error: unknown) => ({ code: null, signal: error instanceof Error ? error.message : String(error) }),
      ),
      terminate: () => handle.terminate(),
      stderrTail: () => handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  const runCommand: CommandRunner = async (argv, timeoutMs, env) => {
    const handle = subprocess.spawn({
      argv,
      cwd: homedir(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
      graceMs: 3_000,
      signal: AbortSignal.timeout(timeoutMs),
      env: { ...(env ?? systemEnv), PYTHONUTF8: '1' },
    })
    const outcome = await handle.done
    return {
      code: outcome.exitCode,
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  const readImage: ImageResolver = async (block) => {
    const store = attachments()
    if (store === undefined) return undefined
    const ref = block.attachment
    const image = await store.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: REQUEST_IMAGE_MAX_BYTES })
    return { data: Buffer.from(image.data).toString('base64'), mimeType: image.mediaType }
  }

  const runtime = new AntigravityRuntime({
    config: runtimeConfig,
    spawnAcp,
    runCommand,
    readImage,
    canReadImages: () => attachments() !== undefined,
    log: {
      info: message => ctx.logger.info(message),
      warn: message => ctx.logger.warn(message),
    },
    onModelsChanged: () => ctx.emit('llm/models-updated', config.provider),
  })

  const fiberEntry = (ctx.fiber as { entry?: { options?: { id?: string } } }).entry
  const settingsNs = fiberEntry?.options?.id ?? name
  const adapter = new AntigravityAdapter(runtime, runtime.displayName(), () => attachments() !== undefined)
  ctx.llm.registerConfigurableProviders([
    {
      provider: config.provider,
      displayName: runtime.displayName(),
      settingsNs,
      settingsPath: [],
      nativeAuth: { env: [], oauth: true },
    },
  ])
  ctx.llm.registerAdapter([config.provider], adapter)
  ctx.effect(() => () => {
    void runtime.dispose()
  }, 'antigravity-acp: runtime')

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as (SettingsWriter & { configure?: (opts: { auto: boolean }, fiber: unknown) => () => void }) | undefined
    if (typeof settings?.configure === 'function') {
      settingsCtx.effect(() => settings.configure!({ auto: false }, ctx.fiber), 'antigravity-acp: custom settings card')
    }
    // An older file keeps working from this start onwards either way; writing
    // the merged list back means the next start reads the new shape directly.
    void writeMigrationBack({
      settings,
      namespace: settingsNs,
      migrated,
      accounts: current(config.accounts),
      configVersion: current(config.configVersion),
      warn: message => ctx.logger.warn(message),
    })
  })

  registerRemote(ctx)
  ctx.plugin(AntigravityRemote, { runtime, settingsNs })

  if (config.warmup) {
    void runtime.warmup().catch((error: unknown) => {
      ctx.logger.warn(`antigravity-acp: warmup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
