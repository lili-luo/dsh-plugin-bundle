/**
 * Per-conversation ACP session state and the turn pump that maps one ACP
 * prompt turn onto DSH model steps.
 *
 * An ACP prompt turn can span many model calls: the agent calls a DSH tool
 * through the MCP bridge, the call parks, and the pump ends the current DSH
 * step with `finish(tool-calls)`. DSH runs the tool through its own pipeline
 * and opens the next step with the result, which resolves the parked call and
 * resumes the same ACP turn. Parked calls that outlive the agent's MCP
 * deadline are relayed through the `dsh_await_result` tool.
 * @module dsh-llm-antigravity-acp/conversation
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AcpPromptResult, AcpSessionUpdate } from './acp-process.ts'
import type { BridgeTool, BridgeToolResult } from './mcp-bridge.ts'
import { AGENT_TOOL_PREFIX, CALL_TOOL_NAME, type NativeSandboxMode } from './history.ts'
import { labeled } from './labels.ts'
import type { StepUsageBatch, StepUsageSample } from './usage-db.ts'
import { AsyncQueue, deferred, type Deferred } from './util.ts'

export { CALL_TOOL_NAME }

/** Agent-side transport retry notice streamed as message text, e.g. `⚠ API error (attempt 1): …`. */
const AGENT_RETRY_NOTICE = /^\s*⚠\s*(?:Error:\s*)?API error \(attempt \d+\)/i
/** Prefix of `AGENT_RETRY_NOTICE` while its opening words arrive across chunks. */
const AGENT_RETRY_PREFIX = /^\s*⚠\s*(?:e(?:r(?:r(?:o(?:r:?)?)?)?)?\s*)?(?:a(?:p(?:i(?:\s+e(?:r(?:r(?:o(?:r(?:\s*\((?:a(?:t(?:t(?:e(?:m(?:p(?:t(?:\s*\d*)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?)?$/i
/** Lone warning prefix (`⚠` or `⚠ Error:`) before the notice body arrives. */
const WARNING_PREFIX = /^\s*⚠(?:\s*e(?:r(?:r(?:o(?:r:?)?)?)?)?)?\s*$/i
/** First sentence of the notice agy inserts when one generation hits its own output cap. */
const OUTPUT_LIMIT_HEAD = 'your previous response was cut off because it exceeded the output token limit'
/** Second sentence of that same notice. */
const OUTPUT_LIMIT_TAIL = 'please continue from where you left off, keeping your response shorter'
/** Terminal step error agy streams as message text when upstream connection attempts fail. */
const NETWORK_ISSUE_MESSAGE = 'There was a network issue connecting to the server, please try again.'
const NETWORK_ISSUE_HEAD = 'there was a network issue connecting to the server, please try again'
/** Terminal step error agy streams as message text when upstream rejects the turn for high traffic. */
const HIGH_TRAFFIC_MESSAGE = 'Our servers are experiencing high traffic right now, please try again in a minute.'
const HIGH_TRAFFIC_HEAD = 'our servers are experiencing high traffic right now, please try again in a minute'

/** Classification of a buffered `agent_message_chunk` sequence against agy's status notices. */
export type AgentNoticeVerdict =
  | { kind: 'emit' }
  | { kind: 'hold' }
  | { kind: 'drop' }
  | { kind: 'error'; code: 'TRANSPORT' | 'RATE_LIMIT'; message: string }

/** Collapse agy's warning mark and line breaks so the notice can be recognized across chunks. */
function noticeText(raw: string): string {
  return raw.replace(/⚠/g, ' ').replace(/\bError:/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function matchTerminalNotice(
  raw: string,
  text: string,
  head: string,
  code: 'TRANSPORT' | 'RATE_LIMIT',
  message: string,
  final: boolean,
): AgentNoticeVerdict | undefined {
  const full = `${head}.`
  const marked = raw.includes('⚠')
  if (text === full || (marked && text.startsWith(`${full} `))) {
    // Without `⚠`, hold until `final` so a model reply that quotes the sentence
    // and continues explaining it is emitted intact.
    return marked || final ? { kind: 'error', code, message } : { kind: 'hold' }
  }
  if (text === head) {
    return final ? { kind: 'error', code, message } : { kind: 'hold' }
  }
  if (!final && full.startsWith(text)) {
    return { kind: 'hold' }
  }
  return undefined
}

/**
 * Classify text against agy's output-cap continuation notice.
 * `drop` is only that notice, `hold` is still a prefix of it, `emit` is model text.
 */
export function classifyOutputLimitNotice(raw: string): 'drop' | 'hold' | 'emit' {
  const text = noticeText(raw)
  if (text.length === 0) return 'emit'
  const stripped = text.replace(/\s*retries remaining:\s*\d*\s*$/i, '').trim()
  const retry = text.slice(stripped.length).trim()
  if (retry.length > 0 && !/^retries remaining:\s*\d*$/i.test(retry)) return 'emit'
  if (stripped.length === 0) return /^retries remaining:\s*\d+$/i.test(text) ? 'drop' : 'emit'
  const full = `${OUTPUT_LIMIT_HEAD} ${OUTPUT_LIMIT_TAIL}`
  if (stripped === full || stripped === OUTPUT_LIMIT_HEAD || stripped === OUTPUT_LIMIT_TAIL) return 'drop'
  if (full.startsWith(stripped) && stripped.startsWith('your previous')) return 'hold'
  if (OUTPUT_LIMIT_TAIL.startsWith(stripped) && stripped.startsWith('please continue from where you left off')) return 'hold'
  if ('retries remaining:'.startsWith(text) && text.startsWith('retries')) return 'hold'
  return 'emit'
}

/**
 * Classify buffered `agent_message_chunk` text against agy's non-model notices.
 * @param raw - buffered message text since the last emitted or dropped chunk.
 * @param final - true when the message stream ended or switched away from text.
 * @returns how the turn should handle `raw`.
 */
export function classifyAgentNotice(raw: string, final = false): AgentNoticeVerdict {
  const outputLimit = classifyOutputLimitNotice(raw)
  if (outputLimit === 'drop') return { kind: 'drop' }
  if (outputLimit === 'hold') return final ? { kind: 'emit' } : { kind: 'hold' }
  if (AGENT_RETRY_NOTICE.test(raw)) return { kind: 'drop' }
  if (!final && (WARNING_PREFIX.test(raw) || AGENT_RETRY_PREFIX.test(raw.trim()))) {
    return { kind: 'hold' }
  }
  const text = noticeText(raw)
  if (text.length === 0) return { kind: 'emit' }
  const network = matchTerminalNotice(raw, text, NETWORK_ISSUE_HEAD, 'TRANSPORT', NETWORK_ISSUE_MESSAGE, final)
  if (network !== undefined) return network
  const traffic = matchTerminalNotice(raw, text, HIGH_TRAFFIC_HEAD, 'RATE_LIMIT', HIGH_TRAFFIC_MESSAGE, final)
  if (traffic !== undefined) return traffic
  return { kind: 'emit' }
}

/** Tool the agent calls to keep waiting on a relayed DSH tool result. */
export const AWAIT_TOOL_NAME = 'dsh_await_result'

/** MCP descriptor of {@link AWAIT_TOOL_NAME}. */
export const AWAIT_TOOL: BridgeTool = {
  name: AWAIT_TOOL_NAME,
  description: 'Wait for the result of a harness tool call that reported it is still running. Call this only when a tool result tells you to, passing the call_id it gave.',
  inputSchema: {
    type: 'object',
    properties: { call_id: { type: 'string', description: 'The call id from the still-running notice.' } },
    required: ['call_id'],
  },
}

/** MCP descriptor of {@link CALL_TOOL_NAME} (~340B, stays below agy's lazy cutoff). */
export const CALL_TOOL: BridgeTool = {
  name: CALL_TOOL_NAME,
  description: 'Invoke any harness tool by exact name when mcp_dsh_<name> is absent from your direct tool declarations.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact DSH tool name without mcp_dsh_ prefix.' },
      arguments: { type: 'object', description: 'Arguments object matching that tool schema.' },
    },
    required: ['name'],
  },
}

/** One tool call the agent issued and DSH has to run. */
export interface ParkedCall {
  readonly id: ToolCallId
  readonly name: string
  readonly argumentsJson: string
  readonly result: Deferred<BridgeToolResult>
}

/** One native built-in tool permission refusal observed during an ACP turn. */
export interface NativePermissionDenial {
  readonly tool: string
  readonly reason: string
  readonly sandboxMode: NativeSandboxMode
}

/** Maximum in-place continuation prompts sent per turn when `agy` ends a turn right after a native permission denial. */
export const MAX_PERMISSION_CONTINUATIONS = 2

/** Event observed during one ACP turn. */
export type TurnEvent =
  | { kind: 'thought'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'park'; call: ParkedCall }
  | { kind: 'done'; result: AcpPromptResult }
  | { kind: 'error'; error: Error }

/**
 * Failure that ends one step as degraded, so the harness request-retry layer
 * asks for the identical request again about a second later and the plugin
 * re-answers inside the same ACP session.
 * @returns the tagged failure with the harness retry hint.
 */
export function degradedRouteError(): LlmError {
  return new LlmError(
    labeled('DEGRADED_ROUTE', '上游把这次回答分到了降级线路，已在原会话重新生成。'),
    'DEGRADED_ROUTE',
    { providerRetryAfterMs: 1_000 },
  )
}

/**
 * Failure that ends a step whose degraded tool call never recovered within the
 * automatic re-answer budget; the tool was never executed.
 * @returns the terminal failure.
 */
export function degradedExhaustedError(): LlmError {
  return new LlmError(
    labeled('DEGRADED_ROUTE_EXHAUSTED', '上游连续把这次回答分到了降级线路；本次工具调用没有执行，请稍后重试。'),
    'DEGRADED_ROUTE_EXHAUSTED',
  )
}

/**
 * Whether a failure asks for (or reports the end of) an automatic re-answer.
 * Neither is upstream quota: such failures must never cool an account down,
 * fail a step over to another account, or reset the ACP session.
 * @param error - the failure.
 * @returns true for {@link degradedRouteError} and {@link degradedExhaustedError}.
 */
export function isReanswerFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'DEGRADED_ROUTE' || code === 'DEGRADED_ROUTE_EXHAUSTED'
}

/** One running ACP prompt turn. */
export class AcpTurn {
  readonly events = new AsyncQueue<TurnEvent>()
  /** Calls handed to DSH whose results have not arrived yet. */
  readonly pendingCalls = new Map<string, ParkedCall>()
  /** Calls the agent issued during this turn. */
  readonly calls = new Map<string, ParkedCall>()
  /** DSH steps this turn has ended with `tool-calls`. */
  toolSteps = 0
  /** Long-decode continuations sent in this turn. */
  continuations = 0
  /** In-place continuations sent after `agy` aborted `session/prompt` on a denied native built-in tool call. */
  permissionContinuations = 0
  /** Unhandled native built-in permission denials since the last visible text or MCP tool park. */
  readonly pendingNativeDenials: NativePermissionDenial[] = []
  /** Most recent native built-in permission denial in this turn, used as visible fallback after continuation cap. */
  lastNativeDenial: NativePermissionDenial | undefined
  /** The agent ended the prompt. */
  finished = false
  /** A parked call was answered with a still-running notice and the agent has not resumed waiting yet. */
  relaying = false
  /** The turn produced visible text or a tool call. */
  produced = false
  /** Agent-side transport retry notices dropped from the output. */
  retryNotices = 0
  /** Terminal transport or overload failure reported as message text by agy. */
  agentFailure: LlmError | undefined
  /** Message text that may still be the start of an agy status notice. */
  private noticeHold = ''
  /** Model calls inside this turn whose usage was already emitted per-step from SQLite. */
  emittedCalls = 0
  /** Cumulative raw token counts already emitted per-step from SQLite during this turn. */
  readonly emittedRaw = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
  }
  /** Usage read from the session DB for the step that is ending, not yet reported. */
  private stagedUsage: StepUsageSample | undefined
  /** Built-in non-MCP toolCallIds already traced to `reasoning` in `native` mode. */
  private readonly tracedToolCallIds = new Set<string>()
  private nextCall = 0

  /**
   * @param turnTag - unique per-turn hex tag used in synthesized call ids (`agy_<turnTag>_<n>`).
   * @param nativeMode - whether to emit concise `[agy]` reasoning traces for built-in tool calls.
   */
  constructor(private readonly turnTag: string, private readonly nativeMode = false) {}

  /**
   * Record one batch of per-step model usage read from the local session DB.
   * @param batch - per-step usage batch consumed since the previous cursor.
   */
  recordStepBatch(batch: Pick<StepUsageBatch, 'calls' | 'usage'>): void {
    this.emittedCalls += batch.calls
    this.emittedRaw.inputTokens += batch.usage.inputTokens ?? 0
    this.emittedRaw.outputTokens += batch.usage.outputTokens ?? 0
    this.emittedRaw.cachedReadTokens += batch.usage.cachedReadTokens ?? 0
    this.emittedRaw.cachedWriteTokens += batch.usage.cachedWriteTokens ?? 0
    this.emittedRaw.thoughtTokens += batch.usage.thoughtTokens ?? 0
  }

  /**
   * Hold usage a read consumed for the step that is ending, so it is reported exactly
   * once: the degradation gate and the end-of-turn check read the same batch the step
   * reports, and a second read would find nothing left.
   * @param sample - usage of the model steps read so far in this step.
   */
  stageStepUsage(sample: StepUsageSample): void {
    const staged = this.stagedUsage
    if (staged === undefined) {
      this.stagedUsage = { calls: sample.calls, usage: { ...sample.usage }, steps: [...sample.steps] }
      return
    }
    staged.calls += sample.calls
    staged.steps.push(...sample.steps)
    staged.usage.inputTokens = (staged.usage.inputTokens ?? 0) + (sample.usage.inputTokens ?? 0)
    staged.usage.outputTokens = (staged.usage.outputTokens ?? 0) + (sample.usage.outputTokens ?? 0)
    staged.usage.cachedReadTokens = (staged.usage.cachedReadTokens ?? 0) + (sample.usage.cachedReadTokens ?? 0)
    staged.usage.cachedWriteTokens = (staged.usage.cachedWriteTokens ?? 0) + (sample.usage.cachedWriteTokens ?? 0)
    staged.usage.thoughtTokens = (staged.usage.thoughtTokens ?? 0) + (sample.usage.thoughtTokens ?? 0)
    staged.usage.totalTokens = (staged.usage.totalTokens ?? 0) + (sample.usage.totalTokens ?? 0)
  }

  /**
   * Take the usage staged for the step that is ending.
   * @returns the staged sample and clears it.
   */
  takeStepUsage(): StepUsageSample | undefined {
    const staged = this.stagedUsage
    this.stagedUsage = undefined
    return staged
  }

  /**
   * Whether an earlier read already staged usage for the step that is ending: the
   * tool gate and the end-of-turn check read the generation this step reports.
   */
  hasStagedUsage(): boolean {
    return this.stagedUsage !== undefined
  }

  /**
   * Drop the usage staged for a step that will never be delivered, counting it as
   * already emitted so a later fallback subtraction never reports it twice.
   */
  discardStagedUsage(): void {
    const staged = this.takeStepUsage()
    if (staged !== undefined) this.recordStepBatch(staged)
  }

  /**
   * Record one denied native built-in tool call so an immediate zero-output
   * `end_turn` from `agy` can continue in-place instead of failing with `EMPTY_RESPONSE`.
   * @param denial - the refused native built-in call details.
   */
  noteNativeDenial(denial: NativePermissionDenial): void {
    this.pendingNativeDenials.push(denial)
    this.lastNativeDenial = denial
  }

  /**
   * Register one agent tool call.
   * @param name - DSH tool name.
   * @param args - parsed arguments.
   * @returns the parked call.
   */
  park(name: string, args: Record<string, unknown>): ParkedCall {
    const held = this.recoverNoticeHold()
    if (held.length > 0 && !this.relaying) this.events.push({ kind: 'text', text: held })
    this.agentFailure = undefined
    this.pendingNativeDenials.length = 0
    const call: ParkedCall = {
      id: ToolCallId(`agy_${this.turnTag}_${++this.nextCall}`),
      name,
      argumentsJson: JSON.stringify(args),
      result: deferred<BridgeToolResult>(),
    }
    this.calls.set(call.id, call)
    this.events.push({ kind: 'park', call })
    return call
  }

  /**
   * Route one ACP session update into the event queue.
   * @param update - the agent notification.
   */
  onUpdate(update: AcpSessionUpdate): void {
    const text = update.content?.type === 'text' ? update.content.text ?? '' : ''
    if (update.sessionUpdate === 'agent_message_chunk' && text.length > 0) {
      this.consumeMessage(text)
      return
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const held = this.recoverNoticeHold()
      if (held.length > 0 && !this.relaying) this.events.push({ kind: 'text', text: held })
      if (text.length > 0 && !this.relaying) this.events.push({ kind: 'thought', text })
      return
    }
    if (
      this.nativeMode
      && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
      && typeof update.toolCallId === 'string'
      && update.toolCallId.length > 0
      && !this.tracedToolCallIds.has(update.toolCallId)
    ) {
      const summary = summarizeNativeBuiltinToolUpdate(update)
      if (summary !== undefined) {
        this.tracedToolCallIds.add(update.toolCallId)
        const held = this.recoverNoticeHold()
        if (held.length > 0 && !this.relaying) this.events.push({ kind: 'text', text: held })
        if (!this.relaying) this.events.push({ kind: 'thought', text: `\n[agy] ${summary}\n` })
      }
    }
  }

  /**
   * Keep a message chunk out of the chat while it matches or may still complete an agy status notice.
   * @param text - one streamed message chunk.
   */
  private consumeMessage(text: string): void {
    if (this.noticeHold.length === 0 && this.agentFailure !== undefined && text.trim().length === 0) {
      return
    }
    const combined = this.noticeHold + text
    const verdict = classifyAgentNotice(combined, false)
    if (verdict.kind === 'hold') {
      this.noticeHold = combined
      return
    }
    this.noticeHold = ''
    if (verdict.kind === 'drop') {
      this.retryNotices++
      return
    }
    if (verdict.kind === 'error') {
      this.retryNotices++
      this.agentFailure = new LlmError(labeled(verdict.code, verdict.message), verdict.code)
      return
    }
    if (combined.trim().length > 0) {
      this.agentFailure = undefined
      this.pendingNativeDenials.length = 0
    }
    if (!this.relaying) this.events.push({ kind: 'text', text: combined })
  }

  /**
   * Release a held prefix once the message stream moves on.
   * A finished agy notice is counted and discarded (or recorded on `agentFailure`); anything else is returned for emission.
   * @returns model text to show, or an empty string.
   */
  recoverNoticeHold(): string {
    if (this.noticeHold.length === 0) return ''
    const held = this.noticeHold
    this.noticeHold = ''
    const verdict = classifyAgentNotice(held, true)
    if (verdict.kind === 'drop') {
      this.retryNotices++
      return ''
    }
    if (verdict.kind === 'error') {
      this.retryNotices++
      this.agentFailure = new LlmError(labeled(verdict.code, verdict.message), verdict.code)
      return ''
    }
    if (this.agentFailure !== undefined && WARNING_PREFIX.test(held)) {
      return ''
    }
    if (held.trim().length > 0) {
      this.agentFailure = undefined
      this.pendingNativeDenials.length = 0
    }
    return this.relaying ? '' : held
  }

  /**
   * Abandon every parked call with an error result.
   * @param reason - message delivered to the agent.
   */
  abandon(reason: string): void {
    for (const call of this.calls.values()) {
      call.result.resolve({ content: [{ type: 'text', text: reason }], isError: true })
    }
    this.pendingCalls.clear()
  }
}

function summarizeNativeBuiltinToolUpdate(update: AcpSessionUpdate): string | undefined {
  const meta = update._meta
  const mcpServer = update.mcpServerName ?? meta?.mcpServerName ?? meta?.serverName ?? meta?.server
  if (typeof mcpServer === 'string' && mcpServer.length > 0) return undefined
  if (typeof update.mcpToolName === 'string' && update.mcpToolName.length > 0) return undefined
  if (typeof meta?.mcpToolName === 'string' && meta?.mcpToolName.length > 0) return undefined
  const rawName = typeof update.name === 'string' && update.name.trim().length > 0
    ? update.name.trim()
    : (typeof meta?.name === 'string' && meta.name.trim().length > 0 ? meta.name.trim() : '')
  const rawTitle = typeof update.title === 'string' ? update.title.replace(/\s+/gu, ' ').trim() : ''
  if (rawName.startsWith('mcp_') || rawTitle.startsWith('mcp_')) return undefined
  let detail = ''
  if (Array.isArray(update.locations) && typeof update.locations[0]?.path === 'string') {
    detail = update.locations[0].path.trim()
  } else if (update.rawInput !== null && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput)) {
    const rec = update.rawInput as Record<string, unknown>
    const candidate = rec.Path ?? rec.path ?? rec.CommandLine ?? rec.command ?? rec.query
    if (typeof candidate === 'string') detail = candidate.replace(/\s+/gu, ' ').trim()
  }
  if (detail.length > 100) detail = `${detail.slice(0, 99)}…`
  const head = rawTitle.length > 0
    ? (rawName.length > 0 && rawTitle !== rawName && !rawTitle.includes(rawName) ? `${rawName}: ${rawTitle}` : rawTitle)
    : (rawName.length > 0 ? rawName : (typeof update.kind === 'string' && update.kind.length > 0 && update.kind !== 'other' ? update.kind : ''))
  if (head.length === 0) return undefined
  const full = detail.length > 0 && !head.includes(detail) ? `${head} (${detail})` : head
  return full.length > 160 ? `${full.slice(0, 159)}…` : full
}

/** Effects the pump needs from its owner. */
export interface PumpHost {
  /** Window that groups parallel tool calls. */
  parkSettleMs: number
  /** Allowed long-decode continuations. */
  maxContinuations: number
  /** Allowed in-place continuations after native built-in permission denials (default {@link MAX_PERMISSION_CONTINUATIONS}). */
  maxPermissionContinuations?: number
  /** Hold `text` chunks in memory while zero `thought` chunks have arrived in the current attempt. */
  holdZeroThoughtText?: boolean
  /** Send one continuation prompt in the same session; resolves with its result. */
  continuePrompt(): Promise<AcpPromptResult>
  /** Send one in-place sandbox-policy refusal notice in the same session when `agy` aborts a turn after denying a built-in tool. */
  continueAfterPermissionDenial?(denials: readonly NativePermissionDenial[]): Promise<AcpPromptResult>
  /** Request cancellation of the running turn. */
  cancel(): void
  /** Observe the final usage of a prompt turn. */
  recordUsage(usage: AcpPromptResult['usage'], steps: number): void
  /**
   * Read the per-step model usage committed to the local session DB since the
   * previous step and report it for the step that is ending.
   * @param options.final - true for the step that ends the ACP turn, the only
   * point where the turn's usage is reconciled against the completed steps.
   */
  consumeStepUsage?(options: { final: boolean }): Promise<{ usage: NonNullable<AcpPromptResult['usage']>; calls: number } | undefined>
  /**
   * Verify SQLite `gen_metadata` on `end_turn` before the answer is delivered.
   * `degrade` discards the held answer and fails the step so the harness
   * re-asks the identical request.
   */
  verifyEndTurn?(hadZeroThoughtHold: boolean): Promise<'ok' | 'degrade'>
}

/**
 * Map one completed prompt or step sample to DSH token usage. When a single
 * sample spanned `calls` internal model steps (tool rounds or continuations),
 * prompt buckets are normalized by `calls` so DSH's native ContextMeter reflects
 * single-request context occupancy rather than the multi-step sum.
 *
 * `agy acp` reports `inputTokens` as uncached input only, disjoint from
 * `cachedReadTokens` and `cachedWriteTokens`, so every bucket is kept as
 * reported and the total is their sum.
 * @param usage - the agent's step or turn usage.
 * @param calls - model calls executed inside this sample (>= 1).
 * @returns DSH usage.
 */
export function toTokenUsage(usage: AcpPromptResult['usage'], calls = 1): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const scale = Math.max(1, calls)
  const input = Math.max(0, Math.round((usage.inputTokens ?? 0) / scale))
  const cacheRead = Math.max(0, Math.round((usage.cachedReadTokens ?? 0) / scale))
  const cacheWrite = Math.max(0, Math.round((usage.cachedWriteTokens ?? 0) / scale))
  const output = Math.max(0, usage.outputTokens ?? 0)
  const reasoning = usage.thoughtTokens !== undefined && usage.thoughtTokens > 0
    ? Math.min(output, usage.thoughtTokens)
    : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...usage.cachedReadTokens !== undefined || cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
    ...reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {},
    totalTokens: input + cacheRead + cacheWrite + output,
  }
}

/**
 * Stream one DSH step out of the running turn.
 * @param turn - the running ACP turn.
 * @param host - owner effects.
 * @param signal - DSH cancellation.
 * @yields DSH stream chunks ending with one finish chunk.
 */
export async function * pumpStep(turn: AcpTurn, host: PumpHost, signal: AbortSignal | undefined): AsyncGenerator<StreamChunk> {
  let index = 0
  let open: { index: number; type: 'text' | 'reasoning'; text: string } | undefined
  const close = function * (): Generator<StreamChunk> {
    if (open === undefined) return
    const block: ContentBlock = open.type === 'text' ? { type: 'text', text: open.text } : { type: 'reasoning', text: open.text }
    yield { type: 'block-end', index: open.index, block }
    open = undefined
  }
  const append = function * (type: 'text' | 'reasoning', text: string): Generator<StreamChunk> {
    if (open?.type !== type) {
      yield * close()
      open = { index: index++, type, text: '' }
      yield { type: 'block-start', index: open.index, blockType: type }
    }
    open.text += text
    yield type === 'text' ? { type: 'text-delta', index: open.index, text } : { type: 'reasoning-delta', index: open.index, text }
  }

  let sawStepThought = false
  let heldZeroThoughtText = ''
  let emittedVisibleText = false
  const flushHeldText = function * (): Generator<StreamChunk> {
    if (heldZeroThoughtText.length === 0) return
    const text = heldZeroThoughtText
    heldZeroThoughtText = ''
    turn.produced = true
    emittedVisibleText = true
    yield * append('text', text)
  }

  for (;;) {
    const ready = await turn.events.wait(signal)
    if (!ready) {
      host.cancel()
      turn.abandon('The harness cancelled this request.')
      heldZeroThoughtText = ''
      yield * close()
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
      return
    }
    if (turn.events.peek()?.kind !== 'text') {
      const held = turn.recoverNoticeHold()
      if (held.length > 0) {
        if (host.holdZeroThoughtText === true && !sawStepThought && !emittedVisibleText) {
          heldZeroThoughtText += held
        } else {
          turn.produced = true
          emittedVisibleText = true
          yield * append('text', held)
        }
      }
    }
    const event = turn.events.shift() as TurnEvent
    switch (event.kind) {
      case 'thought':
        sawStepThought = true
        yield * flushHeldText()
        yield * append('reasoning', event.text)
        break
      case 'text':
        if (host.holdZeroThoughtText === true && !sawStepThought && !emittedVisibleText) {
          heldZeroThoughtText += event.text
        } else {
          turn.produced = true
          emittedVisibleText = true
          yield * append('text', event.text)
        }
        break
      case 'park': {
        yield * flushHeldText()
        turn.produced = true
        yield * close()
        const batch: ParkedCall[] = [event.call]
        // Parallel calls of one model response arrive within a short window.
        while (await turn.events.wait(signal, host.parkSettleMs)) {
          const next = turn.events.peek()
          if (next?.kind !== 'park') break
          turn.events.shift()
          batch.push(next.call)
        }
        for (const call of batch) {
          const blockIndex = index++
          turn.pendingCalls.set(call.id, call)
          yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: blockIndex, id: call.id, name: call.name, argumentsDelta: call.argumentsJson }
          yield { type: 'block-end', index: blockIndex, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.argumentsJson } }
        }
        const stepSample = await host.consumeStepUsage?.({ final: false })
        if (stepSample !== undefined) {
          const usage = toTokenUsage(stepSample.usage, stepSample.calls)
          if (usage !== undefined) yield { type: 'usage', usage }
        }
        turn.toolSteps++
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      case 'done': {
        if (turn.agentFailure !== undefined) {
          heldZeroThoughtText = ''
          turn.finished = true
          yield * close()
          throw turn.agentFailure
        }
        const stop = event.result.stopReason
        if (stop === 'max_tokens' && turn.continuations < host.maxContinuations) {
          yield * flushHeldText()
          turn.continuations++
          void host.continuePrompt().then(
            result => turn.events.push({ kind: 'done', result }),
            (error: unknown) => turn.events.push({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
          )
          break
        }
        if (stop === 'end_turn' && turn.pendingNativeDenials.length > 0) {
          const denials = turn.pendingNativeDenials.splice(0)
          const maxPermCont = host.maxPermissionContinuations ?? MAX_PERMISSION_CONTINUATIONS
          if (host.continueAfterPermissionDenial !== undefined && turn.permissionContinuations < maxPermCont) {
            yield * flushHeldText()
            turn.permissionContinuations++
            void host.continueAfterPermissionDenial(denials).then(
              result => turn.events.push({ kind: 'done', result }),
              (error: unknown) => turn.events.push({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
            )
            break
          }
        }
        if (stop === 'end_turn' && host.verifyEndTurn !== undefined) {
          const hadZeroThoughtHold = !sawStepThought && heldZeroThoughtText.length > 0 && !emittedVisibleText
          if (await host.verifyEndTurn(hadZeroThoughtHold) === 'degrade') {
            // The degraded answer is discarded: held text never reaches the
            // transcript, and the step fails so the harness re-asks the same
            // request. Reasoning already streamed stays.
            heldZeroThoughtText = ''
            turn.finished = true
            yield * close()
            throw degradedRouteError()
          }
        }
        yield * flushHeldText()
        if (stop === 'end_turn' && !turn.produced && turn.lastNativeDenial !== undefined) {
          const d = turn.lastNativeDenial
          const fallback = `Operation refused by DSH sandbox policy (${d.sandboxMode}): ${d.tool} (${d.reason}).`
          turn.produced = true
          emittedVisibleText = true
          yield * append('text', fallback)
        }
        turn.finished = true
        yield * close()
        const calls = turn.toolSteps + turn.continuations + turn.permissionContinuations + 1
        host.recordUsage(event.result.usage, calls)
        const finalSample = await host.consumeStepUsage?.({ final: true })
        let usage: TokenUsage | undefined
        if (finalSample !== undefined) {
          usage = toTokenUsage(finalSample.usage, finalSample.calls)
        } else if (turn.emittedCalls > 0 && event.result.usage !== undefined) {
          const total = event.result.usage
          const remInput = Math.max(0, (total.inputTokens ?? 0) - turn.emittedRaw.inputTokens)
          const remOutput = Math.max(0, (total.outputTokens ?? 0) - turn.emittedRaw.outputTokens)
          const remCacheRead = Math.max(0, (total.cachedReadTokens ?? 0) - turn.emittedRaw.cachedReadTokens)
          const remCacheWrite = Math.max(0, (total.cachedWriteTokens ?? 0) - turn.emittedRaw.cachedWriteTokens)
          const remThought = Math.max(0, (total.thoughtTokens ?? 0) - turn.emittedRaw.thoughtTokens)
          const rem: NonNullable<AcpPromptResult['usage']> = {
            inputTokens: remInput,
            outputTokens: remOutput,
            ...total.cachedReadTokens !== undefined ? { cachedReadTokens: remCacheRead } : {},
            cachedWriteTokens: remCacheWrite,
            thoughtTokens: remThought,
            totalTokens: remInput + remCacheRead + remCacheWrite + remOutput,
          }
          const remCalls = Math.max(1, calls - turn.emittedCalls)
          usage = toTokenUsage(rem, remCalls)
        } else {
          usage = toTokenUsage(event.result.usage, calls)
        }
        if (usage !== undefined) yield { type: 'usage', usage }
        if (stop === 'end_turn' && !turn.produced) {
          throw new LlmError(labeled('EMPTY_RESPONSE', 'Antigravity ended the turn without visible output'), 'EMPTY_RESPONSE')
        }
        switch (stop) {
          case 'end_turn':
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          case 'max_tokens':
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          case 'cancelled':
            yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Antigravity cancelled the turn', code: 'ABORTED' } } }
            return
          case 'refusal':
            yield { type: 'finish', reason: { kind: 'error', failure: { message: labeled('REFUSAL', 'Antigravity refused the request'), code: 'REFUSAL' } } }
            return
          default:
            yield { type: 'finish', reason: { kind: 'error', failure: { message: `Antigravity stopped: ${stop}`, code: 'PROVIDER_ERROR' } } }
            return
        }
      }
      case 'error':
        turn.finished = true
        yield * close()
        throw event.error
    }
  }
}

/**
 * Notice returned to the agent when a DSH tool outlives the MCP call deadline.
 * @param call - the still-running call.
 * @returns MCP result instructing the agent to keep waiting.
 */
export function relayNotice(call: ParkedCall): BridgeToolResult {
  return {
    content: [{
      type: 'text',
      text: `The harness is still running tool call ${call.id} (${call.name}). Call ${AGENT_TOOL_PREFIX}${AWAIT_TOOL_NAME} with {"call_id":"${call.id}"} now to receive its result. Do not repeat the original call and do not answer the user before the result arrives.`,
    }],
  }
}
