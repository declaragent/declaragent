/**
 * Thrown when a caller attempts to cross a tenant boundary — e.g. publish
 * an event scoped to tenant A into tenant B's bus, look up tenant A's
 * session from tenant B's registry, or resolve a secret whose path prefix
 * belongs to a different tenant.
 *
 * Always an error. The unified audit sink (slice 5) additionally logs a
 * `tenant_boundary_violation` record for every throw so operators can
 * triage attempted escapes without grepping stack traces.
 */
export type TenantBoundaryResource = 'event' | 'session' | 'secret' | 'tool' | 'audit';

export interface TenantBoundaryErrorDetails {
  sourceTenantId: string;
  targetTenantId: string;
  resource: TenantBoundaryResource;
  /** E.g. an event id, a session id, a secret ref. */
  resourceId: string;
}

export class TenantBoundaryError extends Error {
  readonly code = 'TENANT_BOUNDARY';
  readonly sourceTenantId: string;
  readonly targetTenantId: string;
  readonly resource: TenantBoundaryResource;
  readonly resourceId: string;

  constructor(details: TenantBoundaryErrorDetails) {
    super(
      `tenant boundary violation: tenant ${details.sourceTenantId} attempted to access ${details.resource} "${details.resourceId}" owned by tenant ${details.targetTenantId}`,
    );
    this.name = 'TenantBoundaryError';
    this.sourceTenantId = details.sourceTenantId;
    this.targetTenantId = details.targetTenantId;
    this.resource = details.resource;
    this.resourceId = details.resourceId;
  }
}

export function isTenantBoundaryError(err: unknown): err is TenantBoundaryError {
  return err instanceof TenantBoundaryError;
}
