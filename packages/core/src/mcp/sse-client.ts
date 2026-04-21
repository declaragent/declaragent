/**
 * SSE MCP client (2024-11-05 remote transport).
 *
 * Flow per the older MCP remote spec:
 *   1. Client opens GET <url> with `Accept: text/event-stream`.
 *   2. Server sends an `event: endpoint` frame whose `data:` payload
 *      is the URL the client must POST outbound messages to. On some
 *      servers this is a relative path joined against the SSE URL.
 *   3. Server emits `event: message` frames whose `data:` is a single
 *      JSON-RPC message. Each one is dispatched to `onNotification`
 *      (for server→client notifications) or resolves a pending request.
 *   4. Client POSTs JSON-RPC requests/notifications to the endpoint URL.
 *
 * Server-initiated requests land as notifications for now — slice 2
 * doesn't expose a request-handler API, mirroring stdio's behavior.
 *
 * @since 0.5.0-slice.2c
 */

import type { Logger } from '../types/logger.js';
import type { FetchFn } from './http-client.js';
import {
  type ErrorHandler,
  type JSONRPCConnection,
  JSONRPCError,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type NotificationHandler,
  TransportClosedError,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCResponse,
  parseMessage,
} from './jsonrpc.js';
import { SSEFrameParser } from './sse-parser.js';
import { type CreateMCPClientOptions, createMCPClient } from './stdio-client.js';
import type { MCPClient, MCPClientInfo, SSETransportConfig } from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

export interface CreateSSEConnectionOptions {
  config: SSETransportConfig;
  logger?: Logger;
  /** Test seam; defaults to global `fetch`. */
  fetch?: FetchFn;
  /** How long to wait for the `endpoint` frame before giving up. Default 10s. */
  endpointTimeoutMs?: number;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export async function createSSEConnection(
  options: CreateSSEConnectionOptions,
): Promise<JSONRPCConnection> {
  const { config } = options;
  const logger = options.logger ?? NOOP_LOGGER;
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchFn);
  const endpointTimeoutMs = options.endpointTimeoutMs ?? 10_000;

  const baseHeaders: Record<string, string> = {
    accept: 'text/event-stream',
    ...(config.headers ?? {}),
  };

  let nextId = 1;
  const pending = new Map<string | number, Pending>();
  const notificationHandlers = new Set<NotificationHandler>();
  const errorHandlers = new Set<ErrorHandler>();

  let endpointUrl: string | undefined;
  let resolveEndpoint: (url: string) => void = () => {};
  let rejectEndpoint: (err: unknown) => void = () => {};
  const endpointPromise = new Promise<string>((res, rej) => {
    resolveEndpoint = res;
    rejectEndpoint = rej;
  });

  let closed = false;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((r) => {
    resolveClosed = r;
  });

  function emitError(err: unknown): void {
    if (errorHandlers.size === 0) return;
    for (const h of errorHandlers) {
      try {
        h(err);
      } catch {
        // swallow
      }
    }
  }

