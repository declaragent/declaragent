import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { verifyEntries } from './chain-verify.js';
import { eraseBySession, erasePlatformUser } from './erase.js';
import { createSqliteAuditSink } from './sqlite-sink.js';
import type { TenantAuditRecord, TenantAuditSink } from './types.js';

let sink: TenantAuditSink;

beforeEach(async () => {
  sink = await createSqliteAuditSink({ path: ':memory:' });
});

afterEach(async () => {
  await sink.close();
});

describe('createSqliteAuditSink — round-trip for every record kind', () => {
  it('tool_call', async () => {
    const rec: TenantAuditRecord = {
      kind: 'tool_call',
      ts: 1_700_000_000_000,
      tenantId: 'acme-prod',
      sessionId: 'sess-1',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
      matchedRule: 'bash:*',
      durationMs: 42,
      correlationId: 'evt-1',
    };
    await sink.record(rec);
    const [entry] = await sink.query({ tenantId: 'acme-prod' });
    expect(entry?.record).toEqual(rec);
  });

  it('channel_event', async () => {
    const rec: TenantAuditRecord = {
      kind: 'channel_event',
      ts: 1_700_000_000_000,
      tenantId: 'acme-prod',
      channelId: 'slack-prod',
      user: { platformUserId: 'U123', displayName: 'alice' },
      conversationId: 'C-ROOM',
      eventKind: 'chat.message',
      payloadSummary: 'hello',
    };
    await sink.record(rec);
    const [entry] = await sink.query({ tenantId: 'acme-prod' });
    expect(entry?.record).toEqual(rec);
  });

  it('channel_tool_call + channel_outbound', async () => {
    const toolCall: TenantAuditRecord = {
      kind: 'channel_tool_call',
      ts: 1_700_000_000_000,
      tenantId: 'acme-prod',
      channelId: 'slack-prod',
      user: { platformUserId: 'U123' },
      conversationId: 'C-ROOM',
      sessionId: 'sess-x',
      tool: 'Edit',
      permissionKey: 'edit:file',
      outcome: 'deny',
      matchedRule: 'deny:secrets/**',
    };
    const outbound: TenantAuditRecord = {
      kind: 'channel_outbound',
      ts: 1_700_000_000_001,
      tenantId: 'acme-prod',
      channelId: 'slack-prod',
      conversationId: 'C-ROOM',
      sessionId: 'sess-x',
      messageId: 'm-1',
      contentKind: 'text',
      latencyMs: 200,
      origin: 'bridge',
    };
    await sink.record(toolCall);
    await sink.record(outbound);
    const entries = await sink.query({ tenantId: 'acme-prod' });
    expect(entries.map((e) => e.record.kind)).toEqual(['channel_tool_call', 'channel_outbound']);
  });

  it('secret_access / tenant_boundary_violation / quota_exceeded', async () => {
    const secret: TenantAuditRecord = {
      kind: 'secret_access',
      ts: 1_700_000_000_000,
      tenantId: 'acme-prod',
      ref: 'vault:kv/x',
      requester: 'channel:slack-prod',
      outcome: 'resolved',
      providerType: 'vault',
      providerName: 'vault-prod',
    };
    const boundary: TenantAuditRecord = {
      kind: 'tenant_boundary_violation',
      ts: 1_700_000_000_001,
      sourceTenantId: 'tenant-a',
      targetTenantId: 'tenant-b',
      resource: 'session',
      resourceId: 'sess-cross',
      blocked: true,
    };
    const quota: TenantAuditRecord = {
      kind: 'quota_exceeded',
      ts: 1_700_000_000_002,
      tenantId: 'acme-prod',
      quota: 'maxConcurrentToolCalls',
      limit: 20,
      observed: 21,
    };
    await sink.record(secret);
    await sink.record(boundary);
    await sink.record(quota);

    const acmeEntries = await sink.query({ tenantId: 'acme-prod' });
    expect(acmeEntries.map((e) => e.record.kind).sort()).toEqual([
      'quota_exceeded',
      'secret_access',
    ]);
    const boundaryEntries = await sink.query({ tenantId: 'tenant-a' });
    expect(boundaryEntries).toHaveLength(1);
    expect(boundaryEntries[0]?.record.kind).toBe('tenant_boundary_violation');
  });

  it('query filters by kind + since + search', async () => {
    await sink.record({
      kind: 'tool_call',
      ts: 100,
      tenantId: 'acme-prod',
      sessionId: 'sess-1',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    });
    await sink.record({
      kind: 'secret_access',
      ts: 200,
      tenantId: 'acme-prod',
      ref: 'vault:db/password',
      requester: 'session:sess-1',
      outcome: 'resolved',
    });
    await sink.record({
      kind: 'secret_access',
      ts: 300,
      tenantId: 'acme-prod',
      ref: 'aws-sm:us-east-1/kafka',
      requester: 'session:sess-2',
      outcome: 'denied',
    });

    const denied = await sink.query({
      tenantId: 'acme-prod',
      kind: 'secret_access',
      sinceMs: 250,
    });
    expect(denied.map((e) => (e.record as { ref?: string }).ref)).toEqual([
      'aws-sm:us-east-1/kafka',
    ]);

    const vaultHits = await sink.query({
      tenantId: 'acme-prod',
      search: 'vault:db/password',
    });
    expect(vaultHits).toHaveLength(1);
  });
});

