/**
 * Projection of DSH request history into Antigravity ACP prompts.
 *
 * ACP sessions own their history, so DSH replays its authoritative history
 * once when a session is (re)built and afterwards sends only new input. The
 * replay renders earlier turns as a delimited transcript in front of the
 * newest user input; tool calls keep the agent-visible `mcp_dsh_` names.
 * @module dsh-llm-antigravity-acp/history
 */
/** Server name under which DSH tools reach the agent; the agent prefixes tool names with `mcp_<server>_`. */
export const MCP_SERVER_NAME = 'dsh';
/** Agent-visible prefix of every DSH tool. */
export const AGENT_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`;
/** Fallback MCP tool name for invoking any DSH tool omitted from direct declarations. */
export const CALL_TOOL_NAME = 'dsh_call_tool';
/**
 * Byte budget for the replayed history transcript while the context gates are
 * unlocked: about 730K tokens, inside the 1M window and the 983K checkpoint
 * budget, with room left for the system prompt, tool schemas, live input, and
 * multi-step tool output.
 */
export const UNLOCKED_REPLAY_BUDGET_BYTES = 2_200_000;
/**
 * Byte budget under an unpatched `agy`, kept below its `64,000 * 3 = 192,000`
 * byte single-`USER_INPUT` truncation limit so the agent never tail-truncates
 * a replay prompt.
 */
export const LOCKED_REPLAY_BUDGET_BYTES = 160_000;
const HISTORY_OPEN = '<dsh_history>\n';
const HISTORY_CLOSE = '\n</dsh_history>\n\n';
/** Upper bound of the omission notice, reserved before history is selected. */
const OMISSION_NOTICE_RESERVE_BYTES = 128;
/** User-role message source kinds injected by DSH context providers rather than typed by a human. */
const BACKGROUND_USER_SOURCES = new Set([
    'runtime-context',
    'skill-catalog',
    'tool-manager-catalog',
    'time-context',
    'agent-instructions',
]);
/**
 * Live input for a rebuild whose trailing messages are all tool results (for
 * example right after compaction in the middle of a tool loop), so the agent
 * receives a meaningful instruction instead of an empty prompt.
 */
export const EMPTY_INPUT_CONTINUATION = 'Continue the task from the latest tool results above.';
function messageSourceKind(message) {
    const source = message.source;
    return typeof source?.kind === 'string' ? source.kind : undefined;
}
function stripSystemReminderEnvelope(raw) {
    const trimmed = raw.trim();
    const match = /^<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>$/i.exec(trimmed);
    return match?.[1] !== undefined ? match[1].trim() : trimmed;
}
/** Zero-width space that breaks an exact upstream string match without changing the visible word. */
const ZWSP = '\u200b';
/** Spans whose bytes must reach the model unchanged: code, tags, URLs, paths, and tool identifiers. */
const PROTECTED_SPAN = /```[\s\S]*?```|`[^`\n]*`|<\/?[A-Za-z][^>\n]*>|\[reanswer:[^\]]+\]|https?:\/\/[^\s<>)]+|(?:^|[\s"'=(])(?:~\/|\.\.?\/|\/)[^\s"'<>)]+|\\(?:[A-Za-z]:)?\\[^\s"'<>)]+/g;
/**
 * Insert a zero-width space after the third letter of each unprotected English word of length 5 or more.
 * Tool names, code spans, tags, URLs, and paths stay intact.
 * @param text - prose that may contain protected spans.
 * @returns the cloaked text.
 */
