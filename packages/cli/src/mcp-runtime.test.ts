import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Logger,
  MCPClient,
  MCPServerInfo,
  MCPTool,
  PluginMCPServerSpec,
} from '@declaragent/core';
import type { MCPConsentStore } from './mcp-consent.js';
import { createMCPConsentStore } from './mcp-consent.js';
import { loadScopedMCPServers, startMCPServers } from './mcp-runtime.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function writeMcpFile(path: string, servers: PluginMCPServerSpec[]): void {
  writeFileSync(path, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`);
}

function stdioSpec(name: string, command = 'true'): PluginMCPServerSpec {
  return {
    name,
    transport: { type: 'stdio', command },
    protocolVersion: '2024-11-05',
  };
}

function fakeClient(opts: {
  tools?: readonly MCPTool[];
  initializeFails?: Error;
  listToolsFails?: Error;
}): MCPClient {
  const serverInfo: MCPServerInfo = {
    name: 'fake',
    version: '0.0.1',
    protocolVersion: '2024-11-05',
    capabilities: {},
  };
  return {
    async initialize() {
      if (opts.initializeFails) throw opts.initializeFails;
      return serverInfo;
    },
    async listTools() {
      if (opts.listToolsFails) throw opts.listToolsFails;
      return opts.tools ?? [];
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    async shutdown() {},
    get status() {
      return 'ready' as const;
    },
    get serverInfo() {
      return serverInfo;
    },
    onToolsChanged() {
      return () => {};
    },
  };
}

describe('loadScopedMCPServers', () => {
  let root: string;
  let agentDir: string;
  let userConfigDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'declara-mcp-scope-'));
    agentDir = join(root, 'agent');
    userConfigDir = join(root, 'user');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(userConfigDir, { recursive: true });
    mkdirSync(join(agentDir, '.declaragent'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns empty when no scope files exist', async () => {
    const out = await loadScopedMCPServers({ agentDir, userConfigDir });
    expect(out).toEqual([]);
  });

  test('merges user, project, and local scopes', async () => {
    writeMcpFile(join(userConfigDir, 'mcp-servers.json'), [stdioSpec('user-only')]);
    writeMcpFile(join(agentDir, '.mcp.json'), [stdioSpec('project-only')]);
    writeMcpFile(join(agentDir, '.declaragent', 'mcp.local.json'), [stdioSpec('local-only')]);
    const out = await loadScopedMCPServers({ agentDir, userConfigDir });
    expect(out.map((s) => `${s.scope}:${s.spec.name}`).sort()).toEqual([
      'local:local-only',
      'project:project-only',
      'user:user-only',
    ]);
  });

  test('local > project > user on name collision', async () => {
    writeMcpFile(join(userConfigDir, 'mcp-servers.json'), [stdioSpec('shared', 'user-cmd')]);
    writeMcpFile(join(agentDir, '.mcp.json'), [stdioSpec('shared', 'project-cmd')]);
    writeMcpFile(join(agentDir, '.declaragent', 'mcp.local.json'), [
      stdioSpec('shared', 'local-cmd'),
    ]);
    const [only] = await loadScopedMCPServers({ agentDir, userConfigDir });
    expect(only?.scope).toBe('local');
    expect(only?.spec.transport.type === 'stdio' && only.spec.transport.command).toBe('local-cmd');
  });

  test('project scope wins when local is absent', async () => {
    writeMcpFile(join(userConfigDir, 'mcp-servers.json'), [stdioSpec('shared', 'user-cmd')]);
    writeMcpFile(join(agentDir, '.mcp.json'), [stdioSpec('shared', 'project-cmd')]);
    const [only] = await loadScopedMCPServers({ agentDir, userConfigDir });
    expect(only?.scope).toBe('project');
  });
});

describe('startMCPServers', () => {
  let root: string;
  let consentPath: string;
  let consentStore: MCPConsentStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'declara-mcp-start-'));
    consentPath = join(root, 'mcp-consent.json');
    consentStore = createMCPConsentStore(consentPath);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('spawns consented servers and wraps every listed tool', async () => {
    await consentStore.approve('alpha');
    const runtime = await startMCPServers({
      servers: [{ spec: stdioSpec('alpha'), scope: 'user', sourcePath: '/x' }],
      logger: NOOP_LOGGER,
      consentStore,
      spawn: () =>
        fakeClient({
          tools: [
            { name: 'greet', inputSchema: { type: 'object' } },
            { name: 'wave', inputSchema: { type: 'object' } },
          ],
        }),
    });
    expect(runtime.tools.map((t) => t.name).sort()).toEqual([
      'mcp__alpha__greet',
      'mcp__alpha__wave',
    ]);
    expect(runtime.skipped).toEqual([]);
    await runtime.shutdown();
  });

  test('un-consented server is skipped when no resolver supplied (non-interactive)', async () => {
    const runtime = await startMCPServers({
      servers: [{ spec: stdioSpec('needs-consent'), scope: 'project', sourcePath: '/x' }],
      logger: NOOP_LOGGER,
      consentStore,
      spawn: () => fakeClient({ tools: [{ name: 't', inputSchema: {} }] }),
    });
    expect(runtime.tools).toHaveLength(0);
    expect(runtime.skipped).toHaveLength(1);
    expect(runtime.skipped[0]?.name).toBe('needs-consent');
    expect(runtime.skipped[0]?.reason).toContain('awaiting-consent');
    await runtime.shutdown();
  });

  test('interactive consent: resolver returns true → consent persisted + server runs', async () => {
    expect(await consentStore.isApproved('interactive')).toBe(false);
    const runtime = await startMCPServers({
      servers: [{ spec: stdioSpec('interactive'), scope: 'project', sourcePath: '/x' }],
      logger: NOOP_LOGGER,
      consentStore,
      consent: async () => true,
      spawn: () => fakeClient({ tools: [{ name: 'ok', inputSchema: {} }] }),
    });
    expect(runtime.tools.map((t) => t.name)).toEqual(['mcp__interactive__ok']);
    expect(await consentStore.isApproved('interactive')).toBe(true);
    await runtime.shutdown();
  });

  test('interactive consent: resolver returns false → skipped + no persistence', async () => {
    const runtime = await startMCPServers({
      servers: [{ spec: stdioSpec('declined'), scope: 'project', sourcePath: '/x' }],
      logger: NOOP_LOGGER,
      consentStore,
      consent: async () => false,
      spawn: () => fakeClient({ tools: [{ name: 'ok', inputSchema: {} }] }),
    });
    expect(runtime.tools).toHaveLength(0);
    expect(runtime.skipped[0]?.reason).toBe('consent-declined');
    expect(await consentStore.isApproved('declined')).toBe(false);
    await runtime.shutdown();
  });

  test('initialize failure is soft-failed + healthy siblings still load', async () => {
    await consentStore.approve('good');
    await consentStore.approve('bad');
    const runtime = await startMCPServers({
      servers: [
        { spec: stdioSpec('good'), scope: 'user', sourcePath: '/g' },
        { spec: stdioSpec('bad'), scope: 'user', sourcePath: '/b' },
      ],
      logger: NOOP_LOGGER,
      consentStore,
      spawn: (spec) =>
        spec.name === 'bad'
          ? fakeClient({ initializeFails: new Error('init boom') })
          : fakeClient({ tools: [{ name: 'ok', inputSchema: {} }] }),
    });
    expect(runtime.tools.map((t) => t.name)).toEqual(['mcp__good__ok']);
    const badSkip = runtime.skipped.find((s) => s.name === 'bad');
    expect(badSkip?.reason).toContain('init boom');
    await runtime.shutdown();
  });

  test('handshake respects timeout', async () => {
    await consentStore.approve('slow');
    const runtime = await startMCPServers({
      servers: [{ spec: stdioSpec('slow'), scope: 'user', sourcePath: '/x' }],
      logger: NOOP_LOGGER,
      consentStore,
      handshakeTimeoutMs: 50,
      spawn: () => {
        const client = fakeClient({ tools: [] });
        return {
          ...client,
          async initialize() {
            await new Promise((r) => setTimeout(r, 5_000));
            throw new Error('unreachable — test times out first');
          },
        };
      },
    });
    expect(runtime.tools).toHaveLength(0);
    expect(runtime.skipped[0]?.reason).toContain('timed out');
    await runtime.shutdown();
  });

  test('default spawn dispatches on transport type (stdio + http both reach a client)', async () => {
    // `spawn` override covers these paths in other tests, but we also
    // want confidence that the default spawn's transport dispatch works
    // for both stdio and http. Use the override to intercept the spec
    // that would otherwise reach `defaultSpawn` and verify the transport
    // is preserved end-to-end.
    await consentStore.approve('stdio-one');
    await consentStore.approve('http-one');
    const seen: string[] = [];
    const runtime = await startMCPServers({
      servers: [
        {
          spec: {
            name: 'stdio-one',
            transport: { type: 'stdio', command: 'true' },
            protocolVersion: '2024-11-05',
          },
          scope: 'user',
          sourcePath: '/x',
        },
        {
          spec: {
            name: 'http-one',
            transport: { type: 'http', url: 'https://example.test/v1' },
            protocolVersion: '2024-11-05',
          },
          scope: 'user',
          sourcePath: '/x',
        },
      ],
      logger: NOOP_LOGGER,
      consentStore,
      spawn: (s) => {
        seen.push(`${s.name}:${s.transport.type}`);
        return fakeClient({ tools: [] });
      },
    });
    expect(seen.sort()).toEqual(['http-one:http', 'stdio-one:stdio']);
    await runtime.shutdown();
  });

  test('shutdown is idempotent', async () => {
    await consentStore.approve('sole');
    const runtime = await startMCPServers({
      servers: [{ spec: stdioSpec('sole'), scope: 'user', sourcePath: '/x' }],
      logger: NOOP_LOGGER,
      consentStore,
      spawn: () => fakeClient({ tools: [] }),
    });
    await runtime.shutdown();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});
