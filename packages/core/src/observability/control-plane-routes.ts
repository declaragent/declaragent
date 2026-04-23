/**
 * Control-plane HTTP routes — Slice 1 tail of
 * `docs/CONTROL_PLANE_PLAN.md` §9 / `docs/ENTERPRISE_PRODUCTION_PLAN.md`
 * §3 item #5.
 *
 * Complements the router + `/metrics` + `/status` substrate in
 * {@link ./control-plane-server.js}. Three read-only JSON routes:
 *
 *   - {@link eventsRoute} — paginated enumeration of `EventStore.list()`
 *     rows. Mirrors the shape `declaragent events list` already renders.
 *   - {@link dlqRoute}    — paginated enumeration of `EventStore.listRejections()`
 *     rows. Only `kind=dispatch` is supported today (matches the CLI verb).
 *   - {@link auditRoute}  — paginated read from a `TenantAuditSink.query()`.
 *     Hash-chain verification is opt-in via `?verify=1` because walking a
 *     large chain on every request is expensive; see §"Open questions"
 *     in the Slice 1 tail status note for the deferral rationale.
 *
 * `/logs` (SSE tail) is intentionally deferred to a later slice — SSE is
 * a different response shape from JSON and warrants its own PR.
 *
 * All routes accept the same pagination contract:
 *   `?since=<iso|ms>&limit=<n>&cursor=<opaque>`
 * plus a small set of per-route filters documented below. They all
 * return `{ events|rejections|entries: [...], nextCursor: string|null }`
 * and emit `400 { error: "..." }` on malformed input.
 *
 * @since 0.7.0-slice.1
 */

import type { DlqOperationAuditRecord, TenantAuditQuery, TenantAuditSink } from '../audit/types.js';
import { type RequeueResult, requeue as requeueDispatchDlq } from '../events/dlq.js';
import type {
  EventRejectionListFilter,
  EventStore,
  EventStoreListFilter,
} from '../events/store.js';
import type { DispatchOutcome, EventBus, EventKind } from '../events/types.js';
import type { ControlPlaneRoute } from './control-plane-server.js';

// ── Shared cursor + query helpers ──────────────────────────────────────────

/**
 * Opaque pagination cursor. Encoded as base64url JSON so the client
 * treats it as a string token. The `(ts, id)` pair is monotonic-enough
 * to resume DESC iteration without needing store-side `untilMs`
 * support; `seq` is used for audit reads where the source is a monotonic
 * sequence rather than a timestamp.
 *
 * Clients MUST NOT inspect or mutate cursors — the schema may grow.
 */
interface EventCursor {
  readonly beforeTs: number;
  readonly beforeId: string;
}

interface AuditCursor {
  readonly beforeSeq: number;
}

function encodeCursor(value: EventCursor | AuditCursor): string {
  const json = JSON.stringify(value);
  return base64UrlEncode(json);
}

function decodeEventCursor(raw: string): EventCursor | { error: string } {
  const parsed = decodeOpaqueCursor(raw);
  if (isDecodeError(parsed)) return parsed;
  const { beforeTs, beforeId } = parsed as Partial<EventCursor>;
  if (typeof beforeTs !== 'number' || !Number.isFinite(beforeTs) || typeof beforeId !== 'string') {
    return { error: 'malformed cursor' };
  }
  return { beforeTs, beforeId };
}

function decodeAuditCursor(raw: string): AuditCursor | { error: string } {
  const parsed = decodeOpaqueCursor(raw);
  if (isDecodeError(parsed)) return parsed;
  const { beforeSeq } = parsed as Partial<AuditCursor>;
  if (typeof beforeSeq !== 'number' || !Number.isFinite(beforeSeq) || beforeSeq < 0) {
    return { error: 'malformed cursor' };
  }
  return { beforeSeq };
}

function isDecodeError(v: Record<string, unknown> | { error: string }): v is { error: string } {
  return typeof (v as { error?: unknown }).error === 'string';
}

function decodeOpaqueCursor(raw: string): Record<string, unknown> | { error: string } {
  try {
    const json = base64UrlDecode(raw);
    const obj = JSON.parse(json) as unknown;
    if (obj === null || typeof obj !== 'object') {
      return { error: 'malformed cursor' };
    }
    return obj as Record<string, unknown>;
  } catch {
    return { error: 'malformed cursor' };
  }
}

function base64UrlEncode(input: string): string {
  // Use URL-safe base64 without padding. Works in both Bun + Node.
  // biome-ignore lint/suspicious/noExplicitAny: Buffer global when on Node; fallback to btoa under Bun/browsers.
  const maybeBuffer = (globalThis as any).Buffer;
  const b64 =
    maybeBuffer && typeof maybeBuffer.from === 'function'
      ? (maybeBuffer.from(input, 'utf8').toString('base64') as string)
      : btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const full = padded + '='.repeat(padLen);
  // biome-ignore lint/suspicious/noExplicitAny: see encode.
  const maybeBuffer = (globalThis as any).Buffer;
  if (maybeBuffer && typeof maybeBuffer.from === 'function') {
    return maybeBuffer.from(full, 'base64').toString('utf8') as string;
  }
  return decodeURIComponent(escape(atob(full)));
}

