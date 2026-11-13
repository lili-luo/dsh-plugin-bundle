/**
 * The MCP tool bridge as `agy` sees it: the schemas advertised on each prompt,
 * the incremental tool deltas appended to keep the agent's view current, and the
 * permission gate that decides which agent tool calls may touch DSH tools.
 *
 * Everything here is pure: the live tenant registry, the bridge transport, and
 * the conversation objects stay with the runtime, which passes in only the
 * facts a decision needs.
 * @module dsh-llm-antigravity-acp/tool-bridge
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { AcpPermissionOutcome, AcpPermissionRequest, AcpSessionUpdate, AcpToolCallMeta, AcpToolLocation } from './acp-process.ts'
import type { EngineMode } from './config.ts'
import { AWAIT_TOOL_NAME, CALL_TOOL_NAME, type NativePermissionDenial } from './conversation.ts'
import { AGENT_TOOL_PREFIX, cloakProse, MCP_SERVER_NAME, type NativeSandboxMode } from './history.ts'
import type { BridgeContent, BridgeTool } from './mcp-bridge.ts'
import { digest } from './util.ts'

/**
 * DSH built-in filesystem, shell, job, and MCP-resource tools that duplicate
 * Antigravity's own native workspace tools and are filtered out in `native` mode.
 */
export const NATIVE_OVERLAPPING_DSH_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'working_directory',
  'job_list',
  'job_output',
  'job_kill',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
])

/**
 * Filter request tools according to the active engine mode. `bridge` mode keeps
 * every declared DSH tool; `native` mode drops only {@link NATIVE_OVERLAPPING_DSH_TOOLS}
 * so subagent, team, workflow, skill, UI, goal, schedule, web, and custom DSH
 * plugin tools remain available over the MCP bridge.
 * @param tools - declared request tools.
 * @param engineMode - active ACP engine mode.
 * @returns tools exposed to the session on the MCP bridge.
 */
export function filterToolsForEngineMode(
  tools: readonly ToolSchema[] | undefined,
  engineMode: EngineMode,
): ToolSchema[] {
  if (tools === undefined || tools.length === 0) return []
  if (engineMode === 'bridge') return [...tools]
  return tools.filter(tool => !NATIVE_OVERLAPPING_DSH_TOOLS.has(tool.name))
}

/** Structured MCP and built-in tool metadata the agent reported for one tool call. */
export interface ReportedToolCall {
  kind?: string
  serverName?: string
  toolName?: string
  name?: string
  title?: string
  locations?: { path?: string }[]
  rawInput?: unknown
  /** Set when later updates contradicted an already established field. */
  conflict?: boolean
}

