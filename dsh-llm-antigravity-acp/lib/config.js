/**
 * Plugin configuration. Fields marked volatile are live settings: the Web
 * settings surface edits them through the profile patch and the next request
 * reads the new value without restarting the plugin.
 * @module dsh-llm-antigravity-acp/config
 */
import z from '@deepseek-ai/schemastery';
/** Reasoning effort ids accepted by the Antigravity ACP `thought_level` option. */
export const EFFORTS = ['low', 'medium', 'high'];
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
export const DEGRADE_ACTIONS = ['observe', 'truncation', 'legacy'];
/**
 * How the plugin runs the Antigravity ACP agent:
 * - `bridge`: launch `agy acp --agent dsh-bridge`, disabling built-in tools and
 *   identity so DSH owns the system prompt and every tool call.
 * - `native`: launch `agy acp` with its native identity and built-in workspace
 *   tools (`read_file`, `edit_file`, `write_file`, `run_command`, etc.) in the
 *   session working directory, exposing non-overlapping DSH tools on MCP.
 */
export const ENGINE_MODES = ['bridge', 'native'];
function maybeVolatile(schema) {
    const candidate = schema;
    return typeof candidate.volatile === 'function' ? candidate.volatile() : schema;
}
/** Configuration schema. */
export const Config = z.object({
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
});
/**
 * Read the current value of one possibly-volatile field.
 * @param value - plain value or volatile reference.
 * @returns the current value.
 */
export function current(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/**
 * Narrow an arbitrary effort id to an Antigravity effort.
 * @param value - requested effort id.
 * @returns the effort, or undefined when Antigravity does not offer it.
 */
export function asEffort(value) {
    return EFFORTS.includes(value ?? '') ? value : undefined;
}
/**
 * Narrow an arbitrary id to a route-health intervention level.
 * @param value - requested level id.
 * @returns the level, or undefined when it is not one of {@link DEGRADE_ACTIONS}.
 */
export function asDegradeAction(value) {
    return typeof value === 'string' && DEGRADE_ACTIONS.includes(value) ? value : undefined;
}
/**
 * Narrow an arbitrary id to an Antigravity ACP engine mode.
 * @param value - requested engine mode id.
 * @returns the engine mode, or undefined when it is not one of {@link ENGINE_MODES}.
 */
export function asEngineMode(value) {
    return typeof value === 'string' && ENGINE_MODES.includes(value) ? value : undefined;
}
