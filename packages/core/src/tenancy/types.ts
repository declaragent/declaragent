/**
 * Phase 6 — Multi-tenant isolation primitives.
 *
 * A `TenantContext` threads through every cross-cutting seam (event bus,
 * extension registry, session manager, secret resolver, audit log) so that
 * cross-tenant access is a compile-time + runtime error, not a convention.
 *
 * For single-tenant deployments (every Phase-1-through-5 caller), the
 * runtime defaults to {@link DEFAULT_TENANT_ID} via {@link DEFAULT_TENANT_CONTEXT};
 * Phase 6's additions are pure extensions.
 */

/**
 * Stable sentinel id for the implicit tenant used when no `tenants.yaml`
 * is configured. Pre-existing session rows, audit records, and event
 * `meta.tenantId` values migrate to this prefix on first run.
 */
export const DEFAULT_TENANT_ID = '__default__';

/**
 * Residency hint that steers session/event storage to a regional backend.
 *
 * @since 1.0.0
 */
export type TenantResidency = 'us' | 'eu' | 'apac' | 'custom';

/**
 * Per-tenant quota knobs enforced by the runtime. Quota breaches surface
 * as typed errors and land in the audit log with `reason: 'quota-exceeded'`.
 *
 * @since 1.0.0
 */
export interface TenantQuotas {
  maxActiveSessions?: number;
  /** Mirrors `spec.deployment.budget.dailyTokenUSD`. */
  dailyTokenUSD?: number;
  maxConcurrentToolCalls?: number;
  maxEventIngressPerSec?: number;
}

/**
 * Identifies the tenant a given request, event, session, or tool-call
 * belongs to. Immutable per runtime — a config reload constructs a fresh
 * context and swaps the live runtime atomically.
 *
 * @since 1.0.0
 */
export interface TenantContext {
  /** Stable identifier, e.g. `"acme-prod"`. Matches `${tenant}` in secret refs. */
  readonly id: string;
  /** Optional human-readable display name. */
  readonly displayName?: string;
  /** Opaque labels usable for routing + audit retention policy. */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Residency hint for session/event storage. The daemon picks a
   * storage backend per residency; mis-residency is a fail-fast error.
   */
  readonly residency?: TenantResidency;
  /**
   * Audit retention in days. Defaults to the global
   * `spec.observability.auditRetentionDays` when omitted; the tenant-level
   * override wins when set.
   */
  readonly auditRetentionDays?: number;
  /** Per-tenant quota knobs. */
  readonly quotas?: TenantQuotas;
}

/**
 * Default tenant — used when no `tenants.yaml` is configured and no
 * explicit `TenantContext` is wired through the dep bag. Every Phase-1
 * -through-5 behavior is preserved bit-for-bit under this default.
 *
 * Frozen so downstream code can rely on reference-equality checks
 * (`ctx === DEFAULT_TENANT_CONTEXT`) to detect "am I in single-tenant mode".
 */
export const DEFAULT_TENANT_CONTEXT: TenantContext = Object.freeze({
  id: DEFAULT_TENANT_ID,
  displayName: 'Default tenant',
});

/** True when `ctx` represents the implicit single-tenant default. */
export function isDefaultTenant(ctx: TenantContext | undefined): boolean {
  return ctx === undefined || ctx.id === DEFAULT_TENANT_ID;
}

/**
 * Resolve a `TenantContext` from an optional input — used by dep-bag
 * consumers that want to "just get the tenant id" without branching.
 *
 * Returns {@link DEFAULT_TENANT_CONTEXT} when the input is `undefined`.
 */
export function resolveTenant(ctx: TenantContext | undefined): TenantContext {
  return ctx ?? DEFAULT_TENANT_CONTEXT;
}