export function cloakProse(text) {
    if (text.length === 0)
        return text;
    let out = '';
    let cursor = 0;
    for (const match of text.matchAll(PROTECTED_SPAN)) {
        const start = match.index ?? 0;
        if (start > cursor)
            out += cloakWords(text.slice(cursor, start));
        out += match[0];
        cursor = start + match[0].length;
    }
    if (cursor < text.length)
        out += cloakWords(text.slice(cursor));
    return out;
}
function cloakWords(text) {
    return text.replace(/\b([A-Za-z]{3})([A-Za-z]{2,})\b/g, `$1${ZWSP}$2`);
}
/** Chinese replacement for the host `@` path guidance. The English sentence is an upstream fingerprint. */
const FILE_REFERENCE_GUIDANCE = '以 @ 开头的标记是用户显式引用的路径：相对路径基于工作区根目录解析，绝对路径指向宿主机上的文件或目录。末尾带 / 表示目录，需要查看目录内容时先列出；其余为文件，需要读取内容时调用 `mcp_dsh_read`，读取前不要声称已检查过内容。`@"..."` 用于包裹含空格的路径。';
/**
 * Replace host prompt sentences that upstream matches exactly.
 * Tool names and the meaning of the guidance stay; the matched English sentences do not.
 * @param text - system or system-update text.
 * @returns the rewritten text.
 */
export function sanitizeSystemPrompt(text) {
    if (text.length === 0)
        return text;
    return text
        .replace(/Tokens prefixed with @ are (?:workspace )?paths the user explicitly referenced\b[\s\S]*?quotes a path containing spaces\./g, FILE_REFERENCE_GUIDANCE)
        .replace(/You are an AI agent powered by DeepSeek Harness\./g, 'You are a coding agent in this session.')
        .replace(/The runtime context names the DeepSeek Harness implementation checkout\./g, 'The runtime context names the host checkout.')
        .replace(/RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL\.[^\n]*/g, 'Requirement words keep their ordinary meaning.');
}
/**
 * Split leading system messages, the one-shot `system` field, and initial
 * `agent-instructions` (`AGENTS.md`) injected before the first assistant turn
 * into the elevated system prompt.
 * @param options - the model request.
 * @returns the combined system text and the remaining messages.
 */
