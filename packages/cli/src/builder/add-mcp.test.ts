import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMCPConfigStore } from '../mcp-config.js';
import { runAddMCP } from './add-mcp.js';
import { BuilderConflictError } from './types.js';

describe('runAddMCP', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-add-mcp-'));
    configPath = join(dir, 'mcp-servers.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('adds a new stdio MCP server to a fresh store', async () => {
    const out = await runAddMCP(
      {
        name: 'filesystem',
        command: '/usr/local/bin/mcp-filesystem',
        args: ['--root', '/tmp/sandbox'],
      },
      { configPath },
    );
    expect(out.ok).toBe(true);
    expect(out.name).toBe('filesystem');
    expect(out.toolPrefix).toBe('mcp__filesystem__');
    expect(out.mcpConfigPath).toBe(configPath);
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      version: number;
      servers: Array<{ name: string; transport: { command: string; args?: string[] } }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.servers).toHaveLength(1);
    expect(raw.servers[0]?.name).toBe('filesystem');
    expect(raw.servers[0]?.transport.command).toBe('/usr/local/bin/mcp-filesystem');
    expect(raw.servers[0]?.transport.args).toEqual(['--root', '/tmp/sandbox']);
  });

  test('rejects duplicate names (CLI verb replaces, builder refuses)', async () => {
    const store = createMCPConfigStore(configPath);
    await store.add({
      name: 'filesystem',
      transport: { type: 'stdio', command: '/old/binary' },
      protocolVersion: '2024-11-05',
    });
    await expect(
      runAddMCP({ name: 'filesystem', command: '/new/binary' }, { configPath }),
    ).rejects.toThrow(BuilderConflictError);
  });

  test('applies default protocol version when none supplied', async () => {
    const out = await runAddMCP({ name: 'time', command: '/usr/bin/mcp-time' }, { configPath });
    expect(out.ok).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      servers: Array<{ protocolVersion: string }>;
    };
    expect(raw.servers[0]?.protocolVersion).toBe('2024-11-05');
  });

  test('omits empty args / env from the written spec', async () => {
    await runAddMCP(
      { name: 'bare', command: '/usr/bin/bare-mcp', args: [], env: {} },
      { configPath },
    );
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      servers: Array<{ transport: Record<string, unknown> }>;
    };
    expect(raw.servers[0]?.transport.args).toBeUndefined();
    expect(raw.servers[0]?.transport.env).toBeUndefined();
  });

  test('passes env vars through when present', async () => {
    await runAddMCP(
      {
        name: 'gh',
        command: '/usr/bin/mcp-gh',
        env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' },
      },
      { configPath },
    );
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      servers: Array<{ transport: { env?: Record<string, string> } }>;
    };
    expect(raw.servers[0]?.transport.env?.GITHUB_TOKEN).toBe('${env:GITHUB_TOKEN}');
  });
});
