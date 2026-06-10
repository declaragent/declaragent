/**
 * Boot-time recovery of events interrupted mid-dispatch (WS5).
 *
 * When the daemon is SIGKILLed (OOM, `kill -9`, routine redeploy without a
 * drain) while an engine turn is in flight, the event's row in the store is
 * left with no outcome (`outcome = NULL`, "pending"). Before this, that row sat
 * there forever — the event was silently lost, and because dedup conflated
 * "recorded" with "processed", the source's redelivery (Kafka redrive, webhook
 * retry with an idempotency key) was swallowed as a duplicate. The customer's
 * request just vanished.
 *
 * {@link recoverPendingEvents} runs once at boot, BEFORE sources start binding,
 * and for each pending event:
 *
 *   1. Marks the original row terminal (`rejected/interrupted`) so a *second*
 *      restart will not recover it again — recovery is idempotent across
 *      restarts (the plan's "recovers exactly once" property).
 *   2. Re-dispatches a clone with a FRESH id (+ `meta.causedBy` lineage,
 *      application idempotency key dropped) so the dispatcher actually routes
 *      it instead of rejecting it as a duplicate of the pending original.
 *
 * Delivery semantics: at-least-once. A crash in the tiny window between the
 * mark and the publish loses that single event; a crash after publish but
 * before the clone reaches a terminal outcome leaves the CLONE pending, which
 * the next boot recovers in turn. Non-idempotent skills can therefore run
 * twice across a crash — document idempotency keys for exactly-once side
 * effects. (See DELIVERY_SEMANTICS.)
 */

import { randomUUID } from 'node:crypto';
import type { EventStore, EventStoreRecord } from './store.js';
import type { AgentEvent } from './types.js';

export interface RecoverPendingOptions {
  readonly store: EventStore;
  /** Re-dispatch sink — typically `bus.publish`. */
  readonly publish: (event: AgentEvent) => Promise<void> | void;
  /**
   * Pre-fetched pending rows to recover. When provided, the store is NOT
   * queried — the caller is responsible for snapshotting `list({outcomeKind:
   * 'pending'})` BEFORE the dispatcher subscription goes live, which avoids a
   * race where a freshly-arrived event is momentarily pending and gets
   * double-dispatched. When omitted, the helper queries the store itself
   * (fine for tests / offline admin flows where no dispatcher is live).
   */
  readonly events?: readonly EventStoreRecord[];
  /** Fresh-id generator seam (tests). Defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Clock seam (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Safety cap on how many pending rows to recover in one boot. Default 1000. */
  readonly limit?: number;
  /** Optional structured logger. */
  readonly logger?: {
    warn(event: string, data?: Record<string, unknown>): void;
    info?(event: string, data?: Record<string, unknown>): void;
  };
}

export interface RecoverPendingResult {
  readonly recovered: number;
  readonly entries: ReadonlyArray<{ originalId: string; newEventId: string }>;
}

/**
 * Recover every pending (interrupted) event in the store by re-dispatching a
 * fresh-id clone. Returns a summary. Safe to call when there are none (returns
 * `{ recovered: 0 }`). Errors recovering one event are logged and skipped — one
 * poison row never blocks the rest of the recovery sweep.
 */
export async function recoverPendingEvents(
  opts: RecoverPendingOptions,
): Promise<RecoverPendingResult> {
  const limit = opts.limit ?? 1000;
  const pending = opts.events ?? (await opts.store.list({ outcomeKind: 'pending', limit }));
  if (pending.length === 0) return { recovered: 0, entries: [] };

  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? Date.now;
  const entries: Array<{ originalId: string; newEventId: string }> = [];

  for (const rec of pending) {
    const original = rec.event;
    const cloneId = newId();
    try {
      // Drop the application idempotency key so the clone isn't deduped against
      // the original row via findDuplicate's (key, source) path.
      const { idempotencyKey: _drop, ...metaRest } = original.meta ?? {};
      const clone: AgentEvent = {
        ...original,
        id: cloneId,
        timestamp: now(),
        meta: {
          ...metaRest,
          causedBy: original.id,
          correlationId: original.meta?.correlationId ?? original.id,
        },
      };
      // Mark the original terminal FIRST → a second restart won't re-recover it.
      await opts.store.markOutcome(original.id, {
        kind: 'rejected',
        reason: 'interrupted',
        details: `interrupted mid-dispatch; recovered at boot as ${cloneId}`,
      });
      await opts.publish(clone);
      entries.push({ originalId: original.id, newEventId: cloneId });
    } catch (err) {
      opts.logger?.warn('event.recovery.error', {
        eventId: original.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (entries.length > 0) {
    opts.logger?.warn('event.recovery.recovered', {
      count: entries.length,
      ...(pending.length > entries.length && { failed: pending.length - entries.length }),
    });
  }
  return { recovered: entries.length, entries };
}
