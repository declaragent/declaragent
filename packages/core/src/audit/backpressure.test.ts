/**
 * Tests for the SIEM back-pressure controller + sink integration + loop
 * evaluator (POST_ENTERPRISE_BACKLOG.md #11).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createPrometheusRegistry } from '../observability/prometheus.js';
import { AuditBackpressureError, createBackpressureController } from './backpressure.js';
import { startAuditExportLoop } from './exporter-loop.js';
import type { AuditExporter, PushResult } from './exporters/exporter.js';
import { createSqliteAuditSink } from './sqlite-sink.js';
import type { TenantAuditRecord, TenantAuditSink } from './types.js';

// ── Fake exporter ──────────────────────────────────────────────────────────

interface FakeExporter extends AuditExporter {
  setBehavior(b: (batch: readonly unknown[]) => Promise<PushResult>): void;
  callCount(): number;
}

function makeFakeExporter(name = 'splunk:bp-test'): FakeExporter {
  let behavior: (batch: readonly unknown[]) => Promise<PushResult> = async (b) => ({
    ok: true,
    acked: b.length,
  });
  let calls = 0;
  const push: AuditExporter['push'] = async (batch) => {
    calls += 1;
    return behavior(batch);
  };
  return {
    name,
    vendor: 'splunk',
    push,
    setBehavior: (b) => {
      behavior = b;
    },
    callCount: () => calls,
  };
}

async function seed(sink: TenantAuditSink, count: number, firstTs: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const rec: TenantAuditRecord = {
      kind: 'tool_call',
      ts: firstTs + i,
      tenantId: 'acme',
      sessionId: `s${i}`,
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    };
    await sink.record(rec);
  }
}

// ── Controller unit tests ──────────────────────────────────────────────────

describe('createBackpressureController', () => {
  it('starts unpaused with fail-fast default policy', () => {
    const c = createBackpressureController();
    expect(c.isPaused()).toBe(false);
    expect(c.policy()).toBe('fail-fast');
  });

  it('flips paused state + records reason', () => {
    const c = createBackpressureController();
    c.setPaused(true, 5_000_000);
    expect(c.isPaused()).toBe(true);
    expect(c.state().reasonMs).toBe(5_000_000);
    c.setPaused(false);
    expect(c.isPaused()).toBe(false);
    expect(c.state().reasonMs).toBeUndefined();
  });

  it('drives the paused_total counter + paused gauge via bindMetrics', () => {
    const c = createBackpressureController();
    const registry = createPrometheusRegistry();
    c.bindMetrics({
      pausedGauge: registry.gauge('bp.active', 'active'),
      pausedTotalCounter: registry.counter('bp.paused_total', 'paused total'),
      dropCounter: registry.counter('bp.drops_total', 'drops total'),
      labels: { exporter: 'splunk:bp-test' },
    });
    c.setPaused(true, 100);
    c.setPaused(false);
    c.setPaused(true, 200);
    c.recordDrop();
    const scrape = registry.scrape();
    expect(scrape).toContain('bp_paused_total{exporter="splunk:bp-test"} 2');
    expect(scrape).toContain('bp_drops_total{exporter="splunk:bp-test"} 1');
  });
});

// ── Sink integration ───────────────────────────────────────────────────────

describe('createSqliteAuditSink — back-pressure gate', () => {
  let sink: TenantAuditSink;
  afterEach(async () => {
    if (sink) await sink.close();
  });

  it('throws AuditBackpressureError on record() when paused (fail-fast)', async () => {
    const controller = createBackpressureController();
    sink = await createSqliteAuditSink({ path: ':memory:', backpressure: controller });
    await seed(sink, 1, 1_000_000);
    controller.setPaused(true, 7_200_000);
    const rec: TenantAuditRecord = {
      kind: 'tool_call',
      ts: 1_000_001,
      tenantId: 'acme',
      sessionId: 'paused',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    };
    await expect(sink.record(rec)).rejects.toBeInstanceOf(AuditBackpressureError);
    const rows = await sink.query({ tenantId: 'acme' });
    expect(rows.length).toBe(1); // only the pre-pause row
  });

  it('silently drops + counts on record() when paused (drop policy)', async () => {
    const controller = createBackpressureController({ policy: 'drop' });
    const registry = createPrometheusRegistry();
    controller.bindMetrics({
      dropCounter: registry.counter('audit.drops_total', 'drops'),
      labels: { exporter: 'test' },
    });
    sink = await createSqliteAuditSink({ path: ':memory:', backpressure: controller });
    controller.setPaused(true, 7_200_000);
    const rec: TenantAuditRecord = {
      kind: 'tool_call',
      ts: 1_000_001,
      tenantId: 'acme',
      sessionId: 'drop',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    };
    await sink.record(rec); // does not throw
    const rows = await sink.query({ tenantId: 'acme' });
    expect(rows.length).toBe(0);
    expect(registry.scrape()).toContain('audit_drops_total{exporter="test"} 1');
  });

  it('resumes normal writes once controller unpauses', async () => {
    const controller = createBackpressureController();
    sink = await createSqliteAuditSink({ path: ':memory:', backpressure: controller });
    controller.setPaused(true, 7_200_000);
    const rec: TenantAuditRecord = {
      kind: 'tool_call',
      ts: 1_000_000,
      tenantId: 'acme',
      sessionId: 's1',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    };
    await expect(sink.record(rec)).rejects.toBeInstanceOf(AuditBackpressureError);
    controller.setPaused(false);
    await sink.record(rec); // succeeds
    const rows = await sink.query({ tenantId: 'acme' });
    expect(rows.length).toBe(1);
  });
});

// ── Loop evaluator ─────────────────────────────────────────────────────────

describe('startAuditExportLoop — back-pressure evaluator', () => {
  let sink: TenantAuditSink;
  beforeEach(async () => {
    sink = await createSqliteAuditSink({ path: ':memory:' });
  });
  afterEach(async () => {
    await sink.close();
  });

  it('engages pause when oldest unshipped row exceeds threshold, resumes when drained', async () => {
    // Seed rows with ts anchored 2h in the past relative to our fake `now`.
    const fakeNow = 10_000_000_000;
    const twoHoursAgo = fakeNow - 2 * 60 * 60 * 1000;
    await seed(sink, 3, twoHoursAgo);

    const controller = createBackpressureController();
    const exp = makeFakeExporter();
    // Start with a stalled exporter so nothing ships.
    exp.setBehavior(async () => ({ ok: false, retryable: true, error: 'stall' }));
    const registry = createPrometheusRegistry();
    const loop = startAuditExportLoop({
      sink,
      exporter: exp,
      intervalMs: 60_000,
      metrics: registry,
      now: () => fakeNow,
      backpressure: {
        enabled: true,
        pauseAfterBacklogMs: 60 * 60 * 1000, // 1h threshold
        controller,
        evaluateIntervalMs: 60_000,
      },
    });

    expect(controller.isPaused()).toBe(false);
    const backlog = await loop.evaluateBackpressureNow();
    expect(backlog).not.toBeNull();
    expect(backlog).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 5);
    expect(controller.isPaused()).toBe(true);

    // New writes now fail-fast.
    const rec: TenantAuditRecord = {
      kind: 'tool_call',
      ts: fakeNow,
      tenantId: 'acme',
      sessionId: 'would-drop',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    };
    // Attach the controller to the sink to get the fail-fast behaviour
    // on an existing (already-seeded) sink.
    const sinkWithBp = await createSqliteAuditSink({
      path: ':memory:',
      backpressure: controller,
    });
    await expect(sinkWithBp.record(rec)).rejects.toBeInstanceOf(AuditBackpressureError);
    await sinkWithBp.close();

    // Metrics scraped show active + paused_total.
    const scrape = registry.scrape();
    expect(scrape).toMatch(/declaragent_audit_backpressure_active\{[^}]*\} 1/);
    expect(scrape).toMatch(/declaragent_audit_backpressure_paused_total\{[^}]*\} 1/);

    // Unstall exporter + drain.
    exp.setBehavior(async (b) => ({ ok: true, acked: b.length }));
    expect(await loop.flushNow()).toBe(3);

    // After draining, backlog is empty and evaluator auto-resumes.
    const postDrain = await loop.evaluateBackpressureNow();
    expect(postDrain).toBeNull();
    expect(controller.isPaused()).toBe(false);

    await loop.stop();
  });

  it('leaves controller alone when backlog stays under threshold', async () => {
    const fakeNow = 10_000_000_000;
    // 30 min old → under 1h threshold.
    const halfHourAgo = fakeNow - 30 * 60 * 1000;
    await seed(sink, 2, halfHourAgo);

    const controller = createBackpressureController();
    const exp = makeFakeExporter();
    exp.setBehavior(async () => ({ ok: false, retryable: true, error: 'stall' }));
    const loop = startAuditExportLoop({
      sink,
      exporter: exp,
      intervalMs: 60_000,
      now: () => fakeNow,
      backpressure: {
        enabled: true,
        pauseAfterBacklogMs: 60 * 60 * 1000,
        controller,
      },
    });
    const backlog = await loop.evaluateBackpressureNow();
    expect(backlog).not.toBeNull();
    expect(controller.isPaused()).toBe(false);
    await loop.stop();
  });

  it('no-ops cleanly when backpressure is omitted', async () => {
    await seed(sink, 1, 1_000_000);
    const exp = makeFakeExporter();
    const loop = startAuditExportLoop({ sink, exporter: exp, intervalMs: 60_000 });
    expect(await loop.evaluateBackpressureNow()).toBeNull();
    await loop.stop();
  });
});
