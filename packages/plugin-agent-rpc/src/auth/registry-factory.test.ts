import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope, LoadedPeers } from '@declaragent/core';
import { parsePeersConfig } from '@declaragent/core';
import { buildAuthVerifyRegistry, buildOutboundSigner } from './registry-factory.js';

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

// ── WS2 sign-side factory (RELEASE_0_8_0_PLAN.md §B1) ──────────────────

function envelopeTo(to: string): AgentRpcEnvelope {
  return {
    version: 1,
    kind: 'request',
    messageId: 'msg-signer-1',
    correlationId: 'corr-signer-1',
    from: 'agent://self',
    to: to as AgentRpcEnvelope['to'],
    capability: 'do-thing',
    payload: { n: 1 },
    auth: { kind: 'internal' },
  };
}

describe('buildOutboundSigner', () => {
  const hmacAuth = { provider: 'hmac', keyId: 'k1', secretRef: 'secret://pair-ab' };

  test('signs to an hmac peer and the verify registry accepts the result', async () => {
    const secrets = async () => 'shared-secret-ab';
    const signer = await buildOutboundSigner({ peers: peerConfig({ auth: hmacAuth }), secrets });
    expect(signer.signablePeers).toBe(1);

    const envelope = envelopeTo('agent://peer-a');
    envelope.auth = await signer.hook(envelope);
    expect(envelope.auth.kind).toBe('hmac');

    // Receiver side: same shared secret + keyId in ITS peer entry for us.
    const registry = await buildAuthVerifyRegistry({
      peers: peerConfig({ auth: hmacAuth }),
      secrets,
    });
    const entry = registry.resolve('agent://peer-a');
    if (entry === undefined) throw new Error('expected verify entry');
    const result = await entry.provider.verify(
      envelope,
      entry.config as Parameters<typeof entry.provider.verify>[1],
    );
    expect(result.ok).toBe(true);
  });

  test('tampering a signed field fails verification', async () => {
    const secrets = async () => 'shared-secret-ab';
    const signer = await buildOutboundSigner({ peers: peerConfig({ auth: hmacAuth }), secrets });
    const envelope = envelopeTo('agent://peer-a');
    envelope.auth = await signer.hook(envelope);
    const tampered = { ...envelope, payload: { n: 999 } };

    const registry = await buildAuthVerifyRegistry({
      peers: peerConfig({ auth: hmacAuth }),
      secrets,
    });
    const entry = registry.resolve('agent://peer-a');
    if (entry === undefined) throw new Error('expected verify entry');
    const result = await entry.provider.verify(
      tampered,
      entry.config as Parameters<typeof entry.provider.verify>[1],
    );
    expect(result.ok).toBe(false);
  });

  test('destination without an auth block gets the legacy internal stamp', async () => {
    const signer = await buildOutboundSigner({
      peers: peerConfig(),
      secrets: async () => {
        throw new Error('no auth blocks — resolver must not be called');
      },
    });
    expect(signer.signablePeers).toBe(0);
    const auth = await signer.hook(envelopeTo('agent://peer-a'));
    expect(auth).toEqual({ kind: 'internal' });
    const unknown = await signer.hook(envelopeTo('agent://not-a-peer'));
    expect(unknown).toEqual({ kind: 'internal' });
  });

  test('an unresolvable secretRef fails the build (boot-abort seam)', async () => {
    await expect(
      buildOutboundSigner({
        peers: peerConfig({ auth: hmacAuth }),
        secrets: async (ref) => {
          throw new Error(`no such secret: ${ref}`);
        },
      }),
    ).rejects.toThrow('no such secret: secret://pair-ab');
  });
});
