import { describe, expect, test } from 'bun:test';
import {
  type JSONRPCConnection,
  LineBuffer,
  createJSONRPCConnection,
  encodeMessage,
} from './jsonrpc.js';
import { createMCPClient } from './stdio-client.js';
import { MCPClientUnavailableError } from './types.js';

/**
 * A minimal in-memory byte pipe with `AsyncIterable<Uint8Array>` semantics.
 * Pulled inline to keep jsonrpc.ts free of test-only exports.
 */
interface BytePipe {
  iterable: AsyncIterable<Uint8Array>;
  push(chunk: Uint8Array): void;
  end(): void;
  readonly ended: boolean;
}

function bytePipe(): BytePipe {
  const queue: Uint8Array[] = [];
  const waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  let ended = false;
  function deliver(): void {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const waiter = waiters.shift();
      if (!waiter) return;
      const next = queue.shift();
      if (next !== undefined) waiter({ value: next, done: false });
      else waiter({ value: undefined as never, done: true });
    }
  }
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            const value = queue.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
          }
          if (ended) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return() {
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
      if (ended) return;
      queue.push(chunk);
      deliver();
    },
    end() {
      ended = true;
      deliver();
    },
    get ended() {
      return ended;
    },
  };
}

interface FakeServer {
  /** The client-facing JSONRPCConnection (test wires this into createMCPClient). */
  connection: JSONRPCConnection;
  /** Register a handler for a JSON-RPC method. */
  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
  /** Push an unsolicited notification to the client. */
  notify(method: string, params?: unknown): void;
  /** Simulate the server crashing — closes both sides. */
  crash(): void;
  /** Promise that resolves when the server's read loop ends. */
  readonly done: Promise<void>;
  /** All inbound method names the server has seen, in order. */
  readonly received: string[];
}

