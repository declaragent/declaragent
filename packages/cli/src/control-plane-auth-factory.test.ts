import { describe, expect, it } from 'bun:test';
import type { LoadedControlPlaneAuth } from '@declaragent/core';
import { buildControlPlaneAuth } from './control-plane-auth-factory.js';

// ── Minimal JWT-signing helpers ────────────────────────────────────────────
// Mirrors `plugin-agent-rpc/src/auth/test-jwt.ts` (internal to that package).
// Replicated here as a colocated test-only helper so we don't widen the
// plugin's public surface just to reach these utilities.

interface SubtleLike {
  generateKey(
    alg: unknown,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<{ publicKey: unknown; privateKey: unknown }>;
  exportKey(format: 'jwk', key: unknown): Promise<Record<string, unknown>>;
  sign(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
function subtle(): SubtleLike {
  return (crypto as unknown as { subtle: SubtleLike }).subtle;
}
function b64url(bytes: Uint8Array | string): string {
  const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let s = '';
  for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i] as number);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
async function genKeyPair(kid = 'test-kid'): Promise<{
  kid: string;
  publicJwk: Record<string, unknown>;
  privateKey: unknown;
}> {
  const pair = await subtle().generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = await subtle().exportKey('jwk', pair.publicKey);
  return { kid, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, privateKey: pair.privateKey };
}
async function signJwt(
  pair: Awaited<ReturnType<typeof genKeyPair>>,
  claims: Record<string, unknown>,
): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid: pair.kid };
  const hEnc = b64url(JSON.stringify(header));
  const cEnc = b64url(JSON.stringify(claims));
  const signingInput = `${hEnc}.${cEnc}`;
  const sig = await subtle().sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}
function cannedFetch(
  routes: Record<string, { status?: number; body: unknown }>,
): typeof globalThis.fetch {
  return (async (input: unknown) => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    const entry = routes[url];
    if (!entry) throw new Error(`cannedFetch: no route for ${url}`);
    const status = entry.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => entry.body,
      text: async () => JSON.stringify(entry.body),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const ISSUER = 'https://dex.example.com';
const JWKS_URI = `${ISSUER}/jwks`;
const AUDIENCE = 'declaragent-control-plane';

function now(): number {
  return 1_700_000_000_000;
}

async function mintToken(
  pair: Awaited<ReturnType<typeof genKeyPair>>,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const nowSec = Math.floor(now() / 1000);
  return signJwt(pair, {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'svc:prom',
    iat: nowSec,
    exp: nowSec + 300,
    scope: 'control:read',
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('buildControlPlaneAuth (OIDC)', () => {
  it('accepts a well-formed token that matches issuer + audience + scope', async () => {
    const pair = await genKeyPair('k1');
    const token = await mintToken(pair);
    const cfg: LoadedControlPlaneAuth = {
      provider: 'oidc',
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: JWKS_URI,
      scopes: ['control:read'],
    };
    const auth = await buildControlPlaneAuth({
      config: cfg,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
      now,
    });
    const result = await auth.verifyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.subject).toBe('svc:prom');
      expect(result.principal.issuer).toBe(ISSUER);
      expect(result.principal.scopes).toContain('control:read');
      expect(result.principal.provider).toBe('oidc');
    }
  });

  it('rejects tokens from the wrong issuer', async () => {
    const pair = await genKeyPair('k1');
    const token = await mintToken(pair, { iss: 'https://evil.example.com' });
    const cfg: LoadedControlPlaneAuth = {
      provider: 'oidc',
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: JWKS_URI,
    };
    const auth = await buildControlPlaneAuth({
      config: cfg,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
      now,
    });
    const result = await auth.verifyToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('wrong-issuer');
    }
  });

  it('rejects tokens missing a required scope (insufficient-scope)', async () => {
    const pair = await genKeyPair('k1');
    const token = await mintToken(pair, { scope: 'other:scope' });
    const cfg: LoadedControlPlaneAuth = {
      provider: 'oidc',
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: JWKS_URI,
      scopes: ['control:read'],
    };
    const auth = await buildControlPlaneAuth({
      config: cfg,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
      now,
    });
    const result = await auth.verifyToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('insufficient-scope');
    }
  });

  it('rejects expired tokens', async () => {
    const pair = await genKeyPair('k1');
    const nowSec = Math.floor(now() / 1000);
    const token = await signJwt(pair, {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'svc:prom',
      iat: nowSec - 1_000,
      exp: nowSec - 500,
      scope: 'control:read',
    });
    const cfg: LoadedControlPlaneAuth = {
      provider: 'oidc',
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: JWKS_URI,
    };
    const auth = await buildControlPlaneAuth({
      config: cfg,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
      now,
    });
    const result = await auth.verifyToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
    }
  });

  it('propagates allowLoopback from config to the middleware', async () => {
    const pair = await genKeyPair('k1');
    const cfg: LoadedControlPlaneAuth = {
      provider: 'oidc',
      allowLoopback: false,
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: JWKS_URI,
    };
    const auth = await buildControlPlaneAuth({
      config: cfg,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
      now,
    });
    expect(auth.allowLoopback).toBe(false);
  });
});

describe('buildControlPlaneAuth (oauth2-client)', () => {
  it('requires a secret resolver', async () => {
    const cfg: LoadedControlPlaneAuth = {
      provider: 'oauth2-client',
      tokenEndpoint: 'https://idp.example.com/oauth/token',
      clientId: 'cp',
      clientSecretRef: 'env:CP_SECRET',
      audience: AUDIENCE,
      issuer: ISSUER,
      jwksUri: JWKS_URI,
    };
    await expect(buildControlPlaneAuth({ config: cfg })).rejects.toThrow(/secrets/i);
  });

  it('resolves the client secret eagerly and verifies tokens against the JWKS', async () => {
    const pair = await genKeyPair('k1');
    const token = await mintToken(pair);
    const cfg: LoadedControlPlaneAuth = {
      provider: 'oauth2-client',
      tokenEndpoint: 'https://idp.example.com/oauth/token',
      clientId: 'cp',
      clientSecretRef: 'env:CP_SECRET',
      audience: AUDIENCE,
      issuer: ISSUER,
      jwksUri: JWKS_URI,
      scopes: ['control:read'],
    };
    let resolverCalls = 0;
    const auth = await buildControlPlaneAuth({
      config: cfg,
      secrets: async (ref) => {
        resolverCalls += 1;
        expect(ref).toBe('env:CP_SECRET');
        return 'resolved-secret';
      },
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
      now,
    });
    expect(resolverCalls).toBe(1);
    const result = await auth.verifyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.provider).toBe('oauth2-client');
    }
  });
});