function parseLimit(raw: string | null, def: number, max: number): number | { error: string } {
  if (raw === null || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return { error: 'limit must be a positive integer' };
  if (n > max) return { error: `limit exceeds max ${max}` };
  return n;
}

/**
 * Parse `?since=` as either ms-epoch or ISO-8601. Returns undefined when
 * the param is absent; returns an error object on malformed input.
 */
function parseSince(raw: string | null): number | undefined | { error: string } {
  if (raw === null || raw === '') return undefined;
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return asNum;
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return asDate;
  return { error: 'since must be a number (ms epoch) or ISO-8601 timestamp' };
}

function jsonResponse(status: number, body: unknown, method: string): Response {
  const payload = JSON.stringify(body);
  return new Response(method === 'HEAD' ? null : payload, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function assertGetOrHead(req: Request): Response | undefined {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  return new Response('method not allowed', {
    status: 405,
    headers: { Allow: 'GET, HEAD' },
  });
}

// ── /events ────────────────────────────────────────────────────────────────

/**
 * JSON body shape for `/events` responses. `events` is ordered newest-
 * first (matching the underlying `EventStore.list()` DESC order).
 *
 * @since 0.7.0-slice.1
 */
export interface EventsResponse {
  readonly events: readonly EventsResponseEntry[];
  /**
   * Opaque continuation token. `null` means the caller reached the end
   * of the stream for the given filter. Clients MUST treat it as an
   * opaque string and pass it unchanged in the next `?cursor=` query.
   */
  readonly nextCursor: string | null;
}

/**
 * One row in an `/events` response. Equivalent to `EventStoreRecord`
 * flattened for JSON over the wire — `event` is the raw `AgentEvent`
 * object, `outcome` is the dispatcher's verdict (absent for events
 * still in-flight), and `recordedAt` / `outcomeAt` are ms-epoch
 * timestamps.
 */
export interface EventsResponseEntry {
  readonly id: string;
  readonly kind: EventKind;
  readonly ts: number;
  readonly recordedAt: number;
  readonly correlationId: string | undefined;
  readonly sourceType: string;
  readonly targetType: string;
  readonly outcome: DispatchOutcome | undefined;
  readonly outcomeAt: number | undefined;
  /** Full event body — the client doesn't need to re-query by id for details. */
  readonly event: unknown;
  /**
   * Agent that owns this event's store. Populated only on `?all=1`
   * fan-out responses so operators can tell which agent produced the
   * row; absent on single-agent responses (back-compat).
   *
   * @since 0.7.3 — POST_ENTERPRISE_BACKLOG.md #19
   */
  readonly agentId?: string;
}

export interface EventsRouteOptions {
  path?: string;
  /**
   * Upper bound on the per-request limit. Prevents a curious client from
   * burning CPU by requesting 10^6 events at once. Default 500.
   */
  maxLimit?: number;
  /** Default page size when `?limit=` is absent. */
  defaultLimit?: number;
  /**
   * Multi-agent fan-out provider. When set, the route accepts `?all=1`
   * and fans the query across every returned `{ agentId, store }`
   * entry. Rows are merged + sorted DESC by `(timestamp, id)`. Absent
   * → `?all=1` returns 400.
   *
   * Auth gate: by convention operators configure
   * `controlPlane.auth.routeScopes: { "/events?all=1": ["control:fan-out"] }`
   * so the fan-out variant requires an explicit scope. The server
   * surfaces `?all=1` as a synthetic `routePath` to
   * {@link applyControlPlaneAuth} — see
   * {@link ./control-plane-server.ts} for the wiring.
   *
   * @since 0.7.3 — POST_ENTERPRISE_BACKLOG.md #19
   */
  fanOut?: () => readonly { readonly agentId: string; readonly store: Pick<EventStore, 'list'> }[];
}

/**
 * `GET /events` — paginated event-store read.
 *
 * Query params:
 *   - `kind`    (optional) single `EventKind` (e.g. `webhook.received`).
 *   - `since`   (optional) ms-epoch or ISO-8601. Events at or after.
 *   - `state`   (optional) `circuit-open` — synthetic filter mirroring
 *               `declaragent events list --state circuit-open`. Narrows
 *               to rejected outcomes whose reason is `circuit-open`.
 *   - `outcome` (optional) `DispatchOutcome['kind']` | `pending`.
 *   - `correlation` (optional) trace-id filter.
 *   - `limit`   (optional) max rows. Default 200, clamped to `maxLimit`.
 *   - `cursor`  (optional) opaque continuation from a prior response.
 */
export function eventsRoute(
  store: Pick<EventStore, 'list'>,
  opts: EventsRouteOptions = {},
): ControlPlaneRoute {
  const path = opts.path ?? '/events';
  const maxLimit = opts.maxLimit ?? 500;
  const defaultLimit = opts.defaultLimit ?? 200;
  return {
    path,
    async fetch(req) {
      const mna = assertGetOrHead(req);
      if (mna) return mna;

      const url = new URL(req.url);
      const q = url.searchParams;

      const limitOrErr = parseLimit(q.get('limit'), defaultLimit, maxLimit);
      if (typeof limitOrErr !== 'number') return jsonError(400, limitOrErr.error);
      const limit = limitOrErr;

      const sinceOrErr = parseSince(q.get('since'));
      if (sinceOrErr !== undefined && typeof sinceOrErr === 'object') {
        return jsonError(400, sinceOrErr.error);
      }
      const since = sinceOrErr;

      const state = q.get('state');
      if (state !== null && state !== 'circuit-open') {
        return jsonError(400, `unsupported state "${state}"; supported: circuit-open`);
      }

      const outcomeParam = q.get('outcome');
      if (outcomeParam !== null && !isAllowedOutcome(outcomeParam)) {
        return jsonError(
          400,
          `unsupported outcome "${outcomeParam}"; supported: dispatched, broadcast, queued, duplicate, rejected, pending`,
        );
      }

      const cursorRaw = q.get('cursor');
      let cursor: EventCursor | undefined;
      if (cursorRaw !== null && cursorRaw !== '') {
        const decoded = decodeEventCursor(cursorRaw);
        if ('error' in decoded) return jsonError(400, decoded.error);
        cursor = decoded;
      }

      const filter: EventStoreListFilter = {};
      if (q.get('kind')) filter.kind = q.get('kind') as EventKind;
      if (q.get('correlation')) filter.correlationId = q.get('correlation') as string;
      if (since !== undefined) filter.sinceMs = since;

      // `state=circuit-open` maps to `outcomeKind=rejected` at the store
      // level; we post-filter the reason in-memory because the store
      // schema doesn't expose it as a separate column.
      let outcomeKind: EventStoreListFilter['outcomeKind'] | undefined;
      if (state === 'circuit-open') {
        outcomeKind = 'rejected';
      } else if (outcomeParam !== null) {
        outcomeKind = outcomeParam as EventStoreListFilter['outcomeKind'];
      }
      if (outcomeKind !== undefined) filter.outcomeKind = outcomeKind;

      // Fetch one extra row to know whether there's a next page. Inflate
      // further when a cursor is in play because the cursor filter is
      // applied in-memory after the store returns rows — a row in the
      // raw DESC window may sort "after" the cursor and get skipped.
      const overFetch = cursor ? Math.max(limit * 2 + 1, 256) : limit + 1;
      filter.limit = overFetch;

      // Multi-agent fan-out (#19). When `?all=1` is set AND `fanOut`
      // is wired, every hosted agent's store is queried; otherwise the
      // route stays on the single-store path. A `?all=1` request with
      // no `fanOut` callback is a 400 — the scope gate (`control:fan-out`)
      // gets enforced by the server's auth middleware before we get
      // here, so reaching this branch means the operator intended it.
      const allMode = q.get('all') === '1';
      let targets: readonly {
        readonly agentId: string | undefined;
        readonly store: Pick<EventStore, 'list'>;
      }[];
      if (allMode) {
        if (!opts.fanOut) {
          return jsonError(400, '?all=1 not supported: fan-out provider not configured');
        }
        const fanned = opts.fanOut();
        if (fanned.length === 0) {
          // No hosted agents with stores — return an empty page rather
          // than 404 so `fleet ps` / CLI callers can just aggregate
          // without branching.
          const body: EventsResponse = { events: [], nextCursor: null };
          return jsonResponse(200, body, req.method);
        }
        targets = fanned.map((f) => ({ agentId: f.agentId, store: f.store }));
      } else {
        targets = [{ agentId: undefined, store }];
      }

      // Fetch one page per target, then merge + post-filter.
      let raw: Array<{
        row: Awaited<ReturnType<EventStore['list']>>[number];
        agentId: string | undefined;
      }> = [];
      for (const target of targets) {
        let rows: Awaited<ReturnType<EventStore['list']>>;
        try {
          rows = await target.store.list(filter);
        } catch (err) {
          return jsonError(500, `event-store list failed: ${errMsg(err)}`);
        }
        for (const r of rows) raw.push({ row: r, agentId: target.agentId });
      }
      // Fan-out merges multiple DESC streams; sort by (ts, id) DESC so
      // the cursor encoding stays monotonic across the merged stream.
      if (allMode) {
        raw.sort((a, b) => {
          const ta = a.row.event.timestamp;
          const tb = b.row.event.timestamp;
          if (ta !== tb) return tb - ta;
          return a.row.event.id < b.row.event.id ? 1 : a.row.event.id > b.row.event.id ? -1 : 0;
        });
        // Bound the in-memory working set to the over-fetch ceiling
        // multiplied by target count — operators with 50 agents don't
        // want the merge to hoard 50×256 rows just to drop 49/50.
        const mergedCap = overFetch;
        if (raw.length > mergedCap) raw = raw.slice(0, mergedCap);
      }

      // Post-filter: cursor (keep rows strictly "older" than the cursor),
      // and for state=circuit-open keep only rejected w/ reason match.
      const filtered: EventsResponseEntry[] = [];
      for (const { row, agentId } of raw) {
        if (cursor) {
          const { event } = row;
          const ts = event.timestamp;
          if (ts > cursor.beforeTs || (ts === cursor.beforeTs && event.id >= cursor.beforeId)) {
            continue;
          }
        }
        if (state === 'circuit-open') {
          if (
            row.outcome?.kind !== 'rejected' ||
            (row.outcome.kind === 'rejected' && row.outcome.reason !== 'circuit-open')
          ) {
            continue;
          }
        }
        filtered.push(toEventsEntry(row, agentId));
        if (filtered.length >= limit + 1) break;
      }

      const hasMore = filtered.length > limit;
      const page = hasMore ? filtered.slice(0, limit) : filtered;
      const tail = page[page.length - 1];
      const nextCursor =
        hasMore && tail ? encodeCursor({ beforeTs: tail.ts, beforeId: tail.id }) : null;

      const body: EventsResponse = { events: page, nextCursor };
      return jsonResponse(200, body, req.method);
    },
  };
}

const ALLOWED_OUTCOME_KINDS = [
  'dispatched',
  'broadcast',
  'queued',
  'duplicate',
  'rejected',
  'pending',
] as const;

function isAllowedOutcome(v: string): boolean {
  return (ALLOWED_OUTCOME_KINDS as readonly string[]).includes(v);
}

function toEventsEntry(
  row: Awaited<ReturnType<EventStore['list']>>[number],
  agentId?: string,
): EventsResponseEntry {
  const { event } = row;
  const base: EventsResponseEntry = {
    id: event.id,
    kind: event.kind,
    ts: event.timestamp,
    recordedAt: row.recordedAt,
    correlationId: event.meta?.correlationId,
    sourceType: event.source.type,
    targetType: event.target.type,
    outcome: row.outcome,
    outcomeAt: row.outcomeAt,
    event,
  };
  // agentId is only populated on `?all=1` fan-out responses (#19).
  // Omitting the key on single-agent responses preserves the pre-0.7.3
  // wire shape exactly.
  return agentId !== undefined ? { ...base, agentId } : base;
}

// ── /dlq ───────────────────────────────────────────────────────────────────

/**
 * JSON body shape for `/dlq` responses.
 *
 * @since 0.7.0-slice.1
 */
export interface DlqResponse {
  readonly rejections: readonly DlqResponseEntry[];
  readonly nextCursor: string | null;
}

export interface DlqResponseEntry {
  readonly eventId: string;
  readonly reason: string;
  readonly details: string | undefined;
  readonly attemptCount: number;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  /**
   * Agent that owns this DLQ entry. Populated only on `?all=1` fan-out
   * responses; absent on single-agent responses.
   *
   * @since 0.7.3 — POST_ENTERPRISE_BACKLOG.md #19
   */
  readonly agentId?: string;
}

export interface DlqRouteOptions {
  path?: string;
  maxLimit?: number;
  defaultLimit?: number;
  /**
   * Multi-agent fan-out provider for `?all=1`. See
   * {@link EventsRouteOptions.fanOut}.
   *
   * @since 0.7.3 — POST_ENTERPRISE_BACKLOG.md #19
   */
  fanOut?: () => readonly {
    readonly agentId: string;
    readonly store: Pick<EventStore, 'listRejections'>;
  }[];
}

/**
 * `GET /dlq` — paginated dispatch-DLQ read.
 *
 * Query params:
 *   - `kind`        (optional, default `dispatch`) — only `dispatch`
 *     is honored today. Future MCP / channel DLQs will add their own
 *     `kind=` values.
 *   - `reason`      (optional) filter by rejection reason.
 *   - `since`       (optional) ms-epoch or ISO-8601 on `lastSeenMs`.
 *   - `minAttempts` (optional) narrow to poison events.
 *   - `limit`       (optional).
 *   - `cursor`      (optional).
 */
export function dlqRoute(
  store: Pick<EventStore, 'listRejections'>,
  opts: DlqRouteOptions = {},
): ControlPlaneRoute {
  const path = opts.path ?? '/dlq';
  const maxLimit = opts.maxLimit ?? 500;
  const defaultLimit = opts.defaultLimit ?? 200;
  return {
    path,
    async fetch(req) {
      const mna = assertGetOrHead(req);
      if (mna) return mna;

      const url = new URL(req.url);
      const q = url.searchParams;

      const kindRaw = q.get('kind');
      if (kindRaw !== null && kindRaw !== 'dispatch') {
        return jsonError(400, `unsupported kind "${kindRaw}"; supported: dispatch`);
      }

      const limitOrErr = parseLimit(q.get('limit'), defaultLimit, maxLimit);
      if (typeof limitOrErr !== 'number') return jsonError(400, limitOrErr.error);
      const limit = limitOrErr;

      const sinceOrErr = parseSince(q.get('since'));
      if (sinceOrErr !== undefined && typeof sinceOrErr === 'object') {
        return jsonError(400, sinceOrErr.error);
      }
      const since = sinceOrErr;

      let minAttempts: number | undefined;
      const minRaw = q.get('minAttempts');
      if (minRaw !== null && minRaw !== '') {
        const n = Number.parseInt(minRaw, 10);
        if (!Number.isFinite(n) || n <= 0) {
          return jsonError(400, 'minAttempts must be a positive integer');
        }
        minAttempts = n;
      }

      const cursorRaw = q.get('cursor');
      let cursor: EventCursor | undefined;
      if (cursorRaw !== null && cursorRaw !== '') {
        const decoded = decodeEventCursor(cursorRaw);
        if ('error' in decoded) return jsonError(400, decoded.error);
        cursor = decoded;
      }

      const filter: EventRejectionListFilter = {};
      if (q.get('reason')) filter.reason = q.get('reason') as string;
      if (since !== undefined) filter.sinceMs = since;
      if (minAttempts !== undefined) filter.minAttempts = minAttempts;

      const overFetch = cursor ? Math.max(limit * 2 + 1, 256) : limit + 1;
      filter.limit = overFetch;

      // Multi-agent fan-out (#19) — see eventsRoute for rationale.
      const allMode = q.get('all') === '1';
      let targets: readonly {
        readonly agentId: string | undefined;
        readonly store: Pick<EventStore, 'listRejections'>;
      }[];
      if (allMode) {
        if (!opts.fanOut) {
          return jsonError(400, '?all=1 not supported: fan-out provider not configured');
        }
        const fanned = opts.fanOut();
        if (fanned.length === 0) {
          const body: DlqResponse = { rejections: [], nextCursor: null };
          return jsonResponse(200, body, req.method);
        }
        targets = fanned.map((f) => ({ agentId: f.agentId, store: f.store }));
      } else {
        targets = [{ agentId: undefined, store }];
      }

      let raw: Array<{
        row: Awaited<ReturnType<EventStore['listRejections']>>[number];
        agentId: string | undefined;
      }> = [];
      for (const target of targets) {
        let rows: Awaited<ReturnType<EventStore['listRejections']>>;
        try {
          rows = await target.store.listRejections(filter);
        } catch (err) {
          return jsonError(500, `event-store listRejections failed: ${errMsg(err)}`);
        }
        for (const r of rows) raw.push({ row: r, agentId: target.agentId });
      }
      if (allMode) {
        // Sort merged stream DESC by `(lastSeenMs, eventId)` for
        // cursor-monotonic pagination.
        raw.sort((a, b) => {
          const ta = a.row.lastSeenMs;
          const tb = b.row.lastSeenMs;
          if (ta !== tb) return tb - ta;
          return a.row.eventId < b.row.eventId ? 1 : a.row.eventId > b.row.eventId ? -1 : 0;
        });
        if (raw.length > overFetch) raw = raw.slice(0, overFetch);
      }

      const filtered: DlqResponseEntry[] = [];
      for (const { row, agentId } of raw) {
        if (cursor) {
          if (
            row.lastSeenMs > cursor.beforeTs ||
            (row.lastSeenMs === cursor.beforeTs && row.eventId >= cursor.beforeId)
          ) {
            continue;
          }
        }
        const entry: DlqResponseEntry = {
          eventId: row.eventId,
          reason: row.rejectionReason,
          details: row.details,
          attemptCount: row.attemptCount,
          firstSeenMs: row.firstSeenMs,
          lastSeenMs: row.lastSeenMs,
        };
        filtered.push(agentId !== undefined ? { ...entry, agentId } : entry);
        if (filtered.length >= limit + 1) break;
      }

      const hasMore = filtered.length > limit;
      const page = hasMore ? filtered.slice(0, limit) : filtered;
      const tail = page[page.length - 1];
      const nextCursor =
        hasMore && tail
          ? encodeCursor({ beforeTs: tail.lastSeenMs, beforeId: tail.eventId })
          : null;

      const body: DlqResponse = { rejections: page, nextCursor };
      return jsonResponse(200, body, req.method);
    },
  };
}

// ── /dlq/drop + /dlq/requeue — mutation routes ─────────────────────────────
//
// Slice 6b of POST_ENTERPRISE_BACKLOG.md #50. The read side of `/dlq` ships
// in Slice 3 (see {@link dlqRoute}). This pair adds the destructive half
// so `declaragent fleet dlq drop/requeue` can act across hosts over HTTP
// instead of requiring a per-host control-socket hop.
//
// Design choices:
//   - Two dedicated exact-match paths (`/dlq/drop`, `/dlq/requeue`) rather
//     than a single `/dlq/:id` — matches the server's exact-path router
//     contract without introducing a per-route parser.
//   - POST method. DELETE would have been RESTfully nicer for drop, but
//     intermediaries (some reverse proxies, corporate CDNs) strip or
//     filter DELETE bodies; POST + JSON response is the lowest-friction
//     verb every operator's network accepts.
//   - Parameters land on the query string (`?kind=dispatch&id=<id>`) so
//     the route never has to parse a body — a malformed client can't
//     hang the handler.
//   - Return shape is `{ ok, op, eventId, attemptsBeforeOp? , reason? }`.
//     Clients render the successful path the same way they do for the
//     control-socket `dlq.requeue` op today, and the cross-host CLI
//     layer tags the response with a `host:` before printing.
//   - The host name is NOT baked into the route response — the route
//     doesn't know which FleetHost name the operator referred to it by
//     (one listener can be pointed at by multiple host entries). The
//     CLI that invoked the call tags the response on receive. This
//     matches how the read-side `/status` etc. already behave.

/**
 * JSON body served by `/dlq/drop` and `/dlq/requeue`. Shared between both
 * routes so cross-host callers can render either without special-casing.
 *
 * @since 0.7.6 — POST_ENTERPRISE_BACKLOG.md #50 Slice 6b
 */
export interface DlqMutationResponse {
  readonly ok: boolean;
  readonly op: 'drop' | 'requeue';
  readonly eventId: string;
  /**
   * Attempt count recorded on the DLQ row just before the mutation
   * landed. Absent when no row existed (drop of an already-absent id,
   * or requeue that hit `dlq-miss`). Useful for operator telemetry.
   */
  readonly attemptsBeforeOp?: number;
  /**
   * Typed failure reason when `ok === false`. Mirrors
   * {@link RequeueRejectionReason} plus `not-found` for the drop path.
   */
  readonly reason?: 'dlq-miss' | 'event-miss' | 'not-found';
  /** Free-form message for the operator. Never machine-parsed. */
  readonly message?: string;
}

/**
 * Hook the route fires exactly once per mutation attempt, success or
 * failure. The up-cli wires this to the shared `TenantAuditSink` so
 * every drop/requeue shows up in the hash-chained audit stream with
 * the invoking user + host context preserved.
 *
 * The hook runs AFTER the helper completes but BEFORE the HTTP response
 * is returned, so audit recording is part of the critical path — a
 * failed audit write surfaces as a 500 to the caller instead of a
 * silent gap in the audit trail.
 */
export type DlqMutationAuditHook = (
  record: Omit<DlqOperationAuditRecord, 'kind' | 'ts'> & { kind?: 'dlq_operation'; ts?: number },
) => Promise<void> | void;

export interface DlqDropRouteOptions {
  path?: string;
  /**
   * Called after the mutation completes (success OR failure). Omit to
   * skip auditing — the route still records the op in the SQLite ledger
   * (via `deleteRejection`), but no `dlq_operation` audit row is written.
   */
  onAudit?: DlqMutationAuditHook;
  /**
   * Override the tenant label on emitted audit records. Defaults to
   * `'system'` — matches how other admin-originated records (e.g. auth
   * checks) tag themselves when no channel context is available.
   */
  auditTenantId?: string;
}

/**
 * `POST /dlq/drop?kind=dispatch&id=<eventId>` — remove a dispatch-DLQ
 * row without re-publishing. The underlying `EventStore.deleteRejection`
 * is idempotent: a second call for the same id returns `ok: false` with
 * `reason: 'not-found'` (HTTP 404) so automation can distinguish a
 * fresh drop from a silent no-op.
 *
 * @since 0.7.6 — POST_ENTERPRISE_BACKLOG.md #50 Slice 6b
 */
export function dlqDropRoute(
  store: Pick<EventStore, 'getRejection' | 'deleteRejection'>,
  opts: DlqDropRouteOptions = {},
): ControlPlaneRoute {
  const path = opts.path ?? '/dlq/drop';
  const auditTenantId = opts.auditTenantId ?? 'system';
  return {
    path,
    async fetch(req) {
      if (req.method !== 'POST') {
        return new Response('method not allowed', {
          status: 405,
          headers: { Allow: 'POST' },
        });
      }
      const url = new URL(req.url);
      const q = url.searchParams;

      const kindRaw = q.get('kind');
      if (kindRaw !== null && kindRaw !== 'dispatch') {
        return jsonError(400, `unsupported kind "${kindRaw}"; supported: dispatch`);
      }
      const id = q.get('id');
      if (!id) {
        return jsonError(400, 'missing required query param "id"');
      }
      const initiator = resolveInitiator(req);

      // Peek the row first so the audit record can carry attempts-before-op
      // even when the delete succeeds. Two round-trips beats losing the
      // telemetry — the table is tiny in practice.
      let attemptsBeforeOp: number | undefined;
      try {
        const row = await store.getRejection(id);
        if (row) attemptsBeforeOp = row.attemptCount;
      } catch (err) {
        return jsonError(500, `event-store getRejection failed: ${errMsg(err)}`);
      }

      let removed: boolean;
      try {
        removed = await store.deleteRejection(id);
      } catch (err) {
        return jsonError(500, `event-store deleteRejection failed: ${errMsg(err)}`);
      }

      const body: DlqMutationResponse = removed
        ? {
            ok: true,
            op: 'drop',
            eventId: id,
            ...(attemptsBeforeOp !== undefined && { attemptsBeforeOp }),
            message: `dropped dispatch DLQ entry for "${id}"`,
          }
        : {
            ok: false,
            op: 'drop',
            eventId: id,
            reason: 'not-found',
            message: `no dispatch DLQ entry for "${id}"`,
          };

      if (opts.onAudit) {
        try {
          await opts.onAudit({
            tenantId: auditTenantId,
            op: 'drop',
            dlqKind: 'dispatch',
            eventId: id,
            ok: removed,
            ...(attemptsBeforeOp !== undefined && { attemptsBeforeOp }),
            initiator,
            ...(!removed && { reason: 'dlq-miss' as const }),
          });
        } catch (err) {
          return jsonError(500, `audit-sink record failed: ${errMsg(err)}`);
        }
      }

      return jsonResponse(removed ? 200 : 404, body, req.method);
    },
  };
}

export interface DlqRequeueRouteOptions {
  path?: string;
  onAudit?: DlqMutationAuditHook;
  auditTenantId?: string;
}

/**
 * `POST /dlq/requeue?kind=dispatch&id=<eventId>` — re-inject a rejected
 * event onto the live bus via {@link requeueDispatchDlq}. Mirrors the
 * semantics of the per-agent `dlq.requeue` control-socket op, just over
 * HTTP so cross-host callers don't need per-agent socket addressing.
 *
 * HTTP status mapping:
 *   - 200 on success.
 *   - 404 when the id isn't in the DLQ (`dlq-miss`) or the row is in the
 *     DLQ but the event body has been vacuumed (`event-miss`).
 *   - 500 on unexpected store / bus failures.
 *
 * @since 0.7.6 — POST_ENTERPRISE_BACKLOG.md #50 Slice 6b
 */
export function dlqRequeueRoute(
  deps: { store: EventStore; bus: EventBus },
  opts: DlqRequeueRouteOptions = {},
): ControlPlaneRoute {
  const path = opts.path ?? '/dlq/requeue';
  const auditTenantId = opts.auditTenantId ?? 'system';
  return {
    path,
    async fetch(req) {
      if (req.method !== 'POST') {
        return new Response('method not allowed', {
          status: 405,
          headers: { Allow: 'POST' },
        });
      }
      const url = new URL(req.url);
      const q = url.searchParams;

      const kindRaw = q.get('kind');
      if (kindRaw !== null && kindRaw !== 'dispatch') {
        return jsonError(400, `unsupported kind "${kindRaw}"; supported: dispatch`);
      }
      const id = q.get('id');
      if (!id) {
        return jsonError(400, 'missing required query param "id"');
      }
      const initiator = resolveInitiator(req);

      let result: RequeueResult;
      try {
        result = await requeueDispatchDlq({
          store: deps.store,
          bus: deps.bus,
          eventId: id,
        });
      } catch (err) {
        return jsonError(500, `requeue failed: ${errMsg(err)}`);
      }

      const body: DlqMutationResponse = result.ok
        ? {
            ok: true,
            op: 'requeue',
            eventId: result.eventId,
            attemptsBeforeOp: result.attemptsBeforeRequeue,
            message: `requeued dispatch DLQ entry for "${result.eventId}" (attempts before requeue: ${result.attemptsBeforeRequeue})`,
          }
        : {
            ok: false,
            op: 'requeue',
            eventId: result.eventId,
            reason: result.reason,
            message: result.message,
          };

      if (opts.onAudit) {
        try {
          await opts.onAudit({
            tenantId: auditTenantId,
            op: 'requeue',
            dlqKind: 'dispatch',
            eventId: id,
            ok: result.ok,
            ...(result.ok && { attemptsBeforeOp: result.attemptsBeforeRequeue }),
            ...(!result.ok && { reason: result.reason }),
            initiator,
          });
        } catch (err) {
          return jsonError(500, `audit-sink record failed: ${errMsg(err)}`);
        }
      }

      return jsonResponse(result.ok ? 200 : 404, body, req.method);
    },
  };
}

/**
 * Best-effort initiator extraction. The CLI path passes
 * `x-declaragent-initiator: <username>`; direct HTTP hits (curl, test
 * harnesses) land as `'api'` so the audit trail never records a forged
 * `"root"` just because nothing was supplied.
 */
function resolveInitiator(req: Request): string {
  const raw = req.headers.get('x-declaragent-initiator');
  if (raw && raw.length > 0 && raw.length <= 128) return raw;
  return 'api';
}

// ── /audit ─────────────────────────────────────────────────────────────────

/**
 * JSON body shape for `/audit` responses.
 *
 * @since 0.7.0-slice.1
 */
export interface AuditResponse {
  readonly entries: readonly AuditResponseEntry[];
  readonly nextCursor: string | null;
  /**
   * Populated only when the caller passed `?verify=1`. Omitted otherwise
   * so the common case doesn't pay the hash-walk cost. Absence does NOT
   * imply the chain is broken — it means verification wasn't requested.
   */
  readonly verify?: AuditVerifySummary;
}

export interface AuditResponseEntry {
  readonly seq: number;
  readonly kind: string;
  readonly ts: number;
  readonly tenantId: string;
  readonly prevHash: string;
  readonly recordHash: string;
  /** Full canonical record — matches `TenantAuditRecord`. */
  readonly record: unknown;
}

export interface AuditVerifySummary {
  readonly ok: boolean;
  readonly totalEntries: number;
  readonly verifiedEntries: number;
  readonly violationCount: number;
}

export interface AuditRouteOptions {
  path?: string;
  maxLimit?: number;
  defaultLimit?: number;
}

/**
 * `GET /audit` — paginated audit-chain read.
 *
 * Query params:
 *   - `tenant`   (optional) tenant scope.
 *   - `kind`     (optional) `TenantAuditRecordKind`; comma-separated for
 *     multiple.
 *   - `since`    (optional) ms-epoch or ISO-8601 on `ts`.
 *   - `until`    (optional) ms-epoch or ISO-8601 on `ts`.
 *   - `limit`    (optional).
 *   - `cursor`   (optional) opaque; encodes `beforeSeq`.
 *   - `verify`   (optional, `1`) — attach a chain-verify summary. Expensive
 *     for large chains; deferred by default.
 *
 * Rows are returned in ASC seq order (chain order). The cursor carries
 * the *highest* `seq` seen; the next call resumes from `seq > beforeSeq`.
 */
export function auditRoute(
  sink: Pick<TenantAuditSink, 'query' | 'verify'>,
  opts: AuditRouteOptions = {},
): ControlPlaneRoute {
  const path = opts.path ?? '/audit';
  const maxLimit = opts.maxLimit ?? 500;
  const defaultLimit = opts.defaultLimit ?? 200;
  return {
    path,
    async fetch(req) {
      const mna = assertGetOrHead(req);
      if (mna) return mna;

      const url = new URL(req.url);
      const q = url.searchParams;

      const limitOrErr = parseLimit(q.get('limit'), defaultLimit, maxLimit);
      if (typeof limitOrErr !== 'number') return jsonError(400, limitOrErr.error);
      const limit = limitOrErr;

      const sinceOrErr = parseSince(q.get('since'));
      if (sinceOrErr !== undefined && typeof sinceOrErr === 'object') {
        return jsonError(400, sinceOrErr.error);
      }
      const since = sinceOrErr;

      const untilOrErr = parseSince(q.get('until'));
      if (untilOrErr !== undefined && typeof untilOrErr === 'object') {
        return jsonError(400, untilOrErr.error);
      }
      const until = untilOrErr;

      const cursorRaw = q.get('cursor');
      let cursor: AuditCursor | undefined;
      if (cursorRaw !== null && cursorRaw !== '') {
        const decoded = decodeAuditCursor(cursorRaw);
        if ('error' in decoded) return jsonError(400, decoded.error);
        cursor = decoded;
      }

      const query: TenantAuditQuery = { order: 'asc' };
      const tenantRaw = q.get('tenant');
      if (tenantRaw !== null && tenantRaw !== '') query.tenantId = tenantRaw;
      const kindRaw = q.get('kind');
      if (kindRaw !== null && kindRaw !== '') {
        const kinds = kindRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (kinds.length === 0) return jsonError(400, 'kind must be non-empty');
        // TenantAuditRecordKind is a narrow union; we pass the strings
        // through and let the sink reject unknown ones rather than
        // rebuilding the kind allow-list here.
        query.kind = kinds as unknown as NonNullable<TenantAuditQuery['kind']>;
      }
      if (since !== undefined) query.sinceMs = since;
      if (until !== undefined) query.untilMs = until;
      const overFetch = cursor ? Math.max(limit * 2 + 1, 256) : limit + 1;
      query.limit = overFetch;

      let rows: Awaited<ReturnType<TenantAuditSink['query']>>;
      try {
        rows = await sink.query(query);
      } catch (err) {
        return jsonError(500, `audit sink query failed: ${errMsg(err)}`);
      }

      const filtered: AuditResponseEntry[] = [];
      for (const row of rows) {
        if (cursor && row.seq <= cursor.beforeSeq) continue;
        const rec = row.record as { ts?: number; tenantId?: string; sourceTenantId?: string };
        const tenantId = rec.tenantId ?? rec.sourceTenantId ?? '';
        filtered.push({
          seq: row.seq,
          kind: row.record.kind,
          ts: rec.ts ?? 0,
          tenantId,
          prevHash: row.prevHash,
          recordHash: row.recordHash,
          record: row.record,
        });
        if (filtered.length >= limit + 1) break;
      }

      const hasMore = filtered.length > limit;
      const page = hasMore ? filtered.slice(0, limit) : filtered;
      const tail = page[page.length - 1];
      const nextCursor = hasMore && tail ? encodeCursor({ beforeSeq: tail.seq }) : null;

      let verifySummary: AuditVerifySummary | undefined;
      if (q.get('verify') === '1') {
        try {
          const report = await sink.verify(query.tenantId);
          verifySummary = {
            ok: report.ok,
            totalEntries: report.totalEntries,
            verifiedEntries: report.verifiedEntries,
            violationCount: report.violations.length,
          };
        } catch (err) {
          return jsonError(500, `audit verify failed: ${errMsg(err)}`);
        }
      }

      const body: AuditResponse = { entries: page, nextCursor };
      if (verifySummary !== undefined) {
        (body as { verify?: AuditVerifySummary }).verify = verifySummary;
      }
      return jsonResponse(200, body, req.method);
    },
  };
}

// ── misc ───────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
