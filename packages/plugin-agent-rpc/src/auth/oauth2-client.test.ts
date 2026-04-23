import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import { type OAuth2ClientPeerConfig, createOAuth2ClientAuthProvider } from './oauth2-client.js';
import { generateRs256KeyPair, signJwt } from './test-jwt.js';

const TOKEN_ENDPOINT = 'https://idp.example.com/oauth2/token';
const JWKS_URI = 'https://idp.example.com/keys';
const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'declaragent-peer-b';

function baseConfig(overrides: Partial<OAuth2ClientPeerConfig> = {}): OAuth2ClientPeerConfig {
  return {
    provider: 'oauth2-client',
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'decl-agent-a',
    clientSecretRef: 'secret://platform/decl-agent-a-client-secret',
    jwksUri: JWKS_URI,
    issuer: ISSUER,
    audience: AUDIENCE,
    ...overrides,
  };
}

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
    auth: { kind: 'oauth2-client', token },
  };
}

describe('createOAuth2ClientAuthProvider — sign()', () => {
  test('fetches token lazily + caches across sign calls', async () => {
    let tokenCalls = 0;
    const fetch = (async (url: unknown, init?: unknown) => {
      if (String(url) === TOKEN_ENDPOINT) {
        tokenCalls += 1;
        const body = ((init ?? {}) as { body?: string }).body ?? '';
        expect(body).toContain('grant_type=client_credentials');
        expect(body).toContain('client_id=decl-agent-a');
        expect(body).toContain('client_secret=raw-secret');
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: `tok-${tokenCalls}`, expires_in: 3600 }),
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error(`unexpected url ${String(url)}`);
    }) as unknown as typeof globalThis.fetch;
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'decl-agent-a',
      clientSecret: 'raw-secret',
      fetch,
    });
    const a = await provider.sign({} as AgentRpcEnvelope);
    const b = await provider.sign({} as AgentRpcEnvelope);
    expect(a).toEqual({ kind: 'oauth2-client', token: 'tok-1' });
    expect(b).toEqual({ kind: 'oauth2-client', token: 'tok-1' });
    expect(tokenCalls).toBe(1);
  });

  test('refreshes when token nears expiry', async () => {
    let tokenCalls = 0;
    let nowMs = 1_000_000;
    const fetch = (async () => {
      tokenCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `tok-${tokenCalls}`, expires_in: 60 }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'decl-agent-a',
      clientSecret: 's',
      refreshSkewSec: 30,
      fetch,
      now: () => nowMs,
    });
    await provider.sign({} as AgentRpcEnvelope);
    nowMs += 35_000; // within the refresh-skew window
    await provider.sign({} as AgentRpcEnvelope);
    expect(tokenCalls).toBe(2);
  });

  test('token endpoint down → JwtError propagates from sign', async () => {
    const fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'c',
      clientSecret: 's',
      fetch,
    });
    await expect(provider.sign({} as AgentRpcEnvelope)).rejects.toThrow(/token endpoint/);
  });
});

describe('createOAuth2ClientAuthProvider — verify()', () => {
  test('accepts a valid token', async () => {
    const pair = await generateRs256KeyPair('k-1');
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'client-decl-agent-a',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        scope: 'rpc:invoke',
      },
    });
    const fetch = (async (url: unknown) => {
      if (String(url) === JWKS_URI) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: [pair.publicJwk] }),
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error(`unexpected ${String(url)}`);
    }) as unknown as typeof globalThis.fetch;
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'c',
      clientSecret: 's',
      fetch,
    });
    const result = await provider.verify(
      envelopeWith(token),
      baseConfig({ scopes: ['rpc:invoke'] }),
    );
    expect(result.ok).toBe(true);
  });

  test('rejects alg:none', async () => {
    const pair = await generateRs256KeyPair('k-1');
    const token = await signJwt({
      pair,
      alg: 'none',
      emptySig: true,
      claims: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'c',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [pair.publicJwk] }),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch;
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'c',
      clientSecret: 's',
      fetch,
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('alg-none');
  });

  test('rejects missing iat', async () => {
    const pair = await generateRs256KeyPair('k-1');
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'c',
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [pair.publicJwk] }),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch;
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'c',
      clientSecret: 's',
      fetch,
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing-claim');
  });

  test('rejects missing required scope', async () => {
    const pair = await generateRs256KeyPair('k-1');
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'c',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        scope: 'other:scope',
      },
    });
    const fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [pair.publicJwk] }),
      text: async () => '',
    })) as unknown as typeof globalThis.fetch;
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'c',
      clientSecret: 's',
      fetch,
    });
    const result = await provider.verify(
      envelopeWith(token),
      baseConfig({ scopes: ['rpc:invoke'] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient-scope');
  });

  test('JWKS unreachable → idp-unreachable', async () => {
    const pair = await generateRs256KeyPair('k-1');
    const token = await signJwt({
      pair,
      claims: {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'c',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof globalThis.fetch;
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'c',
      clientSecret: 's',
      fetch,
    });
    const result = await provider.verify(envelopeWith(token), baseConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('idp-unreachable');
  });

  test('config-error when jwksUri is not configured', async () => {
    const provider = createOAuth2ClientAuthProvider({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'c',
      clientSecret: 's',
      fetch: (async () => ({}) as unknown as Response) as unknown as typeof globalThis.fetch,
    });
    const { jwksUri: _jwksUri, ...partial } = baseConfig();
    void _jwksUri;
    const cfg = partial as OAuth2ClientPeerConfig;
    const result = await provider.verify(envelopeWith('a.b.c'), cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('config-error');
  });
});
