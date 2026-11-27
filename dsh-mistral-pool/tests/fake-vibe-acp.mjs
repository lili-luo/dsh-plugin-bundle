#!/usr/bin/env node
/**
 * Scriptable mock `vibe-acp` binary for `tests/acp.test.mjs`.
 *
 * Implements the ACP v1 JSON-RPC 2.0 subset and exercises Streamable-HTTP MCP
 * tool discovery, tool calls, `[DSH_RELAY]` -> `dsh_await_result`, permissions,
 * cancellation, cumulative `usage_update`, and `402` key failover.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const stdin = process.stdin
const stdout = process.stdout
stdin.setEncoding('utf8')

let buffer = ''
let mcpConfig = null
let activePrompt = null
let turnCount = 0
let cumPrompt = 0
let cumOutput = 0
let cumCached = 0
const sessionId = 'fake-vibe-session-1'

function send(msg) {
  stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
}

function sendNotify(method, params) {
  send({ method, params })
}

let reqId = 1
const pendingClientReqs = new Map()
function requestClient(method, params) {
  const id = `agent_${reqId++}`
  return new Promise((resolve, reject) => {
    pendingClientReqs.set(id, { resolve, reject })
    send({ id, method, params })
  })
}

async function mcpPost(method, params) {
  if (!mcpConfig) throw new Error('No MCP server registered')
  const headers = { 'content-type': 'application/json' }
  for (const h of mcpConfig.headers ?? []) {
    headers[h.name] = h.value
  }
  const body = method === 'notifications/initialized'
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: reqId++, method, params }
  const res = await fetch(mcpConfig.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (res.status === 202) return null
  const ctype = res.headers.get('content-type') || ''
  if (ctype.includes('text/event-stream')) {
    const text = await res.text()
    const lines = text.split('\n')
    let last = null
    for (const line of lines) {
      if (line.startsWith('data:')) {
        last = JSON.parse(line.slice(5).trim())
      }
    }
    return last?.result
  }
  const json = await res.json()
  return json.result
}

function promptText(blocks) {
  return (blocks ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')
}

async function handlePrompt(rpcId, params) {
  const apiKey = process.env.MISTRAL_API_KEY || ''
  const vibeHome = process.env.VIBE_HOME || ''
  const configToml = vibeHome && existsSync(join(vibeHome, 'config.toml'))
    ? readFileSync(join(vibeHome, 'config.toml'), 'utf8')
    : ''

  if (apiKey.includes('dead')) {
    send({
      id: rpcId,
      error: { code: -32603, message: 'Provider billing denied (HTTP 402): insufficient credits' },
    })
    return
  }

  turnCount += 1
  const text = promptText(params.prompt)
  let cancelled = false
  activePrompt = {
    cancel: () => { cancelled = true },
  }

  try {
    if (text.includes('TRIGGER_PERMISSION')) {
      const denyRes = await requestClient('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'tc_bash', name: 'bash', _meta: { toolName: 'bash' } },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
        ],
      })
      const allowRes = await requestClient('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'tc_ts', name: 'run_typescript', _meta: { toolName: 'run_typescript' } },
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
        ],
      })
      sendNotify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `perm:${denyRes?.outcome?.optionId}/${allowRes?.outcome?.optionId}` },
        },
      })
      send({ id: rpcId, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } })
      return
    }

    if (text.includes('TRIGGER_SLOW_HANG')) {
      sendNotify('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } },
      })
      for (let i = 0; i < 40 && !cancelled; i += 1) {
        await new Promise((r) => setTimeout(r, 50))
      }
      send({ id: rpcId, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } })
      return
    }

    if (text.includes('TRIGGER_PARALLEL')) {
      cumPrompt += 100
      cumOutput += 20
      cumCached += 40
      sendNotify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 100,
          size: 1048576,
          _meta: { promptTokens: cumPrompt, completionTokens: cumOutput, cachedTokens: cumCached },
        },
      })
      const [r1, r2] = await Promise.all([
        mcpPost('tools/call', { name: 'read', arguments: { path: 'a.txt' } }),
        mcpPost('tools/call', { name: 'grep', arguments: { query: 'foo' } }),
      ])
      const t1 = r1?.content?.[0]?.text ?? ''
      const t2 = r2?.content?.[0]?.text ?? ''
      cumPrompt += 180
      cumOutput += 15
      cumCached += 120
      sendNotify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `parallel:${t1}+${t2}` },
        },
      })
      send({
        id: rpcId,
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: cumPrompt, outputTokens: cumOutput, cachedReadTokens: cumCached },
        },
      })
      return
    }

    if (text.includes('TRIGGER_TOOL')) {
      sendNotify('session/update', {
        sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'calling tool' } },
      })
      cumPrompt += 120
      cumOutput += 15
      cumCached += 20
      sendNotify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: 120,
          size: 1048576,
          _meta: { promptTokens: cumPrompt, completionTokens: cumOutput, cachedTokens: cumCached },
        },
      })
      let res = await mcpPost('tools/call', { name: 'read', arguments: { path: 'hello.txt' } })
      let txt = res?.content?.[0]?.text ?? ''
      let relayed = false
      for (let hop = 0; hop < 5 && txt.includes('[DSH_RELAY]'); hop += 1) {
        const relayMatch = /call_id:\s*"([^"]+)"/.exec(txt)
        if (!relayMatch) break
        relayed = true
        res = await mcpPost('tools/call', { name: 'dsh_await_result', arguments: { call_id: relayMatch[1] } })
        txt = res?.content?.[0]?.text ?? ''
      }
      if (relayed) txt = `relayed:${txt}`
      cumPrompt += 200
      cumOutput += 12
      cumCached += 120
      sendNotify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `tool:${txt}` },
        },
      })
      send({
        id: rpcId,
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: cumPrompt, outputTokens: cumOutput, cachedReadTokens: cumCached },
        },
      })
      return
    }

    cumPrompt += 100
    cumOutput += 10
    cumCached += turnCount > 1 ? 80 : 0
    sendNotify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'reasoning' },
      },
    })
    const activeMatch = /active_model\s*=\s*"([^"]+)"/.exec(configToml)
    const activeModel = activeMatch ? activeMatch[1] : 'unknown'
    sendNotify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `ok:turn=${turnCount}:key=${apiKey.slice(-4)}:model=${activeModel}:has_ctx=${text.includes('<dsh_context>')}:body=${text.split('\n').pop()}`,
        },
      },
    })
    send({
      id: rpcId,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: cumPrompt, outputTokens: cumOutput, cachedReadTokens: cumCached },
      },
    })
  } finally {
    activePrompt = null
  }
}

async function onMessage(msg) {
  if (msg.method === undefined && msg.id !== undefined) {
    const waiter = pendingClientReqs.get(msg.id)
    if (waiter) {
      pendingClientReqs.delete(msg.id)
      waiter.resolve(msg.result)
    }
    return
  }

  if (msg.method === 'session/cancel') {
    activePrompt?.cancel()
    return
  }

  const id = msg.id
  if (id === undefined || id === null) return

  switch (msg.method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true } },
          agentInfo: { name: '@mistralai/mistral-vibe', title: 'Mistral Vibe', version: '3.1.3-fake' },
        },
      })
      break
    case 'session/new': {
      mcpConfig = msg.params?.mcpServers?.[0] ?? null
      send({
        id,
        result: {
          sessionId,
          modes: { currentModeId: 'dsh-bridge', availableModes: [{ id: 'dsh-bridge', name: 'DSH Bridge' }] },
          configOptions: [],
        },
      })
      if (mcpConfig) {
        setTimeout(() => {
          void (async () => {
            await mcpPost('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
            await mcpPost('notifications/initialized', {})
            await mcpPost('tools/list', {})
          })().catch(() => {})
        }, 15)
      }
      break
    }
    case 'session/prompt':
      void handlePrompt(id, msg.params)
      break
    case 'session/close':
      send({ id, result: {} })
      break
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
      break
  }
}

stdin.on('data', (chunk) => {
  buffer += chunk
  let nl = buffer.indexOf('\n')
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line) {
      try { void onMessage(JSON.parse(line)) } catch { /* ignore */ }
    }
    nl = buffer.indexOf('\n')
  }
})
