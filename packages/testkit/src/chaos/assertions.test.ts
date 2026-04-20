import { describe, expect, it } from 'bun:test';
import type { MetricRecord, StoredAuditEntry } from '@declaragent/core';
import { dedupNeverDropsAssertion } from './assertions/dedup-never-drops.js';
import { noCrossTenantLeakAssertion } from './assertions/no-cross-tenant-leak.js';
import { noEventLossAssertion } from './assertions/no-event-loss.js';
import { createNoSecretInLogsAssertion } from './assertions/no-secret-in-logs.js';
import { createSlosHeldAssertion } from './assertions/slos-held.js';
import type { ChaosSnapshot } from './types.js';

function snapshot(overrides: Partial<ChaosSnapshot> = {}): ChaosSnapshot {
  return {
    metrics: [],
    auditRecords: [],
    busDepth: 0,
    dlqDepths: {},
    ...overrides,
  };
}

function counter(name: string, id: string, value = 1): MetricRecord {
  return { kind: 'counter', name, op: 'inc', value, labels: { id } };
}

describe('noEventLossAssertion', () => {
  it('passes when received == processed + dlq + inflight', async () => {
    const metrics: MetricRecord[] = [
      counter('source.messages.received', 's1', 10),
      counter('source.messages.processed', 's1', 8),
      counter('source.messages.dlq', 's1', 2),
      { kind: 'gauge', name: 'source.inflight', op: 'set', value: 0, labels: { id: 's1' } },
    ];
    const result = await noEventLossAssertion.check(snapshot({ metrics }));
    expect(result.ok).toBe(true);
  });

  it('fails when ingress exceeds processed + dlq + inflight', async () => {
    const metrics: MetricRecord[] = [
      counter('source.messages.received', 's1', 10),
      counter('source.messages.processed', 's1', 4),
      counter('source.messages.dlq', 's1', 1),
      { kind: 'gauge', name: 'source.inflight', op: 'set', value: 1, labels: { id: 's1' } },
    ];
    const result = await noEventLossAssertion.check(snapshot({ metrics }));
    expect(result.ok).toBe(false);
    const details = (result.details ?? {}) as {
      offenders?: Array<{ id: string; leaked: number }>;
    };
    expect(details.offenders?.[0]?.leaked).toBe(4);
  });
});

