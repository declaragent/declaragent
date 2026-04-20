/**
 * Phase 6 slice-3 — secret provider contracts.
 *
 * The Phase-4 `SecretResolver` shipped with an opaque `secretHandler?: (path)
 * => Promise<string>` hook. Slice 3 formalizes that hook into a typed
 * {@link SecretProvider} interface + ships four concrete implementations
 * (Vault, AWS Secrets Manager, GCP Secret Manager, Kubernetes Secrets).
 *
 * Every resolve produces a {@link SecretAccessAuditRecord}; slice 5 folds
 * that record type into the unified audit sink.
 */

import type { TenantContext } from '../tenancy/types.js';

/** Stable label for diagnostics and audit records. */
export type SecretProviderType = 'vault' | 'aws-sm' | 'gcp-sm' | 'k8s' | 'env';

/**
 * Context handed to every `SecretProvider.resolve()` call. Providers
 * enforce tenant-scoped path prefixes — slice 6's multi-tenant mode
 * throws `TenantBoundaryError` when a resolve escapes the tenant's
 * scope.
 */
export interface SecretResolveContext {
  readonly tenant: TenantContext;
  /** Actor requesting the secret — session id, skill name, adapter id. */
  readonly requester: string;
}

/**
 * Per-secret metadata returned without the secret value. The rotation
 * monitor reads this to detect stale secrets.
 */
export interface SecretMetadata {
  /** ms-epoch of the last rotation, when the provider knows it. */
  lastRotatedAt?: number;
  /** Provider-specific version identifier. */
  version?: string;
  /** Suggested cache TTL from the provider (e.g. Vault lease duration). */
  ttlMs?: number;
}

export interface SecretProvider {
  readonly type: SecretProviderType;
  /** Stable instance name for diagnostics (e.g. `"vault-prod"`). */
  readonly name: string;
  /**
   * Resolve `path` to the secret's raw value. `path` is the portion
   * AFTER the type prefix — the resolver strips `vault:` / `aws-sm:` /
   * etc. before calling.
   */
  resolve(path: string, ctx: SecretResolveContext): Promise<string>;
  /**
   * Return metadata without the value. Used by the rotation monitor.
   * Optional because some providers (e.g. a static env-backed provider)
   * don't track rotation.
   */
  metadata?(path: string, ctx: SecretResolveContext): Promise<SecretMetadata>;
  /** Graceful shutdown hook — close token leases, release clients, etc. */
  close?(): Promise<void>;
}

/**
 * Audit record emitted for every secret access. The value is NEVER
 * persisted — only the ref, the outcome, and optional error surface.
 */
export interface SecretAccessAuditRecord {
  kind: 'secret_access';
  ts: number;
  tenantId: string;
  ref: string;
  requester: string;
  outcome: 'resolved' | 'denied' | 'error';
  providerType?: SecretProviderType;
  providerName?: string;
  error?: { message: string; code?: string };
}

/**
 * Sink for {@link SecretAccessAuditRecord}s. Slice 5 unifies this into
 * `TenantAuditSink`; slice 3 keeps it narrow so the secret resolver
 * stays self-contained.
 */
export interface SecretAuditSink {
  record(record: SecretAccessAuditRecord): void | Promise<void>;
}