  function dispatch(msg: JSONRPCMessage): void {
    if (isJSONRPCResponse(msg)) {
      const id = msg.id;
      if (id === null) {
        emitError(new Error('JSON-RPC response with null id'));
        return;
      }
      const entry = pending.get(id);
      if (!entry) {
        emitError(new Error(`JSON-RPC response for unknown id ${String(id)}`));
        return;
      }
      pending.delete(id);
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
    // Server-initiated request: slice-2-era MCP clients don't expose a
    // request-handler API, so we route through onNotification so at
    // least it's visible. A future slice can add proper request handling.
    const asReq = msg as JSONRPCRequest;
    for (const h of notificationHandlers) {
      try {
        h(asReq.method, asReq.params);
      } catch (err) {
        emitError(err);
      }
    }
  }

  function resolveEndpointUrl(raw: string): string {
    // Server may advertise absolute or root-relative; normalize to absolute.
    try {
      return new URL(raw, config.url).toString();
    } catch {
      return raw;
    }
  }

  // Open the inbound SSE stream. Must happen now (await-able) so that
  // `request()` can be called immediately and find a live endpoint.
  let getResponse: Response;
  try {
    getResponse = await fetchImpl(config.url, {
      method: 'GET',
      headers: baseHeaders,
    });
  } catch (err) {
    throw new TransportClosedError(
      `sse fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!getResponse.ok || getResponse.body === null) {
    throw new TransportClosedError(
      `sse GET ${config.url} returned ${getResponse.status}${getResponse.body === null ? ' (no body)' : ''}`,
    );
  }

  // Background reader loop. Drains the ReadableStream, parses SSE
  // frames, dispatches JSON-RPC payloads. Resolves `closedPromise` when
  // the stream ends.
  const reader = getResponse.body.getReader();
  const parser = new SSEFrameParser();
  const readerLoop = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        for (const frame of parser.push(value)) {
          // `event: endpoint` arrives once; everything else is `message`.
          if (frame.event === 'endpoint' && endpointUrl === undefined) {
            endpointUrl = resolveEndpointUrl(frame.data);
            resolveEndpoint(endpointUrl);
            continue;
          }
          if (frame.event === 'message' || frame.event === '') {
            if (frame.data.length === 0) continue;
            try {
              dispatch(parseMessage(frame.data));
            } catch (err) {
              emitError(err);
            }
          }
          // Unknown event types silently ignored.
        }
      }
      const trailing = parser.flush();
      if (trailing && trailing.data.length > 0) {
        try {
          dispatch(parseMessage(trailing.data));
        } catch (err) {
          emitError(err);
        }
      }
    } catch (err) {
      emitError(err);
    } finally {
      closed = true;
      const closedErr = new TransportClosedError();
      for (const entry of pending.values()) entry.reject(closedErr);
      pending.clear();
      if (endpointUrl === undefined) rejectEndpoint(closedErr);
      resolveClosed();
    }
  })();

  // Guard: if the server never sends the `endpoint` frame within the
  // timeout, fail the handshake clearly rather than hanging.
  const endpointTimer = setTimeout(() => {
    if (endpointUrl === undefined) {
      rejectEndpoint(
        new TransportClosedError(
          `sse server at ${config.url} did not send endpoint within ${endpointTimeoutMs}ms`,
        ),
      );
    }
  }, endpointTimeoutMs);
  endpointPromise.finally(() => clearTimeout(endpointTimer)).catch(() => {});

  async function postToEndpoint(body: unknown): Promise<Response> {
    const url = endpointUrl ?? (await endpointPromise);
    return fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(body),
    });
  }

  // Ensure we surface endpoint-handshake failures to the caller rather
  // than leaving the promise dangling.
  endpointPromise.catch(() => {});

  return {
    async request(method, params, signal): Promise<unknown> {
      if (closed) throw new TransportClosedError('sse connection closed');
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const id = nextId++;
      const req: JSONRPCRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      };
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        if (signal) {
          const onAbort = (): void => {
            if (pending.delete(id)) reject(signal.reason ?? new Error('aborted'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      try {
        const res = await postToEndpoint(req);
        if (!res.ok) {
          pending.delete(id);
          throw new JSONRPCError({
            code: -32000,
            message: `sse POST returned ${res.status}`,
          });
        }
        // MCP servers usually ACK with 202 + empty body; the actual
        // response arrives on the SSE stream. But some inline the
        // response in the POST body — accept either shape.
        const ctype = res.headers.get('content-type') ?? '';
        if (ctype.includes('application/json')) {
          const parsed = (await res.json()) as unknown;
          // If this POST returned the response inline, dispatch it so
          // `pending` resolves the same way it would over SSE.
          try {
            dispatch(parseMessage(JSON.stringify(parsed)));
          } catch (err) {
            pending.delete(id);
            emitError(err);
            throw err;
          }
        }
      } catch (err) {
        pending.delete(id);
        throw err;
      }
      return promise;
    },

    async notify(method, params): Promise<void> {
      if (closed) return;
      const note = {
        jsonrpc: '2.0' as const,
        method,
        ...(params === undefined ? {} : { params }),
      };
      try {
        const res = await postToEndpoint(note);
        if (!res.ok) emitError(new Error(`notification responded ${res.status}`));
      } catch (err) {
        emitError(err);
      }
    },

    onNotification(handler): () => void {
      notificationHandlers.add(handler);
      return () => {
        notificationHandlers.delete(handler);
      };
    },

    onError(handler): () => void {
      errorHandlers.add(handler);
      return () => {
        errorHandlers.delete(handler);
      };
    },

    get closed(): Promise<void> {
      return closedPromise;
    },

    async close(): Promise<void> {
      if (closed) {
        await readerLoop;
        return;
      }
      closed = true;
      try {
        await reader.cancel();
      } catch (err) {
        logger.warn('mcp.sse.cancel-failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      resolveClosed();
      await readerLoop;
    },
  };
}

export interface CreateSSEMCPClientOptions {
  name: string;
  transport: SSETransportConfig;
  protocolVersion: string;
  clientInfo?: MCPClientInfo;
  logger?: Logger;
  fetch?: FetchFn;
  endpointTimeoutMs?: number;
  maxConsecutiveFailures?: number;
}

export function createSSEMCPClient(options: CreateSSEMCPClientOptions): MCPClient {
  const connect: CreateMCPClientOptions['connect'] = () =>
    createSSEConnection({
      config: options.transport,
      ...(options.logger !== undefined && { logger: options.logger }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      ...(options.endpointTimeoutMs !== undefined && {
        endpointTimeoutMs: options.endpointTimeoutMs,
      }),
    });
  return createMCPClient({
    name: options.name,
    protocolVersion: options.protocolVersion,
    connect,
    ...(options.maxConsecutiveFailures !== undefined && {
      maxConsecutiveFailures: options.maxConsecutiveFailures,
    }),
    ...(options.clientInfo !== undefined && { clientInfo: options.clientInfo }),
    ...(options.logger !== undefined && { logger: options.logger }),
  });
}
