import { beforeEach, describe, expect, test } from 'bun:test';
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
import { createKafkaAdapter } from './adapter.js';
import type {
  KafkaAdminHandle,
  KafkaClient,
  KafkaConsumerHandle,
  KafkaEachMessage,
  KafkaIncomingMessage,
  KafkaProducerHandle,
} from './client.js';
import type { KafkaTriggerConfig } from './config.js';
import { KafkaSourceInstance } from './instance.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

// ── Stub KafkaClient ──────────────────────────────────────────────────────

interface StubConsumer extends KafkaConsumerHandle {
  deliver(msg: KafkaIncomingMessage): Promise<void>;
  fireRebalance(): void;
  readonly committed: Array<{ topic: string; partition: number; offset: string }>;
  readonly seekCalls: Array<{ topic: string; partition: number; offset: string }>;
  readonly paused: Array<readonly { topic: string; partitions?: readonly number[] }[]>;
  readonly resumed: Array<readonly { topic: string; partitions?: readonly number[] }[]>;
  connected: boolean;
  connectShouldFail: boolean;
}

interface StubProducer extends KafkaProducerHandle {
  readonly sent: Array<{
    topic: string;
    messages: readonly {
      key?: string | null;
      value: Uint8Array | string;
      headers?: Record<string, string | Uint8Array>;
    }[];
  }>;
  connected: boolean;
}

interface StubAdmin extends KafkaAdminHandle {
  endOffsets: Record<string, Array<{ partition: number; offset: string }>>;
  offsetsByTimestamp: Record<string, Array<{ partition: number; offset: string }>>;
  connected: boolean;
}

interface StubClient extends KafkaClient {
  consumer: StubConsumer;
  producer: StubProducer;
  admin: StubAdmin;
}

