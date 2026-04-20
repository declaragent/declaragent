/**
 * Default `SecretResolver` implementation.
 *
 * Understands the following reference schemes:
 *
 *   env:VAR          → `process.env[VAR]`
 *   file:/abs/path   → `readFileSync(path, 'utf-8').trim()`
 *   secret:path      → default {@link SecretProvider} (when configured)
 *   vault:path       → {@link SecretProvider} of type `"vault"`
 *   aws-sm:path      → {@link SecretProvider} of type `"aws-sm"`
 *   gcp-sm:path      → {@link SecretProvider} of type `"gcp-sm"`
 *   k8s:path         → {@link SecretProvider} of type `"k8s"`
 *
 * The resolver also walks a `ConfiguredSource` (or any JSON value) and
 * substitutes `${env:VAR}` / `${file:/path}` / `${vault:...}` placeholders
 * inside string fields. That makes it safe for YAML configs to embed
 * secrets as references without leaking them to disk.
 *
 * Placeholders are scanned non-greedily so a single string can contain
 * multiple refs:
 *
 *   `postgres://${env:DB_USER}:${env:DB_PASS}@host:5432/app`
 *
 * Phase 6 slice 3: every typed-provider resolve (including legacy
 * `secret:`) emits a {@link SecretAccessAuditRecord} via the injected
 * {@link SecretAuditSink}. The secret value is NEVER stored — only the
 * ref, outcome, and optional error.
 */

import { readFileSync } from 'node:fs';
import type {
  SecretAccessAuditRecord,
  SecretAuditSink,
  SecretProvider,
  SecretProviderType,
} from '../secrets/types.js';
import { DEFAULT_TENANT_CONTEXT, type TenantContext } from '../tenancy/types.js';
import type { SecretResolver } from './types.js';

/** Thrown for malformed `${scheme:value}` references. */
export class SecretResolverError extends Error {
  constructor(
    message: string,
    readonly ref: string,
  ) {
    super(message);
    this.name = 'SecretResolverError';
  }
}

export interface CreateSecretResolverOptions {
  /**
   * Env map. Defaults to `process.env`. Tests pass their own to avoid
   * leaking state between runs.
   */
  env?: Record<string, string | undefined>;
  /**
   * If set, `file:` references that don't start with `/` are resolved
   * relative to this directory. Absolute paths are unchanged.
   */
  fileRoot?: string;
  /**
   * Legacy Phase-4 hook for `secret:` references. Still honored when
   * present; new deployments should wire {@link providers} instead.
   */
  secretHandler?: (path: string) => Promise<string>;
  /**
   * Phase 6 slice 3. Providers matched by type prefix (`vault:`,
   * `aws-sm:`, etc.). The first provider whose `type` matches the
   * scheme wins; `secret:` refs (no explicit type) fall back to the
   * provider flagged as `default` via {@link defaultProviderType}, or
   * {@link secretHandler} if still set.
   */
  providers?: readonly SecretProvider[];
  /** Provider type used for bare `secret:path` refs. */
  defaultProviderType?: SecretProviderType;
  /**
   * Tenant handed to every provider via {@link SecretResolveContext}.
   * Defaults to `DEFAULT_TENANT_CONTEXT`.
   */
  tenant?: TenantContext;
  /**
   * Label carried on every audit record — typically the adapter id /
   * skill name that's resolving the secret. Callers can override
   * per-call via {@link SecretResolver.resolve} after slice 5 lands the
   * full context-aware API.
   */
  requester?: string;
  /** Audit sink for secret accesses. Absent → no audit. */
  auditSink?: SecretAuditSink;
  /** Clock override for audit record timestamps. */
  now?: () => number;
}

/**
 * Matches `scheme:path` where scheme is a dash-separated lowercase
 * identifier. Supports every legacy scheme (`env`, `file`, `secret`) +
 * every provider type prefix (`vault`, `aws-sm`, `gcp-sm`, `k8s`).
 */
const REF_PATTERN = /^([a-z][a-z0-9-]*):(.+)$/;

/**
 * Build a resolver. The returned object is a valid `SecretResolver` and
 * also exposes `resolveRef` + `expand` for the config loader.
 */
