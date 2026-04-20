/**
 * Phase 6 slice-3 `secrets.yaml` / `secrets.json` loader.
 *
 * Config shape (see `docs/PHASE_6_PLAN.md` §8):
 *
 * ```yaml
 * version: 1
 * default: vault-prod
 * providers:
 *   vault-prod:
 *     type: vault
 *     address: "https://vault.acme.internal"
 *     auth:
 *       method: approle
 *       roleId: "${env:VAULT_ROLE_ID}"
 *       secretId: "${env:VAULT_SECRET_ID}"
 *     defaultTtlMs: 300000
 *   aws-sm-prod:
 *     type: aws-sm
 *     region: us-east-1
 * rotationMonitor:
 *   enabled: true
 *   checkIntervalMs: 3600000
 *   warnAfterDays: 90
 *   errorAfterDays: 180
 * ```
 *
 * No `${secret:...}` refs are allowed — providers are the bootstrap layer
 * and can't depend on themselves. `${env:...}` and `${file:...}` are
 * expanded via the Phase-4 resolver (which runs WITHOUT any providers
 * wired so recursion can't happen).
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { createDefaultSecretResolver } from '../events/secret-resolver.js';
import { createAwsSmProvider } from './providers/aws-sm.js';
import { createEnvSecretProvider } from './providers/env.js';
import { createGcpSmProvider } from './providers/gcp-sm.js';
import { createK8sProvider } from './providers/k8s.js';
import { createVaultProvider } from './providers/vault.js';
import type { SecretProvider, SecretProviderType } from './types.js';

export class SecretsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsConfigError';
  }
}

// ── Zod schema ──────────────────────────────────────────────────────────────

const vaultProviderSchema = z.object({
  type: z.literal('vault'),
  address: z.string(),
  namespace: z.string().optional(),
  auth: z.discriminatedUnion('method', [
    z.object({
      method: z.literal('token'),
      token: z.string(),
    }),
    z.object({
      method: z.literal('approle'),
      roleId: z.string(),
      secretId: z.string(),
      mount: z.string().optional(),
    }),
  ]),
  defaultTtlMs: z.number().int().positive().optional(),
});

const awsSmProviderSchema = z.object({
  type: z.literal('aws-sm'),
  defaultRegion: z.string().optional(),
  defaultTtlMs: z.number().int().positive().optional(),
});

const gcpSmProviderSchema = z.object({
  type: z.literal('gcp-sm'),
  defaultTtlMs: z.number().int().positive().optional(),
});

const k8sProviderSchema = z.object({
  type: z.literal('k8s'),
  apiUrl: z.string().optional(),
  defaultTtlMs: z.number().int().positive().optional(),
});

const envProviderSchema = z.object({
  type: z.literal('env'),
});

const providerConfigSchema = z.discriminatedUnion('type', [
  vaultProviderSchema,
  awsSmProviderSchema,
  gcpSmProviderSchema,
  k8sProviderSchema,
  envProviderSchema,
]);

export const rotationMonitorConfigSchema = z.object({
  enabled: z.boolean().optional(),
  checkIntervalMs: z.number().int().positive().optional(),
  warnAfterDays: z.number().int().positive().optional(),
  errorAfterDays: z.number().int().positive().optional(),
});

const secretsConfigSchema = z.object({
  version: z.literal(1),
  default: z.string().optional(),
  providers: z.record(z.string(), providerConfigSchema),
  rotationMonitor: rotationMonitorConfigSchema.optional(),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
export type RotationMonitorConfig = z.infer<typeof rotationMonitorConfigSchema>;

// ── Loader ──────────────────────────────────────────────────────────────────

export interface LoadSecretsOptions {
  /** Absolute path to `secrets.yaml` / `secrets.json`. */
  path: string;
  /** Env map used to expand `${env:...}` refs inside the config. */
  env?: Record<string, string | undefined>;
  /** Root for relative `file:` refs. Defaults to the config file's dir. */
  fileRoot?: string;
}

