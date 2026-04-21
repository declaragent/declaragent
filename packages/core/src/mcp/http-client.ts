/**
 * HTTP MCP client — plain request/response over `fetch`.
 *
 * Each JSON-RPC call is one HTTP POST. Response body is the JSON-RPC
 * response. This is the simplest flavor of remote MCP — fine for
 * servers that exchange only request/response and don't push
 * notifications. SSE and streamable HTTP (which layer bidirectional
 * streams on top of a single HTTP connection) land in slice 2c.
 *
 * The client implements `JSONRPCConnection` directly rather than going
 * through `createJSONRPCConnection` — HTTP is naturally request/response
 * so the stream-based connection machinery (line buffer, pending map,
 * read loop) would be pure overhead. Notifications arriving from the
 * server are not possible over plain HTTP; `onNotification` handlers
 * never fire.
 *
 * @since 0.5.0-slice.2b
 */

import type { Logger } from '../types/logger.js';
import {
  type ErrorHandler,
  type JSONRPCConnection,
  JSONRPCError,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type NotificationHandler,
  TransportClosedError,
  isJSONRPCErrorResponse,
  isJSONRPCResponse,
} from './jsonrpc.js';
import { type CreateMCPClientOptions, createMCPClient } from './stdio-client.js';
import type { HTTPTransportConfig, MCPClient, MCPClientInfo } from './types.js';

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

/** Custom fetch injectable for tests; defaults to the global `fetch`. */
export type FetchFn = typeof fetch;

export interface CreateHTTPConnectionOptions {
  config: HTTPTransportConfig;
  logger?: Logger;
  /** Test seam; defaults to global `fetch`. */
  fetch?: FetchFn;
}

export function createHTTPConnection(options: CreateHTTPConnectionOptions): JSONRPCConnection {
  const { config } = options;
  const logger = options.logger ?? NOOP_LOGGER;
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchFn);

  let nextId = 1;
  let closed = false;
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  // Notifications are never received over plain HTTP, but the interface
  // requires onNotification / onError so callers don't special-case. We
  // track handlers anyway in case a subclass (SSE in 2c) wants to reuse
  // this class and push notifications through them.
  const notificationHandlers = new Set<NotificationHandler>();
  const errorHandlers = new Set<ErrorHandler>();

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

  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(config.headers ?? {}),
  };

  async function postAndAwait(
    body: JSONRPCRequest,
    signal?: AbortSignal,
  ): Promise<JSONRPCResponse> {
    if (closed) throw new TransportClosedError('http connection closed');
    let res: Response;
    try {
      res = await fetchImpl(config.url, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(body),
        ...(signal && { signal }),
      });
    } catch (err) {
      throw new TransportClosedError(
        `http fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JSONRPCError({
        code: -32000,
        message: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      });
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new JSONRPCError({
        code: -32700,
        message: `malformed JSON response: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!isJSONRPCResponse(parsed)) {
      throw new JSONRPCError({
        code: -32700,
        message: 'response was not a valid JSON-RPC response',
      });
    }
    return parsed;
  }

  return {
    async request(method, params, signal): Promise<unknown> {
      if (closed) throw new TransportClosedError('http connection closed');
      if (signal?.aborted) {
        throw signal.reason ?? new Error('aborted');
      }
      const id = nextId++;
      const req: JSONRPCRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      };
      const res = await postAndAwait(req, signal);
      if (isJSONRPCErrorResponse(res)) {
        throw new JSONRPCError(res.error);
      }
      if (res.id !== id) {
        logger.warn('mcp.http.id-mismatch', { expected: id, got: res.id });
      }
      return res.result;
    },

    async notify(method, params): Promise<void> {
      if (closed) return;
      const note = {
        jsonrpc: '2.0' as const,
        method,
        ...(params === undefined ? {} : { params }),
      };
      try {
        const res = await fetchImpl(config.url, {
          method: 'POST',
          headers: baseHeaders,
          body: JSON.stringify(note),
        });
        // Some servers respond 204; some respond 200 with empty body.
        // Either is fine — notifications are fire-and-forget.
        if (!res.ok) {
          emitError(new Error(`notification responded ${res.status}`));
        }
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
      if (closed) return;
      closed = true;
      resolveClosed();
    },
  };
}

export interface CreateHTTPMCPClientOptions {
  name: string;
  transport: HTTPTransportConfig;
  protocolVersion: string;
  clientInfo?: MCPClientInfo;
  logger?: Logger;
  /** Test seam; substitutes the underlying `fetch`. */
  fetch?: FetchFn;
  /**
   * Override for `createMCPClient`'s restart behavior. HTTP is
   * inherently stateless — every call reconnects — so the default is
   * `1`: the first handshake failure marks the client `failed` rather
   * than cycling through backoff retries that won't change the outcome.
   * SSE / streamable (2c) will override to the stdio default.
   */
  maxConsecutiveFailures?: number;
}

export function createHTTPMCPClient(options: CreateHTTPMCPClientOptions): MCPClient {
  const connect: CreateMCPClientOptions['connect'] = async () =>
    createHTTPConnection({
      config: options.transport,
      ...(options.logger !== undefined && { logger: options.logger }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
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