describe('chain integrity', () => {
  it('verify returns ok for a clean chain', async () => {
    for (let i = 0; i < 10; i += 1) {
      await sink.record({
        kind: 'tool_call',
        ts: i,
        tenantId: 'acme',
        sessionId: `sess-${i}`,
        tool: 'Bash',
        permissionKey: 'bash:exec',
        outcome: 'allow',
      });
    }
    const report = await sink.verify('acme');
    expect(report.ok).toBe(true);
    expect(report.totalEntries).toBe(10);
    expect(report.verifiedEntries).toBe(10);
    expect(report.violations).toHaveLength(0);
  });

  it('detects tamper: flipping a byte in record_json', async () => {
    await sink.close();
    const { rmSync } = await import('node:fs');
    const path = '/tmp/declaragent-audit-tamper.sqlite';
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        rmSync(p);
      } catch {
        /* ignore */
      }
    }
    sink = await createSqliteAuditSink({ path });
    for (let i = 0; i < 5; i += 1) {
      await sink.record({
        kind: 'tool_call',
        ts: i,
        tenantId: 'acme',
        sessionId: `sess-${i}`,
        tool: 'Bash',
        permissionKey: 'bash:exec',
        outcome: 'allow',
      });
    }
    const adversarial = new Database(path);
    // Find the 3rd seq (index 2, zero-based) — avoids AUTOINCREMENT
    // drift between runs.
    const row = adversarial
      .prepare('SELECT seq FROM audit_records ORDER BY seq ASC LIMIT 1 OFFSET 2')
      .get() as { seq: number } | null;
    const targetSeq = row?.seq ?? 3;
    adversarial
      .prepare(
        `UPDATE audit_records SET record_json = json_set(record_json, '$.tool', 'Rm') WHERE seq = ?`,
      )
      .run(targetSeq);
    adversarial.close();

    const report = await sink.verify('acme');
    expect(report.ok).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations[0]?.seq).toBe(targetSeq);
    expect(report.violations[0]?.kind).toBe('hash-mismatch');
  });

  it('detects tamper: overwriting prev_hash breaks continuity', async () => {
    await sink.close();
    const { rmSync } = await import('node:fs');
    const path = '/tmp/declaragent-audit-prev.sqlite';
    try {
      rmSync(path);
    } catch {
      /* file may not exist */
    }
    try {
      rmSync(`${path}-wal`);
    } catch {
      /* fine */
    }
    try {
      rmSync(`${path}-shm`);
    } catch {
      /* fine */
    }
    sink = await createSqliteAuditSink({ path });
    for (let i = 0; i < 4; i += 1) {
      await sink.record({
        kind: 'quota_exceeded',
        ts: i,
        tenantId: 'acme',
        quota: 'maxActiveSessions',
        limit: 10,
        observed: 10 + i,
      });
    }
    const adversarial = new Database(path);
    // Grab the actual seq of the second entry (first is the lowest).
    const row = adversarial
      .prepare('SELECT seq FROM audit_records ORDER BY seq ASC LIMIT 1 OFFSET 1')
      .get() as { seq: number } | null;
    const targetSeq = row?.seq ?? 2;
    adversarial
      .prepare('UPDATE audit_records SET prev_hash = ? WHERE seq = ?')
      .run('0'.repeat(64), targetSeq);
    adversarial.close();

    const report = await sink.verify('acme');
    expect(report.ok).toBe(false);
    expect(report.violations[0]?.kind).toBe('prev-hash-mismatch');
    expect(report.violations[0]?.seq).toBe(targetSeq);
  });

  it('standalone verifyEntries works against an exported list', async () => {
    for (let i = 0; i < 5; i += 1) {
      await sink.record({
        kind: 'tool_call',
        ts: i,
        tenantId: 'x',
        sessionId: `s-${i}`,
        tool: 'Read',
        permissionKey: 'read:file',
        outcome: 'allow',
      });
    }
    const entries = await sink.query({ tenantId: 'x' });
    const report = await verifyEntries(entries);
    expect(report.ok).toBe(true);
    expect(report.verifiedEntries).toBe(5);
  });
});

