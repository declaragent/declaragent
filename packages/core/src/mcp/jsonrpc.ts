/**
 * JSON-RPC 2.0 message types, line framing, and a connection that
 * correlates requests with responses and dispatches notifications.
 *
 * Transport-agnostic: the connection takes a byte source (`AsyncIterable<Uint8Array>`)
 * and a byte sink (`write` + `closeWrite` callbacks), so the same code
 * works against `Bun.spawn` stdio (slice 2), `fetch` + SSE (slice 9),
 * or in-memory pipes (tests).
 */

export type JSONRPCId = number | string;

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: JSONRPCId;
  method: string;
  params?: unknown;
}

export interface JSONRPCSuccessResponse {
  jsonrpc: '2.0';
  id: JSONRPCId;
  result: unknown;
}

export interface JSONRPCErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCErrorResponse {
  jsonrpc: '2.0';
  id: JSONRPCId | null;
  error: JSONRPCErrorObject;
}

export type JSONRPCResponse = JSONRPCSuccessResponse | JSONRPCErrorResponse;

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

export class JSONRPCError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: JSONRPCErrorObject) {
    super(`JSON-RPC error ${error.code}: ${error.message}`);
    this.name = 'JSONRPCError';
    this.code = error.code;
    this.data = error.data;
  }
}

export class TransportClosedError extends Error {
  readonly code = 'ETRANSPORTCLOSED';
  constructor(message = 'JSON-RPC transport closed before response') {
    super(message);
    this.name = 'TransportClosedError';
  }
}

export function isJSONRPCResponse(msg: unknown): msg is JSONRPCResponse {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') return false;
  return 'result' in m || 'error' in m;
}

export function isJSONRPCErrorResponse(msg: JSONRPCResponse): msg is JSONRPCErrorResponse {
  return 'error' in msg;
}

export function isJSONRPCNotification(msg: unknown): msg is JSONRPCNotification {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === '2.0' && typeof m.method === 'string' && !('id' in m);
}

export function isJSONRPCRequest(msg: unknown): msg is JSONRPCRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === '2.0' && typeof m.method === 'string' && 'id' in m;
}

const TEXT_ENCODER = new TextEncoder();

export function encodeMessage(msg: JSONRPCMessage): Uint8Array {
  return TEXT_ENCODER.encode(`${JSON.stringify(msg)}\n`);
}

export function parseMessage(line: string): JSONRPCMessage {
  const obj = JSON.parse(line) as unknown;
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('JSON-RPC message must be an object');
  }
  const m = obj as Record<string, unknown>;
  if (m.jsonrpc !== '2.0') {
    throw new Error(`unsupported JSON-RPC version: ${String(m.jsonrpc)}`);
  }
  return obj as JSONRPCMessage;
}

/**
 * Buffers byte/string chunks and emits complete newline-terminated lines.
 * Empty lines are dropped.
 */
export class LineBuffer {
  private buffer = '';
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) lines.push(line);
      idx = this.buffer.indexOf('\n');
    }
    return lines;
  }

  /** Drain any non-newline-terminated trailing bytes. */
  flush(): string | null {
    const remaining = this.buffer;
    this.buffer = '';
    return remaining.length > 0 ? remaining : null;
  }
}

export type NotificationHandler = (method: string, params: unknown) => void;
export type ErrorHandler = (err: unknown) => void;

export interface JSONRPCConnection {
  /** Send a request and await its response. Throws `JSONRPCError` on error responses. */
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Send a notification (fire-and-forget). */
  notify(method: string, params?: unknown): Promise<void>;
  /** Subscribe to inbound notifications. Returns an unsubscribe fn. */
  onNotification(handler: NotificationHandler): () => void;
  /** Subscribe to inbound parse / dispatch errors. Returns an unsubscribe fn. */
  onError(handler: ErrorHandler): () => void;
  /** Resolves once the inbound side ends. */
  readonly closed: Promise<void>;
  /** Initiate graceful close: flush + close the writer; reader drains until EOF. */
  close(): Promise<void>;
}

export interface CreateConnectionOptions {
  /** Source of inbound bytes (e.g. a child's stdout). */
  read: AsyncIterable<Uint8Array>;
  /** Send one chunk to the peer. */
  write(chunk: Uint8Array): Promise<void> | void;
  /** Close the outbound side (e.g. EOF the child's stdin). */
  closeWrite(): Promise<void> | void;
}

