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
 *   3. Publish a cloned event onto `bus.publish()` — the dispatcher's
 *      bus subscriber picks it up exactly like a fresh arrival.
 *   4. Delete the rejection row on success so the DLQ only reflects
 *      events currently stuck. The original event row (+ its outcome
 *      history) stays in `events` unchanged — the rejection is still
 *      the historical truth.
 *
 * Idempotence: the second call for the same id (after the first has
 * already deleted the rejection row) returns `{ ok: false, reason:
 * 'dlq-miss' }`. Never a silent duplicate-publish.
 *
 * @since 0.6.x
 */

import type { EventStore } from './store.js';
import type { EventBus } from './types.js';

export type RequeueRejectionReason =
  /** The event id was never in the rejected_events table, or already requeued. */
  | 'dlq-miss'
  /** The event id was in the DLQ but the full event row has been vacuumed. */
  | 'event-miss';

export interface RequeueResultOk {
  readonly ok: true;
  readonly eventId: string;
  readonly attemptsBeforeRequeue: number;
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
}

/**
 * Requeue a single rejected event back onto the bus.
 *
 * Call flow:
 *   store.getRejection   — find the DLQ ledger row
 *   store.get            — find the original event body
 *   bus.publish          — re-dispatch (dispatcher records a fresh outcome)
 *   store.deleteRejection — acknowledge the DLQ row
 *
 * The deleteRejection happens AFTER the publish so a publish-throw doesn't
 * leave the DLQ empty with no requeue done. If the publish itself succeeds
 * but the new dispatch rejects again, the dispatcher's `upsertRejection`
 * path re-inserts the row (with attempt_count bumped), which is the
 * intended retry-ledger behavior.
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

  // Re-publish onto the live bus. We intentionally publish the *same*
  // event id so the dispatcher's idempotency cache sees this as a retry
  // (not a fresh event). The outcome row on `events` will be overwritten
  // by the new dispatch attempt's outcome.
  await bus.publish(record.event);

  // Delete the DLQ ledger row only after publish succeeds. If the
  // re-dispatch rejects again, the dispatcher's own upsertRejection
  // path will re-insert with attempt_count bumped.
  await store.deleteRejection(eventId);

  return {
    ok: true,
    eventId,
    attemptsBeforeRequeue: rejection.attemptCount,
  };
}