/** Live conversation facts the permission gate reads. */
export interface PermissionGateState {
  sessionId: string | undefined
  /** Set only while an MCP bridge endpoint is mounted for this session. */
  tenantKey: string | undefined
  turnLive: boolean
  engineMode?: EngineMode | undefined
  sandboxMode?: NativeSandboxMode | undefined
  sessionCwd?: string | undefined
  writableRoots?: readonly string[] | undefined
  reportedToolCalls: ReadonlyMap<string, ReportedToolCall>
  advertisedToolNames: ReadonlySet<string>
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseAgentMcpName(name: string | undefined): { serverName: string; toolName: string } | undefined {
  if (name === undefined || !name.startsWith(AGENT_TOOL_PREFIX)) return undefined
  const toolName = name.slice(AGENT_TOOL_PREFIX.length)
  return toolName.length > 0 ? { serverName: MCP_SERVER_NAME, toolName } : undefined
}

/**
 * Extract structured MCP tool identity from explicit metadata fields or the
 * agent's protocol tool `name` (`mcp_dsh_<tool>`), flagging contradictions
 * between the two. `title` and `rawInput` are deliberately never consulted.
 */
function extractMcpIdentity(
  carrier: {
    mcpServerName?: unknown
    mcpToolName?: unknown
    name?: unknown
    _meta?: AcpToolCallMeta
  } | undefined,
): { serverName?: string; toolName?: string; name?: string; conflict?: boolean } {
  const meta: AcpToolCallMeta | undefined = carrier?._meta
  const explicitServer = nonEmpty(carrier?.mcpServerName) ?? nonEmpty(meta?.mcpServerName) ?? nonEmpty(meta?.serverName) ?? nonEmpty(meta?.server)
  const explicitTool = nonEmpty(carrier?.mcpToolName) ?? nonEmpty(meta?.mcpToolName) ?? nonEmpty(meta?.toolName) ?? nonEmpty(meta?.tool)
  const name = nonEmpty(carrier?.name) ?? nonEmpty(meta?.name)
  // agy >= 1.5.8 reports `name: "mcp_dsh_<tool>"` without `mcpServerName`/`mcpToolName` or `_meta`.
  const parsed = parseAgentMcpName(name)
  const conflict = (parsed !== undefined && explicitServer !== undefined && explicitServer !== parsed.serverName)
    || (parsed !== undefined && explicitTool !== undefined && explicitTool !== parsed.toolName)
  const serverName = explicitServer ?? parsed?.serverName
  const toolName = explicitTool ?? parsed?.toolName
  return {
    ...(serverName !== undefined ? { serverName } : {}),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(conflict ? { conflict: true } : {}),
  }
}

/**
 * Merge one `session/update` identity report into the conversation's table of
 * reported tool calls. Only these reports may authorize a permission request.
 * @param conv - conversation holding the reported calls.
 * @param update - the agent's session update.
 * @returns how the report was absorbed, or `undefined` for unrelated updates.
 */
export function recordReportedToolCall(
  conv: { readonly reportedToolCalls: Map<string, ReportedToolCall> },
  update: AcpSessionUpdate,
): 'created' | 'merged' | 'conflict' | undefined {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
  if (typeof update.toolCallId !== 'string' || update.toolCallId.length === 0) return
  const { serverName, toolName, name, conflict: selfConflict } = extractMcpIdentity(update)
  const title = nonEmpty(update.title)
  const kind = typeof update.kind === 'string' ? update.kind : undefined
  const existing = conv.reportedToolCalls.get(update.toolCallId)
  const merged: ReportedToolCall = existing === undefined ? {} : { ...existing }
  let conflict = selfConflict === true
  if (kind !== undefined) {
    if (merged.kind !== undefined && merged.kind !== kind) conflict = true
    else merged.kind = kind
  }
  if (serverName !== undefined) {
    if (merged.serverName !== undefined && merged.serverName !== serverName) conflict = true
    else merged.serverName = serverName
  }
  if (toolName !== undefined) {
    if (merged.toolName !== undefined && merged.toolName !== toolName) conflict = true
    else merged.toolName = toolName
  }
  if (name !== undefined) {
    if (merged.name !== undefined && merged.name !== name) conflict = true
    else merged.name = name
  }
  if (title !== undefined && merged.title === undefined) merged.title = title
  if (Array.isArray(update.locations) && update.locations.length > 0) {
    const incoming = update.locations
      .filter((loc): loc is AcpToolLocation => loc !== null && typeof loc === 'object')
      .map(loc => (typeof loc.path === 'string' ? { path: loc.path } : {}))
    merged.locations = merged.locations === undefined ? incoming : [...merged.locations, ...incoming]
  }
  if (update.rawInput !== undefined && !isEmptyInput(update.rawInput)) {
    merged.rawInput = update.rawInput
  }
  if (conflict) merged.conflict = true
  conv.reportedToolCalls.set(update.toolCallId, merged)
  if (conflict) return 'conflict'
  return existing === undefined ? 'created' : 'merged'
}

const READ_ONLY_BUILTIN_TOOLS = new Set([
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'grep_search',
  'find_by_name',
  'list_dir',
  'search_web',
  'list_resources',
  'read_resource',
])

const EDIT_BUILTIN_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
])

const EXECUTE_BUILTIN_TOOLS = new Set([
  'run_command',
  'manage_task',
  'send_command_input',
])

