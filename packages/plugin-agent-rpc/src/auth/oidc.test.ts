import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import { type OidcPeerConfig, createOidcAuthProvider } from './oidc.js';
import { cannedFetch, generateRs256KeyPair, signJwt } from './test-jwt.js';

const ISSUER = 'https://dex.example.com';
const AUDIENCE = 'declaragent-peer-a';
const JWKS_URI = `${ISSUER}/keys`;

function envelopeWith(token: string): AgentRpcEnvelope {
  return {
    version: 1,
    kind: 'request',
    messageId: 'm1',
    correlationId: 'c1',
    from: 'agent://peer-a',
    to: 'agent://peer-b',
    capability: 'cap',
    replyTo: 'memory://agents.peer-a.responses',
    payload: {},
    auth: { kind: 'oidc', token },
  };
}

function baseConfig(overrides: Partial<OidcPeerConfig> = {}): OidcPeerConfig {
  return {
    provider: 'oidc',
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: JWKS_URI,
    ...overrides,
  };
}

async function mintToken(
  pair: Awaited<ReturnType<typeof generateRs256KeyPair>>,
  claims: Record<string, unknown>,
  opts: { omitKid?: boolean; alg?: string; emptySig?: boolean } = {},
): Promise<string> {
  const sigOpt: { omitKid?: boolean; alg?: string; emptySig?: boolean } = {};
  if (opts.omitKid !== undefined) sigOpt.omitKid = opts.omitKid;
  if (opts.alg !== undefined) sigOpt.alg = opts.alg;
  if (opts.emptySig !== undefined) sigOpt.emptySig = opts.emptySig;
  return signJwt({
    pair,
    ...sigOpt,
    claims: {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'peer-a',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    },
  });
}

describe('createOidcAuthProvider — sign()', () => {
  test('stamps an oidc auth block with the configured token', async () => {
    const provider = createOidcAuthProvider({ token: 'tok-abc', fetch: cannedFetch({}) });
    const env = envelopeWith('ignored');
    const auth = await provider.sign(env);
    expect(auth).toEqual({ kind: 'oidc', token: 'tok-abc' });
  });

  test('includes keyId hint when provided', async () => {
    const provider = createOidcAuthProvider({
      token: 'tok',
      keyId: 'kid-7',
      fetch: cannedFetch({}),
    });
    const auth = await provider.sign(envelopeWith('x'));
    expect(auth).toEqual({ kind: 'oidc', token: 'tok', keyId: 'kid-7' });
  });
});