describe('right-to-erasure', () => {
  it('erase replaces matching records with tombstones + chain stays verifiable', async () => {
    await sink.record({
      kind: 'channel_event',
      ts: 1,
      tenantId: 'acme',
      channelId: 'slack',
      user: { platformUserId: 'U-KEEP' },
      conversationId: 'C1',
      eventKind: 'chat.message',
    });
    await sink.record({
      kind: 'channel_event',
      ts: 2,
      tenantId: 'acme',
      channelId: 'slack',
      user: { platformUserId: 'U-ERASE' },
      conversationId: 'C1',
      eventKind: 'chat.message',
    });
    await sink.record({
      kind: 'channel_tool_call',
      ts: 3,
      tenantId: 'acme',
      channelId: 'slack',
      user: { platformUserId: 'U-ERASE' },
      conversationId: 'C1',
      sessionId: 'sess-to-erase',
      tool: 'Write',
      permissionKey: 'write:file',
      outcome: 'allow',
    });
    const erased = await erasePlatformUser(sink, {
      platformUserId: 'U-ERASE',
      reason: 'gdpr-test',
    });
    expect(erased).toBe(2);

    const entries = await sink.query({ tenantId: 'acme' });
    const kinds = entries.map((e) => e.record.kind);
    expect(kinds).toEqual(['channel_event', 'erased', 'erased']);
    // Erased tombstones carry the original kind for filtering.
    const tombstones = entries.filter(
      (e): e is typeof e & { record: { kind: 'erased' } } => e.record.kind === 'erased',
    );
    expect(tombstones.map((t) => (t.record as { originalKind: string }).originalKind)).toEqual([
      'channel_event',
      'channel_tool_call',
    ]);
    // The kept record carries the non-erased user.
    const kept = entries.find((e) => e.record.kind === 'channel_event');
    expect((kept?.record as { user: { platformUserId: string } }).user.platformUserId).toBe(
      'U-KEEP',
    );

    // Chain-verify stays green.
    const report = await sink.verify('acme');
    expect(report.ok).toBe(true);
  });

  it('eraseBySession wipes tool_call + outbound records tied to a session', async () => {
    await sink.record({
      kind: 'tool_call',
      ts: 1,
      tenantId: 'acme',
      sessionId: 'keep',
      tool: 'Read',
      permissionKey: 'read:file',
      outcome: 'allow',
    });
    await sink.record({
      kind: 'tool_call',
      ts: 2,
      tenantId: 'acme',
      sessionId: 'wipe',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    });
    await sink.record({
      kind: 'channel_outbound',
      ts: 3,
      tenantId: 'acme',
      channelId: 'slack',
      conversationId: 'C',
      sessionId: 'wipe',
      messageId: 'm-1',
      contentKind: 'text',
    });
    const erased = await eraseBySession(sink, { sessionId: 'wipe' });
    expect(erased).toBe(2);
    const entries = await sink.query({ tenantId: 'acme' });
    expect(entries.map((e) => e.record.kind)).toEqual(['tool_call', 'erased', 'erased']);
  });

  it('verify stays green after erase (tombstone preserves chain)', async () => {
    for (let i = 0; i < 6; i += 1) {
      await sink.record({
        kind: 'channel_event',
        ts: i,
        tenantId: 'acme',
        channelId: 'slack',
        user: { platformUserId: i % 2 === 0 ? 'U-EVEN' : 'U-ODD' },
        conversationId: 'C',
        eventKind: 'chat.message',
      });
    }
    await erasePlatformUser(sink, { platformUserId: 'U-ODD' });
    const report = await sink.verify('acme');
    expect(report.ok).toBe(true);
    expect(report.totalEntries).toBe(6);
  });
});

describe('retention prune', () => {
  it('deletes records older than retentionDays for one tenant only', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = 1_700_000_000_000;
    await sink.record({
      kind: 'tool_call',
      ts: now - 100 * dayMs,
      tenantId: 'acme',
      sessionId: 'old',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    });
    await sink.record({
      kind: 'tool_call',
      ts: now - 10 * dayMs,
      tenantId: 'acme',
      sessionId: 'recent',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    });
    await sink.record({
      kind: 'tool_call',
      ts: now - 200 * dayMs,
      tenantId: 'other',
      sessionId: 'other-old',
      tool: 'Bash',
      permissionKey: 'bash:exec',
      outcome: 'allow',
    });

    const pruned = await sink.prune({
      tenantId: 'acme',
      retentionDays: 30,
      now: () => now,
    });
    expect(pruned).toBe(1);

    const remaining = await sink.query({ tenantId: 'acme' });
    expect(remaining.map((e) => (e.record as { sessionId: string }).sessionId)).toEqual(['recent']);
    // Other tenant untouched.
    const other = await sink.query({ tenantId: 'other' });
    expect(other).toHaveLength(1);
  });
});