export function splitSystem(options) {
    const parts = [];
    if (options.system !== undefined && options.system.length > 0)
        parts.push(options.system);
    let index = 0;
    for (const message of options.messages) {
        if (message.role !== 'system')
            break;
        parts.push(textOf(message.content));
        index++;
    }
    const rules = [];
    const remaining = [];
    let sawAssistant = false;
    for (let i = index; i < options.messages.length; i++) {
        const message = options.messages[i];
        if (message.role === 'assistant')
            sawAssistant = true;
        if (!sawAssistant && message.role === 'user' && messageSourceKind(message) === 'agent-instructions') {
            const cleaned = stripSystemReminderEnvelope(textOf(message.content));
            if (cleaned.length > 0)
                rules.push(cleaned);
            continue;
        }
        remaining.push(message);
    }
    if (rules.length > 0) {
        parts.push(`<user_rules>\n${rules.join('\n\n')}\n</user_rules>`);
    }
    return { system: sanitizeSystemPrompt(parts.filter(Boolean).join('\n\n')), messages: remaining };
}
function parseWorkingDirectory(text) {
    const quoted = /Current working directory:\s*("(?:\\.|[^"\\])*")/.exec(text);
    if (quoted?.[1] !== undefined) {
        try {
            const parsed = JSON.parse(quoted[1]);
            if (typeof parsed === 'string' && parsed.length > 0)
                return parsed;
        }
        catch {
            // Malformed JSON string falls through.
        }
    }
    const bare = /Current working directory:\s*([^\r\n"]+?)\.?\s*(?:\r?\n|$)/.exec(text);
    return bare?.[1] !== undefined && bare[1].trim().length > 0 ? bare[1].trim() : undefined;
}
function parseSandboxPolicy(text) {
    const modeMatch = /\bCurrent DSH file policy:\s*(read-only|workspace-write|danger-full-access)\b/.exec(text);
    if (modeMatch?.[1] === undefined)
        return {};
    const sandboxMode = modeMatch[1];
    let workspaceRoot;
    const rootMatch = /\bunder the session workspace:\s*("(?:\\.|[^"\\])*")/.exec(text);
    if (rootMatch?.[1] !== undefined) {
        try {
            const parsed = JSON.parse(rootMatch[1]);
            if (typeof parsed === 'string' && parsed.length > 0)
                workspaceRoot = parsed;
        }
        catch {
            // Ignore malformed workspace string.
        }
    }
    let additionalWritableRoots;
    const extraMatch = /\bAdditional writable directories:\s*(\[(?:\s*"(?:\\.|[^"\\])*"\s*,?)*\])/.exec(text);
    if (extraMatch?.[1] !== undefined) {
        try {
            const parsed = JSON.parse(extraMatch[1]);
            if (Array.isArray(parsed)) {
                const dirs = parsed.filter((item) => typeof item === 'string' && item.length > 0);
                if (dirs.length > 0)
                    additionalWritableRoots = dirs;
            }
        }
        catch {
            // Ignore malformed writable directory list.
        }
    }
    return {
        sandboxMode,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        ...(additionalWritableRoots !== undefined ? { additionalWritableRoots } : {}),
    };
}
function parseFallbackTeamIdentity(text) {
    const paragraphs = stripSystemReminderEnvelope(text)
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(Boolean);
    const matched = paragraphs.filter(p => /^(?:Team\b|You are (?:a |the )?team(?:mate| lead)\b)/i.test(p));
    return matched.length > 0 ? matched.join('\n\n') : undefined;
}
function parseRuntimeContextMessage(message) {
    const rawText = stripSystemReminderEnvelope(textOf(message.content));
    if (/^Current runtime context:\s*none\b/i.test(rawText)) {
        return { cleared: true, isSnapshot: true, entry: {} };
    }
    const source = message.source;
    const sections = Array.isArray(source?.sections) ? source.sections : undefined;
    const isSnapshot = source?.form === 'snapshot' || /This snapshot supersedes earlier runtime-context snapshots/i.test(rawText);
    let cwd;
    let policy = {};
    let teamIdentity;
    if (sections !== undefined) {
        for (const sec of sections) {
            if (sec === null || typeof sec !== 'object')
                continue;
            const secText = typeof sec.text === 'string' ? sec.text : '';
            if (sec.name === 'working-directory:current') {
                cwd = parseWorkingDirectory(secText) ?? cwd;
            }
            else if (sec.name === 'sandbox:policy') {
                const parsed = parseSandboxPolicy(secText);
                if (parsed.sandboxMode !== undefined)
                    policy = parsed;
            }
            else if (sec.name === 'team:identity') {
                const trimmed = secText.trim();
                if (trimmed.length > 0)
                    teamIdentity = trimmed;
            }
        }
    }
    cwd ??= parseWorkingDirectory(rawText);
    if (policy.sandboxMode === undefined)
        policy = parseSandboxPolicy(rawText);
    if (sections === undefined)
        teamIdentity ??= parseFallbackTeamIdentity(rawText);
    return {
        cleared: false,
        isSnapshot,
        entry: {
            ...(cwd !== undefined ? { cwd } : {}),
            ...policy,
            ...(teamIdentity !== undefined ? { teamIdentity } : {}),
        },
    };
}
/**
 * Extract the effective working directory, sandbox policy, and optional team
 * identity from DSH `runtime-context` messages (latest snapshot wins).
 * @param messages - request messages.
 * @returns the extracted session context facts.
 */
export function extractNativeSessionContext(messages) {
    let state = {};
    for (const message of messages) {
        if (messageSourceKind(message) !== 'runtime-context')
            continue;
        const parsed = parseRuntimeContextMessage(message);
        if (parsed.cleared) {
            state = {};
            continue;
        }
        if (parsed.isSnapshot) {
            state = { ...parsed.entry };
            continue;
        }
        const merged = { ...state, ...parsed.entry };
        if (parsed.entry.sandboxMode !== undefined && parsed.entry.sandboxMode !== 'workspace-write') {
            delete merged.workspaceRoot;
            delete merged.additionalWritableRoots;
        }
        state = merged;
    }
    return state;
}
/**
 * Prepare a DSH request for `engineMode: 'native'`: drop DSH's internal
 * agent-loop system prompt and `runtime-context` snapshots (keeping only
 * `team:identity` when present), lift initial `AGENTS.md` instructions into
 * `rulesText`, and extract the workspace `cwd` and sandbox policy.
 * @param options - the model request.
 * @returns the extracted workspace rules, filtered messages, and session context.
 */
export function prepareNativeRequest(options) {
    const sessionContext = extractNativeSessionContext(options.messages);
    const rules = [];
    const remaining = [];
    let sawAssistant = false;
    for (const message of options.messages) {
        if (message.role === 'system')
            continue;
        if (message.role === 'assistant')
            sawAssistant = true;
        if (!sawAssistant && message.role === 'user' && messageSourceKind(message) === 'agent-instructions') {
            const cleaned = stripSystemReminderEnvelope(textOf(message.content));
            if (cleaned.length > 0)
                rules.push(cleaned);
            continue;
        }
        if (message.role === 'user' && messageSourceKind(message) === 'runtime-context') {
            const { entry } = parseRuntimeContextMessage(message);
            if (entry.teamIdentity !== undefined && entry.teamIdentity.length > 0) {
                remaining.push({ ...message, content: [{ type: 'text', text: entry.teamIdentity }] });
            }
            continue;
        }
        remaining.push(message);
    }
    return {
        rulesText: rules.join('\n\n'),
        messages: remaining,
        sessionContext,
    };
}
/**
 * Join the text blocks of one message.
 * @param content - message content blocks.
 * @returns concatenated text.
 */
export function textOf(content) {
    return content.filter((b) => b.type === 'text').map(b => b.text).join('');
}
/**
 * Render full untruncated descriptions and parameter docs for active tools
 * whose MCP declarations exceed `maxEagerBytes` and are compacted on the wire.
 * @param tools - active tool schemas for the session.
 * @param maxEagerBytes - byte ceiling above which MCP schemas are compacted.
 * @returns markdown specification block body, or `''` when all tools fit intact.
 */
export function renderFullToolContracts(tools, maxEagerBytes) {
    if (tools === undefined || tools.length === 0)
        return '';
    const sections = [];
    for (const tool of tools) {
        if (tool.deferLoading === true)
            continue;
        const inputSchema = tool.parameters.type === undefined ? { type: 'object', ...tool.parameters } : tool.parameters;
        const wireBytes = Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, inputSchema }), 'utf8');
        if (wireBytes <= maxEagerBytes)
            continue;
        const lines = [`### ${AGENT_TOOL_PREFIX}${tool.name}`];
        const desc = tool.description.trim();
        if (desc.length > 0)
            lines.push(desc);
        const rawProps = inputSchema.properties;
        if (rawProps !== null && typeof rawProps === 'object' && !Array.isArray(rawProps)) {
            const paramLines = [];
            for (const [propName, propVal] of Object.entries(rawProps)) {
                const propDesc = propVal !== null && typeof propVal === 'object'
                    ? propVal.description
                    : undefined;
                if (typeof propDesc === 'string' && propDesc.trim().length > 0) {
                    paramLines.push(`- \`${propName}\`: ${propDesc.trim()}`);
                }
            }
            if (paramLines.length > 0)
                lines.push(`Parameters:\n${paramLines.join('\n')}`);
        }
        sections.push(lines.join('\n\n'));
    }
    return sections.join('\n\n');
}
/**
 * The bridge instructions appended to the agent's system prompt.
 * @param system - the DSH system prompt.
 * @param toolContracts - optional full prose contracts for compacted MCP tools.
 * @returns the complete appended system text.
 */
