import { createTtlCache } from '../ttl-cache.js';
import type { SecretMetadata, SecretProvider, SecretResolveContext } from '../types.js';

/**
 * Google Cloud Secret Manager provider (fetch-based, no peer dep).
 *
 * Path convention:
 *
 *   gcp-sm:projects/<project>/secrets/<name>            → latest version
 *   gcp-sm:projects/<project>/secrets/<name>/versions/1 → pinned version
 *
 * Auth: caller supplies a bearer-token resolver. In-cluster on GKE
 * (Workload Identity Federation), the default resolver hits the GCP
 * metadata server at `http://metadata.google.internal/computeMetadata/v1/
 * instance/service-accounts/default/token`. Outside GKE, pass a custom
 * `tokenProvider` that wraps the user's preferred ADC path.
 */

export interface GcpSmProviderOptions {
  /** Instance name for audit + diagnostics. */
  name?: string;
  /**
   * Bearer token resolver. Default: query the GCE/GKE metadata server.
   * Tokens are cached internally until expiry (or 1h if the server
   * doesn't supply an expiry).
   */
  tokenProvider?: () => Promise<{ token: string; expiresAtMs?: number }>;
  /** Default cache TTL for resolved values. Default 5m. */
  defaultTtlMs?: number;
  /** Clock + fetch injection for tests. */
  now?: () => number;
  fetch?: typeof fetch;
}

interface GcpSecretVersionResponse {
  name?: string;
  payload?: {
    data?: string; // base64
  };
}

interface GcpSecretMetaResponse {
  name?: string;
  createTime?: string;
  state?: string;
}

interface GcpMetadataTokenResponse {
  access_token?: string;
  expires_in?: number;
}

function defaultTokenProviderFactory(): () => Promise<{ token: string; expiresAtMs?: number }> {
  return async () => {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'metadata-flavor': 'Google' } },
    );
    if (!res.ok) {
      throw new Error(
        `gcp-sm: metadata server returned ${res.status} — not running on GCE/GKE or missing permissions`,
      );
    }
    const body = (await res.json()) as GcpMetadataTokenResponse;
    if (!body.access_token) {
      throw new Error('gcp-sm: metadata server response missing access_token');
    }
    const expiresAtMs =
      body.expires_in !== undefined ? Date.now() + body.expires_in * 1000 - 60_000 : undefined;
    return expiresAtMs !== undefined
      ? { token: body.access_token, expiresAtMs }
      : { token: body.access_token };
  };
}

function normalizeVersion(path: string): string {
  // Accept both `projects/p/secrets/n` and `projects/p/secrets/n/versions/N`.
  // Default to `/versions/latest` when the version segment is absent.
  if (path.includes('/versions/')) return path;
  return `${path}/versions/latest`;
}

function strippedForMetadata(path: string): string {
  // Metadata is per-secret (not per-version); strip trailing version segment.
  const idx = path.indexOf('/versions/');
  if (idx < 0) return path;
  return path.slice(0, idx);
}

export function createGcpSmProvider(options: GcpSmProviderOptions = {}): SecretProvider {
  const tokenProvider = options.tokenProvider ?? defaultTokenProviderFactory();
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const name = options.name ?? 'gcp-sm';

  const valueCache = createTtlCache<string>({ defaultTtlMs, now });
  const metadataCache = createTtlCache<SecretMetadata>({ defaultTtlMs, now });
  let cachedToken: { token: string; expiresAtMs: number } | null = null;

  async function getToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAtMs > now()) return cachedToken.token;
    const fresh = await tokenProvider();
    cachedToken = {
      token: fresh.token,
      expiresAtMs: fresh.expiresAtMs ?? now() + 3_600_000,
    };
    return fresh.token;
  }

  async function getJson<T>(path: string, ctx: string): Promise<T> {
    const token = await getToken();
    const res = await doFetch(`https://secretmanager.googleapis.com/v1/${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (res.status === 404) throw new Error(`gcp-sm: not found: ${ctx}`);
    if (res.status === 403) {
      const err = new Error(`gcp-sm: access denied: ${ctx}`);
      (err as Error & { code?: string }).code = 'EDENIED';
      throw err;
    }
    if (!res.ok) {
      throw new Error(`gcp-sm: ${ctx} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async function resolve(raw: string, _ctx: SecretResolveContext): Promise<string> {
    const cached = valueCache.get(raw);
    if (cached !== undefined) return cached;
    const path = normalizeVersion(raw);
    const payload = await getJson<GcpSecretVersionResponse>(`${path}:access`, `access ${path}`);
    const b64 = payload.payload?.data;
    if (b64 === undefined) {
      throw new Error(`gcp-sm: access response missing payload.data for ${path}`);
    }
    // GCP returns base64 (URL-safe permitted). `atob` handles standard b64.
    try {
      const decoded = atob(b64);
      valueCache.set(raw, decoded);
      return decoded;
    } catch (err) {
      throw new Error(
        `gcp-sm: payload is not valid base64 (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  async function metadata(raw: string, _ctx: SecretResolveContext): Promise<SecretMetadata> {
    const base = strippedForMetadata(raw);
    const cached = metadataCache.get(base);
    if (cached) return cached;
    const payload = await getJson<GcpSecretMetaResponse>(base, `describe ${base}`);
    const out: SecretMetadata = {};
    if (payload.createTime) {
      const parsed = Date.parse(payload.createTime);
      if (!Number.isNaN(parsed)) out.lastRotatedAt = parsed;
    }
    if (payload.name) out.version = payload.name;
    metadataCache.set(base, out);
    return out;
  }

  async function close(): Promise<void> {
    valueCache.clear();
    metadataCache.clear();
    cachedToken = null;
  }

  return { type: 'gcp-sm', name, resolve, metadata, close };
}
