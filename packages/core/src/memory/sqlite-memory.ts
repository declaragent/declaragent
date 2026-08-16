/**
 * SQLite-backed long-term memory store (durable-with-memory "mode 3").
 *
 * Mirrors the persistence pattern in `packages/core/src/session/sqlite.ts`:
 * a Bun {@link Database} opened with WAL + NORMAL + `foreign_keys`,
 * prepared statements, `CREATE TABLE IF NOT EXISTS`, a `{ path }` config,
 * and a `close()`.
 *
 * The store is namespaced: every row is keyed `(namespace, key)`. A
 * namespace is the per-agent isolation boundary — two agents writing the
 * same `key` under different namespaces never collide. The CLI defaults a
 * namespace to the agent id (overridable via `agent.yaml#memory.namespace`).
 *
 * Memories survive across sessions AND process restarts because they live
 * in an on-disk file. `:memory:` is supported for in-RAM tests where
 * reopen is not exercised.
 *
 * This is mode 3 of the durability ladder; semantic / embedding recall and
 * automatic transcript summarization/pruning are explicit FUTURE work (see
 * `docs/AGENT_MEMORY.md`).
 *
 * @since 0.5.6
 */

import { Database } from 'bun:sqlite';

/** A single persisted memory record. */
export interface MemoryRecord {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
  /** Free-form labels for filtering via {@link MemoryStore.search}. */
  readonly tags: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Filter for {@link MemoryStore.search}. Provided fields AND-combine. An
 * empty query (no fields) returns the whole namespace — equivalent to
 * {@link MemoryStore.list}.
 */
export interface MemorySearchQuery {
  /** Match keys that start with this string. */
  prefix?: string;
  /** Match records whose key OR value contains this substring. */
  substring?: string;
  /** Match records carrying ALL of these tags. */
  tags?: readonly string[];
}

/** Optional metadata accepted by {@link MemoryStore.write}. */
export interface MemoryWriteOptions {
  tags?: readonly string[];
}

export interface MemoryStore {
  /**
   * Upsert by `(namespace, key)`. A first write stamps `createdAt`; a
   * later write to the same key preserves `createdAt`, replaces `value` +
   * `tags`, and bumps `updatedAt`.
   */
  write(namespace: string, key: string, value: string, opts?: MemoryWriteOptions): void;
  /** Read a single record, or `undefined` when the key is absent. */
  read(namespace: string, key: string): MemoryRecord | undefined;
  /**
   * Filtered listing within a namespace (AND-combined). An empty query
   * returns the whole namespace, ordered by `updatedAt DESC`.
   */
  search(namespace: string, query: MemorySearchQuery): MemoryRecord[];
  /** Remove a record. Returns whether a row was deleted. */
  delete(namespace: string, key: string): boolean;
  /** All records in a namespace, ordered by `updatedAt DESC`. */
  list(namespace: string): MemoryRecord[];
  close(): void;
}

export interface SqliteMemoryStoreConfig {
  /** Filesystem path or `:memory:`. */
  path: string;
}

interface MemoryRow {
  namespace: string;
  key: string;
  value: string;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  );

  CREATE INDEX IF NOT EXISTS idx_memories_ns_updated
    ON memories(namespace, updated_at);
`;

/**
 * Parse the persisted `tags_json` column back into a string array. A
 * malformed / non-array payload is treated as "no tags" rather than
 * throwing, so a single hand-tampered row can't wedge a read.
 */
function parseTags(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    // fall through to empty
  }
  return [];
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    namespace: row.namespace,
    key: row.key,
    value: row.value,
    tags: parseTags(row.tags_json),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function createSqliteMemoryStore(config: SqliteMemoryStoreConfig): MemoryStore {
  const db = new Database(config.path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  // Upsert: preserve created_at on conflict (excluded carries the NEW
  // row's would-be created_at, so we DON'T overwrite the existing one),
  // replace value + tags, bump updated_at.
  const upsert = db.prepare(
    `INSERT INTO memories (namespace, key, value, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(namespace, key) DO UPDATE SET
       value = excluded.value,
       tags_json = excluded.tags_json,
       updated_at = excluded.updated_at`,
  );
  const selectOne = db.prepare<MemoryRow, [string, string]>(
    'SELECT namespace, key, value, tags_json, created_at, updated_at FROM memories WHERE namespace = ? AND key = ?',
  );
  const selectAll = db.prepare<MemoryRow, [string]>(
    'SELECT namespace, key, value, tags_json, created_at, updated_at FROM memories WHERE namespace = ? ORDER BY updated_at DESC, key ASC',
  );
  const deleteOne = db.prepare('DELETE FROM memories WHERE namespace = ? AND key = ?');

  function listAll(namespace: string): MemoryRecord[] {
    return selectAll.all(namespace).map(rowToRecord);
  }

  return {
    write(namespace: string, key: string, value: string, opts?: MemoryWriteOptions): void {
      const now = Date.now();
      // Normalise to a plain string[] before persisting so the column is
      // always a well-formed JSON array, never `undefined`.
      const tags = opts?.tags !== undefined ? [...opts.tags] : [];
      upsert.run(namespace, key, value, JSON.stringify(tags), now, now);
    },

    read(namespace: string, key: string): MemoryRecord | undefined {
      const row = selectOne.get(namespace, key);
      return row ? rowToRecord(row) : undefined;
    },

    search(namespace: string, query: MemorySearchQuery): MemoryRecord[] {
      // Filter in-process after a namespace-scoped fetch. The dataset per
      // namespace is small (operator-curated facts), so this keeps the
      // SQL simple and the tag/substring semantics unambiguous. Empty
      // query short-circuits to the full namespace.
      const rows = listAll(namespace);
      const { prefix, substring, tags } = query;
      const hasFilter =
        prefix !== undefined || substring !== undefined || (tags !== undefined && tags.length > 0);
      if (!hasFilter) return rows;

      return rows.filter((rec) => {
        if (prefix !== undefined && !rec.key.startsWith(prefix)) return false;
        if (
          substring !== undefined &&
          !rec.key.includes(substring) &&
          !rec.value.includes(substring)
        ) {
          return false;
        }
        if (tags !== undefined && tags.length > 0) {
          for (const t of tags) {
            if (!rec.tags.includes(t)) return false;
          }
        }
        return true;
      });
    },

    delete(namespace: string, key: string): boolean {
      const result = deleteOne.run(namespace, key);
      return result.changes > 0;
    },

    list(namespace: string): MemoryRecord[] {
      return listAll(namespace);
    },

    close(): void {
      db.close();
    },
  };
}