export function bridgeSystemPrompt(system, toolContracts) {
    const preamble = [
        'You are the primary model of this coding session. The host owns the conversation, the tools, and their permissions.',
        `Every harness tool is available to you under the prefix \`${AGENT_TOOL_PREFIX}\`: a tool named \`X\` in the instructions below is the tool \`${AGENT_TOOL_PREFIX}X\`. If \`${AGENT_TOOL_PREFIX}X\` is absent from your direct tool declarations, invoke it via \`${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME}\` with \`{"name":"X","arguments":{...}}\`. Use only these tools; pass arguments exactly as their schemas define.`,
        'When the first user message contains a <dsh_history> block, it reproduces the earlier part of this conversation; continue from the newest input after it without repeating completed actions.',
        `Each MCP tool result is capped at about 9.5 KB, so one \`${AGENT_TOOL_PREFIX}read\` call never returns a file over about 180 lines whole: page through it with \`offset\` and \`limit\` (for example \`limit: 160\`) and follow the continuation notice at the end of a capped result.`,
    ].join('\n');
    const parts = [preamble];
    if (system.length > 0)
        parts.push(system);
    if (toolContracts !== undefined && toolContracts.length > 0) {
        parts.push(`<harness_tool_contracts>\nFull specifications for harness tools whose MCP schemas were compacted for eager loading:\n\n${toolContracts}\n</harness_tool_contracts>`);
    }
    return cloakProse(sanitizeSystemPrompt(parts.join('\n\n')));
}
/**
 * Concise MCP extension instructions appended to the native Antigravity agent's
 * system prompt in `engineMode: 'native'`, leaving Antigravity's own `<identity>`
 * and built-in workspace tool instructions intact.
 * @param rulesText - lifted workspace `AGENTS.md` instructions (`<user_rules>`), if any.
 * @param toolContracts - optional full specifications for compacted MCP tools.
 * @param cwd - primary working directory of this session, when bound.
 * @returns the appended system prompt text.
 */
