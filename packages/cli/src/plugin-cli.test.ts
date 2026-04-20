import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPluginStore } from '@declaragent/core';
import { pluginInfo, pluginInstall, pluginList, pluginRemove } from './plugin-cli.js';

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
  workDir = await fs.mkdtemp(join(tmpdir(), 'declaragent-cli-'));
  storePath = join(workDir, 'plugins.json');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('plugin install / list / info / remove', () => {
  test('install validates the fixture manifest and persists consent on approval', async () => {
    const store = createPluginStore(storePath);
    const cap = captureIO();
    const code = await pluginInstall(FIXTURE_DIR, {
      io: cap.io,
      store,
      now: () => '2026-04-16T12:00:00.000Z',
      consent: async () => true,
    });
    expect(code).toBe(0);
    expect(cap.stdout).toContain('✓ installed @declaragent/plugin-sample@0.1.0');
    expect(cap.stdout).toContain('consented permissions');
    expect(cap.stdout).toContain('Bash:echo *');
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('@declaragent/plugin-sample');
    expect(entries[0]?.dir).toBe(FIXTURE_DIR);
    expect(entries[0]?.installedAt).toBe('2026-04-16T12:00:00.000Z');
    expect(entries[0]?.consentedPermissions).toEqual(['Bash:echo *']);
    expect(entries[0]?.consentedAt).toBe('2026-04-16T12:00:00.000Z');
  });

  test('install does nothing and returns 1 when consent is rejected', async () => {
    const store = createPluginStore(storePath);
    const cap = captureIO();
    let consentManifestSeen = '';
    const code = await pluginInstall(FIXTURE_DIR, {
      io: cap.io,
      store,
      consent: async (m) => {
        consentManifestSeen = m.name;
        return false;
      },
    });
    expect(code).toBe(1);
    expect(consentManifestSeen).toBe('@declaragent/plugin-sample');
    expect(cap.stderr).toContain('install cancelled');
    expect(await store.list()).toEqual([]);
  });

  test('install with the default (no consent) resolver refuses installation', async () => {
    const store = createPluginStore(storePath);
    const cap = captureIO();
    const code = await pluginInstall(FIXTURE_DIR, { io: cap.io, store });
    expect(code).toBe(1);
    expect(cap.stderr).toContain('install cancelled');
  });

  test('install on a path with no plugin.json returns 1 with EPLUGINMANIFEST message', async () => {
    const cap = captureIO();
    const store = createPluginStore(storePath);
    const code = await pluginInstall(workDir, { io: cap.io, store });
    expect(code).toBe(1);
    expect(cap.stderr).toContain('no plugin.json found');
    expect(await store.list()).toEqual([]);
  });

  test('list prints "no plugins" when the store is empty, and entries otherwise', async () => {
    const store = createPluginStore(storePath);
    const empty = captureIO();
    expect(await pluginList({ io: empty.io, store })).toBe(0);
    expect(empty.stdout).toContain('no plugins installed');

    await pluginInstall(FIXTURE_DIR, {
      io: captureIO().io,
      store,
      now: () => '2026-04-16T12:00:00.000Z',
      consent: async () => true,
    });
    const filled = captureIO();
    expect(await pluginList({ io: filled.io, store })).toBe(0);
    expect(filled.stdout).toContain('@declaragent/plugin-sample@0.1.0');
    expect(filled.stdout).toContain(`dir: ${FIXTURE_DIR}`);
  });

  test('info shows the manifest contributions for an installed plugin', async () => {
    const store = createPluginStore(storePath);
    await pluginInstall(FIXTURE_DIR, { io: captureIO().io, store, consent: async () => true });
    const cap = captureIO();
    expect(await pluginInfo('@declaragent/plugin-sample', { io: cap.io, store })).toBe(0);
    expect(cap.stdout).toContain('@declaragent/plugin-sample@0.1.0');
    expect(cap.stdout).toContain('tools:      1');
    expect(cap.stdout).toContain('skills:     1');
    expect(cap.stdout).toContain('hooks:      1');
  });

  test('info on an unknown plugin returns 1', async () => {
    const cap = captureIO();
    const store = createPluginStore(storePath);
    expect(await pluginInfo('unknown', { io: cap.io, store })).toBe(1);
    expect(cap.stderr).toContain('not installed');
  });

  test('remove deletes the entry and returns 0; subsequent remove returns 1', async () => {
    const store = createPluginStore(storePath);
    await pluginInstall(FIXTURE_DIR, { io: captureIO().io, store, consent: async () => true });
    expect((await store.list()).length).toBe(1);

    const cap1 = captureIO();
    expect(await pluginRemove('@declaragent/plugin-sample', { io: cap1.io, store })).toBe(0);
    expect(cap1.stdout).toContain('✓ removed');
    expect(await store.list()).toEqual([]);

    const cap2 = captureIO();
    expect(await pluginRemove('@declaragent/plugin-sample', { io: cap2.io, store })).toBe(1);
    expect(cap2.stderr).toContain('not installed');
  });
});
