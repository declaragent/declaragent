import { describe, expect, test } from 'bun:test';
import type { TenantAuditRecord, TenantAuditSink } from '@declaragent/core';
import { createSqliteAuditSink } from '@declaragent/core';
import type { AuditCliDeps, AuditCliIO } from './audit-cli.js';
import { auditErase, auditPrune, auditQuery, auditVerify } from './audit-cli.js';

function captureIo(): {
  io: AuditCliIO;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
    },
    out,
    err,
  };
}

async function seeded(): Promise<TenantAuditSink> {
  const sink = await createSqliteAuditSink({ path: ':memory:' });
  const now = Date.now();
  const baseRecords: TenantAuditRecord[] = [
    {
      kind: 'tool_call',
      ts: now - 5000,
      tenantId: 'acme-prod',
      sessionId: 'sess-A',
      tool: 'Bash',
      permissionKey: 'Bash',
      outcome: 'allow',
      durationMs: 12,
    },
    {
      kind: 'tool_call',
      ts: now - 1000,
      tenantId: 'acme-prod',
      sessionId: 'sess-B',
      tool: 'Read',
      permissionKey: 'Read',
      outcome: 'deny',
    },
    {
      kind: 'quota_exceeded',
      ts: now,
      tenantId: 'beta-tenant',
      quota: 'maxConcurrentToolCalls',
      limit: 1,
      observed: 2,
    },
  ];
  for (const r of baseRecords) await sink.record(r);
  return sink;
}

describe('audit-cli', () => {
  describe('auditQuery', () => {
    test('unfiltered query prints every record', async () => {
      const cap = captureIo();
      const sink = await seeded();
      const deps: AuditCliDeps = {
        io: cap.io,
        dbPath: ':memory:',
        openSink: async () => sink,
      };
      const code = await auditQuery({}, deps);
      expect(code).toBe(0);
      const output = cap.out.join('');
      expect(output).toContain('audit records (3)');
      expect(output).toContain('tool_call');
      expect(output).toContain('quota_exceeded');
    });

    test('--tenant + --kind filter + --json emits structured output', async () => {
      const cap = captureIo();
      const sink = await seeded();
      const deps: AuditCliDeps = {
        io: cap.io,
        dbPath: ':memory:',
        openSink: async () => sink,
      };
      const code = await auditQuery({ tenant: 'acme-prod', kind: 'tool_call', json: true }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out.join(''));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      for (const entry of parsed) {
        expect(entry.record.kind).toBe('tool_call');
        expect(entry.record.tenantId).toBe('acme-prod');
      }
    });

    test('error path: missing DB returns 1 with a fix hint', async () => {
      const cap = captureIo();
      const code = await auditQuery({}, { io: cap.io, dbPath: '/definitely-missing.db' });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('audit database not found');
    });
  });

  describe('auditVerify', () => {
    test('intact chain: exit 0 + prints "chain intact"', async () => {
      const cap = captureIo();
      const sink = await seeded();
      const deps: AuditCliDeps = {
        io: cap.io,
        dbPath: ':memory:',
        openSink: async () => sink,
      };
      const code = await auditVerify({}, deps);
      expect(code).toBe(0);
      expect(cap.out.join('')).toContain('chain intact');
    });

    test('violations: exit 1 + prints each violation', async () => {
      const cap = captureIo();
      const fakeSink: TenantAuditSink = {
        record: async () => {},
        query: async () => [],
        erase: async () => 0,
        prune: async () => 0,
        verify: async () => ({
          ok: false,
          totalEntries: 3,
          verifiedEntries: 1,
          violations: [
            {
              seq: 2,
              kind: 'hash-mismatch',
              expectedHash: 'aaa',
              observedHash: 'bbb',
              message: 'hash mismatch at seq=2',
            },
          ],
        }),
        close: async () => {},
      };
      const code = await auditVerify(
        {},
        { io: cap.io, dbPath: ':memory:', openSink: async () => fakeSink },
      );
      expect(code).toBe(1);
      const err = cap.err.join('');
      expect(err).toContain('chain verification failed');
      expect(err).toContain('hash-mismatch');
    });
  });

  describe('auditErase', () => {
    test('erases every channel record matching the platform user id', async () => {
      const cap = captureIo();
      const sink = await createSqliteAuditSink({ path: ':memory:' });
      const now = Date.now();
      await sink.record({
        kind: 'channel_event',
        ts: now,
        tenantId: 'acme-prod',
        channelId: 'slack-prod',
        conversationId: 'C1',
        eventKind: 'chat.message',
        user: { platformUserId: 'U123', displayName: 'Alice' },
      });
      await sink.record({
        kind: 'channel_event',
        ts: now,
        tenantId: 'acme-prod',
        channelId: 'slack-prod',
        conversationId: 'C2',
        eventKind: 'chat.message',
        user: { platformUserId: 'U999', displayName: 'Bob' },
      });

      const deps: AuditCliDeps = {
        io: cap.io,
        dbPath: ':memory:',
        openSink: async () => sink,
      };
      const code = await auditErase({ user: 'U123', json: true }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out.join(''));
      expect(parsed.erased).toBe(1);
      expect(parsed.platformUserId).toBe('U123');
    });

    test('error path: sink open throws → returns 1', async () => {
      const cap = captureIo();
      const code = await auditErase(
        { user: 'U123' },
        {
          io: cap.io,
          dbPath: ':memory:',
          openSink: async () => {
            throw new Error('sqlite busy');
          },
        },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('failed to open audit database');
    });
  });

  describe('auditPrune', () => {
    test('prunes records older than the retention window', async () => {
      const cap = captureIo();
      const sink = await createSqliteAuditSink({ path: ':memory:' });
      const longAgo = Date.now() - 1000 * 60 * 60 * 24 * 400; // 400 days ago
      await sink.record({
        kind: 'tool_call',
        ts: longAgo,
        tenantId: 'acme-prod',
        sessionId: 's',
        tool: 't',
        permissionKey: 'p',
        outcome: 'allow',
      } as TenantAuditRecord);
      await sink.record({
        kind: 'tool_call',
        ts: Date.now(),
        tenantId: 'acme-prod',
        sessionId: 's',
        tool: 't',
        permissionKey: 'p',
        outcome: 'allow',
      } as TenantAuditRecord);

      const deps: AuditCliDeps = {
        io: cap.io,
        dbPath: ':memory:',
        openSink: async () => sink,
      };
      const code = await auditPrune({ tenant: 'acme-prod', retentionDays: 30, json: true }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out.join(''));
      expect(parsed.pruned).toBe(1);
      expect(parsed.tenantId).toBe('acme-prod');
    });
  });
});
