import type { SecretMetadata, SecretProvider, SecretResolveContext } from '../types.js';

/**
 * Env-backed provider — a sanity check implementation used primarily
 * for local development and tests. `env:PATH` refs route here; the
 * provider reads `process.env[PATH]` (or a caller-supplied map) and
 * returns the value.
 *
 * No rotation metadata is tracked; `metadata()` reports the env was
 * "always available" via `lastRotatedAt = 0`. Rotation monitoring is
 * effectively disabled for env-backed refs.
 */

export interface EnvSecretProviderOptions {
  /** Instance name. Defaults to `"env"`. */
  name?: string;
  /** Env map. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export function createEnvSecretProvider(options: EnvSecretProviderOptions = {}): SecretProvider {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const name = options.name ?? 'env';

  return {
    type: 'env',
    name,
    async resolve(path: string, _ctx: SecretResolveContext): Promise<string> {
      const value = env[path];
      if (value === undefined || value === '') {
        throw new Error(`env variable "${path}" is not set`);
      }
      return value;
    },
    async metadata(_path: string, _ctx: SecretResolveContext): Promise<SecretMetadata> {
      return { lastRotatedAt: 0 };
    },
  };
}