function normalizeFsPath(rawPath: string, baseCwd: string | undefined, hops = 0): string | undefined {
  if (hops > 16) return undefined
  const trimmed = rawPath.trim()
  if (trimmed.length === 0 || trimmed.includes('\0')) return undefined
  let candidate = trimmed
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate)
    } catch {
      return undefined
    }
  }
  let resolved: string
  if (isAbsolute(candidate)) {
    resolved = resolve(candidate)
  } else {
    if (baseCwd === undefined || baseCwd.trim().length === 0) return undefined
    resolved = resolve(baseCwd, candidate)
  }
  const suffix: string[] = []
  let cursor = resolved
  for (;;) {
    try {
      const real = realpathSync(cursor)
      return suffix.length === 0 ? real : resolve(real, ...suffix)
    } catch {
      try {
        if (lstatSync(cursor).isSymbolicLink()) {
          const linkTarget = readlinkSync(cursor)
          const resolvedLink = isAbsolute(linkTarget) ? resolve(linkTarget) : resolve(dirname(cursor), linkTarget)
          const combined = suffix.length === 0 ? resolvedLink : resolve(resolvedLink, ...suffix)
          return normalizeFsPath(combined, baseCwd, hops + 1)
        }
      } catch {
        // Path entry does not exist; continue walking up to nearest existing ancestor.
      }
      const parent = dirname(cursor)
      if (parent === cursor) {
        return suffix.length === 0 ? cursor : resolve(cursor, ...suffix)
      }
      suffix.unshift(basename(cursor))
      cursor = parent
    }
  }
}

