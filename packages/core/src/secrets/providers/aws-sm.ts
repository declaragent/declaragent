import { createTtlCache } from '../ttl-cache.js';
import type { SecretMetadata, SecretProvider, SecretResolveContext } from '../types.js';

/**
 * AWS Secrets Manager provider (fetch-based with inline SigV4 signing).
 *
 * Path convention:
 *
 *   aws-sm:<region>/<secret-id>           → AWSCURRENT version
 *   aws-sm:<region>/<secret-id>#field     → JSON field of the secret
 *
 * The secret-id portion after the region is the AWS SecretId — either
 * the secret's name or its full ARN. A trailing `#field` fragment
 * selects a single key when the secret's payload is JSON (mirroring the
 * Vault convention).
 *
 * Credentials are resolved in this order, unless overridden by
 * {@link AwsSmProviderOptions.credentialsProvider}:
 *   1. Env vars `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional
 *      `AWS_SESSION_TOKEN` (covers IRSA, ECS, direct exports).
 *   2. Throws — EC2 IMDS / SSO fall-throughs are opt-in via a caller
 *      supplied `credentialsProvider`.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsSmProviderOptions {
  /** Instance name for audit + diagnostics. */
  name?: string;
  /** Default region, used when a ref omits the region segment. */
  defaultRegion?: string;
  /** Credentials resolver. Default: env-backed. */
  credentialsProvider?: () => Promise<AwsCredentials>;
  /** Default cache TTL. Default 5m. */
  defaultTtlMs?: number;
  /** Clock + fetch injection for tests. */
  now?: () => number;
  fetch?: typeof fetch;
}

interface GetSecretValueResponse {
  ARN?: string;
  Name?: string;
  VersionId?: string;
  SecretString?: string;
  SecretBinary?: string;
  CreatedDate?: number;
}

interface DescribeSecretResponse {
  ARN?: string;
  Name?: string;
  CreatedDate?: number;
  LastChangedDate?: number;
  LastRotatedDate?: number;
  VersionIdsToStages?: Record<string, string[]>;
}

function parseRef(
  raw: string,
  defaultRegion: string | undefined,
): {
  region: string;
  secretId: string;
  field?: string;
} {
  const hashIdx = raw.indexOf('#');
  const withoutField = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const field = hashIdx >= 0 ? raw.slice(hashIdx + 1) : undefined;
  const slashIdx = withoutField.indexOf('/');
  let region = defaultRegion;
  let secretId = withoutField;
  // Refs starting with `arn:` don't have a region segment — AWS ARNs carry
  // their own region. Extract it.
  if (withoutField.startsWith('arn:')) {
    const arnParts = withoutField.split(':');
    region = arnParts[3] ?? region;
    secretId = withoutField;
  } else if (slashIdx > 0) {
    region = withoutField.slice(0, slashIdx);
    secretId = withoutField.slice(slashIdx + 1);
  }
  if (!region) {
    throw new Error(`aws-sm: ref "${raw}" is missing a region segment and no defaultRegion is set`);
  }
  if (!secretId) {
    throw new Error(`aws-sm: ref "${raw}" has an empty secret id`);
  }
  return field !== undefined ? { region, secretId, field } : { region, secretId };
}

function defaultCredentialsProvider(): () => Promise<AwsCredentials> {
  return async () => {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'aws-sm: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set. Supply a custom `credentialsProvider` for SSO / IMDS flows.',
      );
    }
    return sessionToken
      ? { accessKeyId, secretAccessKey, sessionToken }
      : { accessKeyId, secretAccessKey };
  };
}

// ── SigV4 ────────────────────────────────────────────────────────────────

