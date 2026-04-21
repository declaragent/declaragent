import { describe, expect, test } from 'bun:test';
import type { JSONRPCRequest, JSONRPCResponse } from './jsonrpc.js';
import {
  createStreamableHTTPConnection,
  createStreamableHTTPMCPClient,
} from './streamable-http-client.js';

function sseResponse(frames: string[], init: ResponseInit = {}): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
    ...init,
  });
}

function jsonResponse(obj: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

describe('createStreamableHTTPConnection — JSON response path (2b-compatible)', () => {
  test('request → POST → single JSON-RPC reply', async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as JSONRPCRequest;
      const ok: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: body.id,
        result: { ok: true, for: body.method },
      };
      return jsonResponse(ok);
    }) as typeof fetch;
    const conn = createStreamableHTTPConnection({
      config: { type: 'http-streamable', url: 'https://mcp.example' },
      fetch: fetchImpl,
    });
    const result = (await conn.request('ping')) as { ok: boolean; for: string };
    expect(result).toEqual({ ok: true, for: 'ping' });
    await conn.close();
  });
});

describe('createStreamableHTTPConnection — SSE response path', () => {
  test('matching response frame resolves the pending request', async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as JSONRPCRequest;
      const reply: JSONRPCResponse = { jsonrpc: '2.0', id: body.id, result: { payload: 42 } };
      return sseResponse([`data: ${JSON.stringify(reply)}\n\n`]);
    }) as typeof fetch;
    const conn = createStreamableHTTPConnection({
      config: { type: 'http-streamable', url: 'https://mcp.example' },
      fetch: fetchImpl,
    });
    const result = (await conn.request('ping')) as { payload: number };
    expect(result.payload).toBe(42);
    await conn.close();
  });

  test('piggy-backed notifications reach onNotification handlers', async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as JSONRPCRequest;
      const reply: JSONRPCResponse = { jsonrpc: '2.0', id: body.id, result: 'ok' };
      const notif = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
      return sseResponse([
        `data: ${JSON.stringify(notif)}\n\n`,
        `data: ${JSON.stringify(reply)}\n\n`,
      ]);
    }) as typeof fetch;
    const conn = createStreamableHTTPConnection({
      config: { type: 'http-streamable', url: 'https://mcp.example' },
      fetch: fetchImpl,
    });
    const seen: string[] = [];
    conn.onNotification((method) => {
      seen.push(method);
    });
    await conn.request('x');
    expect(seen).toContain('notifications/tools/list_changed');
    await conn.close();
  });

  test('session id from Mcp-Session-Id is echoed on subsequent requests', async () => {
    const seenSessionHeaders: Array<string | null> = [];
    let callNum = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      callNum += 1;
      const headerBag = init?.headers as Record<string, string> | undefined;
      seenSessionHeaders.push(headerBag?.['mcp-session-id'] ?? null);
      const body = JSON.parse(init?.body as string) as JSONRPCRequest;
      const reply: JSONRPCResponse = { jsonrpc: '2.0', id: body.id, result: null };
      return jsonResponse(reply, {
        headers: callNum === 1 ? { 'mcp-session-id': 'sess-abc' } : {},
      });
    }) as typeof fetch;
    const conn = createStreamableHTTPConnection({
      config: { type: 'http-streamable', url: 'https://mcp.example' },
      fetch: fetchImpl,
    });
    await conn.request('one');
    await conn.request('two');
    expect(seenSessionHeaders).toEqual([null, 'sess-abc']);
    await conn.close();
  });

  test('non-2xx HTTP status → JSONRPCError with status visible', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const conn = createStreamableHTTPConnection({
      config: { type: 'http-streamable', url: 'https://mcp.example' },
      fetch: fetchImpl,
    });
    await expect(conn.request('x')).rejects.toThrow(/HTTP 500/);
    await conn.close();
  });
});

describe('createStreamableHTTPMCPClient', () => {
  test('end-to-end handshake using JSON responses', async () => {
    let notifiedInitialized = false;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as
        | JSONRPCRequest
        | { method: string; params?: unknown };
      if (!('id' in body)) {
        // Notification: notifications/initialized is fire-and-forget.
        if (body.method === 'notifications/initialized') notifiedInitialized = true;
        return new Response(null, { status: 202 });
      }
      if (body.method === 'initialize') {
        const reply: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'streamable', version: '0.1.0' },
          },
        };
        return jsonResponse(reply);
      }
      if (body.method === 'tools/list') {
        const reply: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'chat', inputSchema: { type: 'object' } }] },
        };
        return jsonResponse(reply);
      }
      const reply: JSONRPCResponse = { jsonrpc: '2.0', id: body.id, result: null };
      return jsonResponse(reply);
    }) as typeof fetch;

    const client = createStreamableHTTPMCPClient({
      name: 'streamable',
      transport: { type: 'http-streamable', url: 'https://mcp.example' },
      protocolVersion: '2025-03-26',
      fetch: fetchImpl,
    });
    const info = await client.initialize();
    expect(info.name).toBe('streamable');
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['chat']);
    expect(notifiedInitialized).toBe(true);
    await client.shutdown();
  });
});
