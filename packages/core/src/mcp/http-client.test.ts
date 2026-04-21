import { describe, expect, test } from 'bun:test';
import { createHTTPConnection, createHTTPMCPClient } from './http-client.js';
import {
  JSONRPCError,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type JSONRPCResponse,
  TransportClosedError,
  isJSONRPCRequest,
} from './jsonrpc.js';

/**
 * Minimal mock `fetch` that dispatches each POST to a registered handler.
 * Tests register per-method handlers + assert the handshake + tool calls
 * flow correctly without requiring a real HTTP server.
 */
interface MockHTTPServer {
  fetch: typeof fetch;
  onRequest(
    method: string,
    handler: (params: unknown) => unknown | Promise<unknown> | Promise<{ error: JSONRPCResponse }>,
  ): void;
  /** Responses return this status (default 200). */
  setStatus(code: number): void;
  /** Counts POSTs — tests assert request count. */
  readonly calls: number;
  /** Last notification body (no `id`). */
  readonly lastNotification: JSONRPCNotification | undefined;
}

function createMockHTTPServer(): MockHTTPServer {
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  let status = 200;
  let calls = 0;
  let lastNotification: JSONRPCNotification | undefined;

  const fetchImpl = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls += 1;
    const body = JSON.parse((init?.body ?? '{}') as string) as JSONRPCRequest | JSONRPCNotification;
    if (!isJSONRPCRequest(body)) {
      lastNotification = body as JSONRPCNotification;
      return new Response(null, { status: 204 });
    }
    const handler = handlers.get(body.method);
    if (!handler) {
      const errResp: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: `method not found: ${body.method}` },
      };
      return new Response(JSON.stringify(errResp), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    try {
      const result = await handler(body.params);
      const ok: JSONRPCResponse = { jsonrpc: '2.0', id: body.id, result };
      return new Response(JSON.stringify(ok), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      const errResp: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      };
      return new Response(JSON.stringify(errResp), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    onRequest(method, handler) {
      handlers.set(method, handler);
    },
    setStatus(code) {
      status = code;
    },
    get calls() {
      return calls;
    },
    get lastNotification() {
      return lastNotification;
    },
  };
}

describe('createHTTPConnection', () => {
  test('request → POST → JSON-RPC response body', async () => {
    const server = createMockHTTPServer();
    server.onRequest('echo', (params) => ({ echoed: params }));
    const conn = createHTTPConnection({
      config: { type: 'http', url: 'https://mcp.example/v1' },
      fetch: server.fetch,
    });
    const result = (await conn.request('echo', { hello: 'world' })) as { echoed: unknown };
    expect(result.echoed).toEqual({ hello: 'world' });
    expect(server.calls).toBe(1);
    await conn.close();
  });

  test('error response throws JSONRPCError', async () => {
    const server = createMockHTTPServer();
    server.onRequest('throws', () => {
      throw new Error('boom from server');
    });
    const conn = createHTTPConnection({
      config: { type: 'http', url: 'https://mcp.example/v1' },
      fetch: server.fetch,
    });
    await expect(conn.request('throws')).rejects.toThrow(JSONRPCError);
    await conn.close();
  });

  test('non-2xx HTTP status throws JSONRPCError with status in message', async () => {
    const server = createMockHTTPServer();
    server.setStatus(503);
    server.onRequest('anything', () => ({}));
    const conn = createHTTPConnection({
      config: { type: 'http', url: 'https://mcp.example/v1' },
      fetch: server.fetch,
    });
    await expect(conn.request('anything')).rejects.toThrow(/HTTP 503/);
    await conn.close();
  });

  test('custom headers are forwarded on every POST', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const server = createMockHTTPServer();
    server.onRequest('ping', () => 'pong');
    const spyingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string> | undefined;
      if (h) capturedHeaders = h;
      return server.fetch(input, init);
    }) as typeof fetch;
    const conn = createHTTPConnection({
      config: {
        type: 'http',
        url: 'https://mcp.example/v1',
        headers: { authorization: 'Bearer abc123', 'x-custom': 'yes' },
      },
      fetch: spyingFetch,
    });
    await conn.request('ping');
    expect(capturedHeaders?.authorization).toBe('Bearer abc123');
    expect(capturedHeaders?.['x-custom']).toBe('yes');
    expect(capturedHeaders?.['content-type']).toBe('application/json');
    await conn.close();
  });

  test('notify fires fire-and-forget, even if server returns 204', async () => {
    const server = createMockHTTPServer();
    const conn = createHTTPConnection({
      config: { type: 'http', url: 'https://mcp.example/v1' },
      fetch: server.fetch,
    });
    await conn.notify('tools/list_changed');
    expect(server.lastNotification?.method).toBe('tools/list_changed');
    await conn.close();
  });

  test('close() rejects subsequent requests with TransportClosedError', async () => {
    const server = createMockHTTPServer();
    server.onRequest('x', () => null);
    const conn = createHTTPConnection({
      config: { type: 'http', url: 'https://mcp.example/v1' },
      fetch: server.fetch,
    });
    await conn.close();
    await expect(conn.request('x')).rejects.toThrow(TransportClosedError);
  });

  test('closed promise resolves after close()', async () => {
    const conn = createHTTPConnection({
      config: { type: 'http', url: 'https://mcp.example/v1' },
      fetch: createMockHTTPServer().fetch,
    });
    let resolved = false;
    void conn.closed.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await conn.close();
    await conn.closed;
    expect(resolved).toBe(true);
  });

  test('fetch rejection is wrapped as TransportClosedError', async () => {
    const brokenFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const conn = createHTTPConnection({
      config: { type: 'http', url: 'https://mcp.example/v1' },
      fetch: brokenFetch,
    });
    await expect(conn.request('x')).rejects.toThrow(TransportClosedError);
    await conn.close();
  });
});

describe('createHTTPMCPClient', () => {
  test('end-to-end: initialize + listTools + callTool via HTTP', async () => {
    const server = createMockHTTPServer();
    server.onRequest('initialize', () => ({
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'remote', version: '0.1.0' },
    }));
    server.onRequest('notifications/initialized', () => null);
    server.onRequest('tools/list', () => ({
      tools: [
        {
          name: 'search',
          description: 'Semantic search',
          inputSchema: { type: 'object' },
        },
      ],
    }));
    server.onRequest('tools/call', (params) => ({
      content: [{ type: 'text', text: `called with ${JSON.stringify(params)}` }],
    }));

    const client = createHTTPMCPClient({
      name: 'remote',
      transport: { type: 'http', url: 'https://mcp.example/v1' },
      protocolVersion: '2024-11-05',
      fetch: server.fetch,
    });

    const serverInfo = await client.initialize();
    expect(serverInfo.name).toBe('remote');
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('search');
    const result = await client.callTool('search', { q: 'hi' });
    // MCP spec wraps callTool input as { name, arguments } on the wire.
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'called with {"name":"search","arguments":{"q":"hi"}}',
    });
    await client.shutdown();
  });

  test('server returning HTTP error during handshake marks client failed', async () => {
    const server = createMockHTTPServer();
    server.setStatus(500);
    const client = createHTTPMCPClient({
      name: 'broken',
      transport: { type: 'http', url: 'https://mcp.example/v1' },
      protocolVersion: '2024-11-05',
      fetch: server.fetch,
    });
    await expect(client.initialize()).rejects.toThrow();
    // Stateless HTTP → maxConsecutiveFailures defaults to 1, so
    // a single init failure marks the client failed (no reconnect
    // cycle that would change the outcome).
    expect(client.status).toBe('failed');
    await client.shutdown();
  });
});
