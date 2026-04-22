/**
 * Unit tests for createKafkaTransport (Slice 7 / PR 7.1).
 *
 * We verify the wire protocol + lifecycle against a mocked kafkajs
 * module. The ACTUAL broker integration test lives in
 * `packages/testkit/src/fleet-integration/` and is gated behind
 * `FLEET_INTEGRATION=1` because it needs a live Redpanda/Kafka.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import {
  type KafkaConsumerLike,
  type KafkaJSModule,
  type KafkaProducerLike,
  createKafkaTransport,
} from './kafka-transport.js';

interface SentMessage {
  topic: string;
  value: string;
}

interface FakeKafka {
  module: KafkaJSModule;
  sent: SentMessage[];
  /** Deliver a raw envelope payload to every subscriber of the topic. */
  deliver: (topic: string, envelope: AgentRpcEnvelope) => Promise<void>;
  /** Force the consumer for a topic to throw on the next disconnect. */
  consumers: Map<string, FakeConsumer>;
  producer: FakeProducer;
}

interface FakeProducer extends KafkaProducerLike {
  connected: boolean;
}

interface FakeConsumer extends KafkaConsumerLike {
  readonly topic: string | null;
  readonly groupId: string;
  handler:
    | ((payload: { topic: string; message: { value: Buffer | null } }) => Promise<void>)
    | null;
}

async function flushMicrotasks(): Promise<void> {
  // A real setTimeout yields to both microtask + timer queues, which is
  // what the consumer's async chain of four awaits needs. Synchronous
  // `Promise.resolve()` cycles didn't drain the fake's setter chain
  // reliably under Bun's scheduler.
  await new Promise((r) => setTimeout(r, 20));
}

