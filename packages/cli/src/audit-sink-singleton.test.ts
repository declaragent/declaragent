import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __hasSharedAuditSink,
  __resetSharedAuditSinkCache,
  getOrOpenSharedAuditSink,
  releaseSharedAuditSink,
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
