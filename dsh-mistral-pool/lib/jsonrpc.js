/**
 * Newline-delimited JSON-RPC 2.0 peer over byte streams for `vibe-acp` stdio.
 *
 * Multiplexes outgoing requests, dispatches incoming agent requests and
 * notifications, replies `-32601` to unhandled methods, and fails all pending
 * requests when the transport closes or emits an invalid/oversized frame.
 * @module dsh-mistral-pool/jsonrpc
 */

/** Hard ceiling for one newline-delimited JSON-RPC line. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024

/** A request the remote peer answered with a JSON-RPC error. */
export class JsonRpcRemoteError extends Error {
  /**
   * @param {string} method - JSON-RPC method name.
   * @param {{ code: number, message: string, data?: unknown }} rpc - remote error payload.
   */
  constructor(method, rpc) {
    super(`${method}: ${rpc.message}`)
    this.name = 'JsonRpcRemoteError'
    this.method = method
    this.rpc = rpc
  }
}

/** The transport closed before a pending request settled. */
export class JsonRpcClosedError extends Error {
  /** @param {string} message - closure reason. */
  constructor(message) {
    super(message)
    this.name = 'JsonRpcClosedError'
  }
}

/** Parse one wire frame into a JSON-RPC 2.0 object, or undefined when invalid. */
function parseFrame(line) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  if (parsed.jsonrpc !== '2.0') return undefined
  const id = parsed.id
  if (id !== undefined && id !== null && typeof id !== 'number' && typeof id !== 'string') return undefined
  if (typeof parsed.method === 'string') return parsed
  if (parsed.method !== undefined) return undefined
  if (typeof id !== 'number' && typeof id !== 'string') return undefined
  const hasResult = 'result' in parsed
  const hasError = 'error' in parsed
  if (hasResult === hasError) return undefined
  if (hasError) {
    const err = parsed.error
    if (err === null || typeof err !== 'object' || Array.isArray(err)) return undefined
    if (typeof err.code !== 'number' || typeof err.message !== 'string') return undefined
  }
  return parsed
}

/** Bidirectional newline-delimited JSON-RPC 2.0 peer. */
export class JsonRpcPeer {
  /**
   * @param {import('node:stream').Readable} input - stream from remote peer.
   * @param {import('node:stream').Writable} output - stream to remote peer.
   * @param {{
   *   onNotification?: (method: string, params: unknown) => void,
   *   onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown,
   *   onClose?: (error: Error) => void,
   * }} [handlers] - callbacks for incoming messages and closure.
   */
  constructor(input, output, handlers = {}) {
    this.output = output
    this.handlers = handlers
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.closed = undefined

    input.setEncoding('utf8')
    input.on('data', (chunk) => this.#onData(chunk))
    input.on('end', () => this.close(new JsonRpcClosedError('ACP stream ended')))
    input.on('error', (error) => this.close(error instanceof Error ? error : new Error(String(error))))
    output.on('error', (error) => this.close(error instanceof Error ? error : new Error(String(error))))
  }

  /** Whether the transport has closed. */
  get isClosed() {
    return this.closed !== undefined
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param {string} method - JSON-RPC method.
   * @param {unknown} params - request parameters.
   * @param {AbortSignal | { signal?: AbortSignal, timeoutMs?: number }} [signalOrOptions] - cancellation or timeout.
   * @returns {Promise<unknown>} remote result payload.
   */
  request(method, params, signalOrOptions) {
    if (this.closed !== undefined) {
      return Promise.reject(new JsonRpcClosedError(`${method}: transport closed (${this.closed.message})`))
    }
    const opts = signalOrOptions && typeof signalOrOptions === 'object' && 'aborted' in signalOrOptions
      ? { signal: signalOrOptions }
      : (signalOrOptions ?? {})
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        this.pending.delete(id)
        cleanup()
        const reason = opts.signal?.reason
        reject(reason instanceof Error ? reason : new Error(`${method}: aborted`))
      }
      this.pending.set(id, {
        method,
        resolve: (value) => { cleanup(); resolve(value) },
        reject: (error) => { cleanup(); reject(error) },
      })
      if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          cleanup()
          reject(new Error(`${method}: no response within ${opts.timeoutMs}ms`))
        }, opts.timeoutMs)
        timer.unref?.()
      }
      if (opts.signal?.aborted) {
        onAbort()
        return
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * Send one JSON-RPC notification without expecting a response.
   * @param {string} method - JSON-RPC method.
   * @param {unknown} params - notification parameters.
   */
  notify(method, params) {
    if (this.closed === undefined) {
      this.#write({ jsonrpc: '2.0', method, params })
    }
  }

  /**
   * Close the peer and fail every pending request.
   * @param {Error} [error] - closure cause.
   */
  close(error = new JsonRpcClosedError('ACP peer closed')) {
    if (this.closed !== undefined) return
    this.closed = error
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new JsonRpcClosedError(`${pending.method}: ${error.message}`))
    }
    this.handlers.onClose?.(error)
  }

  #write(message) {
    try {
      this.output.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  #onData(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) {
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          this.close(new JsonRpcClosedError(`ACP emitted a frame above ${MAX_LINE_BYTES} bytes`))
          return
        }
        this.#onLine(line)
        if (this.closed !== undefined) return
      }
      newline = this.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
      this.close(new JsonRpcClosedError(`ACP emitted a frame above ${MAX_LINE_BYTES} bytes`))
    }
  }

  #onLine(line) {
    const message = parseFrame(line)
    if (message === undefined) {
      this.close(new JsonRpcClosedError(`ACP emitted invalid JSON-RPC: ${line.slice(0, 200)}`))
      return
    }
    const method = typeof message.method === 'string' ? message.method : undefined
    const id = message.id
    if (method === undefined) {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (message.error !== undefined) {
        pending.reject(new JsonRpcRemoteError(pending.method, {
          code: typeof message.error.code === 'number' ? message.error.code : -32603,
          message: typeof message.error.message === 'string' ? message.error.message : 'unknown error',
          ...(message.error.data === undefined ? {} : { data: message.error.data }),
        }))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (id === undefined || id === null) {
      try {
        this.handlers.onNotification?.(method, message.params)
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }

    if (typeof this.handlers.onRequest !== 'function') {
      this.#write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      return
    }

    Promise.resolve()
      .then(() => this.handlers.onRequest(method, message.params))
      .then(
        (result) => {
          if (this.closed === undefined) this.#write({ jsonrpc: '2.0', id, result: result ?? null })
        },
        (error) => {
          if (this.closed !== undefined) return
          const rpc = error instanceof JsonRpcRemoteError
            ? error.rpc
            : {
                code: typeof error?.code === 'number' ? error.code : -32603,
                message: error instanceof Error ? error.message : String(error),
              }
          this.#write({ jsonrpc: '2.0', id, error: rpc })
        },
      )
  }
}
