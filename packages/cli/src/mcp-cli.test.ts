import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpAdd, mcpList, mcpRemove } from './mcp-cli.js';
import { createMCPConfigStore } from './mcp-config.js';

let workDir: string;
let storePath: string;

interface CapturedIO {
  stdout: string;
  stderr: string;
  io: { out: (s: string) => void; err: (s: string) => void };
}

function captureIO(): CapturedIO {
  const cap: CapturedIO = {
    stdout: '',
    stderr: '',
    io: {
      out(s: string) {
        cap.stdout += s;
      },
      err(s: string) {
        cap.stderr += s;
      },
    },
  };
  return cap;
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'declaragent-mcpcli-'));
  storePath = join(workDir, 'mcp-servers.json');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('mcp add / list / remove', () => {
  test('add persists a stdio server with default protocol version', async () => {
    const store = createMCPConfigStore(storePath);
    const cap = captureIO();
    expect(
      await mcpAdd(
        { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        { io: cap.io, store },
      ),
    ).toBe(0);
    expect(cap.stdout).toContain('✓ added MCP server "github"');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('github');
    expect(list[0]?.transport.type).toBe('stdio');
    if (list[0]?.transport.type === 'stdio') {
      expect(list[0].transport.command).toBe('npx');
      expect(list[0].transport.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    }
    expect(list[0]?.protocolVersion).toBe('2024-11-05');
  });

  test('add rejects invalid names', async () => {
    const store = createMCPConfigStore(storePath);
    const cap = captureIO();
    expect(await mcpAdd({ name: 'bad/name', command: 'x' }, { io: cap.io, store })).toBe(1);
    expect(cap.stderr).toContain('invalid name');
  });

  test('add overwrites an existing entry of the same name', async () => {
    const store = createMCPConfigStore(storePath);
    await mcpAdd({ name: 'a', command: 'old' }, { io: captureIO().io, store });
    await mcpAdd({ name: 'a', command: 'new' }, { io: captureIO().io, store });
    const list = await store.list();
    expect(list).toHaveLength(1);
    if (list[0]?.transport.type === 'stdio') expect(list[0].transport.command).toBe('new');
  });

  test('list returns the configured set with stdio command line', async () => {
    const store = createMCPConfigStore(storePath);
    await mcpAdd({ name: 'a', command: 'npx', args: ['x'] }, { io: captureIO().io, store });
    const cap = captureIO();
    expect(await mcpList({ io: cap.io, store })).toBe(0);
    expect(cap.stdout).toContain('a  [stdio]');
    expect(cap.stdout).toContain('command: npx x');
  });

  test('list prints "no MCP servers configured" when empty', async () => {
    const store = createMCPConfigStore(storePath);
    const cap = captureIO();
    expect(await mcpList({ io: cap.io, store })).toBe(0);
    expect(cap.stdout).toContain('no MCP servers configured');
  });

  test('remove returns 1 for unknown names, 0 after a successful remove', async () => {
    const store = createMCPConfigStore(storePath);
    await mcpAdd({ name: 'a', command: 'x' }, { io: captureIO().io, store });
    const ok = captureIO();
    expect(await mcpRemove('a', { io: ok.io, store })).toBe(0);
    expect(ok.stdout).toContain('✓ removed a');
    const fail = captureIO();
    expect(await mcpRemove('a', { io: fail.io, store })).toBe(1);
    expect(fail.stderr).toContain('not configured');
  });
});
