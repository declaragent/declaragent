import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionRegistry } from '../extension/registry.js';
import type { ExtensionRegistry } from '../extension/types.js';
import { createPermissionGate } from '../permission/gate.js';
import type { Logger } from '../types/logger.js';
import {
  AdapterDiscoveryError,
  discoverAdapters,
  registerDiscoveredAdapters,
} from './adapter-discovery.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function makeRegistry(): ExtensionRegistry {
  return createExtensionRegistry({
    logger: NOOP_LOGGER,
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    configDir: '/tmp',
  });
}

// ── Fixture helpers ─────────────────────────────────────────────────────

interface FakePackageOpts {
  /** Root directory the package is installed under (becomes `<root>/node_modules/@declaragent/source-<name>/`). */
  root: string;
  name: string;
  version?: string;
  declaragent?: {
    kind?: string;
    type?: string;
    agent_compat?: string;
  };
  /** Adapter module contents (ESM). Defaults to a minimal passing adapter. */
  moduleSource?: string;
  /** `main` field override; default "index.js". */
  main?: string;
}

function installFakePackage(opts: FakePackageOpts): string {
  const pkgDir = join(opts.root, 'node_modules', '@declaragent', `source-${opts.name}`);
  mkdirSync(pkgDir, { recursive: true });
  const main = opts.main ?? 'index.js';
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: `@declaragent/source-${opts.name}`,
        version: opts.version ?? '0.1.0',
        main,
        type: 'module',
        declaragent: opts.declaragent ?? {
          kind: 'event-source-adapter',
          type: opts.name,
          agent_compat: '*',
        },
      },
      null,
      2,
    ),
  );
  const runtimeType = opts.declaragent?.type ?? opts.name;
  const defaultAdapter = `
export default {
  type: ${JSON.stringify(runtimeType)},
  agentCompat: '*',
  validateConfig(c) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string') {
      throw new Error('${opts.name} requires string id');
    }
  },
  async create(config, _deps) {
    return {
      id: config.id,
      type: ${JSON.stringify(runtimeType)},
      async start() {},
      async stop() {},
      async pause() {},
      async resume() {},
      async health() { return { status: 'healthy' }; },
      metrics() { return { eventsPublished: 0, lastEventAt: null }; },
    };
  },
};
`;
  writeFileSync(join(pkgDir, main), opts.moduleSource ?? defaultAdapter);
  return pkgDir;
}

