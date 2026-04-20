import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TenantAuditRecord, TenantAuditSink } from '@declaragent/core';
import { createSqliteAuditSink } from '@declaragent/core';
import { createAuditVerifyTool, runAuditVerify } from './audit-verify.js';

let sink: TenantAuditSink;

const sampleRecord: TenantAuditRecord = {
  kind: 'tool_call',
  ts: 1_700_000_000_000,
  tenantId: 'acme',
  sessionId: 'sess-1',
  tool: 'Bash',
  permissionKey: 'bash:exec',
  outcome: 'allow',
  matchedRule: 'bash:*',
  durationMs: 10,
  correlationId: 'evt-1',
};

beforeEach(async () => {
  sink = await createSqliteAuditSink({ path: ':memory:' });
});

afterEach(async () => {
  await sink.close();
});

describe('runAuditVerify', () => {
  test('reports ok=true + 0 entries for an empty chain', async () => {
    const out = await runAuditVerify({}, { sink });
    expect(out.ok).toBe(true);
    expect(out.totalEntries).toBe(0);
    expect(out.verifiedEntries).toBe(0);
    expect(out.violations).toEqual([]);
  });

  test('counts records after append', async () => {
    await sink.record(sampleRecord);
    await sink.record({ ...sampleRecord, correlationId: 'evt-2' });
    const out = await runAuditVerify({}, { sink });
    expect(out.ok).toBe(true);
    expect(out.totalEntries).toBe(2);
    expect(out.verifiedEntries).toBe(2);
  });

  test('tenant filter narrows the scope', async () => {
    await sink.record(sampleRecord);
    await sink.record({ ...sampleRecord, tenantId: 'globex', correlationId: 'evt-b' });
    const out = await runAuditVerify({ tenant: 'acme' }, { sink });
    expect(out.totalEntries).toBe(1);
  });
});

describe('createAuditVerifyTool', () => {
  test('readonly + parallelSafe', () => {
    const tool = createAuditVerifyTool();
    expect(tool.readonly).toBe(true);
    expect(tool.parallelSafe).toBe(true);
  });

  test('permissionKey namespaces by tenant', () => {
    const tool = createAuditVerifyTool();
    expect(tool.permissionKey({})).toBe('audit-verify');
    expect(tool.permissionKey({ tenant: 'acme' })).toBe('audit-verify:acme');
  });
});
