/**
 * Phase 6 slice-5 unified audit contract.
 *
 * Consolidates every audit record kind emitted across the runtime into
 * a single tagged union + sink interface. Downstream consumers (CLI
 * queries, SIEM export, chain-verify) work against the union type so
 * new record kinds land without rippling through every consumer.
 *
 * Record lineage:
 *   - `tool_call`                Phase 1 — any tool dispatch.
 *   - `channel_event`            Phase 5 — inbound channel message.
 *   - `channel_tool_call`        Phase 5 — tool call from a channel session.
 *   - `channel_outbound`         Phase 5 — outbound send.
 *   - `secret_access`            Phase 6 slice 3 — secret resolver hit.
 *   - `tenant_boundary_violation` Phase 6 — cross-tenant attempt blocked.
 *   - `quota_exceeded`           Phase 6 — tenant quota breach.
 */

import type {
  ChannelEventAuditRecord,
  ChannelOutboundAuditRecord,
  ChannelToolCallAuditRecord,
} from '../channels/audit.js';
import type { SecretAccessAuditRecord } from '../secrets/types.js';
import type { TenantBoundaryResource } from '../tenancy/boundary-error.js';
import type { TenantQuotas } from '../tenancy/types.js';

// ── New record kinds introduced by slice 5 ────────────────────────────────

/**
 * Generic tool-call audit record — covers REPL, scheduled-trigger, and
 * every non-channel tool dispatch. Channel-initiated calls use
 * `ChannelToolCallAuditRecord` (carries conversation/user context on top).
 */
export interface ToolCallAuditRecord {
  kind: 'tool_call';
  ts: number;
  tenantId: string;
  sessionId: string;
  tool: string;
  permissionKey: string;
  outcome: 'allow' | 'deny' | 'prompt';
  /** Glob pattern that matched (allowed or denied). */
  matchedRule?: string;
  /** Execution duration for allowed calls, in ms. */
  durationMs?: number;
  /** Error payload on tool failure. */
  error?: { code?: string; message: string };
  /** Trace id threaded from the originating event. */
  correlationId?: string;
}

/**
 * A cross-tenant access attempt that the runtime rejected. Always
 * carries `blocked: true` in v1.0 — the field exists for future
 * "log-only" dry-run mode.
 */
export interface TenantBoundaryAuditRecord {
  kind: 'tenant_boundary_violation';
  ts: number;
  /** The tenant that initiated the attempt. */
  sourceTenantId: string;
  /** The tenant that owns the targeted resource. */
  targetTenantId: string;
  resource: TenantBoundaryResource;
  resourceId: string;
  blocked: boolean;
  correlationId?: string;
}

/** Per-tenant quota breach. */
export interface QuotaExceededAuditRecord {
  kind: 'quota_exceeded';
  ts: number;
  tenantId: string;
  quota: keyof TenantQuotas;
  limit: number;
  observed: number;
  correlationId?: string;
}

/**
 * RPC auth verify outcome. One record per inbound envelope — whether
 * accepted or rejected — so operators can audit authentication decisions
 * on the hash chain.
 *
 * @since 1.2.0
 */
export interface AuthCheckAuditRecord {
  kind: 'auth_check';
  ts: number;
  tenantId: string;
  /** Logical peer address (`agent://...`) of the sender. */
  peerId: string;
  /** Auth provider that made the decision. `none` when envelope lacked an auth block. */
  provider: 'oidc' | 'oauth2-client' | 'hmac' | 'internal' | 'none';
  decision: 'accept' | 'reject';
  /** Typed rejection reason; absent on `accept`. */
  reason?: string;
  /** RPC correlation id of the originating envelope, for cross-referencing. */
  correlationId?: string;
  /** Resolved principal subject when the decision is `accept` and a JWT was parsed. */
  subject?: string;
}

/**
 * Erasure tombstone — surfaced by queries in place of records that
 * `TenantAuditSink.erase()` has scrubbed. Keeps the hash-chain verifier
 * able to confirm continuity even after right-to-erasure requests.
 */
