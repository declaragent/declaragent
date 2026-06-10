/**
 * Phase 6 slice-6 `tenants.yaml` / `tenants.json` loader.
 *
 * Example shape (see `docs/PHASE_6_PLAN.md` §6.8):
 *
 * ```yaml
 * version: 1
 * strategy:
 *   bus: per-tenant          # or: shared-with-filter
 *   secretProvider: vault
 * tenants:
 *   - id: acme-prod
 *     displayName: "ACME Production"
 *     residency: us
 *     auditRetentionDays: 90
 *     quotas:
 *       maxActiveSessions: 500
 *       dailyTokenUSD: 200
 *       maxConcurrentToolCalls: 20
 *     labels:
 *       env: production
 *     extensions:
 *       allow:
 *         - "channel-telegram"
 *         - "source-kafka"
 *         - "tool:Bash"
 *       deny:
 *         - "plugin-experimental-*"
 * ```
 *
 * The loader returns a `LoadedTenantsConfig` that callers hand to
 * {@link createTenantRuntime} (one per tenant entry) or that drives
 * the daemon's per-tenant branch.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { createDefaultSecretResolver } from '../events/secret-resolver.js';
import type { TenantContext, TenantQuotas, TenantResidency } from './types.js';

export class TenantsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantsConfigError';
  }
}

// ── Zod schema ──────────────────────────────────────────────────────────

const quotasSchema = z
  .object({
    maxActiveSessions: z.number().int().positive().optional(),
    dailyTokenUSD: z.number().positive().optional(),
    maxConcurrentToolCalls: z.number().int().positive().optional(),
    maxEventIngressPerSec: z.number().positive().optional(),
  })
  .strict();

const residencySchema = z.enum(['us', 'eu', 'apac', 'custom']);

const extensionScopeSchema = z
  .object({
    /**
     * Glob or exact-id patterns that MAY run for this tenant. When
     * omitted, every extension is available (unless listed in `deny`).
     */
    allow: z.array(z.string()).optional(),
    /**
     * Glob or exact-id patterns that are explicitly blocked. Always
     * wins over `allow`.
     */
    deny: z.array(z.string()).optional(),
  })
  .strict();

const tenantEntrySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
        'tenant id must be a URL-safe identifier (alphanumeric + `-` / `_`)',
      ),
    displayName: z.string().optional(),
    residency: residencySchema.optional(),
    auditRetentionDays: z.number().int().positive().optional(),
    quotas: quotasSchema.optional(),
    labels: z.record(z.string(), z.string()).optional(),
    secretScopes: z.array(z.string()).optional(),
    extensions: extensionScopeSchema.optional(),
  })
  .strict();

export const tenantsConfigSchema = z
  .object({
    version: z.literal(1),
    strategy: z
      .object({
        bus: z.enum(['per-tenant', 'shared-with-filter']).optional(),
        secretProvider: z.string().optional(),
      })
      .strict()
      .optional(),
    tenants: z.array(tenantEntrySchema).min(1),
  })
  .strict();

export type TenantsConfig = z.infer<typeof tenantsConfigSchema>;
export type TenantEntryConfig = z.infer<typeof tenantEntrySchema>;
export type BusStrategy = 'per-tenant' | 'shared-with-filter';

export interface ExtensionScope {
  /** Include patterns. Empty/undefined = allow-all. */
  readonly allow?: readonly string[];
  /** Block patterns. Always wins over allow. */
  readonly deny?: readonly string[];
}

export interface LoadedTenant {
  /** Fully-materialized context ready to hand to `createTenantRuntime`. */
  readonly context: TenantContext;
  readonly extensions?: ExtensionScope;
  readonly secretScopes?: readonly string[];
}

export interface LoadedTenantsConfig {
  readonly strategy: {
    readonly bus: BusStrategy;
    readonly secretProvider?: string;
  };
  readonly tenants: readonly LoadedTenant[];
  readonly format: 'json' | 'yaml';
  readonly rawText: string;
}

/**
 * WS8 — resolve a tenant id against a loaded `tenants.yaml` to its
 * {@link TenantContext} (id + quotas + residency). Returns undefined when the
 * id isn't declared, so the caller can fail loud (a typo'd tenant must not
 * silently fall back to an unquota'd default). Pure; unit-testable.
 *
 * @since 0.7.6
 */
export function resolveTenantContext(
  loaded: LoadedTenantsConfig,
  tenantId: string,
): TenantContext | undefined {
  return loaded.tenants.find((t) => t.context.id === tenantId)?.context;
}

// ── Loader ──────────────────────────────────────────────────────────────

export interface LoadTenantsOptions {
  /** Absolute path to `tenants.yaml` / `tenants.json`. */
  path: string;
  /** Env map used to expand `${env:...}` refs inside the config. */
  env?: Record<string, string | undefined>;
  /** Root for relative `file:` refs. Defaults to the config file's dir. */
  fileRoot?: string;
}

export async function loadTenantsConfig(options: LoadTenantsOptions): Promise<LoadedTenantsConfig> {
  const rawText = await readFile(options.path, 'utf-8');
  const ext = extname(options.path).toLowerCase();
  const format: 'json' | 'yaml' = ext === '.json' ? 'json' : 'yaml';
  let parsed: unknown;
  try {
    parsed = format === 'yaml' ? parseYaml(rawText) : JSON.parse(rawText);
  } catch (err) {
    throw new TenantsConfigError(
      `failed to parse ${options.path} as ${format}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const bootstrap = createDefaultSecretResolver({
    env: options.env ?? process.env,
    ...(options.fileRoot !== undefined && { fileRoot: options.fileRoot }),
  });
  const expanded = await bootstrap.expand(parsed);

  const validation = tenantsConfigSchema.safeParse(expanded);
  if (!validation.success) {
    throw new TenantsConfigError(`tenants config validation failed: ${validation.error.message}`);
  }

  const config = validation.data;
  const seen = new Set<string>();
  const tenants: LoadedTenant[] = [];
  for (const entry of config.tenants) {
    if (seen.has(entry.id)) {
      throw new TenantsConfigError(`duplicate tenant id "${entry.id}"`);
    }
    seen.add(entry.id);
    const context: TenantContext = {
      id: entry.id,
      ...(entry.displayName !== undefined && { displayName: entry.displayName }),
      ...(entry.residency !== undefined && {
        residency: entry.residency as TenantResidency,
      }),
      ...(entry.auditRetentionDays !== undefined && {
        auditRetentionDays: entry.auditRetentionDays,
      }),
      ...(entry.labels !== undefined && { labels: entry.labels }),
      ...(entry.quotas !== undefined && {
        quotas: entry.quotas as TenantQuotas,
      }),
    };
    const extScope: ExtensionScope | undefined = entry.extensions
      ? {
          ...(entry.extensions.allow !== undefined && { allow: entry.extensions.allow }),
          ...(entry.extensions.deny !== undefined && { deny: entry.extensions.deny }),
        }
      : undefined;
    const loaded: LoadedTenant = {
      context,
      ...(extScope !== undefined && { extensions: extScope }),
      ...(entry.secretScopes !== undefined && { secretScopes: entry.secretScopes }),
    };
    tenants.push(loaded);
  }

  return {
    strategy: {
      bus: config.strategy?.bus ?? 'per-tenant',
      ...(config.strategy?.secretProvider !== undefined && {
        secretProvider: config.strategy.secretProvider,
      }),
    },
    tenants,
    format,
    rawText,
  };
}
