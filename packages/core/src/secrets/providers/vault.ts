import { createTtlCache } from '../ttl-cache.js';
import type { SecretMetadata, SecretProvider, SecretResolveContext } from '../types.js';

/**
 * HashiCorp Vault provider (fetch-based, no peer dep).
 *
 * Path conventions:
 *
 *   vault:secret/data/acme/kafka             → full KV-v2 data payload (see below)
 *   vault:secret/data/acme/kafka#password    → just the `password` field
 *   vault:kv/data/team/stripe                → same shape on a non-default mount
 *
 * The portion after `vault:` is appended directly to `<address>/v1/`;
 * callers control the mount + engine. The trailing `#field` is a
 * fragment that selects a single key out of the KV v2 `data.data` object;
 * without it, the provider returns the single-field payload's value if
 * there's exactly one field, else the raw JSON of `data.data`.
 */

export interface VaultTokenAuth {
  kind: 'token';
  token: string;
}

export interface VaultAppRoleAuth {
  kind: 'approle';
  roleId: string;
  secretId: string;
  /** Mount path; defaults to `approle`. */
  mount?: string;
}

export type VaultAuth = VaultTokenAuth | VaultAppRoleAuth;

export interface VaultProviderOptions {
  /** Instance name for audit + diagnostics. */
  name?: string;
  /** `https://vault.example.com` (no trailing slash, no `/v1/`). */
  address: string;
  auth: VaultAuth;
  /** Vault namespace header — optional, for Vault Enterprise. */
  namespace?: string;
  /** Default cache TTL when Vault doesn't supply a lease. Default 5m. */
  defaultTtlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Fetch override for tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Shape of a KV v2 read response:
 *
 *   { data: { data: { key: value, ... }, metadata: { version, created_time, ... } } }
 *
 * We support KV v1 too by treating `data` as the raw payload when
 * `data.data` is absent.
 */
interface VaultKVResponse {
  data?: {
    data?: Record<string, unknown>;
    metadata?: {
      version?: number;
      created_time?: string;
      deletion_time?: string;
    };
    lease_duration?: number;
  };
  // KV v1 lives under `data` directly; shape is free-form.
  lease_duration?: number;
}

interface VaultAppRoleLoginResponse {
  auth?: {
    client_token?: string;
    lease_duration?: number;
  };
}

interface ParsedPath {
  path: string;
  field?: string;
}

function parsePath(input: string): ParsedPath {
  const hashIdx = input.indexOf('#');
  if (hashIdx < 0) return { path: input };
  return {
    path: input.slice(0, hashIdx),
    field: input.slice(hashIdx + 1),
  };
}

export function createVaultProvider(options: VaultProviderOptions): SecretProvider {
  const name = options.name ?? `vault:${new URL(options.address).host}`;
  const address = options.address.replace(/\/+$/, '');
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  const valueCache = createTtlCache<string>({ defaultTtlMs, now });
  const metadataCache = createTtlCache<SecretMetadata>({ defaultTtlMs, now });

  // AppRole token cache — resolve once + reuse until lease expiry.
  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (options.auth.kind === 'token') return options.auth.token;
    if (cachedToken && cachedToken.expiresAt > now()) return cachedToken.value;
    const mount = options.auth.mount ?? 'approle';
    const url = `${address}/v1/auth/${mount}/login`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role_id: options.auth.roleId,
        secret_id: options.auth.secretId,
      }),
    });
    if (!res.ok) {
      throw new Error(`vault approle login failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as VaultAppRoleLoginResponse;
    const token = body.auth?.client_token;
    if (!token) throw new Error('vault approle login: no client_token in response');
    // Renew a minute before the lease expires to avoid a thundering herd.
    const leaseMs = Math.max((body.auth?.lease_duration ?? 3600) * 1000 - 60_000, 60_000);
    cachedToken = { value: token, expiresAt: now() + leaseMs };
    return token;
  }

  async function readKV(path: string): Promise<VaultKVResponse> {
    const token = await getToken();
    const headers: Record<string, string> = {
      'x-vault-token': token,
      accept: 'application/json',
    };
    if (options.namespace) headers['x-vault-namespace'] = options.namespace;
    const res = await doFetch(`${address}/v1/${path}`, { headers });
    if (res.status === 404) {
      throw new Error(`vault: not found at ${path}`);
    }
    if (res.status === 403) {
      const err = new Error(`vault: access denied on ${path}`);
      (err as Error & { code?: string }).code = 'EDENIED';
      throw err;
    }
    if (!res.ok) {
      throw new Error(`vault read ${path} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as VaultKVResponse;
  }

  function extractValue(payload: VaultKVResponse, field: string | undefined): string {
    const data = payload.data?.data ?? payload.data ?? {};
    if (typeof data !== 'object' || data === null) {
      throw new Error('vault: response data is not an object');
    }
    if (field !== undefined) {
      const value = (data as Record<string, unknown>)[field];
      if (value === undefined) {
        throw new Error(`vault: field "${field}" not present in secret`);
      }
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 1 && entries[0]) {
      const only = entries[0][1];
      return typeof only === 'string' ? only : JSON.stringify(only);
    }
    return JSON.stringify(data);
  }

  function leaseTtl(payload: VaultKVResponse): number | undefined {
    const ttlSec = payload.data?.lease_duration ?? payload.lease_duration;
    if (ttlSec && ttlSec > 0) return ttlSec * 1000;
    return undefined;
  }

  async function resolve(raw: string, _ctx: SecretResolveContext): Promise<string> {
    const { path, field } = parsePath(raw);
    const cached = valueCache.get(raw);
    if (cached !== undefined) return cached;
    const payload = await readKV(path);
    const value = extractValue(payload, field);
    const ttl = leaseTtl(payload);
    valueCache.set(raw, value, ttl);
    const metadata: SecretMetadata = {};
    if (payload.data?.metadata?.created_time) {
      const parsed = Date.parse(payload.data.metadata.created_time);
      if (!Number.isNaN(parsed)) metadata.lastRotatedAt = parsed;
    }
    if (payload.data?.metadata?.version !== undefined) {
      metadata.version = String(payload.data.metadata.version);
    }
    if (ttl !== undefined) metadata.ttlMs = ttl;
    metadataCache.set(path, metadata, ttl);
    return value;
  }

  async function metadata(raw: string, _ctx: SecretResolveContext): Promise<SecretMetadata> {
    const { path } = parsePath(raw);
    const cached = metadataCache.get(path);
    if (cached) return cached;
    const payload = await readKV(path);
    const out: SecretMetadata = {};
    if (payload.data?.metadata?.created_time) {
      const parsed = Date.parse(payload.data.metadata.created_time);
      if (!Number.isNaN(parsed)) out.lastRotatedAt = parsed;
    }
    if (payload.data?.metadata?.version !== undefined) {
      out.version = String(payload.data.metadata.version);
    }
    const ttl = leaseTtl(payload);
    if (ttl !== undefined) out.ttlMs = ttl;
    metadataCache.set(path, out, ttl);
    return out;
  }

  async function close(): Promise<void> {
    valueCache.clear();
    metadataCache.clear();
    cachedToken = null;
  }

  return { type: 'vault', name, resolve, metadata, close };
}
