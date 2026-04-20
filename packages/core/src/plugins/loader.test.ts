import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { createExtensionRegistry } from '../extension/registry.js';
import { createHookRegistry } from '../hooks/registry.js';
import { createPermissionGate } from '../permission/gate.js';
import type { Logger } from '../types/logger.js';
import { loadPlugin } from './loader.js';
import { PluginActivationError } from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

const FIXTURE_DIR = path.resolve(import.meta.dir, '__fixtures__', 'plugin-sample');

function makeRegistries() {
  return {
    registry: createExtensionRegistry({
      logger: NOOP_LOGGER,
      permissions: createPermissionGate({ mode: 'default', rules: [] }),
      configDir: '/tmp/declaragent-test',
    }),
    hookRegistry: createHookRegistry(),
  };
}

describe('loadPlugin (fixture)', () => {
  test('registers contributed tools, skills, and hooks with plugin source', async () => {
    const { registry, hookRegistry } = makeRegistries();
    const activation = await loadPlugin({
      pluginDir: FIXTURE_DIR,
      registry,
      hookRegistry,
    });

    expect(activation.pluginId).toBe('@declaragent/plugin-sample');
    expect(activation.pluginVersion).toBe('0.1.0');

    const tools = registry.byKind('tool');
    expect(tools.map((e) => e.descriptor.id)).toEqual(['tool:EchoFromPlugin']);
    const toolSrc = tools[0]?.descriptor.source;
    expect(toolSrc).toEqual({
      type: 'plugin',
      pluginId: '@declaragent/plugin-sample',
      pluginVersion: '0.1.0',
    });

    const skills = registry.byKind('skill');
    expect(skills.map((e) => e.payload.lookupName)).toEqual(['@declaragent/plugin-sample:greet']);
    expect(skills[0]?.descriptor.id).toBe('skill:plugin:@declaragent/plugin-sample:greet');

    const hooks = registry.byKind('hook');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.payload.point).toBe('tool.before');

    // Hook subscription was wired into the HookRegistry.
    expect(hookRegistry.count('tool.before')).toBe(1);

    await activation.deactivate();
  });

  test('deactivate unregisters every contribution and unsubscribes hooks', async () => {
    const { registry, hookRegistry } = makeRegistries();
    const activation = await loadPlugin({
      pluginDir: FIXTURE_DIR,
      registry,
      hookRegistry,
    });

    expect(registry.list()).not.toEqual([]);
    expect(hookRegistry.count('tool.before')).toBe(1);

    await activation.deactivate();

    expect(registry.list()).toEqual([]);
    expect(hookRegistry.count('tool.before')).toBe(0);
  });

  test('deactivate is idempotent', async () => {
    const { registry, hookRegistry } = makeRegistries();
    const activation = await loadPlugin({
      pluginDir: FIXTURE_DIR,
      registry,
      hookRegistry,
    });
    await activation.deactivate();
    await expect(activation.deactivate()).resolves.toBeUndefined();
  });

  test('extensionIds reflects everything that was registered', async () => {
    const { registry, hookRegistry } = makeRegistries();
    const activation = await loadPlugin({
      pluginDir: FIXTURE_DIR,
      registry,
      hookRegistry,
    });
    expect(activation.extensionIds).toContain('tool:EchoFromPlugin');
    expect(activation.extensionIds).toContain('skill:plugin:@declaragent/plugin-sample:greet');
    expect(activation.extensionIds.some((id) => id.startsWith('hook:tool.before:'))).toBe(true);
    await activation.deactivate();
  });

  test('rolls back partial registrations when a contribution fails to load', async () => {
    const { registry, hookRegistry } = makeRegistries();
    // Inject a manifest that points at a non-existent hooks module so the
    // hook step fails after tools and skills are already registered.
    const manifest = {
      name: '@declaragent/plugin-bad',
      version: '0.0.1',
      permissions: [],
      contributes: {
        tools: ['./dist/tools.ts'],
        skills: ['./skills/'],
        mcpServers: [],
        hooks: ['./does-not-exist.js'],
        commands: [],
      },
    } as const;

    await expect(
      loadPlugin({
        pluginDir: FIXTURE_DIR,
        registry,
        hookRegistry,
        manifest,
      }),
    ).rejects.toBeInstanceOf(PluginActivationError);

    // Everything that was registered was rolled back.
    expect(registry.list()).toEqual([]);
    expect(hookRegistry.count('tool.before')).toBe(0);
  });
});
