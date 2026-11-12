import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bridgeSystemPrompt, cloakProse, nativeBridgeSystemPrompt, sanitizeSystemPrompt, splitSystem } from '../lib/history.js'
import { toBridgeTools } from '../lib/tool-bridge.js'
import { prepareHome } from '../lib/preflight.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FILE_REFERENCE = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.'
const RFC = "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. 'NEVER' = 'MUST NOT'; 'AVOID' = 'SHOULD NOT'."

test('known fingerprint sentences are rewritten before any zero-width spacing', () => {
  const source = [
    'You are an AI agent powered by DeepSeek Harness.',
    FILE_REFERENCE,
    'The runtime context names the DeepSeek Harness implementation checkout. The checkout location stays separate.',
    RFC,
    'Use `mcp_dsh_read` for files.',
  ].join('\n')
  const sanitized = sanitizeSystemPrompt(source)
  assert.doesNotMatch(sanitized, /Tokens prefixed with @/)
  assert.doesNotMatch(sanitized, /powered by DeepSeek Harness/)
  assert.doesNotMatch(sanitized, /DeepSeek Harness implementation checkout/)
  assert.doesNotMatch(sanitized, /RFC 2119 keywords/)
  assert.match(sanitized, /以 @ 开头的标记是用户显式引用的路径/)
  assert.match(sanitized, /`mcp_dsh_read`/)
  assert.match(sanitized, /The checkout location stays separate/)
})

test('prose words of five or more letters gain one zero-width space while code, tags, urls, paths, and tool ids stay literal', () => {
  const text = [
    'Read the workspace before editing.',
    'Call `mcp_dsh_read` or `dsh_call_tool` with {"name":"read"}.',
    '```',
    'const answer = "unchanged tokens here"',
    '```',
    '<user_rules>keep RULE_ONE</user_rules>',
    'See https://antigravity.google/docs/models and /Users/luoluo/project.',
  ].join('\n')
  const cloaked = cloakProse(text)
  assert.match(cloaked, /Read the wor\u200bkspace bef\u200bore edi\u200bting/)
  assert.match(cloaked, /`mcp_dsh_read`/)
  assert.match(cloaked, /`dsh_call_tool`/)
  assert.match(cloaked, /const answer = "unchanged tokens here"/)
  assert.match(cloaked, /<user_rules>keep RULE_ONE<\/user_rules>/)
  assert.match(cloaked, /https:\/\/antigravity\.google\/docs\/models/)
  assert.match(cloaked, /\/Users\/luoluo\/project/)
  assert.doesNotMatch(cloaked, /workspace/)
})

test('the bridge prompt drops the harness name and cloaks the rewritten system text once', () => {
  const split = splitSystem({
    system: `You are an AI agent powered by DeepSeek Harness.\n${FILE_REFERENCE}`,
    messages: [],
  })
  assert.match(split.system, /以 @ 开头的标记/)
  assert.doesNotMatch(split.system, /\u200b/)
  const prompt = bridgeSystemPrompt(`[reanswer:abc123:1]\n\n${split.system}`)
  const plain = prompt.replaceAll('\u200b', '')
  assert.match(plain, /primary model of this coding session/)
  assert.doesNotMatch(prompt, /DeepSeek Harness/)
  assert.doesNotMatch(prompt, /Tokens prefixed with @/)
  assert.match(prompt, /pri\u200bmary/)
  assert.match(prompt, /\[reanswer:abc123:1\]/)
  assert.equal(prompt.replaceAll('\u200b', '').split('以 @').length - 1, 1)
})

test('native prompts cloak rules without renaming built-in tools', () => {
  const prompt = nativeBridgeSystemPrompt(`${FILE_REFERENCE}\nRULE_ONE`, undefined, '/tmp/workspace')
  assert.doesNotMatch(prompt, /Tokens prefixed with @/)
  assert.match(prompt, /read_file/)
  assert.match(prompt, /`\/tmp\/workspace`/)
  assert.match(prompt, /RULE_ONE/)
})

test('advertised tool names stay exact while descriptions are cloaked', () => {
  const [tool] = toBridgeTools([{
    name: 'todo_write',
    description: 'Update the session todo list.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the item', enum: ['open', 'done'] },
      },
      required: ['title'],
    },
  }])
  assert.equal(tool.name, 'todo_write')
  assert.match(tool.description, /Upd\u200bate/)
  assert.equal(tool.inputSchema.properties.title.enum.join(','), 'open,done')
  assert.match(tool.inputSchema.properties.title.description, /Sho\u200brt/)
  assert.equal(tool.inputSchema.required[0], 'title')
})

test('the bridge agent file opens with the Antigravity identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-identity-'))
  prepareHome(home, home)
  const agent = readFileSync(join(home, 'config', 'plugins', 'dsh-bridge', 'agents', 'dsh-bridge.md'), 'utf8')
  assert.match(agent, /<identity>\nYou are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding\./)
  assert.doesNotMatch(agent, /DeepSeek Harness/)
})
