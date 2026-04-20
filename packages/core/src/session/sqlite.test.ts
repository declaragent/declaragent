import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../engine/engine.js';
import { createPermissionGate } from '../permission/gate.js';
import { isTenantBoundaryError } from '../tenancy/boundary-error.js';
import { DEFAULT_TENANT_ID } from '../tenancy/types.js';
import { FakeProvider } from '../testing/fake-provider.js';
import type { LLMResponse } from '../types/llm.js';
import type { AgentSpec } from '../types/session.js';
import { type SqliteSessionStore, createSqliteSessionStore } from './sqlite.js';

const SPEC: AgentSpec = {
  name: 'test',
  model: 'claude-opus-4-6',
  systemPrompt: 'sys',
};

function textResponse(text: string, usage = { inputTokens: 10, outputTokens: 5 }): LLMResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage,
    model: 'claude-opus-4-6',
  };
}

describe('SqliteSessionStore', () => {
  let dir: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-sqlite-'));
    store = createSqliteSessionStore({ path: join(dir, 'sessions.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('create + appendMessage + transcript reflects appends', async () => {
    const session = store.create(SPEC, 'sess-1');
    expect(session.id).toBe('sess-1');
    expect(session.transcript.length).toBe(0);

    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
    await session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      meta: {
        model: 'claude-opus-4-6',
        stopReason: 'end_turn',
        usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      },
    });

    expect(session.transcript.length).toBe(2);
    const ledger = session.ledger();
    expect(ledger.inputTokens).toBe(1_000_000);
    expect(ledger.outputTokens).toBe(100_000);
    // 1M @ $15 + 100K @ $75 = $15 + $7.5 = $22.5
    expect(ledger.estimatedCostUSD).toBeCloseTo(22.5);
  });

  test('open(id) replays the transcript', async () => {
    const a = store.create(SPEC, 'sess-2');
    await a.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'first' }],
    });
    await a.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      meta: {
        model: 'claude-opus-4-6',
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    });

    const b = store.open('sess-2');
    expect(b).not.toBeNull();
    expect(b?.transcript.length).toBe(2);
    expect(b?.transcript[0]?.content[0]).toEqual({ type: 'text', text: 'first' });
    expect(b?.ledger().inputTokens).toBe(5);
    expect(b?.ledger().outputTokens).toBe(3);
  });

  test('open() returns null for missing session', () => {
    expect(store.open('nope')).toBeNull();
  });

  test('list returns sessions ordered by updated_at desc', async () => {
    const s1 = store.create(SPEC, 's1');
    await s1.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'one' }],
    });
    // Force ordering: s2 is newer.
    await new Promise((r) => setTimeout(r, 5));
    const s2 = store.create(SPEC, 's2');
    await s2.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'two' }],
    });

    const list = store.list();
    expect(list.length).toBe(2);
    expect(list[0]?.id).toBe('s2');
    expect(list[1]?.id).toBe('s1');
    expect(list[0]?.messageCount).toBe(1);
  });

  test('delete cascades messages', async () => {
    const s = store.create(SPEC, 'doomed');
    await s.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'x' }],
    });
    expect(store.delete('doomed')).toBe(true);
    expect(store.open('doomed')).toBeNull();
    expect(store.delete('doomed')).toBe(false);
  });

  test('markTurn ok increments ledger.turns once per turnId', async () => {
    const s = store.create(SPEC, 's-turns');
    await s.markTurn('t1', 'ok');
    await s.markTurn('t2', 'ok');
    await s.markTurn('t1', 'ok'); // duplicate same id
    await s.markTurn('t3', 'error');
    expect(s.ledger().turns).toBe(2);
  });

  test('engine round-trip persists across reopen → /resume scenario', async () => {
    const provider = new FakeProvider([textResponse('first'), textResponse('second')]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });

    const original = store.create(SPEC, 'resume-me');
    await engine.runAgent({ session: original, userMessage: 'hi' });
    expect(original.transcript.length).toBe(2);

    const resumed = store.open('resume-me');
    expect(resumed).not.toBeNull();
    expect(resumed?.transcript.length).toBe(2);

    // Continuation: feed another user message; transcript should grow to 4.
    if (resumed) {
      await engine.runAgent({ session: resumed, userMessage: 'continue' });
      expect(resumed.transcript.length).toBe(4);
    }
  });

  test('appendMessage is durable across store close/reopen', async () => {
    const dbPath = join(dir, 'sessions.db');
    const s = store.create(SPEC, 'persist');
    await s.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'one' }],
    });
    store.close();

    const reopened = createSqliteSessionStore({ path: dbPath });
    try {
      const session = reopened.open('persist');
      expect(session?.transcript.length).toBe(1);
    } finally {
      reopened.close();
    }
  });

  test('updateSpec mutates current spec and persists across reopen', async () => {
    const s = store.create(SPEC, 'mutating');
    expect(s.spec.model).toBe('claude-opus-4-6');
    await s.updateSpec({ model: 'claude-sonnet-4-6' });
    expect(s.spec.model).toBe('claude-sonnet-4-6');

    const reopened = store.open('mutating');
    expect(reopened?.spec.model).toBe('claude-sonnet-4-6');
  });

  test('atomic append: SQLite stores well-formed JSON for content and meta', async () => {
    const s = store.create(SPEC, 'roundtrip');
    await s.appendMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 't1', name: 'X', input: { a: 1 } },
      ],
      meta: {
        model: 'claude-opus-4-6',
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    });
    const reopened = store.open('roundtrip');
    const msg = reopened?.transcript[0];
    expect(msg?.content.length).toBe(2);
    expect(msg?.meta?.stopReason).toBe('tool_use');
  });
});

