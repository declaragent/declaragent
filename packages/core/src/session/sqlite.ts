import { Database } from 'bun:sqlite';
import { TenantBoundaryError } from '../tenancy/boundary-error.js';
import { DEFAULT_TENANT_ID } from '../tenancy/types.js';
import type { Message, MessageMeta } from '../types/messages.js';
import type { AgentSpec, SessionHandle, SessionLedger, TurnStatus } from '../types/session.js';
import { estimateCostUSD } from './pricing.js';

export interface SqliteSessionStoreConfig {
  /** Filesystem path or `:memory:`. */
  path: string;
}

/**
 * Optional tenant scope for session lookups. Omitting `tenantId` falls
 * back to {@link DEFAULT_TENANT_ID}, preserving Phase-1-through-5
 * single-tenant semantics.
 */
export interface TenantScope {
  tenantId?: string;
}

export interface SessionMetadata {
  id: string;
  tenantId: string;
  specName: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

export interface SqliteSessionStore {
  create(spec: AgentSpec, id?: string, scope?: TenantScope): SessionHandle;
  /**
   * Open a session by id within a tenant scope. Returns `null` when the
   * session doesn't exist; throws {@link TenantBoundaryError} when the
   * session exists but belongs to a different tenant.
   */
  open(id: string, scope?: TenantScope): SessionHandle | null;
  list(scope?: TenantScope): SessionMetadata[];
  /**
   * Delete a session scoped to a tenant. Returns `false` when the
   * session doesn't exist. Throws {@link TenantBoundaryError} when the
   * session exists but belongs to a different tenant.
   */
  delete(id: string, scope?: TenantScope): boolean;
  close(): void;
}

interface MessageRow {
  seq: number;
  role: string;
  content_json: string;
  meta_json: string | null;
}

interface SessionRow {
  id: string;
  tenant_id: string;
  spec_json: string;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}',
    spec_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id, id);

  CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    meta_json TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_seq
    ON messages(session_id, seq);

  CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    status TEXT NOT NULL,
    ended_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, turn_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`;

function rowToMessage(row: MessageRow): Message {
  const message: Message = {
    role: row.role as Message['role'],
    content: JSON.parse(row.content_json) as Message['content'],
  };
  if (row.meta_json) {
    message.meta = JSON.parse(row.meta_json) as MessageMeta;
  }
  return message;
}

function deriveLedger(messages: Message[]): SessionLedger {
  const ledger: SessionLedger = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    estimatedCostUSD: 0,
  };
  for (const m of messages) {
    const usage = m.meta?.usage;
    if (!usage) continue;
    ledger.inputTokens += usage.inputTokens;
    ledger.outputTokens += usage.outputTokens;
    if (usage.cacheReadTokens) ledger.cacheReadTokens += usage.cacheReadTokens;
    ledger.estimatedCostUSD += estimateCostUSD(m.meta?.model, usage);
  }
  return ledger;
}

/**
 * Upgrade a pre-v1.0 `sessions` table to the (tenant_id, id) shape.
 *
 * Older databases (Phase 1–6) created the table without a `tenant_id`
 * column. Adding the column with `NOT NULL DEFAULT '__default__'` stamps
 * every legacy row onto the implicit default tenant — preserving single-
 * tenant behaviour bit-for-bit — while the new column is available for
 * tenant-aware callers.
 */
function migrateTenantColumn(db: Database): void {
  const cols = db.query<{ name: string }, []>('PRAGMA table_info(sessions)').all();
  if (cols.length === 0) return; // fresh DB — SCHEMA will create it.
  if (cols.some((c) => c.name === 'tenant_id')) return;
  db.exec(
    `ALTER TABLE sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}';`,
  );
}

