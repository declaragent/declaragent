/**
 * Phase 6 slice-6 `TenantRuntime` assembler.
 *
 * Binds together the per-tenant pieces the daemon needs:
 *   - `TenantContext`      — identity + quotas + residency
 *   - `EventBus`           — tenant-scoped or filtered view
 *   - `ExtensionRegistryView` — read-only registry filtered by scope
 *   - `QuotaTracker`       — in-memory counters + breach emission
 *   - `TenantAuditSink` handle (optional)
 *
 * Single-tenant deployments (no `tenants.yaml`) assemble a runtime from
 * {@link DEFAULT_TENANT_CONTEXT} via {@link createDefaultTenantRuntime},
 * which preserves Phase-1-through-5 behaviour exactly.
 */

import type { TenantAuditSink } from '../audit/types.js';
import { createEventBus } from '../events/bus.js';
import type { EventBus } from '../events/types.js';
import type { ExtensionRegistry } from '../extension/types.js';
import type { PrometheusRegistry } from '../observability/prometheus.js';
import type { Logger } from '../types/logger.js';
import type { ExtensionScope } from './config-loader.js';
import { type ExtensionRegistryView, scopeRegistry } from './extension-view.js';
import { type QuotaTracker, createQuotaTracker } from './quota.js';
import { DEFAULT_TENANT_CONTEXT, type TenantContext } from './types.js';

/** Live per-tenant runtime — constructed by {@link createTenantRuntime}. */
export interface TenantRuntime {
  readonly tenant: TenantContext;
  readonly bus: EventBus;
  readonly registry: ExtensionRegistryView;
  readonly quotas: QuotaTracker;
  /** Optional — only set when the daemon wires a sink. */
  readonly audit?: Pick<TenantAuditSink, 'record'>;
  /**
   * Phase 7 slice 0.4 — per-tenant Prometheus registry. Pre-stamped with
   * `constLabels: { tenant_id }` so every sample written through
   * `deps.metrics` carries the tenant label without the adapter having
   * to opt in. Absent when the daemon is in single-tenant mode or when
   * a shared registry is configured.
   */
  readonly metrics?: PrometheusRegistry;
  /** Graceful shutdown — releases resources held by this tenant only. */
  close(): Promise<void>;
}

export interface CreateTenantRuntimeOptions {
  tenant: TenantContext;
  /** Global extension registry; scoped to the tenant via {@link extensionScope}. */
  registry: ExtensionRegistry;
  /** Allow / deny lists for this tenant's extension lookups. */
  extensionScope?: ExtensionScope;
  /** Audit sink fed by the quota tracker. Optional. */
  audit?: Pick<TenantAuditSink, 'record'>;
  logger?: Logger;
  /** Clock override. */
  now?: () => number;
  /**
   * Bus strategy. `per-tenant` (default) — each runtime gets its own
   * `EventBus`; `shared` — the caller supplies one bus bound to
   * `filterSubscribersByTenant: true` and every runtime shares it.
   */
  sharedBus?: EventBus;
  /**
   * Phase 7 slice 0.4 — pre-built Prometheus registry surfaced on
   * {@link TenantRuntime.metrics}. The daemon auto-constructs one per
   * tenant with `constLabels: { tenant_id: tenant.id }` when it loads a
   * multi-tenant config; single-tenant callers can leave it unset.
   */
  metrics?: PrometheusRegistry;
}

/**
 * Build a `TenantRuntime`. When `sharedBus` is omitted, a fresh
 * `EventBus` is created with `tenantScope = tenant.id` so every
 * publish is validated. When `sharedBus` is provided, the runtime
 * reuses it — in that case the caller is responsible for wiring
 * `filterSubscribersByTenant` correctly.
 */
export function createTenantRuntime(options: CreateTenantRuntimeOptions): TenantRuntime {
  const { tenant, registry } = options;

  const bus: EventBus =
    options.sharedBus ??
    createEventBus({
      tenantScope: tenant.id,
      ...(options.logger !== undefined && { logger: options.logger }),
    });

  const view = scopeRegistry(registry, options.extensionScope);

  const quotas = createQuotaTracker({
    tenant,
    ...(options.audit !== undefined && { audit: options.audit }),
    ...(options.now !== undefined && { now: options.now }),
  });

  async function close(): Promise<void> {
    // Per-tenant bus has no explicit close; shared bus is owned by the
    // caller. Reserve the hook for future slice-7 chaos wiring that may
    // need to tear down quota/audit handles.
  }

  return {
    tenant,
    bus,
    registry: view,
    quotas,
    ...(options.audit !== undefined && { audit: options.audit }),
    ...(options.metrics !== undefined && { metrics: options.metrics }),
    close,
  };
}

/**
 * Convenience: build a runtime for the implicit default tenant. Every
 * Phase-1-through-5 caller uses this shape.
 */
export function createDefaultTenantRuntime(options: {
  registry: ExtensionRegistry;
  audit?: Pick<TenantAuditSink, 'record'>;
  logger?: Logger;
}): TenantRuntime {
  return createTenantRuntime({
    tenant: DEFAULT_TENANT_CONTEXT,
    registry: options.registry,
    ...(options.audit !== undefined && { audit: options.audit }),
    ...(options.logger !== undefined && { logger: options.logger }),
  });
}