export interface ErasedAuditRecord {
  kind: 'erased';
  ts: number;
  tenantId: string;
  /** Original kind before erasure, for query filtering. */
  originalKind: string;
  /** Timestamp the erasure happened. */
  erasedAt: number;
  /** Reason code supplied to `erase()` — typically `"gdpr-subject-access"`. */
  reason: string;
}

// ── Unified union ─────────────────────────────────────────────────────────

/**
 * Every kind of audit record the sink persists. Each non-tombstone
 * record carries a `tenantId` (channel records gain one on write via
 * the context that produced them).
 *
 * @since 1.0.0
 */
export type TenantAuditRecord =
  | (ToolCallAuditRecord & { tenantId: string })
  | (ChannelEventAuditRecord & { tenantId: string })
  | (ChannelToolCallAuditRecord & { tenantId: string })
  | (ChannelOutboundAuditRecord & { tenantId: string })
  | SecretAccessAuditRecord
  | TenantBoundaryAuditRecord
  | QuotaExceededAuditRecord
  | AuthCheckAuditRecord
  | ErasedAuditRecord;

/** @since 1.0.0 */
export type TenantAuditRecordKind = TenantAuditRecord['kind'];

// ── Query types ───────────────────────────────────────────────────────────

export interface TenantAuditQuery {
  tenantId?: string;
  kind?: TenantAuditRecordKind | readonly TenantAuditRecordKind[];
  /** Records with `ts >= sinceMs`. */
  sinceMs?: number;
  /** Records with `ts <= untilMs`. */
  untilMs?: number;
  /** Max rows to return. Default 1000. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
  /** Order by timestamp: ascending by default. */
  order?: 'asc' | 'desc';
  /** Free-form substring match over the serialized record (sqlite LIKE). */
  search?: string;
}

// ── Chain + verification ──────────────────────────────────────────────────

/**
 * One row as stored: the record itself plus the chain metadata needed
 * to verify continuity + detect tamper after-the-fact.
 */
export interface StoredAuditEntry {
  /** Monotonic sequence id (primary key). */
  seq: number;
  record: TenantAuditRecord;
  /** Hex SHA-256 of the previous entry's recordHash, or "" for the first. */
  prevHash: string;
  /** Hex SHA-256 of `${prevHash}\n${serialized(record)}`. */
  recordHash: string;
}

export interface VerifyReport {
  ok: boolean;
  totalEntries: number;
  verifiedEntries: number;
  /** Rows that failed verification (first-failure-first order). */
  violations: readonly VerifyViolation[];
}

export interface VerifyViolation {
  seq: number;
  kind: 'hash-mismatch' | 'prev-hash-mismatch' | 'missing-entry';
  expectedHash?: string;
  observedHash?: string;
  message: string;
}

// ── Sink interface ────────────────────────────────────────────────────────

export interface EraseOptions {
  /** Human-readable reason code stored on every tombstone. */
  reason: string;
  /** Predicate over a stored record. Every matching entry is tombstoned. */
  matches: (record: TenantAuditRecord) => boolean;
}

export interface RetentionPruneOptions {
  /** Only prune records for this tenant. */
  tenantId: string;
  /** Retention window, in days. Records older than `ts < now - days * 86400000` are pruned. */
  retentionDays: number;
  /** Clock override. */
  now?: () => number;
}

/** @since 1.0.0 */
export interface TenantAuditSink {
  /** Append one record. Assigns `seq` + chain hash atomically. */
  record(record: TenantAuditRecord): Promise<void>;
  /** Query records by tenant / kind / time window. */
  query(query?: TenantAuditQuery): Promise<readonly StoredAuditEntry[]>;
  /**
   * Right-to-erasure helper. Replaces every matching record's content
   * with a {@link ErasedAuditRecord} tombstone while leaving `prevHash`
   * + `recordHash` untouched so chain-verify stays green.
   */
  erase(options: EraseOptions): Promise<number>;
  /**
   * Walk every entry for a tenant (or all tenants) and verify the
   * chain is intact.
   */
  verify(tenantId?: string): Promise<VerifyReport>;
  /**
   * Remove entries past the retention window for `tenantId`. Returns
   * the count of pruned rows.
   */
  prune(options: RetentionPruneOptions): Promise<number>;
  /** Graceful shutdown. */
  close(): Promise<void> | void;
}
