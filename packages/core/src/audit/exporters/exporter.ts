/**
 * Shared trait + types for SIEM audit exporters.
 *
 * An exporter takes a batch of {@link AuditExportEntry} rows and POSTs
 * them to a vendor endpoint (Splunk HEC / Elastic bulk / Datadog Logs
 * v2). The {@link AuditExportLoop} owns batching, cursor persistence,
 * retry, and the 5-consecutive-failure alert+pause behaviour — the
 * exporter trait is kept deliberately small so a new adapter is ~80
 * LoC of vendor-specific glue.
 *
 * ### Contract
 *
 * - `push()` MUST be all-or-nothing unless the vendor supports partial
 *   acks, in which case return `{ok: true, acked: <n>}` with `n` less
 *   than `entries.length`. The loop advances the cursor to the first
 *   `n` rows and retries the rest.
 * - Non-retryable errors (e.g. HTTP 401 token invalid, 403 permission,
 *   400 schema rejected) MUST return `{ok: false, retryable: false}`
 *   so the loop pauses immediately rather than burning a backoff
 *   budget.
 * - Retryable errors (network blip, 429, 5xx) MUST return
 *   `{ok: false, retryable: true}`.
 * - Errors MUST NOT include the auth token or the full endpoint URL
 *   path — redact to `<vendor>: <class>`. The exporter loop forwards
 *   the error string into logs + Prometheus labels.
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #10
 */

import type { StoredAuditEntry } from '../types.js';

/**
 * Minimal fetch shape accepted by exporters. We avoid `typeof fetch`
 * here because Bun's ambient types bolt on extra methods (`preconnect`,
 * `BunFetchRequestInit`) that tests don't want to mock. The four
 * argument shapes the standard expects are enough for our needs.
 */
export type ExporterFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * One envelope-shaped row handed to {@link AuditExporter.push}. The loop
 * stamps the `host`, `source`, and `tenant` metadata once when it
 * materialises the batch so exporters don't have to know about the
 * runtime layout.
 */
export interface AuditExportEntry {
  /** Monotonic sequence id (primary key from `audit_records`). */
  seq: number;
  /** ms-epoch the original record was written. */
  ts: number;
  /** Audit record kind (e.g. `tool_call`, `channel_event`). */
  kind: string;
  /** Tenant id; `"_system"` for chain-wide entries that predate tenancy. */
  tenantId: string;
  /** Serialised record — the same JSON the SQLite sink stores. */
  record: Readonly<Record<string, unknown>>;
  /** Hex SHA-256 chain hash, exposed so SIEMs can audit chain integrity. */
  recordHash: string;
  /** Previous entry's `recordHash`; empty string for `seq=1`. */
  prevHash: string;
}

/**
 * Vendor push outcome.
 *
 * - `{ok: true, acked: N}` — N rows ack'd; loop advances cursor by N.
 * - `{ok: false, retryable: true}` — transient failure; loop retries
 *   with backoff.
 * - `{ok: false, retryable: false}` — permanent failure; loop pauses
 *   after 5 consecutive failures and emits an alert metric.
 */
export type PushResult =
  | { ok: true; acked: number }
  | { ok: false; error: string; retryable: boolean };

/**
 * Adapter trait. Every vendor exporter implements this shape.
 *
 * The `name` is used as the {@link ExportCursor} primary key, so it
 * MUST be stable across restarts. Convention: `"<vendor>:<instance>"`
 * (`"splunk:default"`, `"elastic:prod"`). When an operator runs two
 * exporters against different indices on the same vendor they MUST
 * give each a unique suffix so the cursors don't clobber.
 */
export interface AuditExporter {
  /** Stable identity for cursor tracking + metrics. */
  readonly name: string;
  /** Vendor family for logging (`splunk` / `elastic` / `datadog`). */
  readonly vendor: 'splunk' | 'elastic' | 'datadog';
  push(entries: readonly AuditExportEntry[]): Promise<PushResult>;
}

/**
 * Convert a {@link StoredAuditEntry} from the SQLite sink into the
 * export-loop envelope shape. Kept here so every exporter's test
 * fixtures build entries the same way.
 */
export function toExportEntry(stored: StoredAuditEntry): AuditExportEntry {
  const raw = stored.record as unknown as Record<string, unknown>;
  const tenantId =
    (raw.tenantId as string | undefined) ?? (raw.sourceTenantId as string | undefined) ?? '_system';
  return {
    seq: stored.seq,
    ts: (raw.ts as number | undefined) ?? 0,
    kind: (raw.kind as string | undefined) ?? 'unknown',
    tenantId,
    record: raw,
    recordHash: stored.recordHash,
    prevHash: stored.prevHash,
  };
}

/**
 * Redact a token/secret down to its first 2 + last 2 chars. Keeps
 * enough for an operator to cross-reference with their config
 * manager without leaking the full credential into logs.
 *
 * Empty / short strings collapse to `"***"`.
 */
export function redactToken(token: string): string {
  if (token.length < 8) return '***';
  return `${token.slice(0, 2)}…${token.slice(-2)}`;
}

/**
 * Classify a thrown fetch error as retryable or not. Network errors
 * are always retryable; HTTP errors are classified by status.
 *
 * Exporters usually don't need this — they classify inline — but when
 * multiple adapters share identical network-error handling this keeps
 * the logic DRY.
 */
export function isRetryableHttpStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}
