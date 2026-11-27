/**
 * Direct OpenAI Responses streaming client for `dsh-mistral-pool`.
 *
 * Converts DSH canonical `GenerateOptions` (messages, system prompt, tools,
 * deferred tool updates, attachments, reasoning effort) into OpenAI Responses
 * SSE requests pointed at the plugin's own loopback proxy, then translates the
 * SSE stream back into DSH `StreamChunk` events.
 * @module dsh-mistral-pool/direct-stream
 */

import {
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  createStructuredError,
  formatOffloadedImagePlaceholder,
  isImageLimitUpstreamError,
  reactiveImageOffloadCount,
  requiredOffloadForRoles,
} from './image-budget.js'
import { resolveMaxRequestImages } from './adapter.js'

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])
const CONTEXT_OVERFLOW_RE = /context[\s_-](?:length|window)[\s_-](?:exceed|overflow|limit)|maximum context length|too (?:long|large) for (?:this |the )?(?:model(?:'s)? )?context/i

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return undefined
  const trimmed = String(headerValue).trim()
  if (!trimmed) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1_000)
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}

function mapErrorCode(status, errorCode = '', message = '') {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 && CONTEXT_OVERFLOW_RE.test(`${errorCode}\n${message}`)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER_ERROR'
}

function textFromBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

function normalizeEffort(effort) {
  if (!effort || effort === 'off') return undefined
  if (effort === 'max') return 'high'
  return VALID_EFFORTS.has(effort) ? effort : undefined
}

/**
 * Resolve active tools after applying any `tool-addition` / `tool-removal`
 * blocks present in developer messages.
 */
function resolveActiveTools(options) {
  const declared = Array.isArray(options?.tools) ? options.tools : []
  if (declared.length === 0) return []
  const byName = new Map()
  const active = new Map()
  for (const tool of declared) {
    if (!tool?.name) continue
    byName.set(tool.name, tool)
    if (tool.deferLoading !== true) active.set(tool.name, tool)
  }
  for (const msg of options?.messages ?? []) {
    if (msg?.role !== 'developer' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block?.type === 'tool-addition' && block.toolName && byName.has(block.toolName)) {
        active.set(block.toolName, byName.get(block.toolName))
      } else if (block?.type === 'tool-removal' && block.toolName) {
        active.delete(block.toolName)
      }
    }
  }
  return [...active.values()]
}

/**
 * Translate DSH `GenerateOptions` + pre-resolved image map into an OpenAI
 * Responses API JSON payload.
 */
export function buildResponsesPayload(options, resolvedImages = new Map(), opts = {}) {
  const instructionParts = []
  if (typeof options?.system === 'string' && options.system.trim() !== '') {
    instructionParts.push(options.system.trim())
  }
  const input = []
  const messages = Array.isArray(options?.messages) ? options.messages : []

  for (const msg of messages) {
    if (!msg) continue
    if (msg.role === 'system') {
      const sysText = textFromBlocks(msg.content).trim()
      if (sysText) instructionParts.push(sysText)
      continue
    }

    if (msg.role === 'user') {
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const parts = []
      for (const block of blocks) {
        if (!block) continue
        if (block.type === 'text') {
          parts.push({ type: 'input_text', text: String(block.text ?? '') })
        } else if (block.type === 'image') {
          if (block.offloaded === true) {
            parts.push({
              type: 'input_text',
              text: formatOffloadedImagePlaceholder(block.attachment, opts?.resolveImagePath?.(block.attachment)),
            })
          } else {
            const resolved = resolvedImages.get(block)
            if (resolved?.data && resolved?.mimeType) {
              parts.push({
                type: 'input_image',
                image_url: `data:${resolved.mimeType};base64,${resolved.data}`,
              })
            } else {
              const label = block.attachment?.path || block.attachment?.name || 'image'
              parts.push({ type: 'input_text', text: `[Image: ${label}]` })
            }
          }
        } else if (block.type === 'file') {
          const path = block.attachment?.path || block.attachment?.name || 'file'
          parts.push({ type: 'input_text', text: `[File: ${path}]` })
        }
      }
      if (parts.length === 0) parts.push({ type: 'input_text', text: '' })
      input.push({ role: 'user', content: parts })
      continue
    }

    if (msg.role === 'developer') {
      const devText = textFromBlocks(msg.content).trim()
      if (devText) {
        input.push({ role: 'developer', content: [{ type: 'input_text', text: devText }] })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const textParts = []
      const flushText = () => {
        if (textParts.length === 0) return
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textParts.join('\n') }],
        })
        textParts.length = 0
      }
      for (const block of blocks) {
        if (!block) continue
        if (block.type === 'text' && block.text) {
          textParts.push(String(block.text))
        } else if (block.type === 'tool-call') {
          flushText()
          input.push({
            type: 'function_call',
            call_id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            arguments: typeof block.arguments === 'string'
              ? block.arguments
              : JSON.stringify(block.arguments ?? {}),
          })
        }
      }
      flushText()
      continue
    }

    if (msg.role === 'tool') {
      const callId = msg.source?.callId ?? msg.callId ?? ''
      const output = textFromBlocks(msg.content)
      input.push({
        type: 'function_call_output',
        call_id: String(callId),
        output,
      })
    }
  }

  const tools = resolveActiveTools(options).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }))

  const payload = {
    model: options.model,
    input,
    stream: true,
    store: false,
  }
  if (instructionParts.length > 0) {
    payload.instructions = instructionParts.join('\n\n')
  }
  if (tools.length > 0) {
    payload.tools = tools
  }
  if (Number.isFinite(options?.maxTokens) && options.maxTokens > 0) {
    payload.max_output_tokens = Math.trunc(options.maxTokens)
  }
  if (Number.isFinite(options?.temperature)) {
    payload.temperature = options.temperature
  }
  const effort = normalizeEffort(options?.reasoningEffort)
  if (effort) {
    payload.reasoning = { effort }
  }
  return payload
}

function extractUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const totalInput = Number(raw.input_tokens ?? raw.prompt_tokens ?? 0) || 0
  const output = Number(raw.output_tokens ?? raw.completion_tokens ?? 0) || 0
  const cached = Number(
    raw.input_tokens_details?.cached_tokens
    ?? raw.prompt_tokens_details?.cached_tokens
    ?? raw.cache_read_input_tokens
    ?? 0,
  ) || 0
  return {
    inputTokens: Math.max(0, totalInput - cached),
    outputTokens: output,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    totalTokens: Number(raw.total_tokens ?? (totalInput + output)) || (totalInput + output),
  }
}

/**
 * Stream one DSH model request directly via OpenAI Responses SSE against
 * the local key-pool loopback proxy.
 */
export async function* streamDirectResponses(options, deps = {}) {
  const signal = options?.signal ?? deps.signal
  if (signal?.aborted) {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
    return
  }

  const messages = Array.isArray(options?.messages) ? options.messages : []
  const maxRequestImages = Number.isSafeInteger(deps.maxRequestImages) && deps.maxRequestImages > 0
    ? deps.maxRequestImages
    : resolveMaxRequestImages(options?.model)
  const maxRequestImageBytes = deps.maxRequestImageBytes !== undefined
    ? Number(deps.maxRequestImageBytes)
    : DEFAULT_MAX_REQUEST_IMAGE_BYTES
  const countQuantum = Number.isSafeInteger(deps.imageOffloadCountQuantum) && deps.imageOffloadCountQuantum > 0
    ? deps.imageOffloadCountQuantum
    : DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM

  const canSendImages = typeof deps.resolveImage === 'function'
  if (canSendImages) {
    const countOffload = requiredOffloadForRoles(
      messages,
      { maxImages: maxRequestImages, countQuantum },
      { sentRoles: ['user'] },
    )
    if (countOffload > 0) {
      throw createStructuredError(
        `Mistral direct request images exceed the limit of ${maxRequestImages}; ${countOffload} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages: countOffload },
      )
    }
  }

  const resolvedImages = new Map()
  if (canSendImages) {
    for (const msg of messages) {
      if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block?.type !== 'image' || block.offloaded) continue
        const img = await deps.resolveImage(block).catch(() => undefined)
        if (img) resolvedImages.set(block, img)
      }
    }
  }

  const sentImageCount = resolvedImages.size
  if (sentImageCount > 0 && Number.isFinite(maxRequestImageBytes) && maxRequestImageBytes > 0) {
    const byteOffload = requiredOffloadForRoles(
      messages,
      { maxImages: maxRequestImages, maxBytes: maxRequestImageBytes, countQuantum },
      { sentRoles: ['user'], getBytes: (block) => resolvedImages.get(block)?.data?.length ?? 0 },
    )
    if (byteOffload > 0) {
      throw createStructuredError(
        `Mistral direct request images exceed the byte budget (${maxRequestImageBytes} bytes); ${byteOffload} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages: byteOffload },
      )
    }
  }

  const baseUrl = String(deps.baseUrl || 'http://127.0.0.1:28401/v1').replace(/\/+$/, '')
  const payload = buildResponsesPayload(options, resolvedImages, { resolveImagePath: deps.resolveImagePath })
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer pool-managed',
    ...(options?.sessionId ? { 'x-dsh-session': String(options.sessionId) } : {}),
  }

  let res
  try {
    res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
      return
    }
    throw createStructuredError(
      `Mistral direct stream connection failed: ${error?.message ?? error}`,
      'TRANSPORT',
      { cause: error },
    )
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    let message = bodyText.slice(0, 300) || `HTTP ${res.status}`
    let errorCode = ''
    try {
      const parsed = JSON.parse(bodyText)
      message = parsed?.error?.message || parsed?.message || parsed?.detail || message
      errorCode = String(parsed?.error?.code ?? parsed?.code ?? '')
    } catch {
      /* keep raw text */
    }
    if (isImageLimitUpstreamError({ status: res.status, code: errorCode, message, bodyText, sentImageCount })) {
      const offloadImages = reactiveImageOffloadCount(messages, {
        sentRoles: ['user'],
        errorText: `${message}\n${bodyText}`,
        countQuantum,
      })
      if (offloadImages > 0) {
        throw createStructuredError(
          `Mistral direct upstream rejected request images (${message.slice(0, 180)}); ${offloadImages} oldest image(s) must be offloaded.`,
          IMAGE_OFFLOAD_REQUIRED_CODE,
          { status: res.status, offloadImages },
        )
      }
    }
    const requestId = res.headers.get('x-request-id') || res.headers.get('request-id') || undefined
    const providerRetryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
    throw createStructuredError(
      message,
      mapErrorCode(res.status, errorCode, message),
      { status: res.status, providerRetryAfterMs, requestId },
    )
  }

  let nextIndex = 0
  let openBlock = null // { index, blockType, text }
  let toolCallCount = 0
  const callsByItemId = new Map()
  let lastUsage = null
  let finishedReason = null

  const closeOpenBlock = function* () {
    if (!openBlock) return
    const block = openBlock.blockType === 'reasoning'
      ? { type: 'reasoning', text: openBlock.text }
      : { type: 'text', text: openBlock.text }
    yield { type: 'block-end', index: openBlock.index, block }
    openBlock = null
  }

  const appendTextBlock = function* (blockType, delta) {
    if (!delta) return
    if (openBlock && openBlock.blockType !== blockType) {
      yield* closeOpenBlock()
    }
    if (!openBlock) {
      openBlock = { index: nextIndex++, blockType, text: '' }
      yield { type: 'block-start', index: openBlock.index, blockType }
    }
    openBlock.text += delta
    yield blockType === 'reasoning'
      ? { type: 'reasoning-delta', index: openBlock.index, text: delta }
      : { type: 'text-delta', index: openBlock.index, text: delta }
  }

  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
    const doc = await res.json()
    const outputs = Array.isArray(doc?.output) ? doc.output : []
    for (const item of outputs) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if ((part?.type === 'output_text' || part?.type === 'text') && part.text) {
            yield* appendTextBlock('text', part.text)
          }
        }
      } else if (item?.type === 'function_call') {
        yield* closeOpenBlock()
        const idx = nextIndex++
        const callId = String(item.call_id || item.id || `call_${idx}`)
        const name = String(item.name || '')
        const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
        toolCallCount += 1
        yield { type: 'block-start', index: idx, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: idx, id: callId, name, argumentsDelta: args }
        yield { type: 'block-end', index: idx, block: { type: 'tool-call', id: callId, name, arguments: args } }
      }
    }
    yield* closeOpenBlock()
    const usage = extractUsage(doc?.usage)
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: toolCallCount > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  const reader = res.body?.getReader?.()
  if (!reader) {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Empty response stream', code: 'PROVIDER_ERROR' } } }
    return
  }

  const processEvent = function* (eventName, dataStr) {
    if (!dataStr || dataStr === '[DONE]') return
    let doc
    try {
      doc = JSON.parse(dataStr)
    } catch {
      return
    }
    const type = doc?.type || eventName
    if (type === 'response.output_text.delta') {
      yield* appendTextBlock('text', String(doc.delta ?? ''))
      return
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      yield* appendTextBlock('reasoning', String(doc.delta ?? ''))
      return
    }
    if (type === 'response.output_item.added' && doc.item?.type === 'function_call') {
      yield* closeOpenBlock()
      const idx = nextIndex++
      const itemId = String(doc.item.id || doc.item.call_id || `item_${idx}`)
      const callId = String(doc.item.call_id || doc.item.id || `call_${idx}`)
      const name = String(doc.item.name || '')
      const state = { index: idx, id: callId, name, args: String(doc.item.arguments ?? ''), done: false }
      callsByItemId.set(itemId, state)
      yield { type: 'block-start', index: idx, blockType: 'tool-call' }
      if (state.args) {
        yield { type: 'tool-call-delta', index: idx, id: callId, name, argumentsDelta: state.args }
      }
      return
    }
    if (type === 'response.function_call_arguments.delta') {
      const itemId = String(doc.item_id ?? '')
      let state = callsByItemId.get(itemId)
      if (!state) {
        yield* closeOpenBlock()
        const idx = nextIndex++
        state = { index: idx, id: itemId || `call_${idx}`, name: '', args: '', done: false }
        callsByItemId.set(itemId, state)
        yield { type: 'block-start', index: idx, blockType: 'tool-call' }
      }
      const delta = String(doc.delta ?? '')
      if (delta) {
        state.args += delta
        yield { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta: delta }
      }
      return
    }
    if (type === 'response.output_item.done' && doc.item?.type === 'function_call') {
      const itemId = String(doc.item.id || doc.item.call_id || '')
      let state = callsByItemId.get(itemId)
      if (!state) {
        yield* closeOpenBlock()
        const idx = nextIndex++
        state = { index: idx, id: String(doc.item.call_id || itemId || `call_${idx}`), name: String(doc.item.name || ''), args: '', done: false }
        callsByItemId.set(itemId, state)
        yield { type: 'block-start', index: idx, blockType: 'tool-call' }
      }
      if (doc.item.name) state.name = String(doc.item.name)
      if (typeof doc.item.arguments === 'string' && doc.item.arguments.length >= state.args.length) {
        state.args = doc.item.arguments
      }
      if (!state.done) {
        state.done = true
        toolCallCount += 1
        yield {
          type: 'block-end',
          index: state.index,
          block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args || '{}' },
        }
      }
      return
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const resp = doc.response ?? doc
      const usage = extractUsage(resp?.usage)
      if (usage) lastUsage = usage
      const incompleteReason = resp?.incomplete_details?.reason
      finishedReason = type === 'response.incomplete' && incompleteReason === 'max_output_tokens'
        ? { kind: 'max-tokens' }
        : toolCallCount > 0
          ? { kind: 'tool-calls' }
          : { kind: 'stop' }
      return
    }
    if (type === 'response.failed' || type === 'error') {
      const msg = doc.response?.error?.message || doc.error?.message || doc.message || 'Mistral response failed'
      const errCode = String(doc.response?.error?.code ?? doc.error?.code ?? doc.code ?? '')
      if (nextIndex === 0 && isImageLimitUpstreamError({ code: errCode, message: msg, bodyText: dataStr, sentImageCount })) {
        const offloadImages = reactiveImageOffloadCount(messages, {
          sentRoles: ['user'],
          errorText: `${msg}\n${dataStr}`,
          countQuantum,
        })
        if (offloadImages > 0) {
          finishedReason = {
            kind: 'error',
            failure: {
              message: `Mistral direct upstream rejected request images (${msg.slice(0, 180)}); ${offloadImages} oldest image(s) must be offloaded.`,
              code: IMAGE_OFFLOAD_REQUIRED_CODE,
              offloadImages,
            },
          }
          return
        }
      }
      finishedReason = { kind: 'error', failure: { message: msg, code: mapErrorCode(400, errCode, msg) } }
    }
  }

  try {
    let currentEvent = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (line === '') {
          currentEvent = ''
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          yield* processEvent(currentEvent, line.slice(5).trim())
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.trim().startsWith('data:')) {
      yield* processEvent(currentEvent, buffer.trim().slice(5).trim())
    }
  } catch (error) {
    yield* closeOpenBlock()
    if (signal?.aborted || error?.name === 'AbortError') {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'Request aborted', code: 'ABORTED' } } }
      return
    }
    throw error
  } finally {
    reader.releaseLock?.()
  }

  yield* closeOpenBlock()
  for (const state of callsByItemId.values()) {
    if (!state.done) {
      state.done = true
      toolCallCount += 1
      yield {
        type: 'block-end',
        index: state.index,
        block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args || '{}' },
      }
      if (!finishedReason || finishedReason.kind === 'stop') {
        finishedReason = { kind: 'tool-calls' }
      }
    }
  }
  if (lastUsage) yield { type: 'usage', usage: lastUsage }
  yield { type: 'finish', reason: finishedReason ?? (toolCallCount > 0 ? { kind: 'tool-calls' } : { kind: 'stop' }) }
}
