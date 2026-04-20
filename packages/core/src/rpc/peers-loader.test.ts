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