function isPathWithinRoot(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function collectBuiltinTargetPaths(
  reported: ReportedToolCall | undefined,
  toolCall: AcpPermissionRequest['toolCall'],
): string[] {
  const paths: string[] = []
  const push = (candidate: unknown): void => {
    if (typeof candidate === 'string' && candidate.trim().length > 0 && !paths.includes(candidate)) {
      paths.push(candidate)
    }
  }
  for (const list of [reported?.locations, toolCall?.locations]) {
    if (!Array.isArray(list)) continue
    for (const loc of list) {
      if (loc !== null && typeof loc === 'object') push((loc as { path?: unknown }).path)
    }
  }
  for (const raw of [reported?.rawInput, toolCall?.rawInput]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    for (const key of ['Path', 'path', 'TargetFile', 'targetFile', 'file_path', 'filePath']) {
      push(rec[key])
    }
  }
  return paths
}

function answerNativeBuiltinPermission(
  state: PermissionGateState,
  request: AcpPermissionRequest,
  reported: ReportedToolCall | undefined,
  pick: (kind: string) => AcpPermissionOutcome | undefined,
  reject: (reason: string) => AcpPermissionOutcome,
  onDenied?: (denial: NativePermissionDenial) => void,
): AcpPermissionOutcome {
  const toolCallId = request.toolCall?.toolCallId ?? 'unknown'
  const rawTargets = collectBuiltinTargetPaths(reported, request.toolCall)
  const sandboxMode: NativeSandboxMode = state.sandboxMode ?? 'workspace-write'
  const claimedName = nonEmpty(request.toolCall?.name) ?? nonEmpty(request.toolCall?._meta?.name)
  const claimedKind = nonEmpty(request.toolCall?.kind)
  const name = claimedName ?? reported?.name ?? reported?.toolName
  const kind = claimedKind ?? reported?.kind
  const baseLabel = name ?? nonEmpty(request.toolCall?.title) ?? reported?.title ?? kind ?? 'built-in tool'
  const toolLabel = rawTargets[0] !== undefined && !baseLabel.includes(rawTargets[0])
    ? `${baseLabel} (${rawTargets[0]})`
    : baseLabel
  const rejectBuiltin = (reason: string): AcpPermissionOutcome => {
    onDenied?.({ tool: toolLabel, reason, sandboxMode })
    return reject(reason)
  }

  if (reported?.conflict === true) {
    return rejectBuiltin(`reported identity of tool call ${toolCallId} conflicts across agent updates`)
  }
  if (claimedName !== undefined && reported?.name !== undefined && claimedName !== reported.name) {
    return rejectBuiltin('tool name conflict')
  }
  if (claimedKind !== undefined && reported?.kind !== undefined && claimedKind !== reported.kind) {
    return rejectBuiltin('tool kind conflict')
  }

  if (sandboxMode === 'danger-full-access') {
    return pick('allow_once') ?? { outcome: 'cancelled' }
  }
  if (sandboxMode === 'read-only') {
    if (
      EDIT_BUILTIN_TOOLS.has(name ?? '')
      || EXECUTE_BUILTIN_TOOLS.has(name ?? '')
      || kind === 'edit'
      || kind === 'delete'
      || kind === 'move'
      || kind === 'execute'
    ) {
      return rejectBuiltin('mutating or execution tool denied in read-only mode')
    }
    if (kind === 'read' || kind === 'search' || READ_ONLY_BUILTIN_TOOLS.has(name ?? '')) {
      return pick('allow_once') ?? { outcome: 'cancelled' }
    }
    return rejectBuiltin('tool not allowed in read-only mode')
  }

  // sandboxMode === 'workspace-write'
  const isEdit = EDIT_BUILTIN_TOOLS.has(name ?? '') || kind === 'edit' || kind === 'delete' || kind === 'move'
  if (isEdit) {
    if (rawTargets.length === 0) return rejectBuiltin('target path outside workspace-write roots')
    const normalizedRoots = (state.writableRoots ?? [])
      .map(root => normalizeFsPath(root, state.sessionCwd))
      .filter((root): root is string => root !== undefined)
    if (normalizedRoots.length === 0) return rejectBuiltin('target path outside workspace-write roots')
    for (const rawTarget of rawTargets) {
      const normalizedTarget = normalizeFsPath(rawTarget, state.sessionCwd)
      if (normalizedTarget === undefined || !normalizedRoots.some(root => isPathWithinRoot(normalizedTarget, root))) {
        return rejectBuiltin('target path outside workspace-write roots')
      }
    }
    return pick('allow_once') ?? { outcome: 'cancelled' }
  }

  if (
    kind === 'read'
    || kind === 'search'
    || kind === 'execute'
    || kind === 'think'
    || kind === 'fetch'
    || READ_ONLY_BUILTIN_TOOLS.has(name ?? '')
    || EXECUTE_BUILTIN_TOOLS.has(name ?? '')
  ) {
    return pick('allow_once') ?? { outcome: 'cancelled' }
  }
  return rejectBuiltin('unrecognized built-in tool in workspace-write mode')
}

function isEmptyInput(rawInput: unknown): boolean {
  if (rawInput === undefined || rawInput === null) return true
  if (typeof rawInput === 'string') return rawInput.trim().length === 0
  if (Array.isArray(rawInput)) return rawInput.length === 0
  if (typeof rawInput === 'object') return Object.keys(rawInput).length === 0
  return false
}

/**
 * Decide one `session/request_permission`. Only a tool call the agent reported
 * itself, carrying this bridge's server name, on a tool this session offers, and
 * during a live turn may run; every other request is refused.
 * @param state - live conversation facts.
 * @param request - the agent's permission request.
 * @param port - bridge handshake lookup and the warning sink for refusals.
 * @returns the outcome handed back to the agent.
 */
export function answerPermission(
  state: PermissionGateState,
  request: AcpPermissionRequest,
  port: {
    hasHandshake(tenantKey: string): boolean
    warn(message: string): void
    onNativeBuiltinRejected?(denial: NativePermissionDenial): void
  },
): AcpPermissionOutcome {
  const pick = (kind: string): AcpPermissionOutcome | undefined => {
    const option = request.options.find(o => o.kind === kind)
    return option === undefined ? undefined : { outcome: 'selected', optionId: option.optionId }
  }
  const reject = (reason: string): AcpPermissionOutcome => {
    port.warn(`antigravity-acp: refused permission request (${reason}): ${request.toolCall?.title ?? 'unknown'}`)
    return pick('reject_once') ?? { outcome: 'cancelled' }
  }
  if (state.sessionId === undefined || request.sessionId !== state.sessionId) return reject('session mismatch')
  const tenantKey = state.tenantKey
  if (tenantKey === undefined) return reject('no MCP bridge is mounted for this session')
  if (!state.turnLive) return reject('no live turn')
  const toolCallId = request.toolCall?.toolCallId
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return reject('missing toolCallId')
  const reported = state.reportedToolCalls.get(toolCallId)
  const claimed = extractMcpIdentity(request.toolCall)
  const engineMode = state.engineMode ?? 'bridge'
  if (engineMode === 'native') {
    const isProbe = reported === undefined
      && claimed.serverName === undefined
      && claimed.toolName === undefined
      && claimed.name === undefined
      && request.toolCall?.kind === 'other'
      && isEmptyInput(request.toolCall.rawInput)
    const isMcp = reported?.serverName !== undefined
      || claimed.serverName !== undefined
      || nonEmpty(request.toolCall?.mcpToolName) !== undefined
      || (request.toolCall?.name ?? reported?.name ?? '').startsWith('mcp_')
      || (request.toolCall?.title ?? reported?.title ?? '').startsWith('mcp_')
    if (!isProbe && !isMcp) {
      return answerNativeBuiltinPermission(state, request, reported, pick, reject, port.onNativeBuiltinRejected)
    }
  }
  if (reported === undefined) {
    if (claimed.conflict === true || claimed.serverName !== undefined || claimed.toolName !== undefined) {
      return reject(`tool call ${toolCallId} was never reported by the agent`)
    }
    if (claimed.name === undefined && request.toolCall?.kind === 'other' && isEmptyInput(request.toolCall.rawInput)) {
      if (!port.hasHandshake(tenantKey)) {
        return reject('identity-less probe without a completed MCP handshake')
      }
      return pick('allow_once') ?? { outcome: 'cancelled' }
    }
    return reject('missing structured tool metadata')
  }
  if (reported.conflict === true) {
    return reject(`reported identity of tool call ${toolCallId} conflicts across agent updates`)
  }
  if (claimed.conflict === true) {
    return reject(`permission request for tool call ${toolCallId} carries conflicting MCP metadata`)
  }
  if (claimed.serverName !== undefined && claimed.serverName !== reported.serverName) return reject('MCP server name conflict')
  if (claimed.toolName !== undefined && claimed.toolName !== reported.toolName) return reject('tool name conflict')
  if (claimed.name !== undefined && reported.name !== undefined && claimed.name !== reported.name) return reject('tool name conflict')
  if (reported.serverName !== MCP_SERVER_NAME) return reject(`unknown MCP server ${reported.serverName ?? '(none)'}`)
  const allowedTools = new Set([...state.advertisedToolNames, AWAIT_TOOL_NAME, CALL_TOOL_NAME])
  if (reported.toolName === undefined || !allowedTools.has(reported.toolName)) {
    return reject(`tool is not offered to this session: ${reported.toolName ?? '(none)'}`)
  }
  return pick('allow_once') ?? { outcome: 'cancelled' }
}

/**
 * Diff active tools against the session's known tool set and render a compact
 * `<harness_tool_update>` block for newly added, modified, restored, or disabled tools.
 * @param conv - conversation tool state (`advertisedToolNames` and `knownTools`).
 * @param tools - active tools for the current step.
 * @returns `<harness_tool_update>` text block, or `''` when unchanged.
 */
export function consumeToolDelta(
  conv: { readonly advertisedToolNames: ReadonlySet<string>; readonly knownTools: Map<string, string> },
  tools: readonly BridgeTool[],
): string {
  const lines: string[] = []
  const active = new Set<string>()
  for (const tool of tools) {
    active.add(tool.name)
    const hash = digest(tool)
    if (conv.knownTools.get(tool.name) === hash) continue
    conv.knownTools.set(tool.name, hash)
    if (conv.advertisedToolNames.has(tool.name)) {
      lines.push(`[tool restored: ${AGENT_TOOL_PREFIX}${tool.name}]`)
    } else {
      lines.push(`[tool available via ${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME} with {"name":"${tool.name}","arguments":{...}}]: ${JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema })}`)
    }
  }
  for (const name of [...conv.knownTools.keys()]) {
    if (!active.has(name)) {
      conv.knownTools.delete(name)
      lines.push(`[tool disabled: ${name}]`)
    }
  }
  return lines.length > 0 ? `<harness_tool_update>\n${lines.join('\n')}\n</harness_tool_update>` : ''
}

/** Byte ceiling keeping advertised MCP tool schemas below agy's ~1,500B lazy cutoff. */
export const MAX_EAGER_BRIDGE_TOOL_BYTES = 1_350

function shortenText(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  if (clean.length <= maxChars) return clean
  const sentenceEnd = clean.indexOf('. ')
  if (sentenceEnd >= 32 && sentenceEnd + 1 <= maxChars) return clean.slice(0, sentenceEnd + 1)
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

function compactSchemaNode(value: unknown, maxDescChars: number): unknown {
  if (Array.isArray(value)) return value.map(item => compactSchemaNode(item, maxDescChars))
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'description' && typeof entry === 'string') {
      if (maxDescChars > 0) out[key] = shortenText(entry, maxDescChars)
      continue
    }
    if (key === 'properties' && entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const props: Record<string, unknown> = {}
      for (const [propKey, propVal] of Object.entries(entry as Record<string, unknown>)) {
        props[propKey] = compactSchemaNode(propVal, maxDescChars)
      }
      out[key] = props
      continue
    }
    out[key] = compactSchemaNode(entry, maxDescChars)
  }
  return out
}

