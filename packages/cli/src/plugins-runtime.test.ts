import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ExtensionRegistry,
  HookRegistry,
  Logger,
  PluginStore,
  PluginStoreEntry,
} from '@declaragent/core';
import {
  createExtensionRegistry,
  createHookRegistry,
  createPermissionGate,
  createPluginStore,
} from '@declaragent/core';
import { startPluginRuntime } from './plugins-runtime.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

/** Write a minimal plugin on disk. Returns its dir. */
function writeFixturePlugin(
  root: string,
  opts: {
    name: string;
    version?: string;
    permissions?: readonly string[];
    toolName?: string;
    withSkill?: boolean;
  },
): string {
  const dir = join(root, opts.name.replace(/[^a-z0-9]/gi, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        name: opts.name,
        version: opts.version ?? '0.0.1',
        permissions: opts.permissions ?? [],
        contributes: {
          tools: ['./tools.js'],
          ...(opts.withSkill === true ? { skills: ['./skills'] } : {}),
        },
      },
      null,
      2,
    ),
  );
  const toolName = opts.toolName ?? 'fixture_tool';
  writeFileSync(
    join(dir, 'tools.js'),
    `export const tools = [{
  name: '${toolName}',
  description: 'fixture tool for plugins-runtime tests',
  inputSchema: { type: 'object' },
  permissionKey: () => '',
  async *execute(_input, _ctx) {
    yield { type: 'result', output: { ok: true } };
  },
}];
`,
  );
  if (opts.withSkill === true) {
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'fixture-skill.md'),
      '---\nname: fixture-skill\ndescription: fixture\ntriggers:\n  - name: ignored\n---\n\nHi from plugin.\n',
    );
  }
  return dir;
}

describe('startPluginRuntime', () => {
  let root: string;
  let pluginStorePathFile: string;
  let store: PluginStore;
  let registry: ExtensionRegistry;
  let hookRegistry: HookRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'declara-plugins-rt-'));
    pluginStorePathFile = join(root, 'plugins.json');
    store = createPluginStore(pluginStorePathFile);
    registry = createExtensionRegistry({
      logger: NOOP_LOGGER,
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      configDir: root,
    });
    hookRegistry = createHookRegistry({ logger: NOOP_LOGGER });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('empty store → no activations, no tools', async () => {
    const rt = await startPluginRuntime({
      registry,
      hookRegistry,
      logger: NOOP_LOGGER,
      store,
    });
    expect(rt.tools).toEqual([]);
    expect(rt.activations).toEqual([]);
    expect(rt.skipped).toEqual([]);
    await rt.shutdown();
  });

  test('consented plugin activates + surfaces its tools', async () => {
    const dir = writeFixturePlugin(root, { name: 'plugin-one', toolName: 'alpha_tool' });
    await store.add({
      name: 'plugin-one',
      version: '0.0.1',
      dir,
      installedAt: new Date().toISOString(),
      consentedPermissions: [],
      consentedAt: new Date().toISOString(),
    });
    const rt = await startPluginRuntime({
      registry,
      hookRegistry,
      logger: NOOP_LOGGER,
      store,
    });
    expect(rt.activations).toHaveLength(1);
    expect(rt.tools.map((t) => t.name)).toEqual(['alpha_tool']);
    expect(rt.skipped).toEqual([]);
    await rt.shutdown();
  });

  test('un-consented plugin is skipped with a helpful reason', async () => {
    const dir = writeFixturePlugin(root, { name: 'plugin-unconsented' });
    await store.add({
      name: 'plugin-unconsented',
      version: '0.0.1',
      dir,
      installedAt: new Date().toISOString(),
      // No consentedAt → deliberately skipped at runtime.
    } as PluginStoreEntry);
    const rt = await startPluginRuntime({
      registry,
      hookRegistry,
      logger: NOOP_LOGGER,
      store,
    });
    expect(rt.activations).toEqual([]);
    expect(rt.skipped[0]?.name).toBe('plugin-unconsented');
    expect(rt.skipped[0]?.reason).toContain('not consented');
    await rt.shutdown();
  });

  test('broken plugin (import error) is reported + siblings still activate', async () => {
    const goodDir = writeFixturePlugin(root, { name: 'plugin-good', toolName: 'good_tool' });
    const badDir = join(root, 'plugin-bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, 'plugin.json'),
      JSON.stringify({
        name: 'plugin-bad',
        version: '0.0.1',
        permissions: [],
        contributes: { tools: ['./tools.js'] },
      }),
    );
    writeFileSync(join(badDir, 'tools.js'), `throw new Error('import boom');\n`);

    const now = new Date().toISOString();
    await store.add({
      name: 'plugin-good',
      version: '0.0.1',
      dir: goodDir,
      installedAt: now,
      consentedPermissions: [],
      consentedAt: now,
    });
    await store.add({
      name: 'plugin-bad',
      version: '0.0.1',
      dir: badDir,
      installedAt: now,
      consentedPermissions: [],
      consentedAt: now,
    });

    const rt = await startPluginRuntime({
      registry,
      hookRegistry,
      logger: NOOP_LOGGER,
      store,
    });
    expect(rt.activations.map((a) => a.pluginId)).toEqual(['plugin-good']);
    const badSkip = rt.skipped.find((s) => s.name === 'plugin-bad');
    expect(badSkip).toBeDefined();
    expect(badSkip?.reason.length ?? 0).toBeGreaterThan(0);
    expect(rt.tools.map((t) => t.name)).toEqual(['good_tool']);
    await rt.shutdown();
  });

  test('shutdown calls deactivate on every activated plugin + is idempotent', async () => {
    const dir = writeFixturePlugin(root, { name: 'plugin-lifecycle' });
    const now = new Date().toISOString();
    await store.add({
      name: 'plugin-lifecycle',
      version: '0.0.1',
      dir,
      installedAt: now,
      consentedPermissions: [],
      consentedAt: now,
    });
    const rt = await startPluginRuntime({
      registry,
      hookRegistry,
      logger: NOOP_LOGGER,
      store,
    });
    expect(registry.byKind('tool')).toHaveLength(1);
    await rt.shutdown();
    // After deactivate, the tool extension is gone.
    expect(registry.byKind('tool')).toHaveLength(0);
    // Second shutdown is a no-op.
    await expect(rt.shutdown()).resolves.toBeUndefined();
  });
});