function startFakeServer(): FakeServer {
  const c2s = bytePipe(); // client → server
  const s2c = bytePipe(); // server → client
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  const received: string[] = [];

  function send(msg: unknown): void {
    s2c.push(encodeMessage(msg as never));
  }

  const connection = createJSONRPCConnection({
    read: s2c.iterable,
    write: (chunk) => c2s.push(chunk),
    closeWrite: () => c2s.end(),
  });

  const done = (async () => {
    const buf = new LineBuffer();
    for await (const chunk of c2s.iterable) {
      for (const line of buf.push(chunk)) {
        let msg: { id?: number | string; method: string; params?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        received.push(msg.method);
        if (msg.id === undefined) continue; // notification — server does not respond
        const handler = handlers.get(msg.method);
        if (!handler) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}` },
          });
          continue;
        }
        try {
          const result = await handler(msg.params);
          send({ jsonrpc: '2.0', id: msg.id, result });
        } catch (err) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }
  })();

  return {
    connection,
    onRequest(method, handler) {
      handlers.set(method, handler);
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    crash() {
      s2c.end(); // closes the client read side
      c2s.end(); // ends our own read loop
    },
    done,
    received,
  };
}

function installInitHandshake(server: FakeServer): void {
  server.onRequest('initialize', () => ({
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'fake', version: '1.2.3' },
  }));
}

describe('createMCPClient — handshake', () => {
  test('runs initialize and sends notifications/initialized', async () => {
    const server = startFakeServer();
    installInitHandshake(server);
    const client = createMCPClient({
      name: 'fake',
      protocolVersion: '2024-11-05',
      connect: async () => server.connection,
    });
    const info = await client.initialize();
    expect(info.name).toBe('fake');
    expect(info.version).toBe('1.2.3');
    expect(info.protocolVersion).toBe('2024-11-05');
    expect(client.status).toBe('ready');
    // Allow the initialized notification to flush.
    await new Promise((r) => setTimeout(r, 5));
    expect(server.received).toContain('initialize');
    expect(server.received).toContain('notifications/initialized');
    await client.shutdown();
  });

  test('initialize is idempotent across concurrent callers', async () => {
    const server = startFakeServer();
    let initCount = 0;
    server.onRequest('initialize', () => {
      initCount++;
      return {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'fake', version: '1.0' },
      };
    });
    const client = createMCPClient({
      name: 'fake',
      protocolVersion: '2024-11-05',
      connect: async () => server.connection,
    });
    const [a, b] = await Promise.all([client.initialize(), client.initialize()]);
    expect(a).toEqual(b);
    expect(initCount).toBe(1);
    await client.shutdown();
  });
});

describe('createMCPClient — tools/list and tools/call', () => {
  test('lists tools and caches the result', async () => {
    const server = startFakeServer();
    installInitHandshake(server);
    let listCount = 0;
    server.onRequest('tools/list', () => {
      listCount++;
      return {
        tools: [
          { name: 'echo', description: 'echo input', inputSchema: { type: 'object' } },
          { name: 'add', inputSchema: { type: 'object' } },
        ],
      };
    });

    const client = createMCPClient({
      name: 'fake',
      protocolVersion: '2024-11-05',
      connect: async () => server.connection,
    });
    const tools = await client.listTools();
    const tools2 = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'add']);
    expect(tools2).toBe(tools);
    expect(listCount).toBe(1);
    await client.shutdown();
  });

  test('callTool forwards name and arguments and parses the result', async () => {
    const server = startFakeServer();
    installInitHandshake(server);
    server.onRequest('tools/call', (params) => {
      const p = params as { name: string; arguments: { x: number } };
      return {
        content: [{ type: 'text', text: `${p.name}(${p.arguments.x})` }],
      };
    });

    const client = createMCPClient({
      name: 'fake',
      protocolVersion: '2024-11-05',
      connect: async () => server.connection,
    });
    const result = await client.callTool('echo', { x: 42 });
    expect(result.content).toEqual([{ type: 'text', text: 'echo(42)' }]);
    await client.shutdown();
  });

  test('notifications/tools/list_changed invalidates the cache and fires handlers', async () => {
    const server = startFakeServer();
    installInitHandshake(server);
    let version = 1;
    server.onRequest('tools/list', () => ({
      tools: [{ name: `v${version}`, inputSchema: { type: 'object' } }],
    }));

    const client = createMCPClient({
      name: 'fake',
      protocolVersion: '2024-11-05',
      connect: async () => server.connection,
    });
    let changedCalls = 0;
    client.onToolsChanged(() => {
      changedCalls++;
    });

    expect((await client.listTools())[0]?.name).toBe('v1');
    version = 2;
    server.notify('notifications/tools/list_changed');
    await new Promise((r) => setTimeout(r, 5));
    expect(changedCalls).toBe(1);
    expect((await client.listTools())[0]?.name).toBe('v2');
    await client.shutdown();
  });
});

describe('createMCPClient — restart and failure', () => {
  test('reconnects after the server crashes mid-session', async () => {
    let attempt = 0;
    const servers: FakeServer[] = [];
    const client = createMCPClient({
      name: 'fake',
      protocolVersion: '2024-11-05',
      connect: async () => {
        const s = startFakeServer();
        installInitHandshake(s);
        s.onRequest('tools/list', () => ({
          tools: [{ name: `attempt-${++attempt}`, inputSchema: { type: 'object' } }],
        }));
        servers.push(s);
        return s.connection;
      },
      sleep: () => Promise.resolve(),
      backoffMs: () => 0,
    });

    expect((await client.listTools())[0]?.name).toBe('attempt-1');
    servers[0]?.crash();
    // Wait for the restart loop to complete one iteration.
    await new Promise((r) => setTimeout(r, 20));
    expect(client.status).toBe('ready');
    expect((await client.listTools())[0]?.name).toBe('attempt-2');
    await client.shutdown();
  });

  test('flips to `failed` after exceeding maxConsecutiveFailures', async () => {
    let attempts = 0;
    const client = createMCPClient({
      name: 'fake',
      protocolVersion: '2024-11-05',
      connect: async () => {
        attempts++;
        throw new Error('connect failed');
      },
      maxConsecutiveFailures: 3,
      backoffMs: () => 0,
      sleep: () => Promise.resolve(),
    });

    await expect(client.initialize()).rejects.toThrow('connect failed');
    // Restart loop runs the remaining attempts.
    await new Promise((r) => setTimeout(r, 30));
    expect(client.status).toBe('failed');
    expect(attempts).toBe(3);
    await expect(client.callTool('x', {})).rejects.toBeInstanceOf(MCPClientUnavailableError);
  });

  test('shutdown is idempotent and prevents further calls', async () => {
    const server = startFakeServer();
    installInitHandshake(server);
    const client = createMCPClient({
      name: 'fake',
      protocolVersion: '2024-11-05',
      connect: async () => server.connection,
    });
    await client.initialize();
    await client.shutdown();
    await client.shutdown();
    expect(client.status).toBe('stopped');
    await expect(client.callTool('x', {})).rejects.toBeInstanceOf(MCPClientUnavailableError);
  });
});

describe('defaultBackoff', () => {
  test('grows exponentially and caps at 30s', async () => {
    const { defaultBackoff } = await import('./stdio-client.js');
    expect(defaultBackoff(0)).toBe(500);
    expect(defaultBackoff(1)).toBe(1000);
    expect(defaultBackoff(2)).toBe(2000);
    expect(defaultBackoff(3)).toBe(4000);
    expect(defaultBackoff(20)).toBe(30_000);
  });
});