describe('SqliteSessionStore — tenant scoping', () => {
  let dir: string;
  let store: SqliteSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-sqlite-tenant-'));
    store = createSqliteSessionStore({ path: join(dir, 'sessions.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('default-tenant fallback: create+open+list without a scope', () => {
    const created = store.create(SPEC, 'd-1');
    expect(created.id).toBe('d-1');

    const opened = store.open('d-1');
    expect(opened).not.toBeNull();

    const listed = store.list();
    expect(listed.length).toBe(1);
    expect(listed[0]?.tenantId).toBe(DEFAULT_TENANT_ID);
  });

  test('sessions in different tenants are isolated from list() and open()', () => {
    store.create(SPEC, 'shared-id', { tenantId: 'acme' });
    // A session with a different id for a different tenant.
    store.create(SPEC, 'beta-only', { tenantId: 'beta' });

    expect(store.list({ tenantId: 'acme' }).map((r) => r.id)).toEqual(['shared-id']);
    expect(store.list({ tenantId: 'beta' }).map((r) => r.id)).toEqual(['beta-only']);
    // Default-tenant scope sees neither.
    expect(store.list()).toEqual([]);

    expect(store.open('shared-id', { tenantId: 'acme' })?.id).toBe('shared-id');
    expect(store.open('beta-only', { tenantId: 'beta' })?.id).toBe('beta-only');
  });

  test('cross-tenant open throws TenantBoundaryError', () => {
    store.create(SPEC, 'acme-sess', { tenantId: 'acme' });

    try {
      store.open('acme-sess', { tenantId: 'beta' });
      throw new Error('expected TenantBoundaryError');
    } catch (err) {
      expect(isTenantBoundaryError(err)).toBe(true);
      if (isTenantBoundaryError(err)) {
        expect(err.code).toBe('TENANT_BOUNDARY');
        expect(err.sourceTenantId).toBe('beta');
        expect(err.targetTenantId).toBe('acme');
        expect(err.resource).toBe('session');
        expect(err.resourceId).toBe('acme-sess');
      }
    }
  });

  test('cross-tenant delete throws TenantBoundaryError and leaves the row intact', () => {
    store.create(SPEC, 'keep-me', { tenantId: 'acme' });

    expect(() => store.delete('keep-me', { tenantId: 'beta' })).toThrow(/tenant boundary/);

    // Still there under its real tenant.
    expect(store.open('keep-me', { tenantId: 'acme' })?.id).toBe('keep-me');
  });

  test('delete returns false for a missing row regardless of tenant', () => {
    expect(store.delete('never-existed', { tenantId: 'acme' })).toBe(false);
  });
});

describe('SqliteSessionStore — pre-v1.0 migration', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-sqlite-migrate-'));
    dbPath = join(dir, 'sessions.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedPreV1(spec: AgentSpec, rows: Array<{ id: string }>): void {
    // Recreate the exact pre-v1.0 schema (no `tenant_id` column) and
    // insert rows through it, then hand the file to the new store.
    const legacy = new Database(dbPath, { create: true });
    legacy.exec('PRAGMA journal_mode = WAL;');
    legacy.exec('PRAGMA foreign_keys = ON;');
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        spec_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        meta_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE turns (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL,
        ended_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );
    `);
    const insert = legacy.prepare(
      'INSERT INTO sessions (id, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    const now = Date.now();
    for (const row of rows) insert.run(row.id, JSON.stringify(spec), now, now);
    legacy.close();
  }

  test('adds tenant_id column and stamps legacy rows with __default__', () => {
    seedPreV1(SPEC, [{ id: 'legacy-1' }, { id: 'legacy-2' }]);

    const store = createSqliteSessionStore({ path: dbPath });
    try {
      // Schema check: the column is there and non-null with the default.
      const db = new Database(dbPath, { readonly: true });
      try {
        const cols = db
          .query<{ name: string; notnull: number; dflt_value: string | null }, []>(
            'PRAGMA table_info(sessions)',
          )
          .all();
        const tenantCol = cols.find((c) => c.name === 'tenant_id');
        expect(tenantCol).toBeDefined();
        expect(tenantCol?.notnull).toBe(1);
        const rows = db
          .query<{ id: string; tenant_id: string }, []>(
            'SELECT id, tenant_id FROM sessions ORDER BY id',
          )
          .all();
        expect(rows).toEqual([
          { id: 'legacy-1', tenant_id: DEFAULT_TENANT_ID },
          { id: 'legacy-2', tenant_id: DEFAULT_TENANT_ID },
        ]);
      } finally {
        db.close();
      }

      // Functional check: default-tenant callers see both legacy rows.
      const listed = store.list().map((r) => r.id);
      expect(listed.sort()).toEqual(['legacy-1', 'legacy-2']);
      expect(store.open('legacy-1')).not.toBeNull();
      // A tenant that didn't own these rows sees nothing.
      expect(store.list({ tenantId: 'acme' })).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('migration is idempotent across multiple opens', () => {
    seedPreV1(SPEC, [{ id: 'legacy-idem' }]);

    const first = createSqliteSessionStore({ path: dbPath });
    first.close();
    const second = createSqliteSessionStore({ path: dbPath });
    try {
      expect(second.list().map((r) => r.id)).toEqual(['legacy-idem']);
    } finally {
      second.close();
    }
  });
});
