import { describe, expect, test } from 'bun:test';
import {
  JSONRPCError,
  type JSONRPCMessage,
  type JSONRPCRequest,
  TransportClosedError,
} from './jsonrpc.js';
import { createSSEConnection, createSSEMCPClient } from './sse-client.js';

/**
 * Fake SSE server built on a ReadableStream we push frames into +
 * a per-request POST handler. Simulates the two-channel shape of the
 * 2024-11-05 MCP remote transport.
 */
interface FakeSSEServer {
  fetch: typeof fetch;
  /** Push an SSE frame onto the GET stream. */
  push(frame: string): void;
  /** Convenience: push a `message` event wrapping a JSON-RPC payload. */
  sendMessage(msg: JSONRPCMessage): void;
  /** Register a handler invoked when the client POSTs. */
  onPost(handler: (body: JSONRPCMessage) => void): void;
  /** End the SSE stream. */
  end(): void;
}

function createFakeSSEServer(opts: {
  endpointUrl: string;
  sendEndpointImmediately?: boolean;
}): FakeSSEServer {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (opts.sendEndpointImmediately !== false) {
        controller.enqueue(encoder.encode(`event: endpoint\ndata: ${opts.endpointUrl}\n\n`));
      }
    },
    cancel() {
      streamController = undefined;
    },
  });
  let postHandler: ((body: JSONRPCMessage) => void) | undefined;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (method === 'POST' && url === opts.endpointUrl) {
      const body = JSON.parse(init?.body as string) as JSONRPCMessage;
      postHandler?.(body);
      return new Response(null, { status: 202 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    push(frame) {
      streamController?.enqueue(encoder.encode(frame));
    },
    sendMessage(msg) {
      streamController?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
    },
    onPost(handler) {
      postHandler = handler;
    },
    end() {
      try {
        streamController?.close();
      } catch {
        // already closed
      }
      streamController = undefined;
    },
  };
}

describe('createSSEConnection', () => {
  test('resolves a request when the server pushes its response on the SSE stream', async () => {
    const server = createFakeSSEServer({ endpointUrl: 'https://mcp.example/messages' });
    server.onPost((body) => {
      if ('id' in body && 'method' in body) {
        server.sendMessage({
          jsonrpc: '2.0',
          id: body.id,
          result: { got: (body as JSONRPCRequest).method },
        });
      }
    });
    const conn = await createSSEConnection({
      config: { type: 'sse', url: 'https://mcp.example/sse' },
      fetch: server.fetch,
    });
    const result = (await conn.request('ping')) as { got: string };
    expect(result.got).toBe('ping');
    await conn.close();
  });

  test('server notifications flow through onNotification', async () => {
    const server = createFakeSSEServer({ endpointUrl: 'https://mcp.example/messages' });
    const conn = await createSSEConnection({
      config: { type: 'sse', url: 'https://mcp.example/sse' },
      fetch: server.fetch,
    });
    const seen: Array<{ method: string; params: unknown }> = [];
    conn.onNotification((method, params) => {
      seen.push({ method, params });
    });
    server.sendMessage({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: undefined,
    });
    // Give the reader loop a tick to dispatch.
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[0]?.method).toBe('notifications/tools/list_changed');
    await conn.close();
  });

  test('endpoint-frame timeout rejects cleanly', async () => {
    const server = createFakeSSEServer({
      endpointUrl: 'https://mcp.example/messages',
      sendEndpointImmediately: false,
    });
    const conn = await createSSEConnection({
      config: { type: 'sse', url: 'https://mcp.example/sse' },
      fetch: server.fetch,
      endpointTimeoutMs: 30,
    });
    await expect(conn.request('ping')).rejects.toThrow(/endpoint/);
    server.end();
    await conn.close();
  });

  test('GET that returns a non-2xx status throws TransportClosedError', async () => {
    const brokenFetch = (async () =>
      new Response(null, { status: 502 })) as unknown as typeof fetch;
    await expect(
      createSSEConnection({
        config: { type: 'sse', url: 'https://mcp.example/sse' },
        fetch: brokenFetch,
      }),
    ).rejects.toThrow(TransportClosedError);
  });

  test('close() cancels the stream + subsequent request rejects', async () => {
    const server = createFakeSSEServer({ endpointUrl: 'https://mcp.example/messages' });
    const conn = await createSSEConnection({
      config: { type: 'sse', url: 'https://mcp.example/sse' },
      fetch: server.fetch,
    });
    await conn.close();
    await expect(conn.request('x')).rejects.toThrow(TransportClosedError);
  });

  test('server-side error response throws JSONRPCError', async () => {
    const server = createFakeSSEServer({ endpointUrl: 'https://mcp.example/messages' });
    server.onPost((body) => {
      if ('id' in body) {
        server.sendMessage({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: 'method not found' },
        });
      }
    });
    const conn = await createSSEConnection({
      config: { type: 'sse', url: 'https://mcp.example/sse' },
      fetch: server.fetch,
    });
    await expect(conn.request('nope')).rejects.toThrow(JSONRPCError);
    await conn.close();
  });
});

describe('createSSEMCPClient', () => {
  test('end-to-end initialize + listTools over SSE', async () => {
    const server = createFakeSSEServer({ endpointUrl: 'https://mcp.example/messages' });
    server.onPost((body) => {
      if (!('id' in body)) return; // notifications (e.g. initialized) — no reply
      const req = body as JSONRPCRequest;
      if (req.method === 'initialize') {
        server.sendMessage({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'sse-server', version: '0.1.0' },
          },
        });
      } else if (req.method === 'tools/list') {
        server.sendMessage({
          jsonrpc: '2.0',
          id: req.id,
          result: { tools: [{ name: 'query', inputSchema: { type: 'object' } }] },
        });
      }
    });
    const client = createSSEMCPClient({
      name: 'sse-server',
      transport: { type: 'sse', url: 'https://mcp.example/sse' },
      protocolVersion: '2024-11-05',
      fetch: server.fetch,
    });
    const info = await client.initialize();
    expect(info.name).toBe('sse-server');
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['query']);
    await client.shutdown();
  });
});