const HEX_CHARS = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += HEX_CHARS[b >> 4];
    out += HEX_CHARS[b & 0xf];
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<Uint8Array> {
  // Accept both ArrayBuffer (from subtle.digest) and Uint8Array; the
  // importKey API wants the raw bytes.
  const keyBytes = key instanceof Uint8Array ? new Uint8Array(key) : new Uint8Array(key);
  const imported = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function signingKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function signSigV4(args: {
  region: string;
  target: string;
  body: string;
  credentials: AwsCredentials;
  now: number;
}): Promise<SignedRequest> {
  const { region, target, body, credentials } = args;
  const d = new Date(args.now);
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');
  const dateStamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const amzDate = `${dateStamp}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const host = `secretsmanager.${region}.amazonaws.com`;
  const url = `https://${host}/`;
  const method = 'POST';
  const payloadHash = await sha256Hex(body);
  const headersBase: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-date': amzDate,
    'x-amz-target': target,
  };
  if (credentials.sessionToken) headersBase['x-amz-security-token'] = credentials.sessionToken;
  const signedHeaderNames = Object.keys(headersBase).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headersBase[h]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [method, '/', '', canonicalHeaders, signedHeaders, payloadHash].join(
    '\n',
  );
  const credentialScope = `${dateStamp}/${region}/secretsmanager/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');
  const key = await signingKey(credentials.secretAccessKey, dateStamp, region, 'secretsmanager');
  const sig = toHex(await hmac(key, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return {
    url,
    headers: { ...headersBase, authorization },
    body,
  };
}

// ── Provider ─────────────────────────────────────────────────────────────

export function createAwsSmProvider(options: AwsSmProviderOptions = {}): SecretProvider {
  const credentialsProvider = options.credentialsProvider ?? defaultCredentialsProvider();
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const name = options.name ?? 'aws-sm';

  const valueCache = createTtlCache<string>({ defaultTtlMs, now });
  const metadataCache = createTtlCache<SecretMetadata>({ defaultTtlMs, now });

  async function callApi<T>(
    region: string,
    target: string,
    body: Record<string, unknown>,
    ctx: string,
  ): Promise<T> {
    const credentials = await credentialsProvider();
    const signed = await signSigV4({
      region,
      target: `secretsmanager.${target}`,
      body: JSON.stringify(body),
      credentials,
      now: now(),
    });
    const res = await doFetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    });
    if (res.status === 404) throw new Error(`aws-sm: not found: ${ctx}`);
    if (res.status === 403 || res.status === 400) {
      const raw = await res.text();
      if (/AccessDenied|UnauthorizedOperation/i.test(raw)) {
        const err = new Error(`aws-sm: access denied: ${ctx}`);
        (err as Error & { code?: string }).code = 'EDENIED';
        throw err;
      }
      throw new Error(`aws-sm: ${ctx} failed: ${res.status} ${raw}`);
    }
    if (!res.ok) {
      throw new Error(`aws-sm: ${ctx} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  function extractValue(resp: GetSecretValueResponse, field?: string): string {
    let raw: string;
    if (resp.SecretString !== undefined) raw = resp.SecretString;
    else if (resp.SecretBinary !== undefined) raw = atob(resp.SecretBinary);
    else
      throw new Error('aws-sm: GetSecretValue response has neither SecretString nor SecretBinary');
    if (field === undefined) return raw;
    // `field` only makes sense when SecretString holds JSON.
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed[field];
      if (value === undefined) throw new Error(`aws-sm: field "${field}" not present in secret`);
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('aws-sm: field')) throw err;
      throw new Error(
        `aws-sm: secret is not JSON, cannot extract field "${field}" (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  async function resolve(rawRef: string, _ctx: SecretResolveContext): Promise<string> {
    const cached = valueCache.get(rawRef);
    if (cached !== undefined) return cached;
    const parsed = parseRef(rawRef, options.defaultRegion);
    const resp = await callApi<GetSecretValueResponse>(
      parsed.region,
      'GetSecretValue',
      { SecretId: parsed.secretId },
      `GetSecretValue ${parsed.secretId}`,
    );
    const value = extractValue(resp, parsed.field);
    valueCache.set(rawRef, value);
    return value;
  }

  async function metadata(rawRef: string, _ctx: SecretResolveContext): Promise<SecretMetadata> {
    const parsed = parseRef(rawRef, options.defaultRegion);
    const cached = metadataCache.get(parsed.secretId);
    if (cached) return cached;
    const resp = await callApi<DescribeSecretResponse>(
      parsed.region,
      'DescribeSecret',
      { SecretId: parsed.secretId },
      `DescribeSecret ${parsed.secretId}`,
    );
    const out: SecretMetadata = {};
    if (resp.LastRotatedDate) out.lastRotatedAt = resp.LastRotatedDate * 1000;
    else if (resp.LastChangedDate) out.lastRotatedAt = resp.LastChangedDate * 1000;
    else if (resp.CreatedDate) out.lastRotatedAt = resp.CreatedDate * 1000;
    const stages = resp.VersionIdsToStages;
    if (stages) {
      for (const [versionId, stageList] of Object.entries(stages)) {
        if (stageList.includes('AWSCURRENT')) {
          out.version = versionId;
          break;
        }
      }
    }
    metadataCache.set(parsed.secretId, out);
    return out;
  }

  async function close(): Promise<void> {
    valueCache.clear();
    metadataCache.clear();
  }

  return { type: 'aws-sm', name, resolve, metadata, close };
}
