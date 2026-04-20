import type { AgentEvent } from '../events/types.js';
import type { TenantContext } from './types.js';

/**
 * Fill `event.meta.tenantId` with `tenant.id` when the field is absent,
 * otherwise return the event untouched. Preserves an explicitly-set
 * `tenantId` — Phase-6 slice 6 introduces the bus-level enforcement that
 * rejects mismatches; slice 1 only handles the default case.
 *
 * Returns a shallow copy when the field is filled in — existing
 * references to `event` remain unchanged (events are treated as
 * immutable values throughout the codebase).
 */
export function stampTenantId(event: AgentEvent, tenant: TenantContext | undefined): AgentEvent {
  if (!tenant) return event;
  if (event.meta?.tenantId !== undefined) return event;
  return {
    ...event,
    meta: { ...event.meta, tenantId: tenant.id },
  };
}
