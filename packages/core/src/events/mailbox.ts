import type { Database } from 'bun:sqlite';
import type { AgentEvent, EventBus } from './types.js';

export interface Mailbox {
  /**
   * Enqueue a message for `toAgent`. Constructs a `mailbox.message` event
   * and, if a bus was configured, publishes it for live observers. The
   * event is persisted so it survives daemon restarts.
   */
  send(toAgent: string, payload: unknown, fromAgent: string): Promise<string>;
  /**
   * Pull every pending message for `agentId`, mark them drained, and
   * return the `AgentEvent`s. Drained rows are tombstoned (not deleted)
   * until `vacuum()` sweeps them.
   *
   * Target on returned events is `{ type: 'broadcast' }`; callers inject
   * into a session or publish as they see fit.
   */
  drainFor(agentId: string): Promise<readonly AgentEvent[]>;
  /** Count of pending (un-drained) messages for `agentId`. */
  depth(agentId: string): Promise<number>;
  /**
   * Delete tombstoned rows whose `drained_at` is older than
   * `olderThanMs` ago. Returns the number of rows removed.
   */
  vacuum(olderThanMs?: number): Promise<number>;
}

export interface CreateMailboxOptions {
  db: Database;
  /** Optional. When present, `send()` publishes the event for live observers. */
  bus?: EventBus;
  /** Vacuum default. Rows tombstoned longer than this are purged. Default 7 days. */
  defaultTtlMs?: number;
}

export const DEFAULT_MAILBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAILBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mailbox (
    id TEXT PRIMARY KEY,
    to_agent TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    payload_json TEXT,
    queued_at INTEGER NOT NULL,
    drained_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_mailbox_pending
    ON mailbox(to_agent) WHERE drained_at IS NULL;

  CREATE INDEX IF NOT EXISTS idx_mailbox_drained_at
    ON mailbox(drained_at) WHERE drained_at IS NOT NULL;
`;

interface MailboxRow {
  id: string;
  to_agent: string;
  from_agent: string;
  payload_json: string | null;
  queued_at: number;
}

export function createMailbox(options: CreateMailboxOptions): Mailbox {
  const { db, bus } = options;
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_MAILBOX_TTL_MS;

  db.exec(MAILBOX_SCHEMA);

  const insert = db.prepare(
    'INSERT INTO mailbox (id, to_agent, from_agent, payload_json, queued_at) VALUES (?, ?, ?, ?, ?)',
  );
  const selectPending = db.prepare<MailboxRow, [string]>(
    'SELECT id, to_agent, from_agent, payload_json, queued_at FROM mailbox WHERE to_agent = ? AND drained_at IS NULL ORDER BY queued_at ASC',
  );
  const markDrained = db.prepare(
    'UPDATE mailbox SET drained_at = ? WHERE to_agent = ? AND drained_at IS NULL',
  );
  const countPending = db.prepare<{ n: number }, [string]>(
    'SELECT COUNT(*) AS n FROM mailbox WHERE to_agent = ? AND drained_at IS NULL',
  );
  const vacuumStmt = db.prepare(
    'DELETE FROM mailbox WHERE drained_at IS NOT NULL AND drained_at < ?',
  );

  // Depth cache. Avoids a SQL roundtrip for the hot path (active agent
  // repeatedly asking "anything for me?") while staying in sync through
  // the send/drain call sites.
  const depthByAgent = new Map<string, number>();

  function incDepth(agentId: string): void {
    depthByAgent.set(agentId, (depthByAgent.get(agentId) ?? 0) + 1);
  }

  function resetDepth(agentId: string): void {
    depthByAgent.set(agentId, 0);
  }

  function resolveDepth(agentId: string): number {
    const cached = depthByAgent.get(agentId);
    if (cached !== undefined) return cached;
    const row = countPending.get(agentId);
    const n = row?.n ?? 0;
    depthByAgent.set(agentId, n);
    return n;
  }

  function rowToEvent(row: MailboxRow): AgentEvent {
    const payload = row.payload_json ? (JSON.parse(row.payload_json) as unknown) : null;
    return {
      id: row.id,
      kind: 'mailbox.message',
      source: { type: 'mailbox', fromAgent: row.from_agent },
      target: { type: 'broadcast' },
      timestamp: row.queued_at,
      payload,
      auth: { kind: 'internal' },
      meta: { idempotencyKey: row.id },
    };
  }

  return {
    async send(toAgent, payload, fromAgent): Promise<string> {
      if (!toAgent) throw new Error('mailbox.send: toAgent is required');
      if (!fromAgent) throw new Error('mailbox.send: fromAgent is required');
      const id = crypto.randomUUID();
      const queuedAt = Date.now();
      // Allow undefined and complex values; we serialize via JSON.
      const serializedPayload = payload === undefined ? null : JSON.stringify(payload ?? null);
      insert.run(id, toAgent, fromAgent, serializedPayload, queuedAt);
      incDepth(toAgent);

      if (bus) {
        const event: AgentEvent = {
          id,
          kind: 'mailbox.message',
          source: { type: 'mailbox', fromAgent },
          target: { type: 'broadcast' },
          timestamp: queuedAt,
          payload: payload ?? null,
          auth: { kind: 'internal' },
          meta: { idempotencyKey: id },
        };
        await bus.publish(event);
      }
      return id;
    },

    async drainFor(agentId): Promise<readonly AgentEvent[]> {
      const rows = selectPending.all(agentId);
      if (rows.length === 0) return [];
      // Tombstone + clear depth in a single transaction so a crash mid-drain
      // can't leave callers thinking messages were delivered when they were
      // in fact still pending.
      const now = Date.now();
      const tx = db.transaction(() => {
        markDrained.run(now, agentId);
      });
      tx();
      resetDepth(agentId);
      return rows.map(rowToEvent);
    },

    async depth(agentId): Promise<number> {
      return resolveDepth(agentId);
    },

    async vacuum(olderThanMs?: number): Promise<number> {
      const cutoff = Date.now() - (olderThanMs ?? defaultTtlMs);
      const result = vacuumStmt.run(cutoff);
      return result.changes;
    },
  };
}
