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
import * as amqplib from 'amqplib';
import { createAmqpAdapter } from '../src/adapter.js';
import type { AmqpTriggerConfig } from '../src/config.js';

/**
 * Env-gated integration test. Set `AMQP_INTEGRATION=1` to run; otherwise
 * everything is skipped so CI stays green without a broker.
 *
 * Boot RabbitMQ first:
 *   docker compose -f test/fixtures/docker-compose.yml up -d
 *   AMQP_INTEGRATION=1 AMQP_URL=amqp://guest:guest@localhost:5672 bun test test/integration.test.ts
 */

const ENABLED = process.env.AMQP_INTEGRATION === '1';
const URL = process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5672';

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

describeIntegration('AmqpSourceInstance (real broker)', () => {
  const runId = Math.random().toString(36).slice(2, 10);
  const queue = `declaragent-it-${runId}`;

  // biome-ignore lint/suspicious/noExplicitAny: amqplib connection type varies across versions.
  let connection: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: amqplib channel type varies across versions.
  let publishChannel: any = null;

  beforeAll(async () => {
    connection = await amqplib.connect(URL);
    publishChannel = await connection.createChannel();
    await publishChannel.assertQueue(queue, { durable: false, autoDelete: true });
  }, 30_000);

  afterAll(async () => {
    if (publishChannel) {
      try {
        await publishChannel.deleteQueue(queue);
        await publishChannel.close();
      } catch {
        // best effort
      }
    }
    if (connection) {
      try {
        await connection.close();
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
    const config: AmqpTriggerConfig = {
      id: `it-${runId}`,
      transport: {
        url: URL,
        queue,
        durable: false,
        autoDelete: true,
      },
      routing: ROUTING,
      delivery: DELIVERY,
      limits: LIMITS,
    };

    const adapter = createAmqpAdapter();
    const instance = await adapter.create(config, deps);
    await instance.start();

    try {
      publishChannel.sendToQueue(queue, Buffer.from('hello'));
      publishChannel.sendToQueue(queue, Buffer.from('world'));

      await waitFor(() => received.length >= 2);
      const payloads = received.map((e) => e.payload).sort();
      expect(payloads).toEqual(['hello', 'world']);
      expect(instance.metrics().messagesProcessed).toBeGreaterThanOrEqual(2);
    } finally {
      await instance.stop('integration-test-end');
    }
  }, 60_000);
});