describe('noCrossTenantLeakAssertion', () => {
  it('passes when every record belongs to the scoped tenant', async () => {
    const auditRecords: StoredAuditEntry[] = [
      {
        seq: 1,
        record: {
          kind: 'tool_call',
          ts: 1,
          tenantId: 'acme',
          sessionId: 's',
          tool: 'Read',
          permissionKey: 'read:file',
          outcome: 'allow',
        },
        prevHash: '',
        recordHash: 'hash-1',
      },
    ];
    const result = await noCrossTenantLeakAssertion.check(
      snapshot({ tenantId: 'acme', auditRecords }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when audit records show a cross-tenant id', async () => {
    const auditRecords: StoredAuditEntry[] = [
      {
        seq: 1,
        record: {
          kind: 'tool_call',
          ts: 1,
          tenantId: 'acme',
          sessionId: 's',
          tool: 'Read',
          permissionKey: 'read:file',
          outcome: 'allow',
        },
        prevHash: '',
        recordHash: 'hash-1',
      },
      {
        seq: 2,
        record: {
          kind: 'tool_call',
          ts: 2,
          tenantId: 'other-tenant',
          sessionId: 's',
          tool: 'Read',
          permissionKey: 'read:file',
          outcome: 'allow',
        },
        prevHash: 'hash-1',
        recordHash: 'hash-2',
      },
    ];
    const result = await noCrossTenantLeakAssertion.check(
      snapshot({ tenantId: 'acme', auditRecords }),
    );
    expect(result.ok).toBe(false);
  });

  it('flags any tenant_boundary_violation record', async () => {
    const auditRecords: StoredAuditEntry[] = [
      {
        seq: 1,
        record: {
          kind: 'tenant_boundary_violation',
          ts: 1,
          sourceTenantId: 'attacker',
          targetTenantId: 'acme',
          resource: 'event',
          resourceId: 'evt-1',
          blocked: true,
        },
        prevHash: '',
        recordHash: 'h',
      },
    ];
    const result = await noCrossTenantLeakAssertion.check(snapshot({ auditRecords }));
    expect(result.ok).toBe(false);
  });
});

describe('createNoSecretInLogsAssertion', () => {
  it('passes when no watched value appears in logs or audit', async () => {
    const assertion = createNoSecretInLogsAssertion({
      watchedValues: () => ['secret-xyz'],
      getLogLines: () => ['some log line', 'another'],
    });
    const result = await assertion.check(snapshot());
    expect(result.ok).toBe(true);
  });

  it('fails when a watched value leaks to logs', async () => {
    const assertion = createNoSecretInLogsAssertion({
      watchedValues: () => ['super-secret-token'],
      getLogLines: () => ['authorized super-secret-token for session'],
    });
    const result = await assertion.check(snapshot());
    expect(result.ok).toBe(false);
    const details = (result.details ?? {}) as { hits?: unknown[] };
    expect((details.hits ?? []).length).toBeGreaterThan(0);
  });
});

describe('createSlosHeldAssertion', () => {
  it('passes when p99 + DLQ rate are within budget', async () => {
    const metrics: MetricRecord[] = [
      ...Array.from({ length: 100 }, () => ({
        kind: 'histogram' as const,
        name: 'channel.outbound.latency_ms',
        op: 'observe' as const,
        value: 100,
      })),
      counter('source.messages.received', 's', 100),
      counter('source.messages.dlq', 's', 0),
    ];
    const assertion = createSlosHeldAssertion();
    const result = await assertion.check(snapshot({ metrics }));
    expect(result.ok).toBe(true);
  });

  it('fails when p99 exceeds the SLO', async () => {
    const metrics: MetricRecord[] = Array.from({ length: 100 }, (_, i) => ({
      kind: 'histogram' as const,
      name: 'channel.outbound.latency_ms',
      op: 'observe' as const,
      value: i < 99 ? 100 : 60_000,
    }));
    const assertion = createSlosHeldAssertion({ maxOutboundP99Ms: 5000 });
    const result = await assertion.check(snapshot({ metrics }));
    expect(result.ok).toBe(false);
  });

  it('fails when DLQ rate exceeds the SLO', async () => {
    const metrics: MetricRecord[] = [
      counter('source.messages.received', 's', 100),
      counter('source.messages.dlq', 's', 5),
    ];
    const assertion = createSlosHeldAssertion({ maxDlqRate: 0.01 });
    const result = await assertion.check(snapshot({ metrics }));
    expect(result.ok).toBe(false);
  });
});

describe('dedupNeverDropsAssertion', () => {
  it('passes when every correlation id appears exactly once', async () => {
    const auditRecords: StoredAuditEntry[] = ['evt-a', 'evt-b', 'evt-c'].map((cid, i) => ({
      seq: i + 1,
      record: {
        kind: 'tool_call',
        ts: i,
        tenantId: 'acme',
        sessionId: `s-${i}`,
        tool: 'Read',
        permissionKey: 'read:file',
        outcome: 'allow',
        correlationId: cid,
      },
      prevHash: '',
      recordHash: `h-${i}`,
    }));
    const result = await dedupNeverDropsAssertion.check(snapshot({ auditRecords }));
    expect(result.ok).toBe(true);
  });

  it('fails when a correlation id appears more than once', async () => {
    const auditRecords: StoredAuditEntry[] = ['evt-dup', 'evt-dup'].map((cid, i) => ({
      seq: i + 1,
      record: {
        kind: 'tool_call',
        ts: i,
        tenantId: 'acme',
        sessionId: `s-${i}`,
        tool: 'Read',
        permissionKey: 'read:file',
        outcome: 'allow',
        correlationId: cid,
      },
      prevHash: '',
      recordHash: `h-${i}`,
    }));
    const result = await dedupNeverDropsAssertion.check(snapshot({ auditRecords }));
    expect(result.ok).toBe(false);
  });
});
