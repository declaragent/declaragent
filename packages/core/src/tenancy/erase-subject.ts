/**
 * WS8 — GDPR subject erasure across stores.
 *
 * The audit found erasure half-built: the audit sink could tombstone records by
 * platform user, but a subject's EVENTS (and other stores) had no deletion
 * path, so a "right to be forgotten" request couldn't actually be honored.
 * {@link eraseSubject} composes the per-store erase paths — audit (tombstone,
 * chain stays verifiable) + events (hard delete) — into one call that reports
 * what each store removed. The CLI `erase --user` verb wraps this over the
 * daemon's actual store handles.
 *
 * Stores are optional so a caller can erase only what it has open. Sessions +
 * long-term memory join here once they expose a subject-keyed delete.
 */

import { erasePlatformUser } from '../audit/erase.js';
import type { TenantAuditSink } from '../audit/types.js';
import type { EventStore } from '../events/store.js';

export interface EraseSubjectStores {
  /** Audit sink — records mentioning the subject are tombstoned (chain intact). */
  readonly auditSink?: TenantAuditSink;
  /** Event stores (one per agent) — the subject's event rows are hard-deleted. */
  readonly eventStores?: ReadonlyArray<Pick<EventStore, 'eraseByPlatformUser'>>;
}

export interface EraseSubjectResult {
  /** Audit records tombstoned. */
  readonly auditRecords: number;
  /** Event rows hard-deleted (summed across every supplied event store). */
  readonly events: number;
}

export async function eraseSubject(
  platformUserId: string,
  stores: EraseSubjectStores,
  opts: { reason?: string } = {},
): Promise<EraseSubjectResult> {
  const reason = opts.reason ?? 'gdpr-erasure';
  let auditRecords = 0;
  if (stores.auditSink) {
    auditRecords = await erasePlatformUser(stores.auditSink, { platformUserId, reason });
  }
  let events = 0;
  for (const store of stores.eventStores ?? []) {
    events += await store.eraseByPlatformUser(platformUserId);
  }
  return { auditRecords, events };
}