/**
 * Keep each MCP-advertised tool schema under `agy`'s eager size threshold while
 * preserving every parameter name, type, required list, and enum constraint.
 * @param tool - raw bridge tool descriptor.
 * @returns compacted descriptor when oversized, otherwise the original descriptor.
 */
export function compactBridgeTool(tool: BridgeTool): BridgeTool {
  if (Buffer.byteLength(JSON.stringify(tool), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES) return tool
  const pass1: BridgeTool = {
    name: tool.name,
    description: shortenText(tool.description, 220),
    inputSchema: compactSchemaNode(tool.inputSchema, 90) as Record<string, unknown>,
  }
  if (Buffer.byteLength(JSON.stringify(pass1), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES) return pass1
  return {
    name: tool.name,
    description: shortenText(tool.description, 140),
    inputSchema: compactSchemaNode(tool.inputSchema, 0) as Record<string, unknown>,
  }
}

/**
 * Resolve currently active tool schemas under either direct `ToolSchema[]` or
 * `toolUpdate: 'in-history'` (`deferLoading: true` + developer `tool-addition` / `tool-removal` blocks).
 * @param rawTools - declared tools on the request.
 * @param messages - request history after leading system messages.
 * @returns active tool schemas in declaration/activation order.
 */
export function resolveActiveToolSchemas(
  rawTools: readonly ToolSchema[] | undefined,
  messages: readonly RequestMessage[],
): ToolSchema[] {
  if (rawTools === undefined || rawTools.length === 0) return []
  const byName = new Map(rawTools.map(t => [t.name, t]))
  const active = new Map<string, ToolSchema>()
  for (const tool of rawTools) {
    if (tool.deferLoading !== true) active.set(tool.name, tool)
  }
  for (const message of messages) {
    if (message.role !== 'developer') continue
    for (const block of message.content) {
      if (block.type === 'tool-addition') {
        const schema = byName.get(block.toolName)
        if (schema !== undefined) {
          const { deferLoading: _defer, ...rest } = schema
          active.set(block.toolName, rest)
        }
      } else if (block.type === 'tool-removal') {
        active.delete(block.toolName)
      }
    }
  }
  return [...active.values()]
}

/**
 * Turn active tool schemas into the compacted descriptors advertised on the bridge.
 * The `read` descriptor also states the per-call MCP result ceiling, so the agent
 * pages large files instead of expecting one call to return them whole.
 * @param tools - active tool schemas.
 * @returns bridge descriptors, defaults expanded to an object schema.
 */
function cloakSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => cloakSchemaDescriptions(item))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = key === 'description' && typeof entry === 'string' ? cloakProse(entry) : cloakSchemaDescriptions(entry)
  }
  return out
}

