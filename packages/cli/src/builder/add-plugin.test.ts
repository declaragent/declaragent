import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginStore } from '@declaragent/core';
import { runAddPlugin } from './add-plugin.js';
import { BuilderConflictError, BuilderValidationError } from './types.js';

const FIXED_NOW = '2026-04-21T12:34:56.000Z';

interface PluginFixture {
  dir: string;
  storePath: string;
}

function scaffoldPlugin(root: string, name: string, manifest: Record<string, unknown>): string {
  const pluginDir = join(root, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  return pluginDir;
}

describe('runAddPlugin', () => {
  let root: string;
  let fixture: PluginFixture;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'declara-builder-add-plugin-'));
    fixture = {
      dir: scaffoldPlugin(root, 'hello-plugin', {
        name: '@acme/hello-plugin',
        version: '0.1.0',
        description: 'Says hello.',
        permissions: ['Bash:echo *'],
        contributes: {
          tools: ['./dist/tools.ts'],
          skills: [],
          mcpServers: [],
          hooks: [],
          commands: [],
        },
      }),
      storePath: join(root, 'plugins.json'),
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('installs a valid local plugin + records consent', async () => {
    const out = await runAddPlugin(
      { pluginPath: fixture.dir },
      { storePath: fixture.storePath, now: () => FIXED_NOW },
    );
    expect(out.ok).toBe(true);
    expect(out.name).toBe('@acme/hello-plugin');
    expect(out.version).toBe('0.1.0');
    expect(out.consentedPermissions).toEqual(['Bash:echo *']);
    expect(out.hint).toContain('Installed @acme/hello-plugin@0.1.0');

    const raw = JSON.parse(readFileSync(fixture.storePath, 'utf8')) as {
      version: number;
      plugins: Record<string, unknown>;
    };
    expect(raw.version).toBe(1);
    const entry = raw.plugins['@acme/hello-plugin'] as {
      consentedPermissions?: string[];
      consentedAt?: string;
      installedAt: string;
    };
    expect(entry.installedAt).toBe(FIXED_NOW);
    expect(entry.consentedPermissions).toEqual(['Bash:echo *']);
    expect(entry.consentedAt).toBe(FIXED_NOW);
  });

  test('omits consent fields when the manifest declares no permissions', async () => {
    const noPerms = scaffoldPlugin(root, 'bare', {
      name: '@acme/bare',
      version: '0.0.1',
      contributes: {
        tools: [],
        skills: [],
        mcpServers: [],
        hooks: [],
        commands: [],
      },
    });
    await runAddPlugin(
      { pluginPath: noPerms },
      { storePath: fixture.storePath, now: () => FIXED_NOW },
    );
    const raw = JSON.parse(readFileSync(fixture.storePath, 'utf8')) as {
      plugins: Record<string, Record<string, unknown>>;
    };
    const entry = raw.plugins['@acme/bare'];
    expect(entry?.consentedPermissions).toBeUndefined();
    expect(entry?.consentedAt).toBeUndefined();
  });

  test('errors cleanly on a directory without plugin.json', async () => {
    const emptyDir = join(root, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    await expect(
      runAddPlugin({ pluginPath: emptyDir }, { storePath: fixture.storePath }),
    ).rejects.toThrow(BuilderValidationError);
  });

  test('errors cleanly on malformed plugin.json', async () => {
    const bad = scaffoldPlugin(root, 'bad', {
      // missing required `name` + `version`
      description: 'broken',
    });
    await expect(
      runAddPlugin({ pluginPath: bad }, { storePath: fixture.storePath }),
    ).rejects.toThrow(BuilderValidationError);
  });

  test('rejects a duplicate plugin name', async () => {
    const store = createPluginStore(fixture.storePath);
    await store.add({
      name: '@acme/hello-plugin',
      version: '0.0.9',
      dir: '/some/other/path',
      installedAt: '2026-04-01T00:00:00Z',
    });
    await expect(
      runAddPlugin(
        { pluginPath: fixture.dir },
        { storePath: fixture.storePath, now: () => FIXED_NOW },
      ),
    ).rejects.toThrow(BuilderConflictError);
  });

  test('hint summarises the declared contributions', async () => {
    const out = await runAddPlugin(
      { pluginPath: fixture.dir },
      { storePath: fixture.storePath, now: () => FIXED_NOW },
    );
    expect(out.hint).toContain('1 tool(s)');
    expect(out.hint).toContain('1 permission(s)');
    expect(out.hint).toContain('Bash:echo *');
  });
});