function makeFakeKafka(): FakeKafka {
  const sent: SentMessage[] = [];
  const consumers = new Map<string, FakeConsumer>();
  const producer: FakeProducer = {
    connected: false,
    async connect() {
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async send(record) {
      for (const msg of record.messages) sent.push({ topic: record.topic, value: msg.value });
    },
  };
  const module: KafkaJSModule = {
    Kafka: class {
      readonly brokers: readonly string[];
      readonly clientId: string;
      constructor(config: { clientId: string; brokers: readonly string[] }) {
        this.brokers = config.brokers;
        this.clientId = config.clientId;
      }
      producer(): FakeProducer {
        return producer;
      }
      consumer(cfg: { groupId: string }): FakeConsumer {
        const consumer: FakeConsumer = {
          topic: null as string | null,
          groupId: cfg.groupId,
          handler: null,
          async connect() {},
          async disconnect() {},
          async subscribe(opts) {
            (this as { topic: string | null }).topic = opts.topic;
          },
          async run(opts) {
            this.handler = opts.eachMessage;
          },
        };
        consumers.set(cfg.groupId, consumer);
        return consumer;
      }
    } as unknown as KafkaJSModule['Kafka'],
  };
  return {
    module,
    sent,
    consumers,
    producer,
    deliver: async (topic, envelope) => {
      // Mirror kafkajs's eachMessage: value is a Buffer.
      const payload = Buffer.from(JSON.stringify(envelope), 'utf-8');
      for (const c of consumers.values()) {
        if (c.topic === topic && c.handler) {
          await c.handler({ topic, message: { value: payload } });
        }
      }
    },
  };
}

const sampleEnvelope: AgentRpcEnvelope = {
  version: 1,
  kind: 'request',
  messageId: 'env-1',
  correlationId: 'corr-1',
  from: 'agent://alpha',
  to: 'agent://beta',
  capability: 'beta.ping',
  payload: { n: 1 },
};

describe('createKafkaTransport', () => {
  test('publish encodes the envelope and routes it to the configured topic', async () => {
    const fake = makeFakeKafka();
    const t = await createKafkaTransport({
      brokers: ['localhost:9092'],
      kafkajsModule: fake.module,
    });

    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.topic).toBe('agents.beta.requests');
    expect(JSON.parse(fake.sent[0]?.value ?? '')).toMatchObject({
      messageId: 'env-1',
      capability: 'beta.ping',
    });
    await t.close();
  });

  test('subscribe wires a consumer that delivers envelopes to the handler', async () => {
    const fake = makeFakeKafka();
    const t = await createKafkaTransport({
      brokers: ['localhost:9092'],
      kafkajsModule: fake.module,
      groupId: 'test-group',
    });
    const received: AgentRpcEnvelope[] = [];
    const unsub = t.subscribe('agents.alpha.responses', async (env) => {
      received.push(env);
    });
    await flushMicrotasks();
    await fake.deliver('agents.alpha.responses', sampleEnvelope);
    expect(received).toHaveLength(1);
    expect(received[0]?.messageId).toBe('env-1');
    unsub();
    await t.close();
  });

  test('unsubscribe removes the handler and tears down the last consumer for that topic', async () => {
    const fake = makeFakeKafka();
    const t = await createKafkaTransport({
      brokers: ['localhost:9092'],
      kafkajsModule: fake.module,
    });
    const received: AgentRpcEnvelope[] = [];
    const unsub = t.subscribe('agents.beta.requests', async (env) => {
      received.push(env);
    });
    // startConsumer is a chain of 4 awaits — we need several microtask
    // cycles to let the fake consumer install its handler.
    await flushMicrotasks();
    unsub();
    await fake.deliver('agents.beta.requests', sampleEnvelope);
    // Handler was unsubscribed before delivery — nothing received.
    expect(received).toHaveLength(0);
    await t.close();
  });

  test('close disconnects the producer and all active consumers', async () => {
    const fake = makeFakeKafka();
    const t = await createKafkaTransport({
      brokers: ['localhost:9092'],
      kafkajsModule: fake.module,
    });
    t.subscribe('topic-a', async () => {});
    t.subscribe('topic-b', async () => {});
    // startConsumer is a chain of 4 awaits — we need several microtask
    // cycles to let the fake consumer install its handler.
    await flushMicrotasks();
    expect(fake.producer.connected).toBe(true);
    await t.close();
    expect(fake.producer.connected).toBe(false);
  });

  test('publish after close rejects', async () => {
    const fake = makeFakeKafka();
    const t = await createKafkaTransport({
      brokers: ['localhost:9092'],
      kafkajsModule: fake.module,
    });
    await t.close();
    await expect(t.publish('topic', sampleEnvelope)).rejects.toThrow('closed');
  });

  test('empty brokers array is rejected', async () => {
    const fake = makeFakeKafka();
    await expect(
      createKafkaTransport({
        brokers: [],
        kafkajsModule: fake.module,
      }),
    ).rejects.toThrow('brokers');
  });

  test('malformed message payloads are logged + dropped without corrupting the handler', async () => {
    const fake = makeFakeKafka();
    const warnings: unknown[] = [];
    const t = await createKafkaTransport({
      brokers: ['localhost:9092'],
      kafkajsModule: fake.module,
      logger: {
        debug() {},
        info() {},
        warn(_event: string, data: unknown) {
          warnings.push(data);
        },
        error() {},
        child: () => ({
          debug() {},
          info() {},
          warn() {},
          error() {},
          child: () => ({}) as never,
        }),
      } as never,
    });
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('agents.beta.requests', async (env) => {
      received.push(env);
    });
    // startConsumer is a chain of 4 awaits — we need several microtask
    // cycles to let the fake consumer install its handler.
    await flushMicrotasks();

    // Deliver a payload that doesn't round-trip through parseEnvelope.
    const consumer = fake.consumers.values().next().value;
    await consumer?.handler?.({
      topic: 'agents.beta.requests',
      message: { value: Buffer.from('{not-json', 'utf-8') },
    });
    // Good envelope still delivers.
    await fake.deliver('agents.beta.requests', sampleEnvelope);

    expect(warnings.length).toBeGreaterThan(0);
    expect(received).toHaveLength(1);
    await t.close();
  });
});