export function createSqliteSessionStore(config: SqliteSessionStoreConfig): SqliteSessionStore {
  const db = new Database(config.path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Order matters: migrate first so the SCHEMA's CREATE-IF-NOT-EXISTS is
  // a no-op for pre-v1.0 tables that already exist, then ensure the full
  // schema (including the new index) is in place.
  migrateTenantColumn(db);
  db.exec(SCHEMA);

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, tenant_id, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectSession = db.prepare<SessionRow, [string]>(
    'SELECT id, tenant_id, spec_json, created_at, updated_at FROM sessions WHERE id = ?',
  );
  const updateSessionTimestamp = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
  const updateSessionSpec = db.prepare(
    'UPDATE sessions SET spec_json = ?, updated_at = ? WHERE id = ?',
  );
  const insertMessage = db.prepare(
    'INSERT INTO messages (session_id, seq, role, content_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectMessages = db.prepare<MessageRow, [string]>(
    'SELECT seq, role, content_json, meta_json FROM messages WHERE session_id = ? ORDER BY seq ASC',
  );
  const upsertTurn = db.prepare(
    'INSERT INTO turns (session_id, turn_id, status, ended_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, turn_id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at',
  );
  const listSessionsByTenant = db.prepare<
    {
      id: string;
      tenant_id: string;
      spec_json: string;
      created_at: number;
      updated_at: number;
      message_count: number;
    },
    [string]
  >(
    `SELECT s.id AS id, s.tenant_id AS tenant_id, s.spec_json AS spec_json,
            s.created_at AS created_at, s.updated_at AS updated_at,
            COALESCE((SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id), 0) AS message_count
       FROM sessions s
       WHERE s.tenant_id = ?
       ORDER BY s.updated_at DESC`,
  );
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');

  function buildHandle(id: string, spec: AgentSpec, initial: Message[]): SessionHandle {
    const messages: Message[] = [...initial];
    let currentSpec: AgentSpec = spec;
    const ledger = deriveLedger(messages);
    const okTurnIds = new Set<string>();

    return {
      id,
      get spec(): AgentSpec {
        return currentSpec;
      },
      get transcript(): ReadonlyArray<Message> {
        return messages;
      },
      async updateSpec(patch: Partial<AgentSpec>): Promise<void> {
        currentSpec = { ...currentSpec, ...patch };
        updateSessionSpec.run(JSON.stringify(currentSpec), Date.now(), id);
      },
      async appendMessage(m: Message): Promise<void> {
        const seq = messages.length;
        const now = Date.now();
        const tx = db.transaction(() => {
          insertMessage.run(
            id,
            seq,
            m.role,
            JSON.stringify(m.content),
            m.meta ? JSON.stringify(m.meta) : null,
            now,
          );
          updateSessionTimestamp.run(now, id);
        });
        tx();
        messages.push(m);
        const usage = m.meta?.usage;
        if (usage) {
          ledger.inputTokens += usage.inputTokens;
          ledger.outputTokens += usage.outputTokens;
          if (usage.cacheReadTokens) {
            ledger.cacheReadTokens += usage.cacheReadTokens;
          }
          ledger.estimatedCostUSD += estimateCostUSD(m.meta?.model, usage);
        }
      },
      ledger(): SessionLedger {
        return { ...ledger };
      },
      async markTurn(turnId: string, status: TurnStatus): Promise<void> {
        upsertTurn.run(id, turnId, status, Date.now());
        if (status === 'ok' && !okTurnIds.has(turnId)) {
          okTurnIds.add(turnId);
          ledger.turns += 1;
        }
      },
    };
  }

  return {
    create(spec: AgentSpec, id?: string, scope?: TenantScope): SessionHandle {
      const tenantId = scope?.tenantId ?? DEFAULT_TENANT_ID;
      const sessionId = id ?? crypto.randomUUID();
      const now = Date.now();
      insertSession.run(sessionId, tenantId, JSON.stringify(spec), now, now);
      return buildHandle(sessionId, spec, []);
    },

    open(id: string, scope?: TenantScope): SessionHandle | null {
      const tenantId = scope?.tenantId ?? DEFAULT_TENANT_ID;
      const row = selectSession.get(id);
      if (!row) return null;
      if (row.tenant_id !== tenantId) {
        throw new TenantBoundaryError({
          sourceTenantId: tenantId,
          targetTenantId: row.tenant_id,
          resource: 'session',
          resourceId: id,
        });
      }
      const spec = JSON.parse(row.spec_json) as AgentSpec;
      const messages = selectMessages.all(id).map(rowToMessage);
      return buildHandle(id, spec, messages);
    },

    list(scope?: TenantScope): SessionMetadata[] {
      const tenantId = scope?.tenantId ?? DEFAULT_TENANT_ID;
      return listSessionsByTenant.all(tenantId).map((row) => {
        const spec = JSON.parse(row.spec_json) as AgentSpec;
        return {
          id: row.id,
          tenantId: row.tenant_id,
          specName: spec.name,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
          messageCount: row.message_count,
        };
      });
    },

    delete(id: string, scope?: TenantScope): boolean {
      const tenantId = scope?.tenantId ?? DEFAULT_TENANT_ID;
      const row = selectSession.get(id);
      if (!row) return false;
      if (row.tenant_id !== tenantId) {
        throw new TenantBoundaryError({
          sourceTenantId: tenantId,
          targetTenantId: row.tenant_id,
          resource: 'session',
          resourceId: id,
        });
      }
      const result = deleteSession.run(id);
      return result.changes > 0;
    },

    close(): void {
      db.close();
    },
  };
}
