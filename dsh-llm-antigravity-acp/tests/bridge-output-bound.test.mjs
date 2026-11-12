// Tests of the MCP tool-result ceiling. `agy` wraps every MCP tool in an output
// truncation that splices out the middle of anything over 10,240 bytes, so the
// bridge bounds each result to 9,600 UTF-8 bytes first: a `read` keeps its
// leading complete lines and tells the agent the next `offset`, every other tool
// keeps a head and a tail around an explicit omission marker.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityAdapter } from '../lib/adapter.js'
import { bridgeSystemPrompt } from '../lib/history.js'
import { AntigravityRuntime } from '../lib/runtime.js'
import {
  boundBridgeContent, boundBridgeToolText, MAX_BRIDGE_RESULT_BYTES, MAX_EAGER_BRIDGE_TOOL_BYTES, READ_PAGING_NOTE, toBridgeTools,
} from '../lib/tool-bridge.js'

const bytes = text => Buffer.byteLength(text, 'utf8')

/** A DSH `read` result as `formatReadOutput` renders it. */
function readOutput({ path = '/w/src/big.ts', from = 1, to, total, line = n => `const value${n} = '数据行 ${n} — ${'x'.repeat(24)}'` }) {
  const lines = []
  for (let n = from; n <= to; n++) lines.push(`${n}: ${line(n)}`)
  const footer = to < total
    ? `(Showing lines ${from}-${to} of ${total}. Use offset=${to + 1} to continue.)`
    : `(End of file - total ${total} lines)`
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n\n${footer}\n</content>`
}

test('results within 9,600 bytes pass through untouched', () => {
  const small = readOutput({ to: 40, total: 40 })
  assert.ok(bytes(small) < MAX_BRIDGE_RESULT_BYTES)
  assert.equal(boundBridgeToolText('read', small), small)
  const exact = 'a'.repeat(MAX_BRIDGE_RESULT_BYTES)
  assert.equal(boundBridgeToolText('bash', exact), exact)
  const items = [{ type: 'text', text: 'ok' }, { type: 'image', data: 'aW1n', mimeType: 'image/png' }]
  assert.deepEqual(boundBridgeContent('bash', items), items)
})

test('an oversized read keeps the header and contiguous leading lines and names the next page', () => {
  const text = readOutput({ to: 2000, total: 2400 })
  assert.ok(bytes(text) > 70_000, 'fixture exceeds agy ceiling many times over')
  const bounded = boundBridgeToolText('read', text)
  assert.ok(bytes(bounded) <= MAX_BRIDGE_RESULT_BYTES, `bounded read is ${bytes(bounded)} bytes`)
  assert.ok(bounded.startsWith('<path>/w/src/big.ts</path>\n<type>file</type>\n<content>\n1: '))
  assert.ok(bounded.endsWith('\n</content>'), 'the content wrapper stays closed')
  assert.doesNotMatch(bounded, /\uFFFD/u, 'no code point is split')

  const body = bounded.slice(bounded.indexOf('<content>\n') + 10, bounded.lastIndexOf('\n\n(MCP result limit'))
  const shown = body.split('\n')
  shown.forEach((line, index) => {
    assert.equal(line, `${index + 1}: const value${index + 1} = '数据行 ${index + 1} — ${'x'.repeat(24)}'`, 'every shown line is complete and contiguous')
  })
  const last = shown.length
  assert.ok(last > 100, `a useful page is kept (${last} lines)`)
  assert.match(bounded, new RegExp(`showing lines 1-${last} of 2400 \\(\\d+ of ${bytes(text)} bytes\\)`))
  assert.match(bounded, new RegExp(`mcp_dsh_read with offset=${last + 1} and limit=160`))
  assert.doesNotMatch(bounded, /Use offset=2001/, 'the stale DSH footer is replaced')
})

test('a read that starts mid-file reports its real line range', () => {
  const bounded = boundBridgeToolText('read', readOutput({ from: 801, to: 1200, total: 1200 }))
  assert.ok(bytes(bounded) <= MAX_BRIDGE_RESULT_BYTES)
  const match = /showing lines 801-(\d+) of 1200/.exec(bounded)
  assert.ok(match, bounded.slice(-400))
  assert.match(bounded, new RegExp(`offset=${Number(match[1]) + 1} and limit=160`))
})

test('an unwrapped read result is still paged by line', () => {
  const text = Array.from({ length: 900 }, (_, i) => `${i + 1}\tline ${i + 1} ${'y'.repeat(30)}`).join('\n')
  const bounded = boundBridgeToolText('read', text)
  assert.ok(bytes(bounded) <= MAX_BRIDGE_RESULT_BYTES)
  assert.ok(bounded.startsWith('1\tline 1 '))
  assert.doesNotMatch(bounded, /<\/content>/)
  assert.match(bounded, /showing lines 1-\d+ \(/)
})

test('an oversized bash result keeps a line-aligned head and tail around an omission marker', () => {
  const lines = Array.from({ length: 1500 }, (_, i) => `[${String(i + 1).padStart(4, '0')}] 构建步骤输出 ${'z'.repeat(20)}`)
  const text = lines.join('\n')
  const bounded = boundBridgeToolText('bash', text)
  assert.ok(bytes(bounded) <= MAX_BRIDGE_RESULT_BYTES, `bounded bash is ${bytes(bounded)} bytes`)
  assert.doesNotMatch(bounded, /\uFFFD/u)
  assert.ok(bounded.startsWith(lines[0]))
  assert.ok(bounded.endsWith(lines.at(-1)))
  const marker = /\n\[\.\.\. (\d+) bytes \((\d+) lines\) omitted to fit the ~9\.5 KB MCP result limit\. Narrow the query[^\n]*mcp_dsh_read with offset and limit, a narrower mcp_dsh_grep[^\n]*\]\n/.exec(bounded)
  assert.ok(marker, 'the omission marker names the counts and how to narrow')
  const [head, tail] = bounded.split(marker[0])
  const headLines = head.split('\n')
  const tailLines = tail.split('\n')
  assert.deepEqual(headLines, lines.slice(0, headLines.length), 'the head is whole leading lines')
  assert.deepEqual(tailLines, lines.slice(lines.length - tailLines.length), 'the tail is whole trailing lines')
  assert.ok(bytes(head) > bytes(tail), 'the head gets the larger share')
  assert.equal(Number(marker[2]), lines.length - headLines.length - tailLines.length)
  assert.equal(Number(marker[1]), bytes(text) - bytes(head) - bytes(tail))
})

test('one giant line without newlines is cut on code-point boundaries', () => {
  const text = '汉'.repeat(20_000)
  const bounded = boundBridgeToolText('web_fetch', text)
  assert.ok(bytes(bounded) <= MAX_BRIDGE_RESULT_BYTES)
  assert.doesNotMatch(bounded, /\uFFFD/u)
  assert.match(bounded, /^汉+\n\[\.\.\. \d+ bytes \(0 lines\) omitted/)
  assert.match(bounded, /\]\n汉+$/)
})

test('a smaller budget is honored exactly', () => {
  const text = readOutput({ to: 500, total: 500 })
  for (const budget of [4_000, 6_000]) {
    assert.ok(bytes(boundBridgeToolText('read', text, budget)) <= budget)
    assert.ok(bytes(boundBridgeToolText('grep', text, budget)) <= budget)
  }
})

test('boundBridgeContent bounds the text of a whole result and keeps images', () => {
  const big = 'line of output\n'.repeat(1_000)
  const image = { type: 'image', data: 'aW1n', mimeType: 'image/png' }
  const bounded = boundBridgeContent('bash', [{ type: 'text', text: big }, image, { type: 'text', text: big }])
  assert.equal(bounded.length, 2)
  assert.equal(bounded[0].type, 'text')
  assert.ok(bytes(bounded[0].text) <= MAX_BRIDGE_RESULT_BYTES)
  assert.deepEqual(bounded[1], image)

  const reserved = boundBridgeContent('bash', [{ type: 'text', text: big }], 1_000)
  assert.ok(bytes(reserved[0].text) + 1_000 <= MAX_BRIDGE_RESULT_BYTES, 'reserved suffix bytes are left free')
})

test('the read descriptor and system prompt tell the agent to page large files', () => {
  const tools = toBridgeTools([
    { name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } },
    { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  ])
  const plain = (value) => String(value).replaceAll('\u200b', '')
  assert.equal(plain(tools[0].description), `Read a UTF-8 text file and return line-numbered content. ${READ_PAGING_NOTE}`)
  assert.match(READ_PAGING_NOTE, /offset and limit \(e\.g\. limit: 160\)/)
  assert.equal(plain(tools[1].description), 'Run a command', 'tool names stay literal')

  // An oversized read descriptor is compacted but keeps the paging note.
  const [compacted] = toBridgeTools([{
    name: 'read',
    description: `Read a file from the workspace with line numbers. ${'Long guidance sentence about reading files. '.repeat(40)}`,
    parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'p'.repeat(400) }, offset: { type: 'number' }, limit: { type: 'number' } } },
  }])
  assert.ok(compacted.description.replaceAll('\u200b', '').includes(READ_PAGING_NOTE))
  assert.ok(bytes(JSON.stringify(compacted)) <= MAX_EAGER_BRIDGE_TOOL_BYTES)

  assert.match(bridgeSystemPrompt('You are DSH.').replaceAll('\u200b', ''), /Each MCP tool result is capped at about 9\.5 KB[^\n]*`mcp_dsh_read`[^\n]*`offset` and `limit`/)
})

// End to end: a 70 KB DSH read result travels through the runtime's bridge to
// the fake agent, which echoes exactly what the MCP call returned.
const here = dirname(fileURLToPath(import.meta.url))
const fake = join(here, 'fake-agy.mjs')
chmodSync(fake, 0o755)
const runtimes = []
after(async () => { for (const runtime of runtimes) await runtime.dispose() })

function makeAdapter() {
  const home = mkdtempSync(join(tmpdir(), 'agy-bound-test-'))
  const runtime = new AntigravityRuntime({
    config: {
      provider: 'antigravity', displayName: 'Antigravity', command: fake, home,
      accounts: [{ id: 'default', displayName: '', home: '', enabled: true, env: {}, contextWindow: 0, system: true, visibleModels: [], priority: 1, weight: 1 }],
      contextWindow: 0, defaultEffort: 'high', autoPatch: false, patchScript: join(home, 'missing.py'),
      maxLiveSessions: 16, idleSessionTtlMs: 600_000, parkSettleMs: 80, keepAliveMs: 1_000,
      longDecodeContinuations: 3, warmup: false, quotaTtlMs: 60_000,
    },
    spawnAcp: (argv, cwd) => {
      const child = spawn(process.execPath, [argv[0], ...argv.slice(1)], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        exited: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))),
        terminate: () => child.kill(),
        stderrTail: () => '',
      }
    },
    runCommand: async argv => ({ code: 0, stdout: argv.includes('--version') ? 'fake-agy 0.0.1' : '{}', stderr: '' }),
    readImage: async () => ({ data: 'aW1n', mimeType: 'image/png' }),
    canReadImages: () => true,
    log: { info: () => undefined, warn: () => undefined },
    onModelsChanged: () => undefined,
  })
  runtimes.push(runtime)
  return new AntigravityAdapter(runtime, 'Antigravity', () => true)
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('toBridgeResult hands agy a paged read result below its 10,240-byte splice', { timeout: 60_000 }, async () => {
  const adapter = makeAdapter()
  const sys = { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are DSH.' }], source: { kind: 'system-prompt' } }
  const user = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'CALL read {"file_path":"/w/src/big.ts"}' }], source: { kind: 'user' } }
  const readTool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } }
  const base = { provider: 'antigravity', model: 'gemini-4-argon', sessionId: 'S-bound', tools: [readTool] }
  const step1 = await collect(adapter.stream({ ...base, messages: [sys, user] }))
  const call = step1.find(c => c.type === 'block-end' && c.block.type === 'tool-call').block
  assert.equal(call.name, 'read')

  const fileText = readOutput({ to: 2000, total: 2400 })
  const assistant = { id: 'a1', role: 'assistant', content: step1.filter(c => c.type === 'block-end').map(c => c.block), source: { kind: 'model', provider: 'antigravity', model: 'gemini-4-argon' } }
  const result = { id: 't1', role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: fileText }], source: { kind: 'tool', callId: call.id } }
  const step2 = await collect(adapter.stream({ ...base, messages: [sys, user, assistant, result] }))
  const reply = step2.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.ok(reply.startsWith('RESULT(read)='), reply.slice(0, 80))
  const delivered = reply.slice('RESULT(read)='.length)
  assert.ok(bytes(delivered) <= MAX_BRIDGE_RESULT_BYTES, `agy received ${bytes(delivered)} bytes`)
  assert.ok(delivered.startsWith('<path>/w/src/big.ts</path>'))
  assert.ok(delivered.endsWith('</content>'))
  assert.match(delivered, /mcp_dsh_read with offset=\d+ and limit=160/)
})

test('a read whose first line alone exceeds the budget says the line is cut', () => {
  const text = `<path>/w/min.js</path>\n<type>file</type>\n<content>\n1: ${'压'.repeat(5_000)}\n2: tail\n\n(End of file - total 2 lines)\n</content>`
  const bounded = boundBridgeToolText('read', text)
  assert.ok(bytes(bounded) <= MAX_BRIDGE_RESULT_BYTES)
  assert.doesNotMatch(bounded, /\uFFFD/u)
  assert.ok(bounded.startsWith('<path>/w/min.js</path>\n<type>file</type>\n<content>\n1: 压'))
  assert.ok(bounded.endsWith('\n</content>'))
  assert.match(bounded, /showing lines 1-1 of 2 .* Line 1 is truncated at \d+ bytes; use mcp_dsh_grep or a filtered command for the rest of it\. Call mcp_dsh_read with offset=2/)
})

test('a failed read is bounded head and tail instead of paged', () => {
  const text = `cannot read "/w/x": ${'error detail line\n'.repeat(1_000)}end of error`
  const [item] = boundBridgeContent('read', [{ type: 'text', text }], 0, true)
  assert.ok(bytes(item.text) <= MAX_BRIDGE_RESULT_BYTES)
  assert.doesNotMatch(item.text, /offset=/)
  assert.match(item.text, /omitted to fit the ~9\.5 KB MCP result limit/)
  assert.ok(item.text.endsWith('end of error'))
})

test('the read paging note stands alone on an empty description', () => {
  const [tool] = toBridgeTools([{ name: 'read', description: '', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }])
  assert.equal(tool.description.replaceAll('\u200b', ''), READ_PAGING_NOTE)
})
