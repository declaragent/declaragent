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
import mqtt from 'mqtt';
import { createMqttAdapter } from '../src/adapter.js';
import type { MqttTriggerConfig } from '../src/config.js';

/**
 * Env-gated integration test. Set `MQTT_INTEGRATION=1` to run; otherwise
 * everything is skipped so CI stays green without a broker.
 *
 * Boot Mosquitto first:
 *   docker compose -f test/fixtures/docker-compose.yml up -d
 *   MQTT_INTEGRATION=1 MQTT_BROKER_URL=mqtt://localhost:1883 bun test test/integration.test.ts
 */

const ENABLED = process.env.MQTT_INTEGRATION === '1';
const BROKER_URL = process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883';

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

describeIntegration('MqttSourceInstance (real broker)', () => {
  const runId = Math.random().toString(36).slice(2, 10);
  const topic = `declaragent/it/${runId}`;

  let publisher: mqtt.MqttClient | null = null;

  beforeAll(async () => {
    publisher = mqtt.connect(BROKER_URL, { clientId: `it-pub-${runId}` });
    await new Promise<void>((resolve, reject) => {
      publisher?.on('connect', () => resolve());
      publisher?.on('error', reject);
    });
  }, 30_000);

  afterAll(async () => {
    if (publisher) {
      await new Promise<void>((resolve) => publisher?.end(false, {}, () => resolve()));
    }
  });

  test('subscribes + publishes messages to the bus', async () => {
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
    const config: MqttTriggerConfig = {
      id: `it-${runId}`,
      transport: {
        brokerUrl: BROKER_URL,
        clientId: `it-consumer-${runId}`,
        clean: true,
        subscriptions: [{ topic, qos: 1 }],
      },
      routing: ROUTING,
      delivery: DELIVERY,
      limits: LIMITS,
    };

    const adapter = createMqttAdapter();
    const instance = await adapter.create(config, deps);
    await instance.start();

    try {
      await new Promise<void>((resolve, reject) => {
        publisher?.publish(topic, 'hello', { qos: 1 }, (err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        publisher?.publish(topic, 'world', { qos: 1 }, (err) => (err ? reject(err) : resolve()));
      });

      await waitFor(() => received.length >= 2);
      const payloads = received.map((e) => e.payload).sort();
      expect(payloads).toEqual(['hello', 'world']);
      expect(instance.metrics().messagesProcessed).toBeGreaterThanOrEqual(2);
    } finally {
      await instance.stop('integration-test-end');
    }
  }, 60_000);
});