export function toBridgeTools(tools: readonly ToolSchema[] | undefined): BridgeTool[] {
  return (tools ?? []).filter(t => t.deferLoading !== true).map((t) => {
    const parameters = t.parameters.type === undefined ? { type: 'object', ...t.parameters } : t.parameters
    const tool: BridgeTool = {
      name: t.name,
      description: cloakProse(t.description),
      inputSchema: cloakSchemaDescriptions(parameters) as Record<string, unknown>,
    }
    return t.name === 'read' ? withReadPagingNote(tool) : compactBridgeTool(tool)
  })
}

/** UTF-8 ceiling of one MCP tool result, below `agy`'s 10,240-byte `outputTruncationTool` middle splice. */
export const MAX_BRIDGE_RESULT_BYTES = 9_600
/** Page size the bounded `read` notice and the `read` descriptor recommend. */
export const READ_PAGE_LINES = 160
/** Sentence appended to the `read` descriptor. */
export const READ_PAGING_NOTE = `MCP returns at most ~9.5 KB per call, so read files over ~180 lines in pages with offset and limit (e.g. limit: ${READ_PAGE_LINES}).`
/** Share of a non-`read` budget kept from the head of the output; the rest goes to its tail. */
const HEAD_SHARE = 0.7
/** Widest number any notice renders, used to reserve notice bytes before the real counts are known. */
const NOTICE_NUMBER_RESERVE = 9_999_999_999