export function createDefaultSecretResolver(
  options: CreateSecretResolverOptions = {},
): SecretResolver & {
  expand(value: unknown): Promise<unknown>;
} {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const fileRoot = options.fileRoot;
  const secretHandler = options.secretHandler;
  const providers = options.providers ?? [];
  const tenant = options.tenant ?? DEFAULT_TENANT_CONTEXT;
  const requester = options.requester ?? 'unknown';
  const auditSink = options.auditSink;
  const now = options.now ?? Date.now;
  const defaultProviderType = options.defaultProviderType;

  const providerByType = new Map<SecretProviderType, SecretProvider>();
  for (const p of providers) {
    // First-match-wins: preserve the first provider for each type so the
    // config-loader's ordering is meaningful.
    if (!providerByType.has(p.type)) providerByType.set(p.type, p);
  }

  function providerForScheme(scheme: string): SecretProvider | undefined {
    // Typed schemes route to their same-type provider; `secret:` falls
    // back to the configured default provider type.
    if (scheme === 'secret') {
      if (defaultProviderType) return providerByType.get(defaultProviderType);
      return undefined;
    }
    return providerByType.get(scheme as SecretProviderType);
  }

  async function audit(
    ref: string,
    outcome: SecretAccessAuditRecord['outcome'],
    provider: SecretProvider | undefined,
    error?: Error,
  ): Promise<void> {
    if (!auditSink) return;
    const record: SecretAccessAuditRecord = {
      kind: 'secret_access',
      ts: now(),
      tenantId: tenant.id,
      ref,
      requester,
      outcome,
    };
    if (provider) {
      record.providerType = provider.type;
      record.providerName = provider.name;
    }
    if (error) {
      const message = error.message;
      const code = (error as Error & { code?: string }).code;
      record.error = code !== undefined ? { message, code } : { message };
    }
    try {
      await auditSink.record(record);
    } catch {
      // Audit sinks must never break the resolve path.
    }
  }

  async function resolveViaProvider(
    provider: SecretProvider,
    ref: string,
    path: string,
  ): Promise<string> {
    try {
      const value = await provider.resolve(path, { tenant, requester });
      await audit(ref, 'resolved', provider);
      return value;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const denied = (error as Error & { code?: string }).code === 'EDENIED';
      await audit(ref, denied ? 'denied' : 'error', provider, error);
      throw error;
    }
  }

  async function resolveRef(ref: string): Promise<string> {
    const m = REF_PATTERN.exec(ref);
    if (!m) {
      throw new SecretResolverError(
        `secret reference must match "scheme:path" (got "${ref}")`,
        ref,
      );
    }
    const scheme = m[1] as string;
    const value = (m[2] ?? '').trim();
    switch (scheme) {
      case 'env': {
        if (!value) {
          throw new SecretResolverError('env reference requires a variable name', ref);
        }
        const out = env[value];
        if (out === undefined || out === '') {
          throw new SecretResolverError(
            `env variable "${value}" is not set (referenced by "${ref}")`,
            ref,
          );
        }
        return out;
      }
      case 'file': {
        if (!value) {
          throw new SecretResolverError('file reference requires a path', ref);
        }
        const path = value.startsWith('/') || !fileRoot ? value : `${fileRoot}/${value}`;
        try {
          return readFileSync(path, 'utf-8').trim();
        } catch (err) {
          throw new SecretResolverError(
            `failed to read file "${path}" (${err instanceof Error ? err.message : String(err)})`,
            ref,
          );
        }
      }
      default: {
        const provider = providerForScheme(scheme);
        if (provider) {
          return resolveViaProvider(provider, ref, value);
        }
        // Back-compat: legacy `secret:` handler still works when no
        // provider was configured.
        if (scheme === 'secret' && secretHandler) {
          try {
            const resolved = await secretHandler(value);
            await audit(ref, 'resolved', undefined);
            return resolved;
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            await audit(ref, 'error', undefined, error);
            throw error;
          }
        }
        throw new SecretResolverError(
          `unknown or unconfigured scheme "${scheme}" in "${ref}" — register a SecretProvider with type "${scheme}"`,
          ref,
        );
      }
    }
  }

  async function expandString(s: string): Promise<string> {
    if (!s.includes('${')) return s;
    // Collect every `${...}` and replace sequentially. We resolve serially
    // because the most common case is 1-2 refs per string and the refs
    // are cheap; keeping it serial avoids Promise.all fan-out overhead.
    const parts: string[] = [];
    let cursor = 0;
    while (cursor < s.length) {
      const start = s.indexOf('${', cursor);
      if (start < 0) {
        parts.push(s.slice(cursor));
        break;
      }
      parts.push(s.slice(cursor, start));
      const end = s.indexOf('}', start + 2);
      if (end < 0) {
        throw new SecretResolverError(`unterminated \${...} in "${s}"`, s.slice(start));
      }
      const ref = s.slice(start + 2, end);
      parts.push(await resolveRef(ref));
      cursor = end + 1;
    }
    return parts.join('');
  }

  async function expand(value: unknown): Promise<unknown> {
    if (typeof value === 'string') return expandString(value);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const v of value) out.push(await expand(v));
      return out;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = await expand(v);
      }
      return out;
    }
    return value;
  }

  return {
    async resolve(ref: string): Promise<string> {
      // Strip an enclosing `${...}` for convenience so callers can pass
      // either `${env:X}` or `env:X`.
      if (ref.startsWith('${') && ref.endsWith('}')) {
        return resolveRef(ref.slice(2, -1));
      }
      return resolveRef(ref);
    },
    expand,
  };
}
