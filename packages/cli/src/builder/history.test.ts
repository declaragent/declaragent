import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TenantAuditRecord, TenantAuditSink } from '@declaragent/core';
import { createSqliteAuditSink } from '@declaragent/core';
import { renderHistory, runHistory } from './history.js';

let sink: TenantAuditSink;

function builderRecord(tool: string, ts: number): TenantAuditRecord {
  return {
    kind: 'tool_call',
    ts,
    tenantId: 'default',
    sessionId: 'repl',
    tool,
    permissionKey: `apply:${tool}`,
    outcome: 'allow',
    durationMs: 12,
    correlationId: 'corr-1',
  };
}

function nonBuilderRecord(ts: number): TenantAuditRecord {
  return {
    kind: 'tool_call',
    ts,
    tenantId: 'default',
    sessionId: 'repl',
    tool: 'Bash',
    permissionKey: 'bash:ls',
    outcome: 'allow',
  };
}

beforeEach(async () => {
  sink = await createSqliteAuditSink({ path: ':memory:' });
});
afterEach(async () => {
  await sink.close();
});

describe('runHistory', () => {
  test('empty sink yields count 0', async () => {
    const out = await runHistory({ sink });
    expect(out.count).toBe(0);
    expect(out.entries).toEqual([]);
  });

  test('surfaces records whose tool starts with "Declara"', async () => {
    await sink.record(builderRecord('DeclaraApplyChange', 1000));
    await sink.record(builderRecord('Declara:addSkill', 1001));
    await sink.record(nonBuilderRecord(1002));
    const out = await runHistory({ sink });
    expect(out.count).toBe(2);
    const tools = out.entries.map((e) => e.tool).sort();
    expect(tools).toEqual(['Declara:addSkill', 'DeclaraApplyChange']);
  });

  test('honours the limit', async () => {
    for (let i = 0; i < 10; i++) {
      await sink.record(builderRecord('DeclaraAddSkill', 1000 + i));
    }
    const out = await runHistory({ sink, limit: 3 });
    // limit caps the *query* size; filter then narrows. We expect
    // at most 3 results because every query row matches.
    expect(out.count).toBeLessThanOrEqual(3);
  });

  test('tenant filter scopes the query', async () => {
    await sink.record(builderRecord('DeclaraAddSkill', 1000));
    const acme: TenantAuditRecord = {
      kind: 'tool_call',
      ts: 1001,
      tenantId: 'acme',
      sessionId: 'repl',
      tool: 'DeclaraAddSkill',
      permissionKey: 'apply:DeclaraAddSkill',
      outcome: 'allow',
    };
    await sink.record(acme);
    const out = await runHistory({ sink, tenant: 'acme' });
    expect(out.count).toBe(1);
  });
});

describe('renderHistory', () => {
  test('returns a friendly placeholder when empty', () => {
    expect(renderHistory({ ok: true, count: 0, entries: [] })).toContain('no builder actions');
  });

  test('renders a header and one line per entry', () => {
    const text = renderHistory({
      ok: true,
      count: 2,
      entries: [
        {
          seq: 1,
          ts: 1000,
          tool: 'DeclaraApplyChange',
          permissionKey: 'apply:abc',
          outcome: 'allow',
          durationMs: 12,
        },
        {
          seq: 2,
          ts: 2000,
          tool: 'DeclaraAddSkill',
          permissionKey: 'apply-step:addSkill',
          outcome: 'deny',
          error: { message: 'oops' },
        },
      ],
    });
    expect(text).toContain('builder actions (2');
    expect(text).toContain('DeclaraApplyChange');
    expect(text).toContain('12ms');
    expect(text).toContain('oops');
  });
});