function withReadPagingNote(tool: BridgeTool): BridgeTool {
  const withNote = (description: string): string => {
    const trimmed = description.trimEnd()
    const note = cloakProse(READ_PAGING_NOTE)
    return trimmed.length > 0 ? `${trimmed} ${note}` : note
  }
  const compacted = compactBridgeTool({ ...tool, description: withNote(tool.description) })
  if (compacted.description.includes('9.5 KB')) return compacted
  // Compaction keeps only the first sentence of an oversized description; put the note back when it still fits.
  const restored: BridgeTool = { ...compacted, description: withNote(compacted.description) }
  return Buffer.byteLength(JSON.stringify(restored), 'utf8') <= MAX_EAGER_BRIDGE_TOOL_BYTES ? restored : compacted
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes that never splits a code point. */
function utf8Head(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** Longest suffix of `text` within `maxBytes` UTF-8 bytes that never splits a code point. */
function utf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let start = buf.length - Math.max(0, maxBytes)
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8')
}

const LINE_NUMBER = /^\s*(\d+)[:→\t|]/u

function lineNumberOf(line: string | undefined): number | undefined {
  const match = line === undefined ? null : LINE_NUMBER.exec(line)
  return match === null ? undefined : Number(match[1])
}

/**
 * Bound one MCP tool result to `maxBytes` UTF-8 bytes so `agy`'s own 10,240-byte
 * output truncation never removes the middle of it. Text within the budget is
 * returned unchanged. A `read` result keeps its header and the complete lines from
 * the start that fit, closes its `<content>` wrapper, and ends with a notice naming
 * the shown line range and the `offset` that continues it. Every other tool keeps a
 * line-aligned head and tail around a marker that states what was omitted and how
 * to narrow the query.
 * @param toolName - DSH tool name without the `mcp_dsh_` prefix.
 * @param text - tool output text.
 * @param maxBytes - UTF-8 budget of the returned text.
 * @returns text of at most `maxBytes` UTF-8 bytes.
 */
export function boundBridgeToolText(toolName: string, text: string, maxBytes: number = MAX_BRIDGE_RESULT_BYTES): string {
  const totalBytes = utf8Bytes(text)
  if (totalBytes <= maxBytes) return text
  const bounded = toolName === 'read' ? boundReadText(text, totalBytes, maxBytes) : boundHeadTail(text, totalBytes, maxBytes)
  // The notices are reserved at their widest, so this only guards budgets too small for any notice.
  return utf8Bytes(bounded) <= maxBytes ? bounded : utf8Head(bounded, maxBytes)
}

function readNotice(first: number, last: number, totalLines: number | undefined, shownBytes: number, totalBytes: number, cutLineBytes?: number): string {
  const range = `lines ${first}-${last}${totalLines !== undefined ? ` of ${totalLines}` : ''}`
  const cut = cutLineBytes === undefined
    ? ''
    : ` Line ${last} is truncated at ${cutLineBytes} bytes; use ${AGENT_TOOL_PREFIX}grep or a filtered command for the rest of it.`
  return `(MCP result limit: showing ${range} (${shownBytes} of ${totalBytes} bytes).${cut} Call ${AGENT_TOOL_PREFIX}read with offset=${last + 1} and limit=${READ_PAGE_LINES} to read the next lines.)`
}

function boundReadText(text: string, totalBytes: number, maxBytes: number): string {
  const open = '<content>\n'
  const close = '\n</content>'
  const openAt = text.indexOf(open)
  const header = openAt >= 0 ? text.slice(0, openAt + open.length) : ''
  let body = openAt >= 0 ? text.slice(openAt + open.length) : text
  const wrapped = openAt >= 0 && body.endsWith(close)
  if (wrapped) body = body.slice(0, -close.length)
  const lines = body.split('\n')
  // The DSH read footer (`(Showing lines …)` / `(End of file …)`) follows one blank line.
  let totalLines: number | undefined
  const footer = lines.at(-1)
  if (lines.length >= 2 && lines.at(-2) === '' && footer !== undefined && footer.startsWith('(')) {
    const total = /\bof (\d+)\b|total (\d+) lines/u.exec(footer)
    if (total !== null) totalLines = Number(total[1] ?? total[2])
    lines.splice(-2, 2)
  }
  const tail = wrapped ? close : ''
  const reserve = utf8Bytes(readNotice(NOTICE_NUMBER_RESERVE, NOTICE_NUMBER_RESERVE, NOTICE_NUMBER_RESERVE, NOTICE_NUMBER_RESERVE, NOTICE_NUMBER_RESERVE, NOTICE_NUMBER_RESERVE))
  const budget = maxBytes - utf8Bytes(header) - utf8Bytes(tail) - reserve - 2
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = utf8Bytes(line) + (kept.length > 0 ? 1 : 0)
    if (used + cost > budget) break
    kept.push(line)
    used += cost
  }
  // A first line longer than the whole budget is shown cut, and the notice says so.
  let cutLineBytes: number | undefined
  if (kept.length === 0 && lines[0] !== undefined) {
    const cutLine = utf8Head(lines[0], Math.max(0, budget))
    cutLineBytes = utf8Bytes(cutLine)
    kept.push(cutLine)
  }
  const first = lineNumberOf(kept[0]) ?? 1
  const last = lineNumberOf(kept.at(-1)) ?? first + kept.length - 1
  const shown = kept.join('\n')
  return `${header}${shown}\n\n${readNotice(first, last, totalLines, utf8Bytes(shown), totalBytes, cutLineBytes)}${tail}`
}