export function createJSONRPCConnection(options: CreateConnectionOptions): JSONRPCConnection {
  type Pending = {
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
    cleanup: () => void;
  };
  const pending = new Map<JSONRPCId, Pending>();
  const notificationHandlers = new Set<NotificationHandler>();
  const errorHandlers = new Set<ErrorHandler>();

  let nextId = 1;
  let closeRequested = false;
  let writerClosed = false;
  let closedReason: TransportClosedError | undefined;

  function emitError(err: unknown) {
    if (errorHandlers.size === 0) return;
    for (const h of errorHandlers) {
      try {
        h(err);
      } catch {
        // swallow
      }
    }
  }

  function dispatch(msg: JSONRPCMessage) {
    if (isJSONRPCResponse(msg)) {
      if (msg.id === null) {
        emitError(new Error('JSON-RPC response with null id (parse error from server)'));
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) {
        emitError(new Error(`JSON-RPC response for unknown id ${String(msg.id)}`));
        return;
      }
      pending.delete(msg.id);
      entry.cleanup();
      if (isJSONRPCErrorResponse(msg)) {
        entry.reject(new JSONRPCError(msg.error));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (isJSONRPCNotification(msg)) {
      for (const h of notificationHandlers) {
        try {
          h(msg.method, msg.params);
        } catch (err) {
          emitError(err);
        }
      }
      return;
    }
    // Anything left is a server→client request. Slice 2 doesn't expose a
    // request-handler API, so we reply with method-not-found rather than
    // letting the server hang.
    const req = msg as JSONRPCRequest;
    if (typeof req.method !== 'string' || !('id' in req)) {
      emitError(new Error('JSON-RPC message neither request, response, nor notification'));
      return;
    }
    const reply: JSONRPCErrorResponse = {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `method not implemented: ${req.method}` },
    };
    writeChunk(encodeMessage(reply)).catch(emitError);
  }

  async function writeChunk(chunk: Uint8Array): Promise<void> {
    if (writerClosed) throw new TransportClosedError('writer is closed');
    await options.write(chunk);
  }

  const reader = (async () => {
    const buf = new LineBuffer();
    try {
      for await (const chunk of options.read) {
        for (const line of buf.push(chunk)) {
          try {
            dispatch(parseMessage(line));
          } catch (err) {
            emitError(err);
          }
        }
      }
    } catch (err) {
      emitError(err);
    } finally {
      // Source ended. Reject any outstanding requests.
      closedReason = closedReason ?? new TransportClosedError();
      for (const entry of pending.values()) {
        entry.cleanup();
        entry.reject(closedReason);
      }
      pending.clear();
    }
  })();

  return {
    request(method, params, signal) {
      if (writerClosed || closedReason) {
        return Promise.reject(closedReason ?? new TransportClosedError('writer is closed'));
      }
      return new Promise<unknown>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        const id = nextId++;
        const onAbort = () => {
          if (pending.delete(id)) {
            reject(signal?.reason ?? new Error('aborted'));
          }
        };
        const cleanup = () => {
          if (signal) signal.removeEventListener('abort', onAbort);
        };
        pending.set(id, { resolve, reject, cleanup });
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        const req: JSONRPCRequest = {
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        };
        writeChunk(encodeMessage(req)).catch((err) => {
          if (pending.delete(id)) {
            cleanup();
            reject(err);
          }
        });
      });
    },

    async notify(method, params) {
      const note: JSONRPCNotification = {
        jsonrpc: '2.0',
        method,
        ...(params === undefined ? {} : { params }),
      };
      await writeChunk(encodeMessage(note));
    },

    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => {
        notificationHandlers.delete(handler);
      };
    },

    onError(handler) {
      errorHandlers.add(handler);
      return () => {
        errorHandlers.delete(handler);
      };
    },

    get closed() {
      return reader;
    },

    async close() {
      if (closeRequested) return;
      closeRequested = true;
      writerClosed = true;
      // Reject pending requests synchronously rather than waiting for the
      // peer to close its writer (which it might never do). The reader
      // still runs in the background; callers needing a hard wait can
      // `await connection.closed` after tearing down the read side.
      closedReason = closedReason ?? new TransportClosedError();
      for (const entry of pending.values()) {
        entry.cleanup();
        entry.reject(closedReason);
      }
      pending.clear();
      try {
        await options.closeWrite();
      } catch (err) {
        emitError(err);
      }
    },
  };
}

/**
 * Build two `JSONRPCConnection`s connected by in-memory queues.
 * Used by tests that need to act as both client and server.
 */
export function createPairedConnections(): {
  client: JSONRPCConnection;
  server: JSONRPCConnection;
} {
  const a2b = createPipe();
  const b2a = createPipe();
  const client = createJSONRPCConnection({
    read: b2a.iterable,
    write: (chunk) => a2b.push(chunk),
    closeWrite: () => a2b.end(),
  });
  const server = createJSONRPCConnection({
    read: a2b.iterable,
    write: (chunk) => b2a.push(chunk),
    closeWrite: () => b2a.end(),
  });
  return { client, server };
}

interface InMemoryPipe {
  iterable: AsyncIterable<Uint8Array>;
  push(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
}

function createPipe(): InMemoryPipe {
  const queue: Uint8Array[] = [];
  const waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  let ended = false;

  function deliver() {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const waiter = waiters.shift();
      if (!waiter) return;
      const next = queue.shift();
      if (next !== undefined) {
        waiter({ value: next, done: false });
      } else {
        waiter({ value: undefined as never, done: true });
      }
    }
  }

  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (queue.length > 0) {
            const value = queue.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
          }
          if (ended) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          ended = true;
          deliver();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };

  return {
    iterable,
    push(chunk) {
      if (ended) return Promise.resolve();
      queue.push(chunk);
      deliver();
      return Promise.resolve();
    },
    end() {
      ended = true;
      deliver();
      return Promise.resolve();
    },
  };
}