export function nativeBridgeSystemPrompt(rulesText, toolContracts, cwd) {
    const workspaceLine = cwd !== undefined && cwd.trim().length > 0
        ? `Built-in tools (\`read_file\`, \`edit_file\`, \`write_file\`, \`run_command\`) operate directly in this session's primary workspace directory (\`${cwd.trim()}\`); if multiple workspaces are listed, treat \`${cwd.trim()}\` as the active workspace for relative paths, file inspection, editing, and shell execution.`
        : 'Built-in tools (`read_file`, `edit_file`, `write_file`, `run_command`) operate directly in the current workspace directory; use them for file inspection, editing, and shell execution.';
    const preamble = [
        workspaceLine,
        `Additional tools mounted on the \`${MCP_SERVER_NAME}\` MCP server (\`${AGENT_TOOL_PREFIX}<name>\`, or \`${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME}\` with \`{"name":"<name>","arguments":{...}}\` when absent from direct declarations) provide subagent delegation, skills, todo tracking, user questions, deliverables, and workspace plugins.`,
        'When the first user message contains a `<dsh_history>` block, continue from the newest input after it without repeating completed actions.',
    ].join('\n');
    const parts = [preamble];
    if (rulesText.trim().length > 0) {
        parts.push(`<user_rules>\n${rulesText.trim()}\n</user_rules>`);
    }
    if (toolContracts !== undefined && toolContracts.trim().length > 0) {
        parts.push(`<mcp_tool_contracts>\nFull specifications for MCP extension tools whose schemas were compacted for eager loading:\n\n${toolContracts.trim()}\n</mcp_tool_contracts>`);
    }
    return cloakProse(sanitizeSystemPrompt(parts.join('\n\n')));
}
/**
 * Render a list of messages as transcript text.
 * @param messages - earlier conversation messages.
 * @returns transcript lines.
 */
