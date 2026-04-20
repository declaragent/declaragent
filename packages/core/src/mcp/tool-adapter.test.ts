import { describe, expect, test } from 'bun:test';
import { createEngine } from '../engine/engine.js';
import { createPermissionGate } from '../permission/gate.js';
import { FakeProvider } from '../testing/fake-provider.js';
import { createMemorySession } from '../testing/memory-session.js';
import type { LLMResponse } from '../types/llm.js';
import {
  type JSONRPCConnection,
  LineBuffer,
  createJSONRPCConnection,
  encodeMessage,
} from './jsonrpc.js';
import { createMCPClient } from './stdio-client.js';
import { createMCPTool, listMCPToolExtensions, mcpToolName } from './tool-adapter.js';

interface BytePipe {
  iterable: AsyncIterable<Uint8Array>;
  push(chunk: Uint8Array): void;
  end(): void;
}

function bytePipe(): BytePipe {
  const queue: Uint8Array[] = [];
  const waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  let ended = false;
  function deliver(): void {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const w = waiters.shift();
      if (!w) return;
      const next = queue.shift();
      if (next !== undefined) w({ value: next, done: false });
      else w({ value: undefined as never, done: true });
    }
  }
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) {
            const v = queue.shift();
            if (v !== undefined) return Promise.resolve({ value: v, done: false });
          }
          if (ended) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<Uint8Array>>((resolve) => waiters.push(resolve));
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
  };
}

interface FakeMCPServer {
  connection: JSONRPCConnection;
  onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
}