function omissionMarker(bytes: number, lines: number): string {
  return `\n[... ${bytes} bytes (${lines} lines) omitted to fit the ~9.5 KB MCP result limit. Narrow the query to see them: ${AGENT_TOOL_PREFIX}read with offset and limit, a narrower ${AGENT_TOOL_PREFIX}grep pattern or path, or a filtered command ...]\n`
}

function boundHeadTail(text: string, totalBytes: number, maxBytes: number): string {
  const lines = text.split('\n')
  const space = Math.max(0, maxBytes - utf8Bytes(omissionMarker(NOTICE_NUMBER_RESERVE, NOTICE_NUMBER_RESERVE)))
  const headBudget = Math.floor(space * HEAD_SHARE)
  const tailBudget = space - headBudget
  let headCount = 0
  let headBytes = 0
  while (headCount < lines.length) {
    const cost = utf8Bytes(lines[headCount] as string) + (headCount > 0 ? 1 : 0)
    if (headBytes + cost > headBudget) break
    headBytes += cost
    headCount++
  }
  let tailCount = 0
  let tailBytes = 0
  while (tailCount < lines.length - headCount) {
    const cost = utf8Bytes(lines[lines.length - 1 - tailCount] as string) + (tailCount > 0 ? 1 : 0)
    if (tailBytes + cost > tailBudget) break
    tailBytes += cost
    tailCount++
  }
  // A single line longer than its share is cut on a code-point boundary instead of dropped.
  const head = headCount > 0 ? lines.slice(0, headCount).join('\n') : utf8Head(lines[0] ?? '', headBudget)
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount).join('\n') : utf8Tail(lines.at(-1) ?? '', tailBudget)
  const omittedBytes = Math.max(0, totalBytes - utf8Bytes(head) - utf8Bytes(tail))
  // A line cut on a code-point boundary is partly shown, so it does not count as omitted.
  const partialHead = headCount === 0 ? 1 : 0
  const partialTail = tailCount === 0 && lines.length - headCount - partialHead > 0 ? 1 : 0
  const omittedLines = Math.max(0, lines.length - headCount - tailCount - partialHead - partialTail)
  return `${head}${omissionMarker(omittedBytes, omittedLines)}${tail}`
}

/**
 * Bound the text of one MCP tool result as a whole. Results within the budget
 * keep their items unchanged; an oversized result is merged into one bounded
 * text item ahead of its non-text items. The text budget never drops below a
 * quarter of `MAX_BRIDGE_RESULT_BYTES`, so a suffix reserved beyond three quarters
 * of it can carry the combined result past the ceiling; the suffix itself is not cut.
 * @param toolName - DSH tool name without the `mcp_dsh_` prefix.
 * @param items - bridge content items.
 * @param reservedBytes - UTF-8 bytes the caller appends to the result afterwards.
 * @param isError - whether the tool failed; a failed result has no line window to page, so it is bounded head and tail.
 * @returns the bounded content items.
 */
export function boundBridgeContent(toolName: string, items: readonly BridgeContent[], reservedBytes = 0, isError = false): BridgeContent[] {
  const budget = Math.max(MAX_BRIDGE_RESULT_BYTES / 4, MAX_BRIDGE_RESULT_BYTES - reservedBytes)
  const texts = items.flatMap(item => item.type === 'text' ? [item.text] : [])
  if (texts.reduce((sum, text) => sum + utf8Bytes(text), 0) <= budget) return [...items]
  // An empty name selects the head-and-tail strategy.
  return [
    { type: 'text', text: boundBridgeToolText(isError ? '' : toolName, texts.join('\n'), budget) },
    ...items.filter(item => item.type !== 'text'),
  ]
}
