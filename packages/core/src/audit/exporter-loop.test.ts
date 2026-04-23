/**
 * Tests for the in-process SIEM export loop.
 *
 * Focus:
 *   - Cursor advances only after ack; restart picks up where the previous
 *     run left off (acceptance A.2 — "Kill the Splunk endpoint; after
 *     restart, no gaps").
 *   - Retryable failures re-queue on the next tick.
 *   - Non-retryable failures pause the loop immediately.
 *   - 5 consecutive retryable failures pause the loop + emit the
 *     Prometheus gauge.
 *   - `resume()` clears the pause + fires a tick.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createPrometheusRegistry } from '../observability/prometheus.js';
import { startAuditExportLoop } from './exporter-loop.js';
import type { AuditExporter, PushResult } from './exporters/exporter.js';
import { createSqliteAuditSink } from './sqlite-sink.js';
import type { TenantAuditRecord, TenantAuditSink } from './types.js';

interface FakeExporter extends AuditExporter {
  push: AuditExporter['push'] & {
    mock: {
      calls: Array<Parameters<AuditExporter['push']>[0]>;
    };
  };
  setBehavior(behavior: (batch: readonly unknown[]) => Promise<PushResult>): void;
}

function makeFakeExporter(name = 'splunk:test'): FakeExporter {
  const calls: Array<readonly unknown[]> = [];
  let behavior: (batch: readonly unknown[]) => Promise<PushResult> = async (b) => ({
    ok: true,
    acked: b.length,
  });
  const push = (async (batch: readonly unknown[]) => {
    calls.push(batch);
    return behavior(batch);
  }) as unknown as FakeExporter['push'];
  (push as unknown as { mock: unknown }).mock = { calls };
  return {
    name,
    vendor: 'splunk',
    push,
    setBehavior(b) {
      behavior = b;
    },
  };
}

async function seedAudit(sink: TenantAuditSink, count: number, tenantId = 'acme'): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    const rec: TenantAuditRecord = {
      kind: 'tool_call',
      ts: 1_700_000_000_000 + i,
      tenantId,
      sessionId: `s${i}`,
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    };
    await sink.record(rec);
  }
}

let sink: TenantAuditSink;
beforeEach(async () => {
  sink = await createSqliteAuditSink({ path: ':memory:' });
});
afterEach(async () => {
  await sink.close();
});

describe('startAuditExportLoop — happy path', () => {
  it('pushes queued rows + advances cursor to the last acked seq', async () => {
    await seedAudit(sink, 5);
    const exp = makeFakeExporter();
    const loop = startAuditExportLoop({
      sink,
      exporter: exp,
      intervalMs: 60_000, // large so the tick doesn't run on its own.
    });

    const acked = await loop.flushNow();
    expect(acked).toBe(5);
    expect(exp.push.mock.calls).toHaveLength(1);
    expect(exp.push.mock.calls[0]).toHaveLength(5);

    const cursor = await sink.readExportCursor?.('splunk:test');
    expect(cursor).not.toBeNull();
    expect(cursor?.lastSeq).toBe(5);

    // A follow-up tick has nothing to push.
    const second = await loop.flushNow();
    expect(second).toBe(0);

    await loop.stop();
  });

  it('cursor survives a loop restart — no gaps, no duplicates', async () => {
    await seedAudit(sink, 3);

    // First loop acks all 3 and advances cursor.
    const exp1 = makeFakeExporter();
    const loop1 = startAuditExportLoop({ sink, exporter: exp1, intervalMs: 60_000 });
    expect(await loop1.flushNow()).toBe(3);
    await loop1.stop();

    // Add 2 more rows between runs.
    await seedAudit(sink, 2);

    // Second loop only pushes the NEW rows (seq > 3).
    const exp2 = makeFakeExporter();
    const loop2 = startAuditExportLoop({ sink, exporter: exp2, intervalMs: 60_000 });
    const acked = await loop2.flushNow();
    expect(acked).toBe(2);
    expect(exp2.push.mock.calls).toHaveLength(1);
    const batch = exp2.push.mock.calls[0] ?? [];
    const seqs = batch.map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual([4, 5]);
    await loop2.stop();
  });
});

describe('startAuditExportLoop — failure paths', () => {
  it('does not advance cursor on retryable failure; re-pushes next tick', async () => {
    await seedAudit(sink, 2);
    const exp = makeFakeExporter();
    let attempts = 0;
    exp.setBehavior(async (batch) => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, error: 'splunk: http 503 — boom', retryable: true };
      }
      return { ok: true, acked: batch.length };
    });
    const loop = startAuditExportLoop({
      sink,
      exporter: exp,
      intervalMs: 60_000,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });

    expect(await loop.flushNow()).toBe(0);
    // Cursor stays at 0.
    const c1 = await sink.readExportCursor?.('splunk:test');
    expect(c1?.lastSeq ?? 0).toBe(0);

    // Second tick pushes the same batch.
    expect(await loop.flushNow()).toBe(2);
    const c2 = await sink.readExportCursor?.('splunk:test');
    expect(c2?.lastSeq).toBe(2);

    await loop.stop();
  });

  it('pauses immediately on a non-retryable failure', async () => {
    await seedAudit(sink, 1);
    const exp = makeFakeExporter();
    exp.setBehavior(async () => ({
      ok: false,
      error: 'splunk: http 401 — unauthorized',
      retryable: false,
    }));
    const registry = createPrometheusRegistry();
    const loop = startAuditExportLoop({
      sink,
      exporter: exp,
      intervalMs: 60_000,
      metrics: registry,
    });
    await loop.flushNow();
    expect(loop.isPaused()).toBe(true);

    // Subsequent tick is a no-op.
    await loop.flushNow();
    expect(exp.push.mock.calls).toHaveLength(1);
    await loop.stop();
  });

  it('pauses after 5 consecutive retryable failures', async () => {
    await seedAudit(sink, 1);
    const exp = makeFakeExporter();
    exp.setBehavior(async () => ({
      ok: false,
      error: 'splunk: http 503 — boom',
      retryable: true,
    }));
    const loop = startAuditExportLoop({
      sink,
      exporter: exp,
      intervalMs: 60_000,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      maxConsecutiveFailures: 5,
    });
    for (let i = 0; i < 5; i += 1) {
      await loop.flushNow();
    }
    expect(loop.isPaused()).toBe(true);
    await loop.stop();
  });

  it('resume() clears the pause + re-enables pushes', async () => {
    await seedAudit(sink, 2);
    const exp = makeFakeExporter();
    let attempts = 0;
    exp.setBehavior(async (batch) => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, error: 'splunk: http 401', retryable: false };
      }
      return { ok: true, acked: batch.length };
    });
    const loop = startAuditExportLoop({
      sink,
      exporter: exp,
      intervalMs: 60_000,
    });
    await loop.flushNow();
    expect(loop.isPaused()).toBe(true);

    loop.resume();
    // The resume schedules a zero-delay tick. Flush-now re-runs synchronously.
    expect(await loop.flushNow()).toBe(2);
    expect(loop.isPaused()).toBe(false);
    await loop.stop();
  });

  it('advances cursor partially on partial-success ack', async () => {
    await seedAudit(sink, 4);
    const exp = makeFakeExporter();
    exp.setBehavior(async () => ({ ok: true, acked: 2 }));
    const loop = startAuditExportLoop({ sink, exporter: exp, intervalMs: 60_000 });
    expect(await loop.flushNow()).toBe(2);
    const cursor = await sink.readExportCursor?.('splunk:test');
    expect(cursor?.lastSeq).toBe(2);
    await loop.stop();
  });

  it('throws when the sink does not implement cursor methods', () => {
    const stubSink = {
      record: async () => {},
      query: async () => [],
      erase: async () => 0,
      verify: async () => ({ ok: true, totalEntries: 0, verifiedEntries: 0, violations: [] }),
      prune: async () => 0,
      close: () => {},
    } as TenantAuditSink;
    const exp = makeFakeExporter();
    expect(() => startAuditExportLoop({ sink: stubSink, exporter: exp })).toThrow(
      /readExportCursor/,
    );
  });
});

describe('startAuditExportLoop — cursor idempotency', () => {
  it('writeExportCursor never rewinds lastSeq', async () => {
    await seedAudit(sink, 3);
    await sink.writeExportCursor?.('splunk:test', 3);
    await sink.writeExportCursor?.('splunk:test', 1);
    const c = await sink.readExportCursor?.('splunk:test');
    expect(c?.lastSeq).toBe(3);
  });
});