function tmpRoot(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-adapter-discovery-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('discoverAdapters', () => {
  test('missing node_modules returns empty', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      const out = await discoverAdapters({
        searchPaths: [path],
        coreVersion: '0.7.0',
        logger: NOOP_LOGGER,
      });
      expect(out).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('discovers a well-formed package', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({ root: path, name: 'alpha' });
      const out = await discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' });
      expect(out).toHaveLength(1);
      expect(out[0]?.type).toBe('alpha');
      expect(out[0]?.packageName).toBe('@declaragent/source-alpha');
      expect(out[0]?.packageVersion).toBe('0.1.0');
      expect(out[0]?.adapter.type).toBe('alpha');
    } finally {
      cleanup();
    }
  });

  test('skips packages without the declaragent.kind marker', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'unmarked',
        declaragent: { kind: 'something-else' },
      });
      installFakePackage({ root: path, name: 'marked' });
      const out = await discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' });
      expect(out.map((a) => a.type)).toEqual(['marked']);
    } finally {
      cleanup();
    }
  });

  test('throws on duplicate types across packages', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'kafka-a',
        declaragent: { kind: 'event-source-adapter', type: 'kafka', agent_compat: '*' },
      });
      installFakePackage({
        root: path,
        name: 'kafka-b',
        declaragent: { kind: 'event-source-adapter', type: 'kafka', agent_compat: '*' },
      });
      await expect(discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' })).rejects.toThrow(
        AdapterDiscoveryError,
      );
      await expect(discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' })).rejects.toThrow(
        /claimed by two packages/,
      );
    } finally {
      cleanup();
    }
  });

  test('throws on mismatched agent_compat', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'futuristic',
        declaragent: { kind: 'event-source-adapter', type: 'futuristic', agent_compat: '>=2.0.0' },
      });
      await expect(discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' })).rejects.toThrow(
        /agent_compat/,
      );
    } finally {
      cleanup();
    }
  });

  test('throws on missing type marker', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'typeless',
        declaragent: { kind: 'event-source-adapter' },
      });
      await expect(discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' })).rejects.toThrow(
        /missing "declaragent.type"/,
      );
    } finally {
      cleanup();
    }
  });

  test('throws on malformed module export', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'broken',
        moduleSource: 'export default { not: "an adapter" };',
      });
      await expect(discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' })).rejects.toThrow(
        /did not export an EventSourceAdapter/,
      );
    } finally {
      cleanup();
    }
  });

  test('throws on import failure with package name in message', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'syntax',
        moduleSource: 'this is not valid JS;',
      });
      await expect(discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' })).rejects.toThrow(
        /@declaragent\/source-syntax/,
      );
    } finally {
      cleanup();
    }
  });

  test('scans multiple search paths; collects adapters across them', async () => {
    const { path: pathA, cleanup: cleanupA } = tmpRoot();
    const { path: pathB, cleanup: cleanupB } = tmpRoot();
    try {
      installFakePackage({ root: pathA, name: 'alpha' });
      installFakePackage({ root: pathB, name: 'beta' });
      const out = await discoverAdapters({
        searchPaths: [pathA, pathB],
        coreVersion: '0.7.0',
      });
      expect(out.map((a) => a.type).sort()).toEqual(['alpha', 'beta']);
    } finally {
      cleanupA();
      cleanupB();
    }
  });

  test('agent_compat compound range is honored', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'range',
        declaragent: {
          kind: 'event-source-adapter',
          type: 'range',
          agent_compat: '>=0.5.0 <1.0.0',
        },
      });
      const out = await discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' });
      expect(out).toHaveLength(1);
      await expect(discoverAdapters({ searchPaths: [path], coreVersion: '1.0.0' })).rejects.toThrow(
        /agent_compat/,
      );
    } finally {
      cleanup();
    }
  });

  test('onPackageError soft-fails a bad package + keeps healthy siblings', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({ root: path, name: 'alpha' });
      installFakePackage({
        root: path,
        name: 'broken',
        moduleSource: "throw new Error('import boom');",
      });
      const failures: Array<{ pkgDir: string; message: string }> = [];
      const out = await discoverAdapters({
        searchPaths: [path],
        coreVersion: '0.7.0',
        onPackageError(pkgDir, err) {
          failures.push({ pkgDir, message: err.message });
        },
      });
      expect(out.map((a) => a.type)).toEqual(['alpha']);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.pkgDir).toContain('source-broken');
      expect(failures[0]?.message).toMatch(/import boom|failed to import/);
    } finally {
      cleanup();
    }
  });

  test('onPackageError does NOT intercept duplicate-type errors', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'dup-a',
        declaragent: { kind: 'event-source-adapter', type: 'dup', agent_compat: '*' },
      });
      installFakePackage({
        root: path,
        name: 'dup-b',
        declaragent: { kind: 'event-source-adapter', type: 'dup', agent_compat: '*' },
      });
      const failures: Array<{ pkgDir: string; message: string }> = [];
      await expect(
        discoverAdapters({
          searchPaths: [path],
          coreVersion: '0.7.0',
          onPackageError(pkgDir, err) {
            failures.push({ pkgDir, message: err.message });
          },
        }),
      ).rejects.toThrow(/claimed by two packages/);
      expect(failures).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('omitting onPackageError preserves strict throw-on-first-error', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({ root: path, name: 'alpha' });
      installFakePackage({
        root: path,
        name: 'broken',
        moduleSource: "throw new Error('import boom');",
      });
      await expect(discoverAdapters({ searchPaths: [path], coreVersion: '0.7.0' })).rejects.toThrow(
        /failed to import/,
      );
    } finally {
      cleanup();
    }
  });
});

describe('registerDiscoveredAdapters', () => {
  test('registers each adapter with descriptor id event-source-adapter:<type>', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({ root: path, name: 'alpha' });
      installFakePackage({ root: path, name: 'beta' });
      const discovered = await discoverAdapters({
        searchPaths: [path],
        coreVersion: '0.7.0',
      });
      const registry = makeRegistry();
      await registerDiscoveredAdapters(registry, discovered);

      const registered = registry.byKind('event-source-adapter');
      const descriptorIds = registered.map((e) => e.descriptor.id).sort();
      expect(descriptorIds).toEqual(['event-source-adapter:alpha', 'event-source-adapter:beta']);

      // Source metadata should point to the plugin origin.
      const alpha = registered.find((e) => e.descriptor.id === 'event-source-adapter:alpha');
      expect(alpha?.descriptor.source).toEqual({
        type: 'plugin',
        pluginId: '@declaragent/source-alpha',
        pluginVersion: '0.1.0',
      });
    } finally {
      cleanup();
    }
  });

  test('duplicate registration through the registry surfaces a conflict error', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({ root: path, name: 'once' });
      const discovered = await discoverAdapters({
        searchPaths: [path],
        coreVersion: '0.7.0',
      });
      const registry = makeRegistry();
      await registerDiscoveredAdapters(registry, discovered);
      await expect(registerDiscoveredAdapters(registry, discovered)).rejects.toThrow(
        /already registered/,
      );
    } finally {
      cleanup();
    }
  });
});
