import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPluginStore } from './store.js';

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'declaragent-store-'));
  storePath = path.join(tmpDir, 'plugins.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const NOW = '2026-04-16T12:00:00.000Z';

describe('createPluginStore', () => {
  test('list/get return empty when the file does not exist yet', async () => {
    const store = createPluginStore(storePath);
    expect(await store.list()).toEqual([]);
    expect(await store.get('any')).toBeUndefined();
  });

  test('add persists across reads and creates the parent dir if missing', async () => {
    const nested = path.join(tmpDir, 'nested', 'plugins.json');
    const store = createPluginStore(nested);
    await store.add({ name: 'a', version: '1.0.0', dir: '/x', installedAt: NOW });
    const reloaded = createPluginStore(nested);
    const list = await reloaded.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('a');
  });

  test('remove returns false for unknown ids and true after a successful remove', async () => {
    const store = createPluginStore(storePath);
    await store.add({ name: 'a', version: '1.0.0', dir: '/x', installedAt: NOW });
    expect(await store.remove('missing')).toBe(false);
    expect(await store.remove('a')).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  test('update merges patches into the entry', async () => {
    const store = createPluginStore(storePath);
    await store.add({ name: 'a', version: '1.0.0', dir: '/x', installedAt: NOW });
    const updated = await store.update('a', {
      consentedPermissions: ['Bash:gh *'],
      consentedAt: NOW,
    });
    expect(updated.consentedPermissions).toEqual(['Bash:gh *']);
    const reread = await store.get('a');
    expect(reread?.consentedAt).toBe(NOW);
  });

  test('rejects unknown store-version files', async () => {
    await fs.writeFile(storePath, JSON.stringify({ version: 99, plugins: {} }));
    const store = createPluginStore(storePath);
    await expect(store.list()).rejects.toThrow(/unsupported plugin-store version/);
  });
});