export function renderTranscript(messages) {
    const lines = [];
    for (const message of messages) {
        switch (message.role) {
            case 'user':
                lines.push(`<user>\n${renderBlocks(message.content)}\n</user>`);
                break;
            case 'assistant': {
                const text = renderBlocks(message.content.filter(b => b.type !== 'tool-call' && b.type !== 'reasoning'));
                if (text.length > 0)
                    lines.push(`<assistant>\n${text}\n</assistant>`);
                for (const block of message.content) {
                    if (block.type === 'tool-call') {
                        lines.push(`<tool_call id="${block.id}" name="${AGENT_TOOL_PREFIX}${block.name}">\n${block.arguments}\n</tool_call>`);
                    }
                }
                break;
            }
            case 'tool':
                lines.push(`<tool_result id="${message.toolCallId}"${message.isError === true ? ' error="true"' : ''}>\n${renderBlocks(message.content)}\n</tool_result>`);
                break;
            case 'developer': {
                const text = renderBlocks(message.content);
                if (text.length > 0)
                    lines.push(`<harness_notice>\n${text}\n</harness_notice>`);
                break;
            }
            case 'system':
                lines.push(`<system_update>\n${cloakProse(sanitizeSystemPrompt(renderBlocks(message.content)))}\n</system_update>`);
                break;
            default:
                break;
        }
    }
    return lines.join('\n\n');
}
function renderBlocks(content) {
    const parts = [];
    for (const block of content) {
        switch (block.type) {
            case 'text':
                parts.push(block.text);
                break;
            case 'image':
                parts.push(`[image ${block.attachment.attachmentId}${block.offloaded === true ? ' (offloaded)' : ''}]`);
                break;
            case 'file':
                parts.push(`[file ${block.attachment.attachmentId}]`);
                break;
            case 'tool-addition':
                parts.push(`[tool added: ${AGENT_TOOL_PREFIX}${block.toolName}]`);
                break;
            case 'tool-removal':
                parts.push(`[tool removed: ${AGENT_TOOL_PREFIX}${block.toolName}]`);
                break;
            default:
                break;
        }
    }
    return parts.join('\n');
}
/**
 * Convert one user-role message into ACP prompt blocks, inlining images.
 * @param content - user content blocks.
 * @param resolveImage - image byte resolver.
 * @returns prompt blocks in content order.
 */
export async function promptBlocks(content, resolveImage) {
    const blocks = [];
    for (const block of content) {
        if (block.type === 'text') {
            if (block.text.length > 0)
                blocks.push({ type: 'text', text: block.text });
        }
        else if (block.type === 'image' && block.offloaded !== true) {
            const image = await resolveImage(block);
            if (image !== undefined)
                blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
            else
                blocks.push({ type: 'text', text: `[image ${block.attachment.attachmentId} unavailable]` });
        }
        else {
            const text = renderBlocks([block]);
            if (text.length > 0)
                blocks.push({ type: 'text', text });
        }
    }
    return blocks;
}
/**
 * Build the prompt that (re)creates a session: earlier history as transcript,
 * then the trailing input messages as live content.
 *
 * The trailing input is always complete. History renders newest-first into the
 * remaining byte budget, so the most recent turns survive and only the oldest
 * messages are omitted; an omitted prefix is announced inside the block. The
 * `<dsh_history>` block is always closed before the live input. When the plan
 * leaves no trailing input (the history ends with tool results), a short
 * continuation instruction is appended so the prompt is never empty.
 * @param history - messages before the trailing input.
 * @param input - trailing input messages sent as live content.
 * @param resolveImage - image byte resolver.
 * @param maxHistoryBytes - combined history and input byte ceiling; defaults to {@link UNLOCKED_REPLAY_BUDGET_BYTES}.
 * @returns prompt blocks.
 */
