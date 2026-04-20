import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPluginStore } from '@declaragent/core';
import { extensionsList } from './extensions-cli.js';
import { createMCPConfigStore } from './mcp-config.js';

const FIXTURE_DIR = resolve(
  __dirname,
  '..',
  '..',
  'core',
  'src',
  'plugins',
  '__fixtures__',
  'plugin-sample',
);

let workDir: string;
let userDir: string;
let teamDir: string;
let pluginStorePath: string;
let mcpStorePath: string;

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
  workDir = await fs.mkdtemp(join(tmpdir(), 'declaragent-extcli-'));
  userDir = join(workDir, 'user');
  teamDir = join(workDir, 'team');
  pluginStorePath = join(workDir, 'plugins.json');
  mcpStorePath = join(workDir, 'mcp-servers.json');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('extensions', () => {
  test('lists nothing when there is nothing to list', async () => {
    const cap = captureIO();
    const code = await extensionsList({
      io: cap.io,
      pluginStore: createPluginStore(pluginStorePath),
      mcpStore: createMCPConfigStore(mcpStorePath),
      userDir,
      teamDir,
    });
    expect(code).toBe(0);
    expect(cap.stdout).toContain('plugins (0)');
    expect(cap.stdout).toContain('(none)');
    expect(cap.stdout).toContain('mcp servers (0)');
    expect(cap.stdout).toContain('skills (0)');
  });

  test('aggregates plugins, MCP servers, and skills across sources', async () => {
    // Plugin
    const pluginStore = createPluginStore(pluginStorePath);
    await pluginStore.add({
      name: '@declaragent/plugin-sample',
      version: '0.1.0',
      dir: FIXTURE_DIR,
      installedAt: new Date().toISOString(),
    });
    // User skill
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(
      join(userDir, 'hi.md'),
      '---\nname: hi\ndescription: greet\n---\nbody',
      'utf-8',
    );
    // User MCP server
    const mcpStore = createMCPConfigStore(mcpStorePath);
    await mcpStore.add({
      name: 'github',
      transport: { type: 'stdio', command: 'npx' },
      protocolVersion: '2024-11-05',
    });

    const cap = captureIO();
    await extensionsList({ io: cap.io, pluginStore, mcpStore, userDir, teamDir });
    expect(cap.stdout).toContain('@declaragent/plugin-sample@0.1.0');
    expect(cap.stdout).toContain('github  [user]');
    expect(cap.stdout).toContain('hi  [user]');
    expect(cap.stdout).toContain('@declaragent/plugin-sample:greet  [plugin]');
    expect(cap.stdout).toContain('hook modules declared by plugins: 1');
    expect(cap.stdout).toContain('command modules declared by plugins: 0');
  });
});