function startFakeMCPServer(tools: unknown[]): FakeMCPServer {
  const c2s = bytePipe();
  const s2c = bytePipe();
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  function send(msg: unknown): void {
    s2c.push(encodeMessage(msg as never));
  }
  const connection = createJSONRPCConnection({
    read: s2c.iterable,
    write: (chunk) => c2s.push(chunk),
    closeWrite: () => c2s.end(),
  });
  // Default handlers for handshake + tools/list.
  handlers.set('initialize', () => ({
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'fake', version: '1.0.0' },
  }));
  handlers.set('tools/list', () => ({ tools }));

  void (async () => {
    const buf = new LineBuffer();
    for await (const chunk of c2s.iterable) {
      for (const line of buf.push(chunk)) {
        let msg: { id?: number | string; method: string; params?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        const h = handlers.get(msg.method);
        if (!h) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}` },
          });
          continue;
        }
        try {
          const result = await h(msg.params);
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

  return { connection, onRequest: (m, h) => handlers.set(m, h) };
}

function buildClient(server: FakeMCPServer) {
  return createMCPClient({
    name: 'fake',
    protocolVersion: '2024-11-05',
    connect: async () => server.connection,
  });
}

async function drain(tool: ReturnType<typeof createMCPTool>, input: unknown) {
  const ctx = {
    abortSignal: new AbortController().signal,
  } as Parameters<typeof tool.execute>[1];
  const events = [];
  for await (const e of tool.execute(input, ctx)) events.push(e);
  return events;
}

describe('createMCPTool', () => {
  test('namespaces the tool as mcp__<server>__<tool> and passes schema through', () => {
    const server = startFakeMCPServer([]);
    const client = buildClient(server);
    const tool = createMCPTool({
      serverName: 'github',
      client,
      mcpTool: {
        name: 'create_pr',
        description: 'open a PR',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      },
    });
    expect(tool.name).toBe('mcp__github__create_pr');
    expect(tool.description).toBe('open a PR');
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
    });
    // Permission key intentionally constant — gate matches via the tool name.
    expect(tool.permissionKey({})).toBe('');
    void client.shutdown();
  });

  test('mcpToolName helper matches the constructor', () => {
    expect(mcpToolName('foo', 'bar')).toBe('mcp__foo__bar');
  });

  test('forwards tool name + arguments to the client and returns text content', async () => {
    const server = startFakeMCPServer([{ name: 'echo', inputSchema: { type: 'object' } }]);
    server.onRequest('tools/call', (params) => {
      const p = params as { name: string; arguments: { msg: string } };
      return {
        content: [{ type: 'text', text: `${p.name} said: ${p.arguments.msg}` }],
      };
    });
    const client = buildClient(server);
    const tool = createMCPTool({
      serverName: 'fake',
      client,
      mcpTool: { name: 'echo', inputSchema: { type: 'object' } },
    });
    const events = await drain(tool, { msg: 'hi' });
    expect(events).toEqual([{ type: 'result', output: 'echo said: hi' }]);
    await client.shutdown();
  });

  test('preserves structured content array when not all text', async () => {
    const server = startFakeMCPServer([{ name: 'snap', inputSchema: { type: 'object' } }]);
    server.onRequest('tools/call', () => ({
      content: [
        { type: 'text', text: 'screenshot:' },
        { type: 'image', data: 'b64...', mimeType: 'image/png' },
      ],
    }));
    const client = buildClient(server);
    const tool = createMCPTool({
      serverName: 'fake',
      client,
      mcpTool: { name: 'snap', inputSchema: { type: 'object' } },
    });
    const events = await drain(tool, {});
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe('result');
    if (event?.type !== 'result') return;
    expect(event.output).toEqual([
      { type: 'text', text: 'screenshot:' },
      { type: 'image', data: 'b64...', mimeType: 'image/png' },
    ]);
    await client.shutdown();
  });

  test('isError result becomes a tool error event with EMCPTOOLERR code', async () => {
    const server = startFakeMCPServer([{ name: 'fail', inputSchema: { type: 'object' } }]);
    server.onRequest('tools/call', () => ({
      content: [{ type: 'text', text: 'rate limited' }],
      isError: true,
    }));
    const client = buildClient(server);
    const tool = createMCPTool({
      serverName: 'fake',
      client,
      mcpTool: { name: 'fail', inputSchema: { type: 'object' } },
    });
    const events = await drain(tool, {});
    expect(events).toEqual([
      { type: 'error', error: { code: 'EMCPTOOLERR', message: 'rate limited' } },
    ]);
    await client.shutdown();
  });

  test('JSON-RPC error from the server surfaces as EMCPRPC', async () => {
    const server = startFakeMCPServer([{ name: 'rpc', inputSchema: { type: 'object' } }]);
    server.onRequest('tools/call', () => {
      throw new Error('upstream said no');
    });
    const client = buildClient(server);
    const tool = createMCPTool({
      serverName: 'fake',
      client,
      mcpTool: { name: 'rpc', inputSchema: { type: 'object' } },
    });
    const events = await drain(tool, {});
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type !== 'error') return;
    expect(events[0].error.code).toBe('EMCPRPC');
    expect(events[0].error.message).toContain('upstream said no');
    await client.shutdown();
  });
});

describe('listMCPToolExtensions', () => {
  test('wraps every advertised tool as an Extension<"tool"> with the given source', async () => {
    const server = startFakeMCPServer([
      { name: 'a', inputSchema: { type: 'object' } },
      { name: 'b', inputSchema: { type: 'object' } },
    ]);
    const client = buildClient(server);
    const exts = await listMCPToolExtensions({
      serverName: 'fake',
      client,
      source: { type: 'plugin', pluginId: '@declaragent/plugin-fake', pluginVersion: '0.1.0' },
    });
    expect(exts.map((e) => e.descriptor.id)).toEqual(['tool:mcp__fake__a', 'tool:mcp__fake__b']);
    expect(exts[0]?.descriptor.source).toEqual({
      type: 'plugin',
      pluginId: '@declaragent/plugin-fake',
      pluginVersion: '0.1.0',
    });
    await client.shutdown();
  });
});

// ─────────────────────────────────────────────────────────────────
// End-to-end through the engine + FakeProvider + fake MCP server
// ─────────────────────────────────────────────────────────────────

function toolCallResp(id: string, name: string, input: unknown): LLMResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'claude-opus-4-6',
  };
}

function textResp(text: string): LLMResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 5 },
    model: 'claude-opus-4-6',
  };
}

describe('end-to-end: engine ⇄ MCP-wrapped tool', () => {
  test('engine calls the MCP tool, sees the result in the next turn', async () => {
    const server = startFakeMCPServer([{ name: 'echo', inputSchema: { type: 'object' } }]);
    server.onRequest('tools/call', (params) => {
      const p = params as { name: string; arguments: { msg: string } };
      return { content: [{ type: 'text', text: `MCP got: ${p.arguments.msg}` }] };
    });
    const client = buildClient(server);
    const tool = createMCPTool({
      serverName: 'fake',
      client,
      mcpTool: { name: 'echo', inputSchema: { type: 'object' } },
    });

    const provider = new FakeProvider([
      toolCallResp('call-1', 'mcp__fake__echo', { msg: 'hi' }),
      textResp('done'),
    ]);
    const engine = createEngine({
      provider,
      tools: [tool],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();

    const result = await engine.runAgent({ session, userMessage: 'use mcp' });
    expect(result.stopReason).toBe('end_turn');
    expect(provider.callCount).toBe(2);

    // The engine appends a tool_result with the MCP-wrapped output.
    const toolResultMsg = session.transcript[2];
    expect(toolResultMsg?.role).toBe('user');
    const block = toolResultMsg?.content[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type !== 'tool_result') return;
    expect(block.isError ?? false).toBe(false);
    expect(block.content).toContain('MCP got: hi');

    await client.shutdown();
  });

  test('permission rule mcp__fake__*:* allows the wrapped tool', async () => {
    const server = startFakeMCPServer([{ name: 'echo', inputSchema: { type: 'object' } }]);
    server.onRequest('tools/call', () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const client = buildClient(server);
    const tool = createMCPTool({
      serverName: 'fake',
      client,
      mcpTool: { name: 'echo', inputSchema: { type: 'object' } },
    });
    const gate = createPermissionGate({
      mode: 'default',
      rules: [{ pattern: 'mcp__fake__*:*', decision: 'allow' }],
    });
    const provider = new FakeProvider([
      toolCallResp('call-1', 'mcp__fake__echo', {}),
      textResp('done'),
    ]);
    const engine = createEngine({
      provider,
      tools: [tool],
      permissions: gate,
    });
    const session = createMemorySession();
    const result = await engine.runAgent({ session, userMessage: 'go' });
    expect(result.stopReason).toBe('end_turn');
    expect(gate.denialsInSession()).toBe(0);
    await client.shutdown();
  });
});
