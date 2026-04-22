import { describe, expect, test } from 'bun:test';
import { PeersConfigError, parsePeersConfig, resolvePeerTransport } from './peers-loader.js';

describe('parsePeersConfig', () => {
  test('accepts empty peer list', () => {
    const loaded = parsePeersConfig({ version: 1, peers: [] });
    expect(loaded.byAgent.size).toBe(0);
  });

  test('indexes peers by agent id', () => {
    const loaded = parsePeersConfig({
      version: 1,
      peers: [
        {
          agent: 'agent://pr-reviewer',
          transports: [
            {
              kind: 'kafka',
              brokers: ['kafka.internal:9092'],
              topics: { requests: 'agents.pr-reviewer.requests' },
            },
          ],
        },
      ],
    });
    expect(loaded.byAgent.get('agent://pr-reviewer')?.agent).toBe('agent://pr-reviewer');
  });

  test('rejects duplicate peer entries', () => {
    expect(() =>
      parsePeersConfig({
        version: 1,
        peers: [
          {
            agent: 'agent://x',
            transports: [{ kind: 'memory', topics: { requests: 'agents.x.requests' } }],
          },
          {
            agent: 'agent://x',
            transports: [{ kind: 'memory', topics: { requests: 'agents.x.requests' } }],
          },
        ],
      }),
    ).toThrow(PeersConfigError);
  });

  test('rejects missing transports', () => {
    expect(() =>
      parsePeersConfig({
        version: 1,
        peers: [{ agent: 'agent://x', transports: [] }],
      }),
    ).toThrow(PeersConfigError);
  });
});

describe('resolvePeerTransport', () => {
  test('returns the first transport and a BrokerAddress', () => {
    const loaded = parsePeersConfig({
      version: 1,
      peers: [
        {
          agent: 'agent://x',
          transports: [
            {
              kind: 'kafka',
              brokers: ['k:9092'],
              topics: { requests: 'agents.x.requests' },
            },
          ],
        },
      ],
    });
    const resolved = resolvePeerTransport(loaded, 'agent://x');
    expect(resolved?.transport.kind).toBe('kafka');
    expect(resolved?.address).toBe('kafka://agents.x.requests');
  });

  test('returns undefined for unknown peer', () => {
    const loaded = parsePeersConfig({ version: 1, peers: [] });
    expect(resolvePeerTransport(loaded, 'agent://missing')).toBeUndefined();
  });

  test('works for memory transport', () => {
    const loaded = parsePeersConfig({
      version: 1,
      peers: [
        {
          agent: 'agent://local',
          transports: [{ kind: 'memory', topics: { requests: 'agents.local.requests' } }],
        },
      ],
    });
    const resolved = resolvePeerTransport(loaded, 'agent://local');
    expect(resolved?.address).toBe('memory://agents.local.requests');
  });
});

describe('parsePeersConfig — per-peer auth (Item #4)', () => {
  test('accepts an OIDC auth block', () => {
    const loaded = parsePeersConfig({
      version: 1,
      peers: [
        {
          agent: 'agent://peer-a',
          transports: [{ kind: 'memory', topics: { requests: 'agents.peer-a.requests' } }],
          auth: {
            provider: 'oidc',
            issuer: 'https://dex.example.com',
            audience: 'declaragent-peer-a',
            jwksUri: 'https://dex.example.com/keys',
            scopes: ['rpc:invoke'],
          },
        },
      ],
    });
    const entry = loaded.byAgent.get('agent://peer-a');
    expect(entry?.auth?.provider).toBe('oidc');
  });

  test('accepts an OAuth2 Client-Credentials auth block with secret ref', () => {
    const loaded = parsePeersConfig({
      version: 1,
      peers: [
        {
          agent: 'agent://peer-b',
          transports: [{ kind: 'memory', topics: { requests: 'agents.peer-b.requests' } }],
          auth: {
            provider: 'oauth2-client',
            tokenEndpoint: 'https://idp.example.com/oauth2/token',
            clientId: 'decl-agent-a',
            clientSecretRef: 'secret://platform/decl-agent-a-client-secret',
            scopes: ['rpc:invoke'],
          },
        },
      ],
    });
    const entry = loaded.byAgent.get('agent://peer-b');
    expect(entry?.auth?.provider).toBe('oauth2-client');
    if (entry?.auth?.provider === 'oauth2-client') {
      expect(entry.auth.clientSecretRef).toBe('secret://platform/decl-agent-a-client-secret');
    }
  });

  test('rejects unknown auth provider', () => {
    expect(() =>
      parsePeersConfig({
        version: 1,
        peers: [
          {
            agent: 'agent://peer-c',
            transports: [{ kind: 'memory', topics: { requests: 'agents.peer-c.requests' } }],
            auth: { provider: 'saml', foo: 'bar' },
          },
        ],
      }),
    ).toThrow(PeersConfigError);
  });

  test('rejects OAuth2 block missing clientSecretRef', () => {
    expect(() =>
      parsePeersConfig({
        version: 1,
        peers: [
          {
            agent: 'agent://peer-d',
            transports: [{ kind: 'memory', topics: { requests: 'agents.peer-d.requests' } }],
            auth: {
              provider: 'oauth2-client',
              tokenEndpoint: 'https://idp.example.com/oauth2/token',
              clientId: 'c',
            },
          },
        ],
      }),
    ).toThrow(PeersConfigError);
  });

  test('no auth block is allowed (legacy)', () => {
    const loaded = parsePeersConfig({
      version: 1,
      peers: [
        {
          agent: 'agent://peer-e',
          transports: [{ kind: 'memory', topics: { requests: 'agents.peer-e.requests' } }],
        },
      ],
    });
    const entry = loaded.byAgent.get('agent://peer-e');
    expect(entry?.auth).toBeUndefined();
  });
});
