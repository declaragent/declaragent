import { describe, expect, test } from 'bun:test';
import type { RpcTransport } from '@declaragent/core';
import { SUPPORTED_FACTORY_KINDS, buildTransportFactories } from './transport-factories.js';

function fakeTransport(kind: string): RpcTransport {
  return {
    kind: kind as RpcTransport['kind'],
    async publish() {},
    subscribe: () => () => {},
    async close() {},
  };
}

describe('buildTransportFactories (WS4)', () => {
  test('exposes factories for kafka + nats', () => {
    const factories = buildTransportFactories({ fleetName: 'acme' });
    for (const kind of SUPPORTED_FACTORY_KINDS) {
      expect(factories[kind]).toBeDefined();
    }
  });

  test('kafka factory maps brokers + derives a stable clientId/groupId from the fleet name', async () => {
    const seen: unknown[] = [];
    const factories = buildTransportFactories({
      fleetName: 'acme',
      constructors: {
        kafka: (opts) => {
          seen.push(opts);
          return fakeTransport('kafka');
        },
      },
    });
    const t = await factories.kafka?.(
      {
        kind: 'kafka',
        brokers: ['b1:9092', 'b2:9092'],
        topics: { requests: 'agents.x.requests' },
      },
      {},
    );
    expect(t?.kind).toBe('kafka');
    expect(seen).toEqual([
      {
        brokers: ['b1:9092', 'b2:9092'],
        clientId: 'declaragent-acme',
        groupId: 'declaragent-acme',
      },
    ]);
  });

  test('kafka factory wires TLS + resolves the SASL passwordRef (WS11)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const resolved: string[] = [];
    const factories = buildTransportFactories({
      fleetName: 'acme',
      resolveSecret: async (ref) => {
        resolved.push(ref);
        return 'broker-pw';
      },
      constructors: {
        kafka: (opts) => {
          seen.push(opts as unknown as Record<string, unknown>);
          return fakeTransport('kafka');
        },
      },
    });
    await factories.kafka?.(
      {
        kind: 'kafka',
        brokers: ['b1:9092'],
        topics: { requests: 'r' },
        ssl: true,
        sasl: {
          mechanism: 'scram-sha-256',
          username: 'svc',
          passwordRef: 'secret://platform/kafka',
        },
      },
      {},
    );
    // passwordRef resolved through the injected resolver, never inlined.
    expect(resolved).toEqual(['secret://platform/kafka']);
    expect(seen[0]?.ssl).toBe(true);
    expect(seen[0]?.sasl).toEqual({
      mechanism: 'scram-sha-256',
      username: 'svc',
      password: 'broker-pw',
    });
  });

  test('kafka SASL without a secret resolver fails loud (no silent unauthenticated connect)', async () => {
    const factories = buildTransportFactories({
      fleetName: 'acme',
      constructors: { kafka: () => fakeTransport('kafka') },
    });
    await expect(
      factories.kafka?.(
        {
          kind: 'kafka',
          brokers: ['b1:9092'],
          topics: { requests: 'r' },
          sasl: { mechanism: 'plain', username: 'svc', passwordRef: 'secret://x' },
        },
        {},
      ),
    ).rejects.toThrow(/secret resolver/);
  });

  test('nats factory maps servers + clientName', async () => {
    const seen: unknown[] = [];
    const factories = buildTransportFactories({
      fleetName: 'acme',
      constructors: {
        nats: (opts) => {
          seen.push(opts);
          return fakeTransport('nats');
        },
      },
    });
    await factories.nats?.(
      { kind: 'nats', servers: ['nats://h:4222'], subjects: { requests: 'agents.x.requests' } },
      {},
    );
    expect(seen).toEqual([{ servers: ['nats://h:4222'], clientName: 'declaragent-acme' }]);
  });

  test('a factory rejects a mismatched config kind (defensive)', async () => {
    const factories = buildTransportFactories({
      fleetName: 'acme',
      constructors: { kafka: () => fakeTransport('kafka') },
    });
    expect(() =>
      factories.kafka?.(
        { kind: 'nats', servers: ['nats://h:4222'], subjects: { requests: 'r' } },
        {},
      ),
    ).toThrow(/non-kafka/);
  });
});
