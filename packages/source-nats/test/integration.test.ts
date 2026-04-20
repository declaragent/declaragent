import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type AgentEvent,
  type DeliveryConfig,
  type LimitsConfig,
  type Logger,
  type MessageNormalizer,
  type RawMessage,
  type RoutingConfig,
  type SourceDependencies,
  createEventBus,
} from '@declaragent/core';
import { type NatsConnection, connect } from 'nats';
import { createNatsAdapter } from '../src/adapter.js';
import type { NatsTriggerConfig } from '../src/config.js';

/**
 * Env-gated integration test. Set `NATS_INTEGRATION=1` to run; otherwise
 * everything is skipped so CI stays green without a server.
 *
 * Boot NATS first:
 *   docker compose -f test/fixtures/docker-compose.yml up -d
 *   NATS_INTEGRATION=1 NATS_SERVERS=nats://localhost:4222 bun test test/integration.test.ts
 */

const ENABLED = process.env.NATS_INTEGRATION === '1';
const SERVERS = (process.env.NATS_SERVERS ?? 'nats://localhost:4222').split(',');

const describeIntegration = ENABLED ? describe : describe.skip;

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function passthroughNormalizer(): MessageNormalizer {
  return {
    async normalize(raw: RawMessage): Promise<AgentEvent | null> {
      const text = typeof raw.value === 'string' ? raw.value : new TextDecoder().decode(raw.value);
      return {
        id: `evt-${raw.meta?.messageId ?? text}`,
        kind: 'trigger.fire',
        source: { type: 'self', reason: 'wakeup' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: text,
        auth: { kind: 'internal' },
      };
    },
  };
}

const DELIVERY: DeliveryConfig = {
  mode: 'at-least-once',
  ackStrategy: 'after-publish',
  maxRetries: 1,
  retryBackoff: { initialMs: 10, maxMs: 100, jitter: false },
  idempotency: { strategy: 'transport-natural', ttlMs: 60_000, store: 'memory' },
};

const LIMITS: LimitsConfig = { concurrency: 2, maxInflight: 50 };

const ROUTING: RoutingConfig = {
  format: 'json',
  kindSelector: { const: 'trigger.fire' },
  targetSelector: { type: 'broadcast' },
};

function waitFor(pred: () => boolean, timeoutMs = 15_000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor: timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describeIntegration('NatsSourceInstance (real JetStream)', () => {
  const runId = Math.random().toString(36).slice(2, 10);
  const stream = `declaragent-it-${runId}`.toUpperCase().replace(/-/g, '_');
  const subject = `declaragent.it.${runId}`;
  const consumerName = `${stream}_CONSUMER`;

  let nc: NatsConnection | null = null;

  beforeAll(async () => {
    nc = await connect({ servers: SERVERS });
    const jsm = await nc.jetstreamManager();
    await jsm.streams.add({ name: stream, subjects: [subject] });
  }, 30_000);

  afterAll(async () => {
    if (nc) {
      try {
        const jsm = await nc.jetstreamManager();
        await jsm.streams.delete(stream);
      } catch {
        // best effort
      }
      try {
        await nc.drain();
      } catch {
        // best effort
      }
    }
  });

  test('consumes messages + publishes to the bus', async () => {
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      received.push(e);
    });

    const deps: SourceDependencies = {
      bus,
      logger: NOOP_LOGGER,
      configDir: '/tmp',
      normalizer: passthroughNormalizer(),
    };
    const config: NatsTriggerConfig = {
      id: `it-${runId}`,
      transport: {
        servers: SERVERS,
        stream,
        durableConsumer: consumerName,
        subjectFilters: [subject],
      },
      routing: ROUTING,
      delivery: DELIVERY,
      limits: LIMITS,
    };

    const adapter = createNatsAdapter();
    const instance = await adapter.create(config, deps);
    await instance.start();

    try {
      const js = nc?.jetstream();
      await js?.publish(subject, new TextEncoder().encode('hello'));
      await js?.publish(subject, new TextEncoder().encode('world'));

      await waitFor(() => received.length >= 2);
      const payloads = received.map((e) => e.payload).sort();
      expect(payloads).toEqual(['hello', 'world']);
      expect(instance.metrics().messagesProcessed).toBeGreaterThanOrEqual(2);
    } finally {
      await instance.stop('integration-test-end');
    }
  }, 60_000);
});
