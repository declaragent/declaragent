/**
 * Streamable HTTP MCP client (2025-03-26 remote transport).
 *
 * One URL handles both directions. Each `request()` POSTs a JSON-RPC
 * message. The server may respond with:
 *   - `application/json` — a single JSON-RPC response (identical to
 *     the plain-HTTP transport).
 *   - `text/event-stream` — one or more SSE frames where each `data:`
 *     is a JSON-RPC message. Typically the matching response plus any
 *     notifications the server wants to piggyback.
 *
 * Session continuity via the `Mcp-Session-Id` response header: the
 * client echoes it back on subsequent POSTs, matching the spec.
 *
 * Limitations (documented):
 *   - No persistent server→client notification stream. Notifications
 *     only arrive bundled on the response to a request the client just
 *     sent. A follow-up slice can add a dedicated GET stream.
 *   - Session resumption (`Last-Event-Id`, reconnect) not implemented.
 *
 * @since 0.5.0-slice.2c
 */

import type { Logger } from '../types/logger.js';
import type { FetchFn, GetAuthHeaderFn, OnAuthErrorFn } from './http-client.js';
import {
  type ErrorHandler,
  type JSONRPCConnection,
  JSONRPCError,
  type JSONRPCMessage,
  type JSONRPCNotification,
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
import type { MCPClient, MCPClientInfo, StreamableHTTPTransportConfig } from './types.js';

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

export interface CreateStreamableHTTPConnectionOptions {
  config: StreamableHTTPTransportConfig;
  logger?: Logger;
  fetch?: FetchFn;
  getAuthHeader?: GetAuthHeaderFn;
  onAuthError?: OnAuthErrorFn;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export function createStreamableHTTPConnection(
  options: CreateStreamableHTTPConnectionOptions,
): JSONRPCConnection {
  const { config } = options;
  const logger = options.logger ?? NOOP_LOGGER;
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchFn);

  const notificationHandlers = new Set<NotificationHandler>();
  const errorHandlers = new Set<ErrorHandler>();
  let nextId = 1;
  let sessionId: string | undefined;
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

  function dispatchNotificationOrSkip(msg: JSONRPCMessage): void {
    if (isJSONRPCNotification(msg)) {
      for (const h of notificationHandlers) {
        try {
          h(msg.method, msg.params);
        } catch (err) {
          emitError(err);
        }
      }
    }
    // We ignore server-initiated requests over streamable HTTP for now —
    // the slice-2 era MCP client has no request-handler API. Surface
    // them as notifications for debuggability.
    const asReq = msg as JSONRPCRequest;
    if (typeof asReq.method === 'string' && 'id' in asReq) {
      for (const h of notificationHandlers) {
        try {
          h(asReq.method, asReq.params);
        } catch (err) {
          emitError(err);
        }
      }
    }
  }

  async function headers(): Promise<Record<string, string>> {
    const dyn = (await options.getAuthHeader?.()) ?? {};
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId !== undefined && { 'mcp-session-id': sessionId }),
      ...(config.headers ?? {}),
      ...dyn,
    };
  }

  async function fetchWithAuthRetry(body: string): Promise<Response> {
    const h = await headers();
    const res = await fetchImpl(config.url, { method: 'POST', headers: h, body });
    if (res.status === 401 && options.onAuthError !== undefined) {
      const retry = await options.onAuthError();
      if (retry) {
        const fresh = await headers();
        return fetchImpl(config.url, { method: 'POST', headers: fresh, body });
      }
    }
    return res;
  }

  async function consumeSSEForResponse(
    res: Response,
    expectedId: string | number,
    pending: Pending,
  ): Promise<void> {
    if (res.body === null) {
      pending.reject(new JSONRPCError({ code: -32000, message: 'SSE response had no body' }));
      return;
    }
    const reader = res.body.getReader();
    const parser = new SSEFrameParser();
    let resolved = false;
    try {
      while (!resolved) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        for (const frame of parser.push(value)) {
          if (frame.data.length === 0) continue;
          let msg: JSONRPCMessage;
          try {
            msg = parseMessage(frame.data);
          } catch (err) {
            emitError(err);
            continue;
          }
          if (isJSONRPCResponse(msg) && msg.id === expectedId) {
            if (isJSONRPCErrorResponse(msg)) pending.reject(new JSONRPCError(msg.error));
            else pending.resolve(msg.result);
            resolved = true;
            // Don't break — drain remaining frames (they're likely
            // piggy-backed notifications for THIS request).
            continue;
          }
          dispatchNotificationOrSkip(msg);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // best-effort
      }
    }
    if (!resolved) {
      pending.reject(
        new TransportClosedError(
          `streamable-http stream closed before response for id ${String(expectedId)}`,
        ),
      );
    }
  }

  async function postRequest(req: JSONRPCRequest): Promise<unknown> {
    if (closed) throw new TransportClosedError('streamable-http connection closed');
    let res: Response;
    try {
      res = await fetchWithAuthRetry(JSON.stringify(req));
    } catch (err) {
      throw new TransportClosedError(
        `streamable-http fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const nextSession = res.headers.get('mcp-session-id');
    if (nextSession !== null && nextSession.length > 0) sessionId = nextSession;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JSONRPCError({
        code: -32000,
        message: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      });
    }
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ctype.includes('text/event-stream')) {
      // Streamed response. The matching reply + zero-or-more piggy-
      // backed notifications arrive as SSE frames.
      return new Promise<unknown>((resolve, reject) => {
        const pending: Pending = { resolve, reject };
        void consumeSSEForResponse(res, req.id, pending).catch((err) => {
          reject(err);
        });
      });
    }
    // Plain JSON response: exactly one JSON-RPC message in the body.
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new JSONRPCError({
        code: -32700,
        message: `malformed JSON response: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!isJSONRPCResponse(parsed) || parsed.id !== req.id) {
      throw new JSONRPCError({ code: -32700, message: 'response id mismatch' });
    }
    if (isJSONRPCErrorResponse(parsed)) throw new JSONRPCError(parsed.error);
    return parsed.result;
  }

  async function postNotify(note: JSONRPCNotification): Promise<void> {
    try {
      const res = await fetchWithAuthRetry(JSON.stringify(note));
      const nextSession = res.headers.get('mcp-session-id');
      if (nextSession !== null && nextSession.length > 0) sessionId = nextSession;
      if (!res.ok) emitError(new Error(`notification responded ${res.status}`));
    } catch (err) {
      emitError(err);
    }
  }

  return {
    async request(method, params, signal): Promise<unknown> {
      if (closed) throw new TransportClosedError('streamable-http connection closed');
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const id = nextId++;
      const req: JSONRPCRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      };
      const abortPromise =
        signal !== undefined
          ? new Promise<never>((_, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(signal.reason ?? new Error('aborted')),
                { once: true },
              );
            })
          : undefined;
      return abortPromise === undefined
        ? postRequest(req)
        : Promise.race([postRequest(req), abortPromise]);
    },

    async notify(method, params): Promise<void> {
      if (closed) return;
      await postNotify({
        jsonrpc: '2.0',
        method,
        ...(params === undefined ? {} : { params }),
      });
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
      if (closed) return;
      closed = true;
      resolveClosed();
      if (sessionId !== undefined) {
        // Best-effort: tell the server we're done so it can reclaim state.
        try {
          const h = await headers();
          await fetchImpl(config.url, { method: 'DELETE', headers: h });
        } catch (err) {
          logger.debug('mcp.streamable.delete-failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}

export interface CreateStreamableHTTPMCPClientOptions {
  name: string;
  transport: StreamableHTTPTransportConfig;
  protocolVersion: string;
  clientInfo?: MCPClientInfo;
  logger?: Logger;
  fetch?: FetchFn;
  getAuthHeader?: GetAuthHeaderFn;
  onAuthError?: OnAuthErrorFn;
  maxConsecutiveFailures?: number;
}

export function createStreamableHTTPMCPClient(
  options: CreateStreamableHTTPMCPClientOptions,
): MCPClient {
  const connect: CreateMCPClientOptions['connect'] = async () =>
    createStreamableHTTPConnection({
      config: options.transport,
      ...(options.logger !== undefined && { logger: options.logger }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      ...(options.getAuthHeader !== undefined && { getAuthHeader: options.getAuthHeader }),
      ...(options.onAuthError !== undefined && { onAuthError: options.onAuthError }),
    });
  return createMCPClient({
    name: options.name,
    protocolVersion: options.protocolVersion,
    connect,
    maxConsecutiveFailures: options.maxConsecutiveFailures ?? 1,
    ...(options.clientInfo !== undefined && { clientInfo: options.clientInfo }),
    ...(options.logger !== undefined && { logger: options.logger }),
  });
}
