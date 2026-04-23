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
 * Per-tool rate-limit stall. Emitted by the {@link import('../tools/rate-limit-gate.js').ToolRateLimitGate}
 * when a tool invocation had to wait for a token longer than the configured
 * `auditThresholdMs` (default 1000 ms). Short waits are silent — auditing
 * every few-ms blip would bloat the chain without operational value.
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #7
 */
export interface RateLimitedAuditRecord {
  kind: 'rate_limited';
  ts: number;
  tenantId: string;
  /** Tool name whose bucket was empty. */
  tool: string;
  /** Configured steady-state rate (rps). */
  rps: number;
  /** Configured burst capacity. */
  burst: number;
  /** Wall-clock time the caller waited, in ms. */
  waitMs: number;
  /** Session the call originated from (when available). */
  sessionId?: string;
  /** Correlation id threaded through from the originating event. */
  correlationId?: string;
}

/**
 * Emitted by {@link import('../rpc/capability-validator.js').createCapabilityValidatorRegistry}
 * when a `RequestAgent` call violates its capability's JSON Schema on
 * either the outbound (`request`) or inbound (`response`) side. One
 * record per violation *event* (not per individual `violations[]` entry)
 * — downstream consumers can drill into `violations` to enumerate which
 * paths/messages tripped.
 *
 * Cardinality decision (POST_ENTERPRISE_BACKLOG.md #9): batched per
 * envelope. A single `/severity: critical` input rejection emits exactly
 * one audit row even if the schema flagged three different fields,
 * because otherwise SIEM volume explodes under bulk-bad-input scenarios.
 * Pinned by `request-agent.test.ts` + `fleet-run.test.ts`.
 *
 * @since 1.2.0 — Enterprise Production Plan §3 Item #11
 */
export interface CapabilitySchemaViolationAuditRecord {
  kind: 'capability_schema_violation';
  ts: number;
  tenantId: string;
  /** Capability name (from `capabilities.yaml#capabilities[].name`). */
  capabilityName: string;
  /** Peer address — `agent://...` — the call was aimed at. */
  peerId: string;
  /** Which side failed validation. */
  side: 'request' | 'response';
  /** All violations detected on this envelope. */
  violations: ReadonlyArray<{ path: string; message: string }>;
  /** RPC correlation id of the originating envelope. */
  correlationId: string;
  /** Session the call originated from (when available). */
  sessionId?: string;
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
  | (RateLimitedAuditRecord & { tenantId: string })
  | CapabilitySchemaViolationAuditRecord
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
  /**
   * Records with `seq > sinceSeq`. Used by cursor-based consumers (SIEM
   * export loop) that need a strictly-monotonic "what's new since last
   * call" iterator that survives restarts.
   *
   * @since 0.6.x — Enterprise Production Plan §3 Item #10
   */
  sinceSeq?: number;
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

/**
 * Persistent cursor state for a forward-only audit consumer (e.g. the
 * SIEM export loop). Stored in the `audit_export_cursor` SQLite table
 * keyed on `exporterName`, so a restart doesn't re-push rows already
 * ack'd by the downstream vendor.
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #10
 */
export interface ExportCursor {
  /** Stable exporter identity. Convention: `"<vendor>:<instance>"` (e.g. `"splunk:default"`). */
  exporterName: string;
  /** Last `seq` the consumer acknowledged. `0` before first push. */
  lastSeq: number;
  /** ms-epoch of the last advance. */
  updatedAt: number;
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
  /**
   * Load the persisted cursor for a forward-only consumer. Returns
   * `null` when the exporter has never advanced (first boot). Optional
   * on the interface for back-compat with older sinks; the SQLite sink
   * implements it.
   *
   * @since 0.6.x — Enterprise Production Plan §3 Item #10
   */
  readExportCursor?(exporterName: string): Promise<ExportCursor | null>;
  /**
   * Atomically advance the persisted cursor. Must be monotonic — calling
   * with `lastSeq < existing.lastSeq` is a no-op (idempotent, so a stale
   * exporter that crashes mid-batch can't rewind the cursor).
   *
   * @since 0.6.x — Enterprise Production Plan §3 Item #10
   */
  writeExportCursor?(exporterName: string, lastSeq: number): Promise<void>;
  /**
   * Timestamp (ms) of the oldest audit row that has not yet been
   * acknowledged by the named exporter's cursor, or `null` when the
   * queue is empty. Used by the SIEM back-pressure evaluator on the
   * export loop.
   *
   * Implementations that don't track a cursor may omit this — the
   * export loop skips back-pressure evaluation when the method is
   * absent.
   *
   * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #11
   */
  oldestUnshippedMs?(exporterName: string): Promise<number | null>;
  /** Graceful shutdown. */
  close(): Promise<void> | void;
}
