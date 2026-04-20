import { describe, expect, test } from 'bun:test';
import type { EventSourceInstance, Logger, SourceDependencies } from '@declaragent/core';
import { createKafkaAdapter } from '@declaragent/source-kafka';
import type {
  KafkaAdminHandle,
  KafkaClient,
  KafkaConsumerHandle,
  KafkaEachMessage,
  KafkaIncomingMessage,
  KafkaProducerHandle,
  KafkaTriggerConfig,
} from '@declaragent/source-kafka';
import type { Producer, ProducerRecord } from 'kafkajs';
import { evaluateAcceptance } from './harness.js';
import { LOAD_SENT_HEADER, LOAD_SEQ_HEADER } from './kafka-producer.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

/**
 * Builds a stubbed kafkajs `Producer` that forwards every `.send()`
 * directly into a linked `KafkaConsumerHandle` stub. This lets us run
 * the full harness flow (load producer → consumer → bus → tracker)
 * end-to-end without a real broker.
 */
function makeInMemoryKafka(): {
  kafkaClient: KafkaClient;
  producer: Producer;
  deliver(msg: KafkaIncomingMessage): Promise<void>;
} {
  let consumerHandler: KafkaEachMessage | null = null;
  let offset = 0;

  const consumer: KafkaConsumerHandle = {
    async connect() {},
    async disconnect() {
      consumerHandler = null;
    },
    async subscribe() {},
    async run(h) {
      consumerHandler = h;
    },
    async commitOffset() {},
    async seek() {},
    pause() {},
    resume() {},
    onRebalance() {
      return () => {};
    },
    async fetchCommittedOffsets() {
      return [];
    },
  };
  const producerHandle: KafkaProducerHandle = {
    async connect() {},
    async disconnect() {},
    async send() {},
  };
  const admin: KafkaAdminHandle = {
    async connect() {},
    async disconnect() {},
    async fetchTopicEndOffsets() {
      return [];
    },
    async fetchTopicOffsetsByTimestamp() {
      return [];
    },
  };
  const kafkaClient: KafkaClient = {
    createConsumer() {
      return consumer;
    },
    createProducer() {
      return producerHandle;
    },
    createAdmin() {
      return admin;
    },
    async disconnect() {},
  };

  // Minimal kafkajs-`Producer` surface: the load producer only calls
  // `.connect()`, `.send()`, `.disconnect()`.
  const producer = {
    async connect() {},
    async disconnect() {},
    async send(record: ProducerRecord) {
      for (const m of record.messages) {
        const headers: Record<string, Uint8Array | string | undefined> = {};
        if (m.headers) {
          for (const [k, v] of Object.entries(m.headers)) {
            if (v === undefined) continue;
            headers[k] = typeof v === 'string' ? v : new Uint8Array(v as Buffer);
          }
        }
        const rawValue = m.value;
        const value =
          typeof rawValue === 'string'
            ? new TextEncoder().encode(rawValue)
            : rawValue instanceof Uint8Array
              ? rawValue
              : new Uint8Array(0);
        const incoming: KafkaIncomingMessage = {
          topic: record.topic,
          partition: 0,
          offset: String(offset++),
          value,
          headers,
          timestamp: Date.now(),
        };
        await deliver(incoming);
      }
      return [];
    },
  } as unknown as Producer;

  async function deliver(msg: KafkaIncomingMessage): Promise<void> {
    if (consumerHandler) await consumerHandler(msg);
  }

  return { kafkaClient, producer, deliver };
}

