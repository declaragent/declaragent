import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __auditSinkRefCount,
  __hasSharedAuditSink,
  __resetSharedAuditSinkCache,
  acquireTenantAuditSink,
  getOrOpenSharedAuditSink,
  releaseSharedAuditSink,
  releaseTenantAuditSink,
} from './audit-sink-singleton.js';

describe('audit-sink singleton — POST_ENTERPRISE_BACKLOG.md #52', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-audit-singleton-'));
    path = join(dir, 'audit.db');
    __resetSharedAuditSinkCache();
  });
  afterEach(async () => {
    await releaseSharedAuditSink(path);
    __resetSharedAuditSinkCache();
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns the same handle for repeated calls on the same path', async () => {
    const a = await getOrOpenSharedAuditSink({ path });
    const b = await getOrOpenSharedAuditSink({ path });
    expect(a).toBe(b);
    expect(__hasSharedAuditSink(path)).toBe(true);
  });

  test('concurrent first-time callers share the in-flight open promise', async () => {
    const [a, b, c] = await Promise.all([
      getOrOpenSharedAuditSink({ path }),
      getOrOpenSharedAuditSink({ path }),
      getOrOpenSharedAuditSink({ path }),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('different paths produce different handles', async () => {
    const path2 = join(dir, 'other.db');
    try {
      const a = await getOrOpenSharedAuditSink({ path });
      const b = await getOrOpenSharedAuditSink({ path: path2 });
      expect(a).not.toBe(b);
    } finally {
      await releaseSharedAuditSink(path2);
    }
  });

  test('release drops the cache entry + subsequent open returns a fresh handle', async () => {
    const first = await getOrOpenSharedAuditSink({ path });
    await releaseSharedAuditSink(path);
    expect(__hasSharedAuditSink(path)).toBe(false);
    const second = await getOrOpenSharedAuditSink({ path });
    expect(second).not.toBe(first);
  });

  test('release on an unknown path is a silent no-op', async () => {
    await releaseSharedAuditSink(join(dir, 'never-opened.db'));
    // No throw, no cache entry.
    expect(__hasSharedAuditSink(join(dir, 'never-opened.db'))).toBe(false);
  });

  test('ref-counted: two owners share one handle and close only on last release (#40)', async () => {
    const a = await acquireTenantAuditSink({ path, owner: 'up-cli' });
    const b = await acquireTenantAuditSink({ path, owner: 'fleet-run' });
    expect(a).toBe(b);
    expect(__auditSinkRefCount(path)).toBe(2);

    // First release — underlying sink MUST stay open for the other owner.
    await releaseTenantAuditSink({ path, owner: 'up-cli' });
    expect(__hasSharedAuditSink(path)).toBe(true);
    expect(__auditSinkRefCount(path)).toBe(1);
    // Other owner's handle still usable — no throw.
    await b.record({
      kind: 'rate_limited',
      ts: 2_000_000,
      tenantId: 'acme',
      tool: 'Bash',
      rps: 1,
      burst: 1,
      waitMs: 10,
    });

    // Second release — cache is cleared + underlying sink closed.
    await releaseTenantAuditSink({ path, owner: 'fleet-run' });
    expect(__hasSharedAuditSink(path)).toBe(false);
    expect(__auditSinkRefCount(path)).toBe(0);
  });

  test('ref-counted: independent paths stay isolated (#40)', async () => {
    const path2 = join(dir, 'other.db');
    try {
      await acquireTenantAuditSink({ path, owner: 'up-cli' });
      await acquireTenantAuditSink({ path: path2, owner: 'fleet-run' });
      expect(__auditSinkRefCount(path)).toBe(1);
      expect(__auditSinkRefCount(path2)).toBe(1);
      // Releasing one does not affect the other.
      await releaseTenantAuditSink({ path, owner: 'up-cli' });
      expect(__hasSharedAuditSink(path)).toBe(false);
      expect(__hasSharedAuditSink(path2)).toBe(true);
    } finally {
      await releaseTenantAuditSink({ path: path2, owner: 'fleet-run' });
    }
  });

  test('ref-counted: same-owner re-acquire is idempotent (#40)', async () => {
    const a = await acquireTenantAuditSink({ path, owner: 'up-cli' });
    const b = await acquireTenantAuditSink({ path, owner: 'up-cli' });
    expect(a).toBe(b);
    expect(__auditSinkRefCount(path)).toBe(1);
    // One release clears the cache (no phantom second reference).
    await releaseTenantAuditSink({ path, owner: 'up-cli' });
    expect(__hasSharedAuditSink(path)).toBe(false);
  });

  test('ref-counted: legacy release does not evict refcounted owners (#40)', async () => {
    // Legacy path pins its own '__legacy__' owner slot, so a
    // `releaseSharedAuditSink` call must NOT close a sink still held
    // by a ref-counted owner.
    await acquireTenantAuditSink({ path, owner: 'fleet-run' });
    await getOrOpenSharedAuditSink({ path }); // bumps the legacy slot
    expect(__auditSinkRefCount(path)).toBe(2);
    await releaseSharedAuditSink(path);
    expect(__hasSharedAuditSink(path)).toBe(true);
    expect(__auditSinkRefCount(path)).toBe(1);
    await releaseTenantAuditSink({ path, owner: 'fleet-run' });
    expect(__hasSharedAuditSink(path)).toBe(false);
  });

  test('ref-counted: releasing an owner that never acquired is a no-op (#40)', async () => {
    await acquireTenantAuditSink({ path, owner: 'up-cli' });
    // Unknown owner release — must not decrement or close.
    await releaseTenantAuditSink({ path, owner: 'phantom' });
    expect(__auditSinkRefCount(path)).toBe(1);
    expect(__hasSharedAuditSink(path)).toBe(true);
    await releaseTenantAuditSink({ path, owner: 'up-cli' });
    expect(__hasSharedAuditSink(path)).toBe(false);
  });

  test('the cached sink records + queries as a normal TenantAuditSink', async () => {
    const sink = await getOrOpenSharedAuditSink({ path });
    await sink.record({
      kind: 'rate_limited',
      ts: 1_000_000,
      tenantId: 'acme',
      tool: 'Bash',
      rps: 1,
      burst: 1,
      waitMs: 1234,
    });
    const rows = await sink.query({ kind: 'rate_limited' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.record.kind).toBe('rate_limited');
  });
});
