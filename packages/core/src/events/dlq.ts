/**
 * Dispatch DLQ requeue helper.
 *
 * The DLQ state (slice 5 / PR 5.1) lives in the `rejected_events` table;
 * the `EventStore.deleteRejection` + `listRejections` surface is read-
 * only from the dispatcher's perspective. Active requeue — re-injecting
 * a rejected event back onto the live bus — needs to be triggered from
 * inside the `up` process (the only place the bus is in-memory and the
 * dispatcher is wired). The control socket (§3 item #6 of the Enterprise
 * Production Plan) exposes `dlq.requeue <id>` as a socket op; this helper
 * is the one-line impl that op calls.
 *
 * Semantics:
 *   1. Look up the rejection row. If absent → `dlq-miss` error.
 *   2. Look up the original event row from `events`. If absent → `event-miss`.
 *   3. Re-dispatch a clone of the event with a FRESH id (+ `meta.causedBy`
 *      lineage, application idempotency key dropped) so the dispatcher routes
 *      it instead of rejecting it as a duplicate. Uses the `dispatch` hook when
 *      supplied (real outcome returned) else `bus.publish` (async outcome).
 *   4. Delete the rejection row on success so the DLQ only reflects events
 *      currently stuck. The original event row (+ its outcome history) stays in
 *      `events` unchanged — the rejection is still the historical truth.
 *
 * Idempotence: the second call for the same id (after the first has already
 * deleted the rejection row) returns `{ ok: false, reason: 'dlq-miss' }`.
 *
 * @since 0.6.x
 * @since 0.7.6 — fresh-id re-dispatch (WS5); previously re-published the same
 *   id, which dedup rejected before routing (a silent no-op).
 */

import { randomUUID } from 'node:crypto';
import type { EventStore } from './store.js';
import type { AgentEvent, DispatchOutcome, EventBus } from './types.js';

export type RequeueRejectionReason =
  /** The event id was never in the rejected_events table, or already requeued. */
  | 'dlq-miss'
  /** The event id was in the DLQ but the full event row has been vacuumed. */
  | 'event-miss';

export interface RequeueResultOk {
  readonly ok: true;
  /** The original DLQ event id that was requeued. */
  readonly eventId: string;
  /**
   * The fresh event id assigned to the re-dispatched event. The requeued event
   * carries `meta.causedBy = eventId` for lineage. Operators trace the outcome
   * on this id (`events show <newEventId>`); the original DLQ row's historical
   * outcome is left untouched.
   *
   * @since 0.7.6 — production-readiness WS5 (requeue was a no-op when it
   *   re-published the same id, which dedup rejected before routing).
   */
  readonly newEventId: string;
  readonly attemptsBeforeRequeue: number;
  /**
   * The real dispatch outcome — present only when a `dispatch` function was
   * supplied (the daemon path). Absent for the fire-and-forget `bus.publish`
   * fallback, where the outcome lands asynchronously on `newEventId`'s row.
   */
  readonly outcome?: DispatchOutcome;
}

export interface RequeueResultErr {
  readonly ok: false;
  readonly eventId: string;
  readonly reason: RequeueRejectionReason;
  /** Free-form clarifier for the caller / CLI renderer. */
  readonly message: string;
}

export type RequeueResult = RequeueResultOk | RequeueResultErr;

export interface RequeueOptions {
  readonly store: EventStore;
  readonly bus: EventBus;
  /** The DLQ event id to requeue. */
  readonly eventId: string;
  /**
   * Dispatch-and-await hook (the dispatcher's `handle`). When supplied, the
   * requeued event is dispatched directly so the real {@link DispatchOutcome}
   * is returned synchronously. When omitted, falls back to fire-and-forget
   * `bus.publish` (the outcome lands asynchronously on the new event id).
   */
  readonly dispatch?: (event: AgentEvent) => Promise<DispatchOutcome>;
  /** Fresh-id generator seam (tests). Defaults to `crypto.randomUUID()`. */
  readonly newId?: () => string;
  /** Clock seam (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Requeue a single rejected event back onto the bus.
 *
 * Call flow:
 *   store.getRejection   — find the DLQ ledger row
 *   store.get            — find the original event body
 *   dispatch / bus.publish — re-dispatch with a FRESH id
 *   store.deleteRejection — acknowledge the DLQ row
 *
 * ## Why a fresh id
 *
 * The original implementation re-published the *same* event id, which the
 * dispatcher's idempotency check (in-memory cache + `store.findDuplicate`)
 * rejected as a `duplicate` BEFORE routing — so requeue executed nothing while
 * reporting success and deleting the DLQ row (a silent no-op). A requeue is a
 * deliberate operator "run this again", so we mint a fresh event id, drop the
 * application idempotency key (which would otherwise dedup against the
 * original via the `(key, source)` path), and stamp `meta.causedBy` with the
 * original id for lineage. The fresh event therefore actually routes.
 *
 * The `deleteRejection` happens AFTER the (re)dispatch so a throw doesn't leave
 * the DLQ empty with no requeue done. If the re-dispatch rejects again, the
 * dispatcher's `upsertRejection` path inserts a new DLQ row keyed on the fresh
 * id — the original row is gone (acknowledged), which is the intended ledger
 * behavior (the DLQ reflects events currently stuck, by their live id).
 */
export async function requeue(opts: RequeueOptions): Promise<RequeueResult> {
  const { store, bus, eventId } = opts;

  const rejection = await store.getRejection(eventId);
  if (!rejection) {
    return {
      ok: false,
      eventId,
      reason: 'dlq-miss',
      message: `no dispatch DLQ entry for "${eventId}" — already requeued or never rejected`,
    };
  }

  const record = await store.get(eventId);
  if (!record) {
    return {
      ok: false,
      eventId,
      reason: 'event-miss',
      message: `event "${eventId}" is in the DLQ but its body is no longer in the events table (vacuumed?)`,
    };
  }

  // Clone with a fresh id + lineage. Build meta explicitly so the application
  // idempotency key is omitted (not carried), which would otherwise dedup the
  // re-run against the original via `findDuplicate`'s (key, source) path.
  const newEventId = (opts.newId ?? randomUUID)();
  const now = (opts.now ?? Date.now)();
  const original = record.event;
  const { idempotencyKey: _drop, ...metaRest } = original.meta ?? {};
  const requeued: AgentEvent = {
    ...original,
    id: newEventId,
    timestamp: now,
    meta: {
      ...metaRest,
      causedBy: original.id,
      correlationId: original.meta?.correlationId ?? original.id,
    },
  };

  // Prefer a dispatch-and-await hook so we can return the real outcome; fall
  // back to fire-and-forget publish (outcome lands async on `newEventId`).
  let outcome: DispatchOutcome | undefined;
  if (opts.dispatch) {
    outcome = await opts.dispatch(requeued);
  } else {
    await bus.publish(requeued);
  }

  await store.deleteRejection(eventId);

  return {
    ok: true,
    eventId,
    newEventId,
    attemptsBeforeRequeue: rejection.attemptCount,
    ...(outcome !== undefined && { outcome }),
  };
}