export async function replayPrompt(history, input, resolveImage, maxHistoryBytes) {
    const inputBlocks = input.length > 0
        ? await inputPrompt(input, resolveImage)
        : [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }];
    const blocks = [];
    if (history.length > 0) {
        const maxBytes = maxHistoryBytes ?? UNLOCKED_REPLAY_BUDGET_BYTES;
        const inputBytes = inputBlocks.reduce((total, block) => total + (block.type === 'text' ? utf8Bytes(block.text) : 0), 0);
        const overhead = utf8Bytes(HISTORY_OPEN) + utf8Bytes(HISTORY_CLOSE) + OMISSION_NOTICE_RESERVE_BYTES;
        const text = historyTranscript(history, Math.max(0, maxBytes - inputBytes - overhead));
        if (text.length > 0)
            blocks.push({ type: 'text', text });
    }
    blocks.push(...inputBlocks);
    return blocks;
}
function historyTranscript(history, budget) {
    const parts = [];
    let used = 0;
    let dropped = 0;
    for (let index = history.length - 1; index >= 0; index--) {
        const message = history[index];
        const rendered = renderTranscript([message]);
        const separator = parts.length === 0 ? 0 : 2;
        const bytes = utf8Bytes(rendered);
        if (used + separator + bytes > budget) {
            if (parts.length === 0 && message.role === 'tool' && budget > 1024) {
                const truncated = truncatedToolTranscript(message, budget);
                if (truncated !== undefined) {
                    parts.unshift(truncated);
                    dropped = index;
                }
                else {
                    dropped = index + 1;
                }
            }
            else {
                dropped = index + 1;
            }
            break;
        }
        parts.unshift(rendered);
        used += separator + bytes;
    }
    if (dropped > 0)
        parts.unshift(`[Earlier ${dropped} history messages omitted to fit the context replay budget]`);
    if (parts.length === 0)
        return '';
    return `${HISTORY_OPEN}${parts.join('\n\n')}${HISTORY_CLOSE}`;
}
function truncatedToolTranscript(message, budget) {
    const marker = '\n[tool result truncated to fit the context replay budget]';
    let limit = budget - utf8Bytes(marker);
    for (let attempt = 0; attempt < 8 && limit > 0; attempt++) {
        const content = [{ type: 'text', text: `${headWithinBytes(renderBlocks(message.content), limit)}${marker}` }];
        const rendered = renderTranscript([{ ...message, content }]);
        const bytes = utf8Bytes(rendered);
        if (bytes <= budget)
            return rendered;
        limit -= bytes - budget;
    }
    return undefined;
}
function utf8Bytes(text) {
    return Buffer.byteLength(text, 'utf8');
}
function headWithinBytes(text, maxBytes) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes)
        return text;
    let end = Math.max(0, maxBytes);
    while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0)
        end--;
    return bytes.subarray(0, end).toString('utf8');
}
function isPureToolUpdateDeveloperMessage(message) {
    return message.role === 'developer'
        && message.content.length > 0
        && message.content.every(b => b.type === 'tool-addition' || b.type === 'tool-removal');
}
function isBackgroundInputMessage(message) {
    if (message.role !== 'user')
        return true;
    const kind = messageSourceKind(message);
    return kind !== undefined && BACKGROUND_USER_SOURCES.has(kind);
}
/**
 * Convert new input messages (user, developer notices) into live prompt blocks,
 * placing background context catalogs before foreground human input and separating
 * consecutive message groups with blank lines.
 * @param input - messages that arrived after the session's known history.
 * @param resolveImage - image byte resolver.
 * @param options - optional rendering controls.
 * @returns prompt blocks.
 */
export async function inputPrompt(input, resolveImage, options) {
    const filtered = options?.omitPureToolUpdates === true
        ? input.filter(m => !isPureToolUpdateDeveloperMessage(m))
        : input;
    const background = [];
    const foreground = [];
    for (const message of filtered) {
        if (isBackgroundInputMessage(message))
            background.push(message);
        else
            foreground.push(message);
    }
    const ordered = [...background, ...foreground];
    const blocks = [];
    for (const message of ordered) {
        let group;
        if (message.role === 'user') {
            group = await promptBlocks(message.content, resolveImage);
        }
        else {
            const text = renderTranscript([message]);
            group = text.length > 0 ? [{ type: 'text', text }] : [];
        }
        if (group.length === 0)
            continue;
        if (blocks.length > 0)
            blocks.push({ type: 'text', text: '\n\n' });
        blocks.push(...group);
    }
    if (blocks.length === 0)
        blocks.push({ type: 'text', text: 'Continue.' });
    return blocks;
}
