import { readFileSync } from 'node:fs';
import { createTtlCache } from '../ttl-cache.js';
import type { SecretMetadata, SecretProvider, SecretResolveContext } from '../types.js';

/**
 * Kubernetes Secrets provider (fetch-based, in-cluster by default).
 *
 * Path convention:
 *
 *   k8s:<namespace>/<secret-name>/<field>
 *
 * Example: `k8s:acme-prod/kafka-secret/password` → value of the
 * `password` key inside Secret `kafka-secret` in namespace `acme-prod`,
 * base64-decoded.
 *
 * Auth + endpoint defaults match the standard in-cluster service-account
 * mount (`/var/run/secrets/kubernetes.io/serviceaccount/`). Callers
 * outside a cluster can supply a custom `apiUrl` + `tokenProvider`.
 */

export interface K8sProviderOptions {
  /** Instance name for audit + diagnostics. */
  name?: string;
  /**
   * API server URL. Defaults to
   * `https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS}`.
   */
  apiUrl?: string;
  /**
   * Caller supplies a token-resolving function. Default: read
   * `/var/run/secrets/kubernetes.io/serviceaccount/token` at call time.
   */
  tokenProvider?: () => Promise<string>;
  /** Default cache TTL. Default 5m. */
  defaultTtlMs?: number;
  /** Clock + fetch injection for tests. */
  now?: () => number;
  fetch?: typeof fetch;
}

interface K8sSecretResponse {
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    resourceVersion?: string;
    annotations?: Record<string, string>;
  };
  type?: string;
  data?: Record<string, string>;
}

interface ParsedPath {
  namespace: string;
  secret: string;
  field: string;
}

function parsePath(path: string): ParsedPath {
  const parts = path.split('/');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error(`k8s: path must be "<namespace>/<secret>/<field>" (got "${path}")`);
  }
  return { namespace: parts[0], secret: parts[1], field: parts[2] };
}

function defaultApiUrl(): string {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443';
  if (!host) {
    throw new Error(
      'k8s: KUBERNETES_SERVICE_HOST is not set — provide `apiUrl` when running outside a cluster',
    );
  }
  return `https://${host}:${port}`;
}

const DEFAULT_SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

function defaultTokenProvider(): () => Promise<string> {
  // Re-read on every call; kubelet rotates the projected token.
  return async () => {
    try {
      return readFileSync(DEFAULT_SA_TOKEN_PATH, 'utf-8').trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `k8s: could not read service-account token at ${DEFAULT_SA_TOKEN_PATH} (${message})`,
      );
    }
  };
}

export function createK8sProvider(options: K8sProviderOptions = {}): SecretProvider {
  const apiUrl = (options.apiUrl ?? defaultApiUrl()).replace(/\/+$/, '');
  const tokenProvider = options.tokenProvider ?? defaultTokenProvider();
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const name = options.name ?? `k8s:${new URL(apiUrl).host}`;

  const valueCache = createTtlCache<string>({ defaultTtlMs, now });
  const secretCache = createTtlCache<K8sSecretResponse>({ defaultTtlMs, now });

  async function readSecret(namespace: string, secret: string): Promise<K8sSecretResponse> {
    const cacheKey = `${namespace}/${secret}`;
    const cached = secretCache.get(cacheKey);
    if (cached) return cached;
    const token = await tokenProvider();
    const url = `${apiUrl}/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(secret)}`;
    const res = await doFetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (res.status === 404) throw new Error(`k8s: secret "${namespace}/${secret}" not found`);
    if (res.status === 403) {
      const err = new Error(`k8s: access denied on "${namespace}/${secret}"`);
      (err as Error & { code?: string }).code = 'EDENIED';
      throw err;
    }
    if (!res.ok) {
      throw new Error(`k8s: read ${namespace}/${secret} failed: ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as K8sSecretResponse;
    secretCache.set(cacheKey, payload);
    return payload;
  }

  function decode(value: string | undefined, field: string): string {
    if (value === undefined) {
      throw new Error(`k8s: field "${field}" not present in secret`);
    }
    // K8s Secret values are base64-encoded.
    try {
      return atob(value);
    } catch (err) {
      throw new Error(
        `k8s: field "${field}" is not valid base64 (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  async function resolve(raw: string, _ctx: SecretResolveContext): Promise<string> {
    const cached = valueCache.get(raw);
    if (cached !== undefined) return cached;
    const { namespace, secret, field } = parsePath(raw);
    const payload = await readSecret(namespace, secret);
    const value = decode(payload.data?.[field], field);
    valueCache.set(raw, value);
    return value;
  }

  async function metadata(raw: string, _ctx: SecretResolveContext): Promise<SecretMetadata> {
    const { namespace, secret } = parsePath(raw);
    const payload = await readSecret(namespace, secret);
    const out: SecretMetadata = {};
    if (payload.metadata?.creationTimestamp) {
      const parsed = Date.parse(payload.metadata.creationTimestamp);
      if (!Number.isNaN(parsed)) out.lastRotatedAt = parsed;
    }
    if (payload.metadata?.resourceVersion) {
      out.version = payload.metadata.resourceVersion;
    }
    return out;
  }

  async function close(): Promise<void> {
    valueCache.clear();
    secretCache.clear();
  }

  return { type: 'k8s', name, resolve, metadata, close };
}
