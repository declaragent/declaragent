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
import { Kafka } from 'kafkajs';
import { createKafkaAdapter } from '../src/adapter.js';
import type { KafkaTriggerConfig } from '../src/config.js';

/**
 * Env-gated integration test. Set `KAFKA_INTEGRATION=1` + `KAFKA_BROKERS`
 * to run — otherwise everything is skipped so CI stays green without a
 * broker.
 *
 * Boot Redpanda first:
 *   docker compose -f test/fixtures/docker-compose.yml up -d
 *   KAFKA_INTEGRATION=1 KAFKA_BROKERS=localhost:19092 bun test test/integration.test.ts
 */

const ENABLED = process.env.KAFKA_INTEGRATION === '1';
const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');

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

function waitFor(pred: () => boolean, timeoutMs = 10_000, intervalMs = 50): Promise<void> {
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

describeIntegration('KafkaSourceInstance (real broker)', () => {
  const runId = Math.random().toString(36).slice(2, 10);
  const topic = `declaragent-it-${runId}`;
  const dlqTopic = `declaragent-it-dlq-${runId}`;
  const consumerGroup = `declaragent-it-group-${runId}`;

  const adminKafka = new Kafka({ brokers: BROKERS, clientId: `it-admin-${runId}` });
  const admin = adminKafka.admin();
  const producer = adminKafka.producer();

  beforeAll(async () => {
    await admin.connect();
    await admin.createTopics({
      topics: [
        { topic, numPartitions: 1, replicationFactor: 1 },
        { topic: dlqTopic, numPartitions: 1, replicationFactor: 1 },
      ],
      waitForLeaders: true,
    });
    await producer.connect();
  }, 30_000);

  afterAll(async () => {
    try {
      await producer.disconnect();
    } catch {
      // best effort
    }
    try {
      await admin.deleteTopics({ topics: [topic, dlqTopic] });
    } catch {
      // best effort
    }
    await admin.disconnect();
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
    const config: KafkaTriggerConfig = {
      id: `it-${runId}`,
      transport: {
        brokers: BROKERS,
        clientId: `it-consumer-${runId}`,
        consumerGroup,
        topics: [topic],
        fromBeginning: true,
      },
      routing: ROUTING,
      delivery: DELIVERY,
      limits: LIMITS,
      dlq: { topic: dlqTopic },
    };

    const adapter = createKafkaAdapter();
    const instance = await adapter.create(config, deps);
    await instance.start();

    try {
      await producer.send({
        topic,
        messages: [{ value: 'hello' }, { value: 'world' }],
      });

      await waitFor(() => received.length >= 2, 20_000);
      const payloads = received.map((e) => e.payload).sort();
      expect(payloads).toEqual(['hello', 'world']);
      expect(instance.metrics().messagesProcessed).toBeGreaterThanOrEqual(2);
    } finally {
      await instance.stop('integration-test-end');
    }
  }, 60_000);

  test('lag() returns end offsets for the subscribed topic', async () => {
    const bus = createEventBus();
    const deps: SourceDependencies = {
      bus,
      logger: NOOP_LOGGER,
      configDir: '/tmp',
      normalizer: passthroughNormalizer(),
    };
    const config: KafkaTriggerConfig = {
      id: `it-lag-${runId}`,
      transport: {
        brokers: BROKERS,
        clientId: `it-lag-${runId}`,
        consumerGroup: `${consumerGroup}-lag`,
        topics: [topic],
        fromBeginning: false,
      },
      routing: ROUTING,
      delivery: DELIVERY,
      limits: LIMITS,
    };
    const adapter = createKafkaAdapter();
    const instance = await adapter.create(config, deps);
    await instance.start();
    try {
      const lag = await instance.lag?.();
      expect(lag).toBeDefined();
      expect(Object.keys(lag ?? {}).length).toBeGreaterThan(0);
    } finally {
      await instance.stop('integration-test-end');
    }
  }, 60_000);
});
