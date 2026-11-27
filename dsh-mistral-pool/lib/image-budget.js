/**
 * Shared image request-budget, `IMAGE_OFFLOAD_REQUIRED` failure construction, and
 * reactive `400 / 3051` image-limit recovery helpers for `dsh-mistral-pool`.
 *
 * Pure zero-dependency ESM so the plugin stays decoupled from `@deepseek-ai/dsh-llm`
 * while matching its `normalizeLlmFailure()` and `requiredImageOffload()` contracts.
 * @module dsh-mistral-pool/image-budget
 */

export const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED'
export const DEFAULT_MAX_REQUEST_IMAGES = 20
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 4

const IMAGE_LIMIT_TEXT_RE = /too many images|maximum (?:number of )?images|max(?:imum)?\s+\d+\s+images|image(?:s)?\s+(?:count|limit|cap)\s*(?:exceeded|reached|of)|exceeds?\s+(?:the\s+)?(?:max(?:imum)?\s+)?(?:number\s+of\s+)?images/i
const CODE_3051_RE = /(?:"code"\s*:\s*"?3051"?|\bcode[\s:=]+3051\b|\b3051\b)/i
const PARSE_LIMIT_RE = /(?:maximum(?:\s+(?:number\s+of|allowed))?|max(?:imum)?|at\s+most|up\s+to|limit\s+of|exceed(?:s|ed)?(?:\s+the)?(?:\s+limit\s+of)?)\s+(\d+)\s+images?\b/i

/**
 * Construct an Error carrying own data-backed `code` and `failure` fields
 * compatible with `@deepseek-ai/dsh-llm`'s `normalizeLlmFailure()`.
 *
 * @param {string} message - human-readable diagnostic.
 * @param {string} code - stable DSH failure code.
 * @param {{ status?: number, providerRetryAfterMs?: number, requestId?: string, offloadImages?: number, cause?: unknown }} [extra]
 * @returns {Error}
 */
export function createStructuredError(message, code, extra = {}) {
  const msg = typeof message === 'string' && message.length > 0 ? message : 'Mistral request failed'
  const errCode = typeof code === 'string' && code.length > 0 ? code : 'PROVIDER_ERROR'
  const err = new Error(msg, extra.cause !== undefined ? { cause: extra.cause } : undefined)
  err.code = errCode

  const failure = {
    message: msg,
    code: errCode,
  }
  if (Number.isInteger(extra.status) && extra.status >= 100 && extra.status <= 599) {
    err.status = extra.status
    failure.status = extra.status
  }
  if (Number.isFinite(extra.providerRetryAfterMs) && extra.providerRetryAfterMs > 0) {
    failure.providerRetryAfterMs = extra.providerRetryAfterMs
  }
  if (typeof extra.requestId === 'string' && extra.requestId.length > 0) {
    failure.requestId = extra.requestId
  }
  if (
    errCode === IMAGE_OFFLOAD_REQUIRED_CODE
    && Number.isSafeInteger(extra.offloadImages)
    && extra.offloadImages > 0
  ) {
    failure.offloadImages = extra.offloadImages
  }
  err.failure = Object.freeze(failure)
  return err
}

/**
 * Number of oldest retained image occurrences a route budget removes, in
 * whole count and byte quanta, once the budget is exceeded.
 * Mirrors `@deepseek-ai/dsh-llm/content`'s `offloadedImagePrefixCount`.
 *
 * @param {readonly number[]} lengths - represented byte length of each retained occurrence, oldest first.
 * @param {{ maxImages?: number, maxBytes?: number, countQuantum?: number, byteQuantum?: number }} budget
 * @returns {number}
 */
export function offloadedImagePrefixCount(lengths, budget = {}) {
  if (!Array.isArray(lengths) || lengths.length === 0) return 0
  const total = lengths.reduce((sum, bytes) => sum + (Number(bytes) || 0), 0)
  const excessCount = budget.maxImages === undefined ? 0 : Math.max(0, lengths.length - budget.maxImages)
  const excessBytes = budget.maxBytes === undefined ? 0 : Math.max(0, total - budget.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0

  const rawCountQuantum = Number(budget.countQuantum ?? 1)
  const maxAllowedQuantum = budget.maxImages === undefined ? Math.max(1, lengths.length) : Math.max(1, budget.maxImages)
  const countQuantum = Number.isFinite(rawCountQuantum) && rawCountQuantum >= 1
    ? Math.min(Math.trunc(rawCountQuantum), maxAllowedQuantum)
    : 1
  const rawByteQuantum = Number(budget.byteQuantum ?? 1)
  const byteQuantum = Number.isFinite(rawByteQuantum) && rawByteQuantum >= 1
    ? Math.trunc(rawByteQuantum)
    : 1

  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum

  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += Number(imageBytes) || 0
    count += 1
  }
  return count
}

/**
 * Count retained (non-offloaded) image blocks across messages matching `roles`.
 *
 * @param {readonly any[]} messages
 * @param {{ roles?: readonly string[] }} [options]
 * @returns {number}
 */
export function countRetainedImages(messages, { roles = ['user', 'tool'] } = {}) {
  if (!Array.isArray(messages)) return 0
  const roleSet = new Set(roles)
  let count = 0
  for (const msg of messages) {
    if (!msg || !roleSet.has(msg.role) || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block?.type === 'image' && block.offloaded !== true) {
        count += 1
      }
    }
  }
  return count
}

/**
 * Translate a count of oldest retained images within `sentRoles` into the
 * total `offloadImages` prefix count over all DSH surface input roles (`user` + `tool`),
 * matching `dsh-compaction-image-offload`'s `offloadOldestImages()` traversal order.
 *
 * @param {readonly any[]} messages
 * @param {readonly string[]} sentRoles
 * @param {number} sentToOffload
 * @returns {number}
 */