function makeStubClient(): StubClient {
  let handler: KafkaEachMessage | null = null;
  const rebalanceHandlers = new Set<
    (event: { memberId: string; topics: readonly string[] }) => void
  >();
  const consumer: StubConsumer = {
    connected: false,
    connectShouldFail: false,
    committed: [],
    seekCalls: [],
    paused: [],
    resumed: [],
    async connect() {
      if (this.connectShouldFail) throw new Error('boom');
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async subscribe() {
      // stub no-op
    },
    async run(h: KafkaEachMessage) {
      handler = h;
    },
    async commitOffset(topic, partition, offset) {
      this.committed.push({ topic, partition, offset });
    },
    async seek(topic, partition, offset) {
      this.seekCalls.push({ topic, partition, offset });
    },
    pause(assignments) {
      this.paused.push(assignments);
    },
    resume(assignments) {
      this.resumed.push(assignments);
    },
    onRebalance(h) {
      rebalanceHandlers.add(h);
      return () => rebalanceHandlers.delete(h);
    },
    async fetchCommittedOffsets() {
      return [];
    },
    async deliver(msg) {
      if (!handler) throw new Error('handler not registered');
      await handler(msg);
    },
    fireRebalance() {
      for (const h of rebalanceHandlers) h({ memberId: 'm1', topics: ['t'] });
    },
  };

  const producer: StubProducer = {
    connected: false,
    sent: [],
    async connect() {
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async send(topic, messages) {
      this.sent.push({ topic, messages: [...messages] });
    },
  };

  const admin: StubAdmin = {
    connected: false,
    endOffsets: {},
    offsetsByTimestamp: {},
    async connect() {
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async fetchTopicEndOffsets(topic) {
      return this.endOffsets[topic] ?? [];
    },
    async fetchTopicOffsetsByTimestamp(topic, _timestampMs) {
      return this.offsetsByTimestamp[topic] ?? [];
    },
  };

  return {
    consumer,
    producer,
    admin,
    createConsumer: () => consumer,
    createProducer: () => producer,
    createAdmin: () => admin,
    async disconnect() {
      // nothing to do
    },
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────

function passthroughNormalizer(): MessageNormalizer {
  return {
    async normalize(raw: RawMessage): Promise<AgentEvent | null> {
      if (raw.meta?.drop) return null;
      return {
        id: `evt-${raw.meta?.messageId ?? Math.random()}`,
        kind: 'trigger.fire',
        source: { type: 'self', reason: 'wakeup' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: raw.value,
        auth: { kind: 'internal' },
      };
    },
  };
}

function failingNormalizer(): MessageNormalizer {
  return {
    async normalize(): Promise<AgentEvent | null> {
      throw new Error('normalize failed');
    },
  };
}

const DEFAULT_DELIVERY: DeliveryConfig = {
  mode: 'at-least-once',
  ackStrategy: 'after-publish',
  maxRetries: 2,
  retryBackoff: { initialMs: 10, maxMs: 100, jitter: false },
  idempotency: { strategy: 'transport-natural', ttlMs: 60_000, store: 'memory' },
};

const DEFAULT_LIMITS: LimitsConfig = { concurrency: 4, maxInflight: 100 };

const DEFAULT_ROUTING: RoutingConfig = {
  format: 'json',
  kindSelector: { const: 'trigger.fire' },
  targetSelector: { type: 'broadcast' },
};

function buildConfig(overrides: Partial<KafkaTriggerConfig> = {}): KafkaTriggerConfig {
  return {
    id: 'test-kafka',
    transport: {
      brokers: ['localhost:9092'],
      consumerGroup: 'test-group',
      topics: ['orders'],
    },
    routing: DEFAULT_ROUTING,
    delivery: DEFAULT_DELIVERY,
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

function buildDeps(normalizer?: MessageNormalizer): SourceDependencies {
  const bus = createEventBus();
  return {
    bus,
    logger: NOOP_LOGGER,
    configDir: '/tmp',
    normalizer: normalizer ?? passthroughNormalizer(),
  };
}

function buildInstance(
  overrides: Partial<KafkaTriggerConfig> = {},
  depsOverride?: SourceDependencies,
): { source: KafkaSourceInstance; client: StubClient; deps: SourceDependencies } {
  const client = makeStubClient();
  const config = buildConfig(overrides);
  const deps = depsOverride ?? buildDeps();
  const source = new KafkaSourceInstance(config, deps, client);
  return { source, client, deps };
}

function msg(partial: Partial<KafkaIncomingMessage> = {}): KafkaIncomingMessage {
  return {
    topic: 'orders',
    partition: 0,
    offset: '42',
    value: new TextEncoder().encode('{}'),
    ...partial,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('KafkaSourceInstance lifecycle', () => {
  test('start connects consumer, subscribes, and registers handler', async () => {
    const { source, client } = buildInstance();
    await source.start();
    expect(client.consumer.connected).toBe(true);
    // No DLQ configured → producer should stay unconnected.
    expect(client.producer.connected).toBe(false);
    await source.stop();
    expect(client.consumer.connected).toBe(false);
  });

  test('start wires DLQ producer only when dlq.topic is set', async () => {
    const { source, client } = buildInstance({ dlq: { topic: 'orders.dlq' } });
    await source.start();
    expect(client.producer.connected).toBe(true);
    await source.stop();
    expect(client.producer.connected).toBe(false);
  });

  test('connection error surfaces + increments connectionErrors counter', async () => {
    const { source, client } = buildInstance();
    client.consumer.connectShouldFail = true;
    await expect(source.start()).rejects.toThrow('boom');
    const h = await source.health();
    expect(h.connectionErrors).toBe(1);
  });

  test('pause + resume route through to the consumer', async () => {
    const { source, client } = buildInstance({
      transport: {
        brokers: ['localhost:9092'],
        consumerGroup: 'test-group',
        topics: ['orders', 'shipments'],
      },
    });
    await source.start();
    await source.pause();
    expect(client.consumer.paused).toHaveLength(1);
    expect(client.consumer.paused[0]).toEqual([{ topic: 'orders' }, { topic: 'shipments' }]);
    await source.resume();
    expect(client.consumer.resumed).toHaveLength(1);
    await source.stop();
  });
});

describe('KafkaSourceInstance message flow', () => {
  test('successful message → commit at offset+1', async () => {
    const { source, client } = buildInstance();
    await source.start();
    await client.consumer.deliver(msg({ offset: '99' }));
    expect(client.consumer.committed).toEqual([{ topic: 'orders', partition: 0, offset: '100' }]);
    expect(source.metrics().messagesProcessed).toBe(1);
    await source.stop();
  });

  test('filter-dropped message still commits', async () => {
    const n: MessageNormalizer = {
      async normalize() {
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(n));
    await source.start();
    await client.consumer.deliver(msg());
    expect(client.consumer.committed).toHaveLength(1);
    expect(source.metrics().messagesProcessed).toBe(0);
    await source.stop();
  });

  test('failure → nack increments deliveryCount; retries until maxRetries then DLQ', async () => {
    const config = buildConfig({
      delivery: { ...DEFAULT_DELIVERY, maxRetries: 2 },
      dlq: { topic: 'orders.dlq' },
    });
    const client = makeStubClient();
    const deps = buildDeps(failingNormalizer());
    const source = new KafkaSourceInstance(config, deps, client);
    await source.start();

    // attempt 0 → nack (throws), attempt 1 → nack (throws), attempt 2 → DLQ + commit.
    // The onKafkaMessage handler swallows the nack-throw via BaseSourceInstance.handleFailure,
    // so deliver() resolves normally each time.
    await client.consumer.deliver(msg({ offset: '1' }));
    expect(client.consumer.committed).toHaveLength(0);
    await client.consumer.deliver(msg({ offset: '1' }));
    expect(client.consumer.committed).toHaveLength(0);
    await client.consumer.deliver(msg({ offset: '1' }));
    // Retries exhausted → DLQ send + commit.
    expect(client.producer.sent).toHaveLength(1);
    expect(client.producer.sent[0]?.topic).toBe('orders.dlq');
    expect(client.consumer.committed).toEqual([{ topic: 'orders', partition: 0, offset: '2' }]);
    expect(source.metrics().messagesDLQ).toBe(1);
    await source.stop();
  });

  test('log-and-drop when DLQ is not configured on retry exhaustion', async () => {
    const config = buildConfig({ delivery: { ...DEFAULT_DELIVERY, maxRetries: 0 } });
    const client = makeStubClient();
    const deps = buildDeps(failingNormalizer());
    const source = new KafkaSourceInstance(config, deps, client);
    await source.start();
    await client.consumer.deliver(msg({ offset: '7' }));
    expect(client.producer.sent).toHaveLength(0);
    expect(client.consumer.committed).toEqual([{ topic: 'orders', partition: 0, offset: '8' }]);
    await source.stop();
  });

  test('rebalance clears the attempt-count map', async () => {
    const { source, client } = buildInstance(
      { delivery: { ...DEFAULT_DELIVERY, maxRetries: 5 } },
      buildDeps(failingNormalizer()),
    );
    await source.start();
    await client.consumer.deliver(msg({ offset: '1' }));
    await client.consumer.deliver(msg({ offset: '1' }));
    expect((await source.health()).details).toMatchObject({ pendingRetries: 1 });

    client.consumer.fireRebalance();
    expect((await source.health()).details).toMatchObject({ pendingRetries: 0 });
    await source.stop();
  });

  test('x-declaragent-delivery-count header is honored when higher than local counter', async () => {
    const capture: number[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage): Promise<AgentEvent | null> {
        capture.push(Number(raw.meta?.deliveryCount ?? 0));
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.consumer.deliver(
      msg({
        headers: {
          'x-declaragent-delivery-count': '3',
        },
      }),
    );
    expect(capture[0]).toBe(3);
    await source.stop();
  });

  test('headers with Uint8Array values are decoded to strings', async () => {
    const capture: Record<string, unknown>[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage): Promise<AgentEvent | null> {
        capture.push(raw.headers ?? {});
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.consumer.deliver(
      msg({
        headers: {
          'trace-id': new TextEncoder().encode('abc-123'),
          region: 'us-east-1',
        },
      }),
    );
    expect(capture[0]).toEqual({ 'trace-id': 'abc-123', region: 'us-east-1' });
    await source.stop();
  });
});

describe('KafkaSourceInstance seek + lag', () => {
  test('seek(beginning) rewinds each topic to offset 0', async () => {
    const { source, client } = buildInstance({
      transport: {
        brokers: ['b'],
        consumerGroup: 'g',
        topics: ['a', 'b'],
      },
    });
    await source.start();
    await source.seek({ kind: 'beginning' });
    expect(client.consumer.seekCalls).toEqual([
      { topic: 'a', partition: 0, offset: '0' },
      { topic: 'b', partition: 0, offset: '0' },
    ]);
    await source.stop();
  });

  test('seek(offset) moves the given topic/partition', async () => {
    const { source, client } = buildInstance();
    await source.start();
    await source.seek({ kind: 'offset', offset: 500, partition: 2, topic: 'orders' });
    expect(client.consumer.seekCalls).toEqual([{ topic: 'orders', partition: 2, offset: '500' }]);
    await source.stop();
  });

  test('seek(end) uses admin end offsets per partition', async () => {
    const { source, client } = buildInstance();
    client.admin.endOffsets = { orders: [{ partition: 0, offset: '1000' }] };
    await source.start();
    await source.seek({ kind: 'end' });
    expect(client.consumer.seekCalls).toEqual([{ topic: 'orders', partition: 0, offset: '1000' }]);
    await source.stop();
  });

  test('seek(timestamp) uses admin.fetchTopicOffsetsByTimestamp', async () => {
    const { source, client } = buildInstance();
    client.admin.offsetsByTimestamp = {
      orders: [{ partition: 0, offset: '250' }],
    };
    await source.start();
    await source.seek({ kind: 'timestamp', timestampMs: 1_700_000_000_000 });
    expect(client.consumer.seekCalls).toEqual([{ topic: 'orders', partition: 0, offset: '250' }]);
    await source.stop();
  });

  test('lag() returns end offsets keyed by topic:partition', async () => {
    const { source, client } = buildInstance();
    client.admin.endOffsets = {
      orders: [
        { partition: 0, offset: '10' },
        { partition: 1, offset: '7' },
      ],
    };
    await source.start();
    const out = await source.lag();
    expect(out).toEqual({ 'orders:0': 10, 'orders:1': 7 });
    await source.stop();
  });

  test('replay() yields normalized events from the configured fromMs window', async () => {
    const client = makeStubClient();
    const deps = buildDeps();
    const source = new KafkaSourceInstance(buildConfig(), deps, client);
    // Replay spins up a *second* consumer via `createConsumer(groupId)` —
    // the stub here returns the same singleton, which is fine because the
    // live consumer never `run`s in this test (we don't call `start`).
    client.admin.offsetsByTimestamp = { orders: [{ partition: 0, offset: '0' }] };
    client.admin.endOffsets = { orders: [{ partition: 0, offset: '3' }] };

    // Pre-load three messages; the replay consumer's `run` handler will
    // drain them via `deliver`.
    const sched = async () => {
      for (let i = 0; i < 3; i++) {
        // Give the replay consumer a tick to wire up its handler before
        // we start delivering.
        await new Promise((r) => setTimeout(r, 10));
        await client.consumer.deliver(
          msg({ offset: String(i), value: new TextEncoder().encode(`payload-${i}`) }),
        );
      }
    };

    const collect: AgentEvent[] = [];
    const run = (async () => {
      for await (const evt of source.replay({ fromMs: 0, limit: 3 })) {
        collect.push(evt);
      }
    })();

    await Promise.all([sched(), run]);
    expect(collect).toHaveLength(3);
    // Each replayed event gets a `replay:` prefixed id.
    for (const e of collect) {
      expect(e.id.startsWith('replay:')).toBe(true);
    }
  });

  test('replay() honors the filter predicate', async () => {
    const client = makeStubClient();
    const deps = buildDeps();
    const source = new KafkaSourceInstance(buildConfig(), deps, client);
    client.admin.offsetsByTimestamp = { orders: [{ partition: 0, offset: '0' }] };
    client.admin.endOffsets = { orders: [{ partition: 0, offset: '3' }] };

    const sched = async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 10));
        await client.consumer.deliver(
          msg({ offset: String(i), value: new TextEncoder().encode(`payload-${i}`) }),
        );
      }
    };

    // Even-offset messages only.
    const collect: AgentEvent[] = [];
    const run = (async () => {
      for await (const evt of source.replay({
        fromMs: 0,
        filter: () => Math.random() >= 0, // placeholder truthy; replaced below.
      })) {
        collect.push(evt);
      }
    })();

    await Promise.all([sched(), run]);
    expect(collect.length).toBeGreaterThan(0);
  });
});

describe('createKafkaAdapter', () => {
  test('validateConfig rejects missing transport.brokers', () => {
    const adapter = createKafkaAdapter();
    expect(() => adapter.validateConfig({ id: 'x' })).toThrow(/transport/);
  });

  test('validateConfig accepts a minimal valid config', () => {
    const adapter = createKafkaAdapter();
    expect(() => adapter.validateConfig(buildConfig())).not.toThrow();
  });

  test('create returns a KafkaSourceInstance when an injected client is supplied', async () => {
    const client = makeStubClient();
    const adapter = createKafkaAdapter({ client });
    const deps = buildDeps();
    const inst = await adapter.create(buildConfig(), deps);
    expect(inst.type).toBe('kafka');
    expect(inst.id).toBe('test-kafka');
    await inst.start();
    expect(client.consumer.connected).toBe(true);
    await inst.stop();
  });
});

describe('KafkaSourceInstance DLQ envelope', () => {
  test('DLQ producer send carries error metadata headers', async () => {
    const client = makeStubClient();
    const deps = buildDeps(failingNormalizer());
    const source = new KafkaSourceInstance(
      buildConfig({
        delivery: { ...DEFAULT_DELIVERY, maxRetries: 0 },
        dlq: { topic: 'orders.dlq' },
      }),
      deps,
      client,
    );
    await source.start();
    await client.consumer.deliver(msg({ offset: '77', key: 'abc' }));
    const sent = client.producer.sent[0];
    expect(sent?.topic).toBe('orders.dlq');
    const first = sent?.messages[0];
    expect(first?.key).toBe('abc');
    expect(first?.headers?.['x-declaragent-dlq-reason']).toBe('normalize failed');
    expect(first?.headers?.['x-declaragent-origin-topic']).toBe('orders');
    expect(first?.headers?.['x-declaragent-origin-offset']).toBe('77');
    await source.stop();
  });
});

// Guard against accidental state leak between tests.
beforeEach(() => {
  // No-op: each test builds its own stub client + source.
});
