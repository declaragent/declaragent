/**
 * Tests for the adaptive batch-interval controller on the SIEM export
 * loop (POST_ENTERPRISE_BACKLOG.md #12).
 *
 * The controller is a simple proportional adjuster: next interval
 * shrinks on big batches (queue is deeper than target) and relaxes on
 * small / empty batches (queue is shallower than target).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createPrometheusRegistry } from '../observability/prometheus.js';
import { startAuditExportLoop } from './exporter-loop.js';
import type { AuditExporter, PushResult } from './exporters/exporter.js';
import { createSqliteAuditSink } from './sqlite-sink.js';
import type { TenantAuditRecord, TenantAuditSink } from './types.js';

function makeFakeExporter(): AuditExporter {
  const push: AuditExporter['push'] = async (batch): Promise<PushResult> => ({
    ok: true,
    acked: batch.length,
  });
  return { name: 'splunk:adaptive', vendor: 'splunk', push };
}

async function seed(sink: TenantAuditSink, count: number): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    const rec: TenantAuditRecord = {
      kind: 'tool_call',
      ts: 1_700_000_000_000 + i,
      tenantId: 'acme',
      sessionId: `s${i}`,
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    };
    await sink.record(rec);
  }
}

describe('startAuditExportLoop — adaptive batch interval', () => {
  let sink: TenantAuditSink;
  beforeEach(async () => {
    sink = await createSqliteAuditSink({ path: ':memory:' });
  });
  afterEach(async () => {
    await sink.close();
  });

  it('contracts toward minIntervalMs on sustained burst', async () => {
    // Seed way more than batchSize so every tick hits the cap.
    await seed(sink, 10_000);
    const loop = startAuditExportLoop({
      sink,
      exporter: makeFakeExporter(),
      intervalMs: 10_000, // start wide
      batchSize: 500,
      batch: {
        minIntervalMs: 200,
        maxIntervalMs: 10_000,
        targetBatchRows: 500,
      },
    });

    const initial = loop.currentIntervalMs();
    // Each tick maxes out (shipped === batchSize) so the controller
    // halves the interval every iteration.
    for (let i = 0; i < 10; i += 1) {
      await loop.flushNow();
    }
    const after = loop.currentIntervalMs();
    expect(after).toBeLessThan(initial);
    expect(after).toBe(200); // clamped at min after enough halving
    await loop.stop();
  });

  it('relaxes toward maxIntervalMs on empty queue', async () => {
    // No rows seeded → every tick ships 0 → interval doubles.
    const loop = startAuditExportLoop({
      sink,
      exporter: makeFakeExporter(),
      intervalMs: 500, // start below max
      batchSize: 500,
      batch: {
        minIntervalMs: 200,
        maxIntervalMs: 10_000,
        targetBatchRows: 500,
      },
    });
    const initial = loop.currentIntervalMs();
    for (let i = 0; i < 10; i += 1) {
      await loop.flushNow();
    }
    const after = loop.currentIntervalMs();
    expect(after).toBeGreaterThanOrEqual(initial);
    expect(after).toBe(10_000);
    await loop.stop();
  });

  it('stays stable at steady state when shipped ≈ target', async () => {
    // Seed exactly the target per tick and refill between ticks.
    await seed(sink, 500);
    const loop = startAuditExportLoop({
      sink,
      exporter: makeFakeExporter(),
      intervalMs: 5_000,
      batchSize: 500,
      batch: {
        minIntervalMs: 200,
        maxIntervalMs: 10_000,
        targetBatchRows: 500,
      },
    });
    const initial = loop.currentIntervalMs();
    // The first tick ships `batchSize` rows which trips the cap logic
    // (halves the interval). So seed in a way that the sink returns
    // exactly targetBatchRows without hitting the cap — use a smaller
    // batchSize than target? No — target IS capped by batchSize. Instead
    // this test validates that when shipped < batchSize and == target,
    // the ratio == 1 so the interval is unchanged.
    // With batchSize=500 and 500 rows waiting, the query returns 500
    // which equals batchSize → hits cap path. So raise batchSize above
    // target:
    await loop.stop();
    const loop2 = startAuditExportLoop({
      sink,
      exporter: makeFakeExporter(),
      intervalMs: 5_000,
      batchSize: 1_000,
      batch: { minIntervalMs: 200, maxIntervalMs: 10_000, targetBatchRows: 500 },
    });
    // Seed a fresh sink scope: wipe by using initial == post-seed of 500 rows,
    // the first tick ships 500 rows (target) → ratio 1 → interval unchanged.
    const before = loop2.currentIntervalMs();
    expect(await loop2.flushNow()).toBe(500);
    const after = loop2.currentIntervalMs();
    expect(after).toBe(before);
    expect(initial).toBe(5_000);
    await loop2.stop();
  });

  it('exposes interval + batch-rows via Prometheus metrics', async () => {
    await seed(sink, 50);
    const registry = createPrometheusRegistry();
    const loop = startAuditExportLoop({
      sink,
      exporter: makeFakeExporter(),
      intervalMs: 1_000,
      batchSize: 500,
      metrics: registry,
      batch: { minIntervalMs: 200, maxIntervalMs: 10_000, targetBatchRows: 500 },
    });
    await loop.flushNow();
    const scrape = registry.scrape();
    expect(scrape).toContain('declaragent_audit_batch_interval_ms');
    expect(scrape).toContain('declaragent_audit_batch_rows');
    // Histogram has buckets + count + sum lines.
    expect(scrape).toMatch(/declaragent_audit_batch_rows_bucket\{[^}]*le="\+Inf"[^}]*\} \d/);
    await loop.stop();
  });

  it('omits adaptive logic when `batch` is undefined (back-compat)', async () => {
    await seed(sink, 10);
    const loop = startAuditExportLoop({
      sink,
      exporter: makeFakeExporter(),
      intervalMs: 7_777,
      batchSize: 500,
    });
    expect(loop.currentIntervalMs()).toBe(7_777);
    await loop.flushNow();
    // Still the fixed interval; no adjustment happens.
    expect(loop.currentIntervalMs()).toBe(7_777);
    await loop.stop();
  });

  it('clamps a supplied intervalMs outside [min, max] into the window', async () => {
    await seed(sink, 1);
    const loop = startAuditExportLoop({
      sink,
      exporter: makeFakeExporter(),
      intervalMs: 500_000, // absurdly large
      batchSize: 500,
      batch: { minIntervalMs: 200, maxIntervalMs: 10_000, targetBatchRows: 500 },
    });
    // Clamped at construction time to maxIntervalMs.
    expect(loop.currentIntervalMs()).toBe(10_000);
    await loop.stop();
  });
});