describe('runAcceptance (in-memory Kafka stub)', () => {
  test('processes every produced message with zero drops + reports p99', async () => {
    const { kafkaClient, producer } = makeInMemoryKafka();
    const adapter = createKafkaAdapter({ client: kafkaClient });

    // Wrap the load producer to use our in-memory kafkajs `Producer`.
    // The harness doesn't expose a hook for this, so we monkey-patch
    // the adapter's create by supplying the producer via a custom
    // `runAcceptance` invocation that fronts the producer directly.
    // Simplest path: call `runKafkaLoadProducer` ourselves via the
    // harness by temporarily replacing `producer` inside its impl —
    // here we bypass by testing the pipeline with a small direct
    // integration.

    // Inline mini-harness: start the source, kick off the kafkajs stub
    // producer sending 20 messages, then wait for the tracker to reach
    // unique=20.
    const config: KafkaTriggerConfig = {
      id: 'acc',
      transport: {
        brokers: ['stub:9092'],
        consumerGroup: 'acc',
        topics: ['acc-topic'],
      },
      routing: {
        format: 'json',
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'broadcast' },
      },
      delivery: {
        mode: 'at-least-once',
        ackStrategy: 'after-publish',
        maxRetries: 0,
        retryBackoff: { initialMs: 1, maxMs: 5, jitter: false },
        idempotency: { strategy: 'transport-natural', ttlMs: 60_000, store: 'memory' },
      },
      limits: { concurrency: 4, maxInflight: 100 },
    };

    // Inline mini-harness: mirrors `runAcceptance`'s steps with a
    // caller-supplied `producer` override so the test stays in-memory.
    const { runKafkaLoadProducer } = await import('./kafka-producer.js');
    const { LoadTracker } = await import('./tracker.js');
    const { passthroughNormalizer } = await import('./harness.js');
    const { createEventBus } = await import('@declaragent/core');

    const bus = createEventBus({ logger: NOOP_LOGGER });
    const tracker = new LoadTracker({ bus, expected: 20 });
    tracker.start();

    const deps: SourceDependencies = {
      bus,
      logger: NOOP_LOGGER,
      configDir: '/tmp',
      normalizer: passthroughNormalizer(),
    };
    const instance: EventSourceInstance = await adapter.create(config, deps);
    await instance.start();

    try {
      await runKafkaLoadProducer({
        brokers: ['stub:9092'],
        topic: 'acc-topic',
        ratePerSec: 1000,
        totalMessages: 20,
        producer,
      });

      // Drain: the in-memory producer calls the consumer synchronously
      // inside `send`, so uniqueCount should already be 20. Still give
      // one macrotask for any stragglers.
      for (let i = 0; i < 20; i++) {
        if (tracker.uniqueCount() >= 20) break;
        await new Promise((r) => setTimeout(r, 5));
      }

      const report = tracker.report();
      expect(report.unique).toBe(20);
      expect(report.missing).toBe(0);
      expect(report.duplicates).toBe(0);
      // Latencies are tiny in-memory — just assert we recorded them.
      expect(report.latency.max).toBeGreaterThanOrEqual(0);
    } finally {
      tracker.stop();
      await instance.stop();
    }
  });

  test('evaluateAcceptance flags p99 over the threshold', () => {
    const verdict = evaluateAcceptance(
      {
        produced: 100,
        producerElapsedMs: 100,
        producerActualRatePerSec: 1000,
        producerSendErrors: 0,
        waitElapsedMs: 100,
        brokerRestartedAt: null,
        tracker: {
          processed: 100,
          unique: 100,
          duplicates: 0,
          missing: 0,
          firstEventAt: 0,
          lastEventAt: 100,
          durationMs: 100,
          latency: { avg: 100, min: 10, max: 6000, p50: 50, p95: 5500, p99: 6000 },
          duplicateExamples: [],
          missingExamples: [],
        },
      },
      { p99LatencyMs: 5000 },
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0]).toMatch(/p99/);
  });

  test('evaluateAcceptance passes a clean run', () => {
    const verdict = evaluateAcceptance({
      produced: 100,
      producerElapsedMs: 100,
      producerActualRatePerSec: 1000,
      producerSendErrors: 0,
      waitElapsedMs: 100,
      brokerRestartedAt: null,
      tracker: {
        processed: 100,
        unique: 100,
        duplicates: 0,
        missing: 0,
        firstEventAt: 0,
        lastEventAt: 100,
        durationMs: 100,
        latency: { avg: 10, min: 1, max: 50, p50: 10, p95: 40, p99: 48 },
        duplicateExamples: [],
        missingExamples: [],
      },
    });
    expect(verdict.passed).toBe(true);
  });
});

// Silence unused-import warnings in the minimal-harness test above.
void LOAD_SEQ_HEADER;
void LOAD_SENT_HEADER;
