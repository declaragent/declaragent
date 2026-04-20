/**
 * Pure transform functions used by `declaragent migrate`. Each takes a
 * parsed-in-memory representation of a config (or a database handle)
 * and returns a decision object describing what — if anything — would
 * change. Every transform is idempotent: running twice is a no-op.
 *
 * These functions never touch the filesystem themselves; the caller
 * (`migrate-cli.ts`) is responsible for reading + writing so tests can
 * swap the IO cleanly.
 */

import type { Database } from 'bun:sqlite';

// ── agent.yaml ────────────────────────────────────────────────────────────

/**
 * Current `agent.yaml` schema version. Frozen at v1.0 — any future
 * breaking shape change bumps this integer and adds a migration rule.
 */
export const AGENT_YAML_CURRENT_SCHEMA_VERSION = 1;

export interface AgentYamlMigrationResult {
  /** The transformed object. Reference-equal to the input when no changes. */
  next: Record<string, unknown>;
  changed: boolean;
  /** Human-readable one-liners describing each step. */
  notes: readonly string[];
}

/**
 * Walk an `agent.yaml` forward to the current schema. Accepts:
 *   - A config with no `schemaVersion` → stamps `schemaVersion: 1`.
 *   - `schemaVersion: 0` (pre-v1.0 internal) → bumps to 1.
 *   - `schemaVersion: "0.9"` string form → bumps to 1.
 *   - `schemaVersion: 1` → no-op.
 *
 * Unrecognised future versions (>= 2) are left untouched and reported
 * so the caller can surface a helpful error without corrupting the
 * file.
 */
export function migrateAgentYaml(input: unknown): AgentYamlMigrationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      next: {},
      changed: false,
      notes: ['agent.yaml is empty or not an object; nothing to migrate'],
    };
  }

  const src = input as Record<string, unknown>;
  const current = src.schemaVersion;
  const notes: string[] = [];

  if (current === AGENT_YAML_CURRENT_SCHEMA_VERSION) {
    return { next: src, changed: false, notes: ['agent.yaml already at schemaVersion 1'] };
  }

  if (
    typeof current === 'number' &&
    current > AGENT_YAML_CURRENT_SCHEMA_VERSION &&
    Number.isFinite(current)
  ) {
    return {
      next: src,
      changed: false,
      notes: [
        `agent.yaml reports schemaVersion ${current} (newer than this CLI supports); leaving untouched`,
      ],
    };
  }

  // Any of: undefined (pre-stamping), 0 (pre-v1.0 internal), "0.9"
  // string, or a legacy pre-1.0 marker — all bump forward.
  const next = { ...src, schemaVersion: AGENT_YAML_CURRENT_SCHEMA_VERSION };
  if (current === undefined) {
    notes.push('stamp schemaVersion: 1 (field was absent)');
  } else {
    notes.push(`bump schemaVersion ${JSON.stringify(current)} -> 1`);
  }
  return { next, changed: true, notes };
}

// ── tenants.yaml ──────────────────────────────────────────────────────────

export interface TenantsYamlMigrationInput {
  /** Absolute path `tenants.yaml` would live at. */
  tenantsPath: string;
  /** Whether `tenants.yaml` currently exists on disk. */
  tenantsExists: boolean;
  /** Whether the agent spec (or sibling configs) appear to use multi-tenant features. */
  multiTenantInUse: boolean;
}

export interface TenantsYamlMigrationResult {
  /**
   * - `no-op`: file exists, nothing to do.
   * - `advise`: multi-tenant hints found but no file; tell the user to run
   *             `declaragent tenants diff` + hand-author a `tenants.yaml`.
   *   Migration never writes a `tenants.yaml` automatically — we refuse
   *   to guess a tenant topology.
   * - `skip`: single-tenant deployment, nothing to do.
   */
  action: 'no-op' | 'advise' | 'skip';
  notes: readonly string[];
}

export function migrateTenantsYaml(input: TenantsYamlMigrationInput): TenantsYamlMigrationResult {
  if (input.tenantsExists) {
    return { action: 'no-op', notes: [`tenants.yaml already present at ${input.tenantsPath}`] };
  }
  if (input.multiTenantInUse) {
    return {
      action: 'advise',
      notes: [
        'multi-tenant features detected but no tenants.yaml on disk',
        'run `declaragent tenants diff` and hand-author `tenants.yaml` before enabling the daemon',
      ],
    };
  }
  return {
    action: 'skip',
    notes: ['single-tenant deployment; no tenants.yaml required'],
  };
}

// ── sessions.db schema ────────────────────────────────────────────────────

export interface SessionSchemaMigrationResult {
  /** Whether the `sessions` table already carries a `tenant_id` column. */
  alreadyMigrated: boolean;
  /** Whether the table is missing entirely (fresh DB). */
  tableMissing: boolean;
  /** Number of rows that would be (or were) stamped with the default tenant. */
  rowCount: number;
  notes: readonly string[];
}

/**
 * Inspect an open `sessions.db` handle. The Phase-7-slice-0.1 loader
 * does the actual migration on first open via
 * `createSqliteSessionStore`; this transform is a read-only pre-flight
 * that tells the user what that loader will do (or has already done).
 *
 * Returns an empty-ish result when the table does not yet exist so
 * callers can differentiate "no work" from "migration pending".
 */
export function migrateSessionSchema(db: Database): SessionSchemaMigrationResult {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    )
    .all();
  if (tables.length === 0) {
    return {
      alreadyMigrated: false,
      tableMissing: true,
      rowCount: 0,
      notes: [
        'sessions table does not yet exist; will be created at tenant-aware schema on first daemon start',
      ],
    };
  }

  const cols = db.query<{ name: string }, []>('PRAGMA table_info(sessions)').all();
  const hasTenant = cols.some((c) => c.name === 'tenant_id');
  const { count } = db
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM sessions')
    .get() ?? { count: 0 };

  if (hasTenant) {
    return {
      alreadyMigrated: true,
      tableMissing: false,
      rowCount: count,
      notes: [
        `sessions table already has tenant_id column (${count} row${count === 1 ? '' : 's'})`,
      ],
    };
  }

  return {
    alreadyMigrated: false,
    tableMissing: false,
    rowCount: count,
    notes: [
      `sessions table is pre-v1.0 (${count} row${count === 1 ? '' : 's'}); tenant_id column will be added and backfilled with the default tenant on next daemon/CLI open`,
    ],
  };
}