export interface LoadSecretsResult {
  providers: readonly SecretProvider[];
  /** Provider type used for bare `secret:path` refs. */
  defaultProviderType?: SecretProviderType;
  /** Rotation-monitor knobs, when the config specifies them. */
  rotationMonitor?: RotationMonitorConfig;
  format: 'json' | 'yaml';
  rawText: string;
}

/**
 * Load + validate `secrets.yaml` / `secrets.json`. Expands `${env:...}`
 * and `${file:...}` refs inline. Returns a ready-to-use array of
 * `SecretProvider` instances.
 */
export async function loadSecretsConfig(options: LoadSecretsOptions): Promise<LoadSecretsResult> {
  const rawText = await readFile(options.path, 'utf-8');
  const format = inferFormat(options.path);
  let parsed: unknown;
  try {
    parsed = format === 'yaml' ? parseYaml(rawText) : JSON.parse(rawText);
  } catch (err) {
    throw new SecretsConfigError(
      `failed to parse ${options.path} as ${format}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Bootstrap-only resolver — no providers wired, so `${secret:...}` refs
  // will fail loudly rather than recursing.
  const bootstrap = createDefaultSecretResolver({
    env: options.env ?? process.env,
    ...(options.fileRoot !== undefined && { fileRoot: options.fileRoot }),
  });
  const expanded = await bootstrap.expand(parsed);

  const validation = secretsConfigSchema.safeParse(expanded);
  if (!validation.success) {
    throw new SecretsConfigError(`secrets config validation failed: ${validation.error.message}`);
  }
  const config = validation.data;

  const providerEntries: { name: string; config: ProviderConfig }[] = Object.entries(
    config.providers,
  ).map(([name, cfg]) => ({ name, config: cfg }));

  const providers: SecretProvider[] = providerEntries.map(({ name, config: cfg }) =>
    instantiateProvider(name, cfg),
  );

  let defaultProviderType: SecretProviderType | undefined;
  if (config.default) {
    const entry = providerEntries.find((e) => e.name === config.default);
    if (!entry) {
      throw new SecretsConfigError(
        `secrets config: default provider "${config.default}" is not declared under providers`,
      );
    }
    defaultProviderType = entry.config.type;
  }

  return {
    providers,
    ...(defaultProviderType !== undefined && { defaultProviderType }),
    ...(config.rotationMonitor !== undefined && { rotationMonitor: config.rotationMonitor }),
    format,
    rawText,
  };
}

function inferFormat(path: string): 'json' | 'yaml' {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return 'json';
  return 'yaml';
}

function instantiateProvider(name: string, config: ProviderConfig): SecretProvider {
  switch (config.type) {
    case 'vault': {
      const auth =
        config.auth.method === 'token'
          ? ({ kind: 'token', token: config.auth.token } as const)
          : ({
              kind: 'approle',
              roleId: config.auth.roleId,
              secretId: config.auth.secretId,
              ...(config.auth.mount !== undefined && { mount: config.auth.mount }),
            } as const);
      return createVaultProvider({
        name,
        address: config.address,
        auth,
        ...(config.namespace !== undefined && { namespace: config.namespace }),
        ...(config.defaultTtlMs !== undefined && { defaultTtlMs: config.defaultTtlMs }),
      });
    }
    case 'aws-sm':
      return createAwsSmProvider({
        name,
        ...(config.defaultRegion !== undefined && { defaultRegion: config.defaultRegion }),
        ...(config.defaultTtlMs !== undefined && { defaultTtlMs: config.defaultTtlMs }),
      });
    case 'gcp-sm':
      return createGcpSmProvider({
        name,
        ...(config.defaultTtlMs !== undefined && { defaultTtlMs: config.defaultTtlMs }),
      });
    case 'k8s':
      return createK8sProvider({
        name,
        ...(config.apiUrl !== undefined && { apiUrl: config.apiUrl }),
        ...(config.defaultTtlMs !== undefined && { defaultTtlMs: config.defaultTtlMs }),
      });
    case 'env':
      return createEnvSecretProvider({ name });
    default: {
      // Exhaustiveness guard.
      const exhaustive: never = config;
      throw new SecretsConfigError(`unknown provider type: ${JSON.stringify(exhaustive)}`);
    }
  }
}
