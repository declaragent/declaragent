import { TenantBoundaryError } from '../tenancy/boundary-error.js';
import type { Logger } from '../types/logger.js';
import type {
  AgentEvent,
  BusPressureListener,
  EventBus,
  EventHandler,
  EventKind,
  EventKindFilter,
} from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

export const DEFAULT_RECENT_BUFFER_SIZE = 1000;

export interface CreateEventBusOptions {
  logger?: Logger;
  /** Max events retained by `recent()`. Defaults to 1000. Oldest are evicted first. */
  recentBufferSize?: number;
  /**
   * Phase 6 slice-6 addition. When set, the bus only accepts publishes
   * whose `event.meta.tenantId` matches this value (or is unset — in
   * which case the scope is stamped before fan-out). Cross-tenant
   * publishes throw {@link TenantBoundaryError}, which the daemon
   * routes to the audit sink as a `tenant_boundary_violation` record.
   *
   * Used by `per-tenant` mode (one bus per tenant) and by
   * `shared-with-filter` subscribers that need the scope surface to
   * derive their filter.
   */
  tenantScope?: string;
  /**
   * When `tenantScope` is set, subscribers only receive events whose
   * `meta.tenantId` matches. Defaults to true; set false only for
   * observability-style taps that want every cross-tenant event
   * (e.g. a central audit aggregator).
   */
  filterSubscribersByTenant?: boolean;
}

export function createEventBus(options: CreateEventBusOptions = {}): EventBus {
  const logger = options.logger ?? NOOP_LOGGER;
  const bufferSize = Math.max(1, options.recentBufferSize ?? DEFAULT_RECENT_BUFFER_SIZE);
  const tenantScope = options.tenantScope;
  const filterSubs = options.filterSubscribersByTenant ?? true;

  function enforceTenantScope(event: AgentEvent): AgentEvent {
    if (!tenantScope) return event;
    const eventTenantId = event.meta?.tenantId;
    if (eventTenantId !== undefined && eventTenantId !== tenantScope) {
      throw new TenantBoundaryError({
        sourceTenantId: eventTenantId,
        targetTenantId: tenantScope,
        resource: 'event',
        resourceId: event.id,
      });
    }
    // Stamp the scope when the event arrived without a tenantId — this
    // is the "default-tenant single bus" back-compat path.
    if (eventTenantId === undefined) {
      return {
        ...event,
        meta: { ...event.meta, tenantId: tenantScope },
      };
    }
    return event;
  }

  function passesTenantFilter(event: AgentEvent): boolean {
    if (!tenantScope || !filterSubs) return true;
    const tid = event.meta?.tenantId;
    return tid === undefined || tid === tenantScope;
  }

  const subsByKind = new Map<EventKind, EventHandler[]>();
  const wildcardSubs: EventHandler[] = [];
  const buffer: AgentEvent[] = [];
  const inFlight = new Set<Promise<unknown>>();

  /**
   * Edge-triggered pressure listeners. Each listener tracks its own
   * "is currently over the high watermark?" bit locally; we compare the
   * bit against the current count on every publish start + finish and
   * fire exactly once per crossing.
   */
  interface LiveListener {
    spec: BusPressureListener;
    over: boolean;
  }
  const pressureListeners = new Set<LiveListener>();

  function emitPressureCrossings(): void {
    const count = inFlight.size;
    for (const lp of pressureListeners) {
      if (!lp.over && count >= lp.spec.highWatermark) {
        lp.over = true;
        try {
          lp.spec.onHigh(count);
        } catch (err) {
          logger.warn('event.pressure.listener.error', { phase: 'onHigh', err: String(err) });
        }
      } else if (lp.over && count <= lp.spec.lowWatermark) {
        lp.over = false;
        try {
          lp.spec.onLow(count);
        } catch (err) {
          logger.warn('event.pressure.listener.error', { phase: 'onLow', err: String(err) });
        }
      }
    }
  }

  function pushRecent(event: AgentEvent): void {
    buffer.push(event);
    if (buffer.length > bufferSize) {
      // Drop oldest. `shift` is O(n) but n is small and bounded; the
      // simplicity is worth more than a ring-index here.
      buffer.shift();
    }
  }

  function handlersFor(kind: EventKind): EventHandler[] {
    // Snapshot so mid-publish subscribe/unsubscribe doesn't mutate the
    // array we're iterating over.
    const kindSubs = subsByKind.get(kind);
    if (kindSubs && kindSubs.length > 0 && wildcardSubs.length > 0) {
      return [...kindSubs, ...wildcardSubs];
    }
    if (kindSubs && kindSubs.length > 0) return [...kindSubs];
    if (wildcardSubs.length > 0) return [...wildcardSubs];
    return [];
  }

  return {
    async publish(input: AgentEvent): Promise<void> {
      const event = enforceTenantScope(input);
      pushRecent(event);
      if (!passesTenantFilter(event)) return;
      const handlers = handlersFor(event.kind);
      if (handlers.length === 0) return;

      // Invoke handlers in parallel. `Promise.allSettled` so one slow or
      // throwing subscriber does not block or abort the others.
      const settlements = handlers.map((h) => Promise.resolve().then(() => h(event)));
      const combined = Promise.allSettled(settlements);
      inFlight.add(combined);
      emitPressureCrossings();
      try {
        const results = await combined;
        for (const [idx, r] of results.entries()) {
          if (r.status === 'rejected') {
            logger.warn('event.subscriber.error', {
              eventId: event.id,
              kind: event.kind,
              handlerIndex: idx,
              err: String(r.reason),
            });
          }
        }
      } finally {
        inFlight.delete(combined);
        emitPressureCrossings();
      }
    },

    subscribe(kind: EventKindFilter, handler: EventHandler): () => void {
      if (kind === '*') {
        wildcardSubs.push(handler);
        return () => {
          const idx = wildcardSubs.indexOf(handler);
          if (idx !== -1) wildcardSubs.splice(idx, 1);
        };
      }
      const arr = subsByKind.get(kind) ?? [];
      arr.push(handler);
      subsByKind.set(kind, arr);
      return () => {
        const cur = subsByKind.get(kind);
        if (!cur) return;
        const idx = cur.indexOf(handler);
        if (idx !== -1) cur.splice(idx, 1);
      };
    },

    recent(filter?: (e: AgentEvent) => boolean): readonly AgentEvent[] {
      if (!filter) return [...buffer];
      return buffer.filter(filter);
    },

    async drained(): Promise<void> {
      // Snapshot so a publish that starts during the await doesn't
      // extend this drain indefinitely. Graceful shutdown should pause
      // sources first (§6 step 1) before calling drained().
      while (inFlight.size > 0) {
        const snapshot = [...inFlight];
        await Promise.allSettled(snapshot);
      }
    },

    registerPressureListener(spec: BusPressureListener): () => void {
      if (spec.lowWatermark > spec.highWatermark) {
        throw new Error(
          `bus.registerPressureListener: lowWatermark (${spec.lowWatermark}) must be <= highWatermark (${spec.highWatermark})`,
        );
      }
      if (spec.highWatermark < 1) {
        throw new Error('bus.registerPressureListener: highWatermark must be >= 1');
      }
      const entry: LiveListener = {
        spec,
        over: inFlight.size >= spec.highWatermark,
      };
      pressureListeners.add(entry);
      return () => {
        pressureListeners.delete(entry);
      };
    },

    inflightCount(): number {
      return inFlight.size;
    },
  };
}