describe('createOidcAuthProvider — verify()', () => {
  test('accepts a valid token', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await mintToken(pair, {});
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.subject).toBe('peer-a');
      expect(result.principal.issuer).toBe(ISSUER);
    }
  });

  test('rejects alg:none', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await mintToken(pair, {}, { alg: 'none', emptySig: true });
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('alg-none');
  });

  test('rejects missing exp claim', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'peer-a',
        iat: Math.floor(Date.now() / 1000),
      },
    });
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-claim');
  });

  test('rejects expired token beyond the clock-skew window', async () => {
    const pair = await generateRs256KeyPair('k1');
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'peer-a',
        iat: now - 1000,
        exp: now - 120, // 120s in the past; 60s skew → still expired
      },
    });
    const provider = createOidcAuthProvider({
      token,
      clockSkewSec: 60,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  test('accepts a token expired within clock-skew window', async () => {
    const pair = await generateRs256KeyPair('k1');
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'peer-a',
        iat: now - 600,
        exp: now - 30, // 30s past but skew is 60s
      },
    });
    const provider = createOidcAuthProvider({
      token,
      clockSkewSec: 60,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(true);
  });

  test('rejects wrong audience', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: 'someone-else',
        sub: 'peer-a',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-audience');
  });

  test('accepts aud array containing the expected audience', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: ['other', AUDIENCE],
        sub: 'peer-a',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(true);
  });

  test('rejects wrong issuer', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await signJwt({
      pair,
      claims: {
        iss: 'https://evil.example.com',
        aud: AUDIENCE,
        sub: 'peer-a',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-issuer');
  });

  test('strict scope check: missing required scope rejects', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await mintToken(pair, { scope: 'rpc:read' });
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(
      envelopeWith(token),
      baseConfig({ scopes: ['rpc:read', 'rpc:invoke'] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient-scope');
  });

  test('strict scope check: all required scopes present accepts', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await mintToken(pair, { scope: 'rpc:read rpc:invoke rpc:admin' });
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({ [JWKS_URI]: { body: { keys: [pair.publicJwk] } } }),
    });
    const result = await provider.verify(
      envelopeWith(token),
      baseConfig({ scopes: ['rpc:read', 'rpc:invoke'] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.scopes).toContain('rpc:invoke');
    }
  });

  test('IdP unreachable (JWKS fetch fails) → idp-unreachable', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await mintToken(pair, {});
    const failFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const provider = createOidcAuthProvider({ token, fetch: failFetch });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('idp-unreachable');
  });

  test('JWKS cache reuses keys within TTL', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await mintToken(pair, {});
    let fetches = 0;
    const trackingFetch = (async (url: unknown) => {
      fetches += 1;
      const u = String(url);
      if (u === JWKS_URI) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: [pair.publicJwk] }),
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof globalThis.fetch;
    const provider = createOidcAuthProvider({
      token,
      jwksCacheTtlMs: 10_000,
      fetch: trackingFetch,
    });
    for (let i = 0; i < 3; i += 1) {
      const r = await provider.verify(envelopeWith(token), baseConfig());
      expect(r.ok).toBe(true);
    }
    expect(fetches).toBe(1);
  });

  test('JWKS refresh after TTL expiry', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await mintToken(pair, {});
    let fetches = 0;
    let nowMs = 1_000_000;
    const trackingFetch = (async () => {
      fetches += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ keys: [pair.publicJwk] }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const provider = createOidcAuthProvider({
      token,
      jwksCacheTtlMs: 1000,
      fetch: trackingFetch,
      now: () => nowMs,
    });
    await provider.verify(envelopeWith(token), baseConfig());
    nowMs += 2000; // past TTL
    await provider.verify(envelopeWith(token), baseConfig());
    expect(fetches).toBe(2);
  });

  test('discovers jwks_uri when peerConfig omits it', async () => {
    const pair = await generateRs256KeyPair('k1');
    const token = await mintToken(pair, {});
    const discoveredUri = `${ISSUER}/alt-jwks`;
    const provider = createOidcAuthProvider({
      token,
      fetch: cannedFetch({
        [`${ISSUER}/.well-known/openid-configuration`]: {
          body: { issuer: ISSUER, jwks_uri: discoveredUri },
        },
        [discoveredUri]: { body: { keys: [pair.publicJwk] } },
      }),
    });
    const cfg: OidcPeerConfig = { provider: 'oidc', issuer: ISSUER, audience: AUDIENCE };
    const result = await provider.verify(envelopeWith(token), cfg);
    expect(result.ok).toBe(true);
  });

  test('missing auth block rejects with missing-auth', async () => {
    const provider = createOidcAuthProvider({ token: 'x', fetch: cannedFetch({}) });
    const { auth: _auth, ...rest } = envelopeWith('x');
    void _auth;
    const env = rest as AgentRpcEnvelope;
    const result = await provider.verify(env, baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-auth');
  });

  test('wrong auth kind rejects with wrong-kind', async () => {
    const provider = createOidcAuthProvider({ token: 'x', fetch: cannedFetch({}) });
    const env = envelopeWith('x');
    env.auth = { kind: 'internal' };
    const result = await provider.verify(env, baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-kind');
  });

  test('malformed token rejects', async () => {
    const provider = createOidcAuthProvider({ token: 'x', fetch: cannedFetch({}) });
    const result = await provider.verify(envelopeWith('not.a.jwt'), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // accept malformed-token OR wrong-issuer depending on what Base64 decode yields
      expect(['malformed-token']).toContain(result.reason);
    }
  });
});
