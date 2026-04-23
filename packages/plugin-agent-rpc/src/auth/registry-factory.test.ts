import { describe, expect, test } from 'bun:test';
import type { LoadedPeers } from '@declaragent/core';
import { parsePeersConfig } from '@declaragent/core';
import { buildAuthVerifyRegistry } from './registry-factory.js';

function peerConfig(overrides: { auth?: unknown } = {}): LoadedPeers {
  return parsePeersConfig({
    version: 1,
    peers: [
      {
        agent: 'agent://peer-a',
        transports: [
          {
            kind: 'memory',
            topics: { requests: 'agents.peer-a.requests' },
          },
        ],
        ...(overrides.auth !== undefined && { auth: overrides.auth }),
      },
    ],
  });
}

describe('buildAuthVerifyRegistry', () => {
  test('returns undefined for peers without an auth block', async () => {
    const registry = await buildAuthVerifyRegistry({
      peers: peerConfig(),
      secrets: async () => {
        throw new Error('should not resolve secrets for peers without auth');
      },
    });
    expect(registry.resolve('agent://peer-a')).toBeUndefined();
    expect(registry.resolve('agent://unknown')).toBeUndefined();
  });

  test('builds an OIDC provider when the peer declares provider: oidc', async () => {
    const registry = await buildAuthVerifyRegistry({
      peers: peerConfig({
        auth: {
          provider: 'oidc',
          issuer: 'https://dex.example.com',
          audience: 'peer-b',
          jwksUri: 'https://dex.example.com/keys',
          scopes: ['agents:call'],
        },
      }),
      secrets: async () => {
        throw new Error('OIDC should not need secrets resolver');
      },
    });
    const entry = registry.resolve('agent://peer-a');
    expect(entry).toBeDefined();
    expect(entry?.provider.name).toBe('oidc');
    expect(entry?.config.provider).toBe('oidc');
  });

  test('builds an OAuth2 client provider + resolves the client secret via the callback', async () => {
    const seenRefs: string[] = [];
    const registry = await buildAuthVerifyRegistry({
      peers: peerConfig({
        auth: {
          provider: 'oauth2-client',
          tokenEndpoint: 'https://idp.example.com/token',
          clientId: 'decl-agent-a',
          clientSecretRef: 'secret://platform/decl-agent-a-client-secret',
          jwksUri: 'https://idp.example.com/keys',
          issuer: 'https://idp.example.com',
          audience: 'peer-b',
          scopes: ['agents:call'],
        },
      }),
      secrets: async (ref) => {
        seenRefs.push(ref);
        return 'resolved-secret-value';
      },
    });
    const entry = registry.resolve('agent://peer-a');
    expect(entry).toBeDefined();
    expect(entry?.provider.name).toBe('oauth2-client');
    expect(entry?.config.provider).toBe('oauth2-client');
    expect(seenRefs).toEqual(['secret://platform/decl-agent-a-client-secret']);
  });

  test('propagates secret resolution failure so up can fail-closed on boot', async () => {
    await expect(
      buildAuthVerifyRegistry({
        peers: peerConfig({
          auth: {
            provider: 'oauth2-client',
            tokenEndpoint: 'https://idp.example.com/token',
            clientId: 'decl-agent-a',
            clientSecretRef: 'secret://missing/value',
          },
        }),
        secrets: async () => {
          throw new Error('EDENIED');
        },
      }),
    ).rejects.toThrow(/EDENIED/);
  });

  test('passes injected fetch + clock through to the provider', async () => {
    // We can only observe injection via OAuth2 — its sign() path will
    // hit the token endpoint. Swap fetch with a canned fake and assert
    // it's reached.
    let called = 0;
    const fakeFetch = (async (url: unknown, init?: unknown) => {
      called += 1;
      if (String(url).includes('/token')) {
        const _body = (init as { body?: string } | undefined)?.body ?? '';
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 't', expires_in: 60 }),
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error('unexpected fetch');
    }) as unknown as typeof globalThis.fetch;
    const registry = await buildAuthVerifyRegistry({
      peers: peerConfig({
        auth: {
          provider: 'oauth2-client',
          tokenEndpoint: 'https://idp.example.com/token',
          clientId: 'c',
          clientSecretRef: 'env:TOKEN',
        },
      }),
      secrets: async () => 's',
      fetch: fakeFetch,
      now: () => 1_000_000,
    });
    const entry = registry.resolve('agent://peer-a');
    expect(entry).toBeDefined();
    const auth = await entry?.provider.sign({
      version: 1,
      kind: 'request',
      messageId: 'm',
      correlationId: 'c',
      from: 'agent://peer-a',
      to: 'agent://peer-b',
      capability: 'x',
      replyTo: 'memory://agents.peer-a.responses',
      payload: {},
    });
    expect(auth?.kind).toBe('oauth2-client');
    expect(called).toBeGreaterThan(0);
  });
});