export function mapSentOffloadToSurfaceCount(messages, sentRoles, sentToOffload) {
  if (!Array.isArray(messages) || sentToOffload <= 0) return 0
  const sentRoleSet = new Set(sentRoles)
  let surfaceCount = 0
  let sentCovered = 0
  for (const msg of messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'tool') || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block?.type !== 'image' || block.offloaded === true) continue
      surfaceCount += 1
      if (sentRoleSet.has(msg.role)) {
        sentCovered += 1
        if (sentCovered >= sentToOffload) return surfaceCount
      }
    }
  }
  return surfaceCount
}

/**
 * Compute how many leading surface input images must be offloaded so that the
 * retained images in `sentRoles` fit within `budget`.
 *
 * @param {readonly any[]} messages
 * @param {{ maxImages?: number, maxBytes?: number, countQuantum?: number, byteQuantum?: number }} budget
 * @param {{ sentRoles?: readonly string[], getBytes?: (block: any) => number }} [options]
 * @returns {number}
 */
export function requiredOffloadForRoles(messages, budget, { sentRoles = ['user', 'tool'], getBytes } = {}) {
  if (!Array.isArray(messages)) return 0
  const roleSet = new Set(sentRoles)
  const sentLengths = []
  for (const msg of messages) {
    if (!msg || !roleSet.has(msg.role) || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block?.type !== 'image' || block.offloaded === true) continue
      sentLengths.push(typeof getBytes === 'function' ? (Number(getBytes(block)) || 0) : 0)
    }
  }
  const sentToOffload = offloadedImagePrefixCount(sentLengths, budget)
  return mapSentOffloadToSurfaceCount(messages, sentRoles, sentToOffload)
}

/**
 * Parse an explicit numeric image-count limit from a provider error string.
 *
 * @param {string} text
 * @returns {number | undefined}
 */
export function parseImageLimitFromError(text) {
  const m = PARSE_LIMIT_RE.exec(String(text ?? ''))
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/**
 * Detect whether an upstream rejection indicates the request carried too many
 * images (including Mistral HTTP 400 / error code `3051` when at least 2
 * images were sent).
 *
 * @param {{ status?: number, code?: string | number, message?: string, bodyText?: string, sentImageCount?: number }} info
 * @returns {boolean}
 */
export function isImageLimitUpstreamError({ status, code, message = '', bodyText = '', sentImageCount = 0 }) {
  if (!Number.isFinite(sentImageCount) || sentImageCount < 2) return false
  const detail = `${message ?? ''}\n${bodyText ?? ''}`
  if (IMAGE_LIMIT_TEXT_RE.test(detail)) return true
  if (status === undefined || status === 400) {
    if (String(code ?? '').trim() === '3051' || CODE_3051_RE.test(detail)) {
      return true
    }
  }
  return false
}

/**
 * Compute a safe reactive `offloadImages` count after an upstream image-limit
 * failure, leaving at least the newest retained image intact (`sentCount - 1`).
 *
 * @param {readonly any[]} messages
 * @param {{ sentRoles?: readonly string[], errorText?: string, countQuantum?: number }} [options]
 * @returns {number}
 */
export function reactiveImageOffloadCount(
  messages,
  { sentRoles = ['user', 'tool'], errorText = '', countQuantum = DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM } = {},
) {
  const sentCount = countRetainedImages(messages, { roles: sentRoles })
  if (sentCount < 2) return 0
  const parsedLimit = parseImageLimitFromError(errorText)
  let sentToOffload
  if (parsedLimit !== undefined && parsedLimit >= 1 && parsedLimit < sentCount) {
    sentToOffload = Math.min(
      sentCount - 1,
      offloadedImagePrefixCount(new Array(sentCount).fill(0), { maxImages: parsedLimit, countQuantum }),
    )
  } else {
    sentToOffload = Math.min(sentCount - 1, Math.max(1, countQuantum))
  }
  return mapSentOffloadToSurfaceCount(messages, sentRoles, sentToOffload)
}

function imageExtension(mediaType) {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return ''
  }
}

/**
 * Deterministic placeholder text for an offloaded image occurrence, matching
 * DSH core's `offloadedImageText()` format and optionally exposing a read-only
 * normalized path for on-demand tool re-reads.
 *
 * @param {any} ref
 * @param {string} [readonlyPath]
 * @returns {string}
 */
export function formatOffloadedImagePlaceholder(ref, readonlyPath) {
  const id = String(ref?.attachmentId ?? 'image')
  const identity = ref?.name ? `${JSON.stringify(String(ref.name))} (${id})` : id
  const prefix = `image omitted to fit request image limits; ${identity}.`
  if (typeof readonlyPath === 'string' && readonlyPath.length > 0) {
    const hasDims = Number.isFinite(ref?.width) && Number.isFinite(ref?.height)
    const meta = hasDims && ref?.mediaType
      ? ` (${ref.width}x${ref.height}px, ${ref.mediaType})`
      : ref?.mediaType
        ? ` (${ref.mediaType})`
        : ''
    const ext = imageExtension(ref?.mediaType)
    const copyHint = ext
      ? ` Copy to a writable path ending in ${ext} before editing.`
      : ' Copy to a writable path before editing.'
    return `[${prefix} Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(readonlyPath)}${meta}. Source dimensions, format, and byte size may differ.${copyHint}]`
  }
  return `[${prefix} No local normalized image path is available; ask the user to attach it again if needed.]`
}
