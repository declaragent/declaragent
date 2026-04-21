import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMCPConsentStore } from './mcp-consent.js';

describe('createMCPConsentStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-mcp-consent-'));
    path = join(dir, 'mcp-consent.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('empty store reports nothing approved', async () => {
    const store = createMCPConsentStore(path);
    expect(await store.isApproved('x')).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  test('approve persists + survives a fresh store handle', async () => {
    const store = createMCPConsentStore(path);
    await store.approve('alpha');
    expect(await store.isApproved('alpha')).toBe(true);
    const fresh = createMCPConsentStore(path);
    expect(await fresh.isApproved('alpha')).toBe(true);
    const on = JSON.parse(readFileSync(path, 'utf-8')) as { version: number };
    expect(on.version).toBe(1);
  });

  test('approve is idempotent — name appears once', async () => {
    const store = createMCPConsentStore(path);
    await store.approve('alpha');
    await store.approve('alpha');
    const list = await store.list();
    expect(list).toHaveLength(1);
  });

  test('revoke removes an approval; returns true only when it changed state', async () => {
    const store = createMCPConsentStore(path);
    await store.approve('alpha');
    expect(await store.revoke('alpha')).toBe(true);
    expect(await store.isApproved('alpha')).toBe(false);
    expect(await store.revoke('alpha')).toBe(false);
  });

  test('rejects unsupported version', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify({ version: 2, approved: [] }));
    const store = createMCPConsentStore(path);
    await expect(store.list()).rejects.toThrow(/unsupported mcp-consent version/);
  });
});
