import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMCPConfigStore } from './mcp-config.js';

let workDir: string;
let storePath: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'declaragent-mcpconf-'));
  storePath = join(workDir, 'mcp-servers.json');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('createMCPConfigStore', () => {
  test('returns empty list when the file does not exist', async () => {
    const store = createMCPConfigStore(storePath);
    expect(await store.list()).toEqual([]);
    expect(await store.get('any')).toBeUndefined();
  });

  test('add appends and overwrites by name', async () => {
    const store = createMCPConfigStore(storePath);
    await store.add({
      name: 'a',
      transport: { type: 'stdio', command: 'x' },
      protocolVersion: '2024-11-05',
    });
    await store.add({
      name: 'a',
      transport: { type: 'stdio', command: 'y' },
      protocolVersion: '2024-11-05',
    });
    const list = await store.list();
    expect(list).toHaveLength(1);
    if (list[0]?.transport.type === 'stdio') expect(list[0].transport.command).toBe('y');
  });

  test('remove returns true on success and false otherwise', async () => {
    const store = createMCPConfigStore(storePath);
    await store.add({
      name: 'a',
      transport: { type: 'stdio', command: 'x' },
      protocolVersion: '2024-11-05',
    });
    expect(await store.remove('missing')).toBe(false);
    expect(await store.remove('a')).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  test('rejects unknown store-version files', async () => {
    await fs.writeFile(storePath, JSON.stringify({ version: 99, servers: [] }));
    await expect(createMCPConfigStore(storePath).list()).rejects.toThrow(/unsupported/);
  });
});
