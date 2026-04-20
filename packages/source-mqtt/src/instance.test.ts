import { describe, expect, test } from 'bun:test';
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
import { createMqttAdapter } from './adapter.js';
import type {
  MqttClient,
  MqttIncomingMessage,
  MqttMessageHandler,
  MqttPublishOptions,
  MqttSubscription,
} from './client.js';
import type { MqttTriggerConfig } from './config.js';
import { topicMatches } from './config.js';
import { MqttSourceInstance } from './instance.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

// ── Stub MqttClient ────────────────────────────────────────────────────────

interface StubClient extends MqttClient {
  deliver(msg: MqttIncomingMessage): Promise<void>;
  readonly published: Array<{
    topic: string;
    payload: Uint8Array | string;
    opts?: MqttPublishOptions;
  }>;
  readonly subscribeCalls: Array<readonly MqttSubscription[]>;
  readonly unsubscribeCalls: Array<readonly string[]>;
  connected: boolean;
  connectShouldFail: boolean;
}

function makeStubClient(): StubClient {
  let handler: MqttMessageHandler | null = null;
  const published: StubClient['published'] = [];
  const subscribeCalls: StubClient['subscribeCalls'] = [];
  const unsubscribeCalls: StubClient['unsubscribeCalls'] = [];
  const stub: StubClient = {
    connected: false,
    connectShouldFail: false,
    published,
    subscribeCalls,
    unsubscribeCalls,
    async connect() {
      if (this.connectShouldFail) throw new Error('boom');
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async subscribe(subs) {
      subscribeCalls.push([...subs]);
    },
    async unsubscribe(topics) {
      unsubscribeCalls.push([...topics]);
    },
    async publish(topic, payload, opts) {
      published.push({
        topic,
        payload,
        ...(opts !== undefined && { opts }),
      });
    },
    onMessage(h) {
      handler = h;
      return () => {
        if (handler === h) handler = null;
      };
    },
    isConnected() {
      return this.connected;
    },
    async deliver(msg) {
      if (!handler) throw new Error('handler not registered');
      await handler(msg);
    },
  };
  return stub;
}

// ── Test helpers ───────────────────────────────────────────────────────────

function passthroughNormalizer(): MessageNormalizer {
  return {
    async normalize(raw: RawMessage): Promise<AgentEvent | null> {
      return {
        id: `evt-${raw.meta?.messageId ?? Math.random()}`,
        kind: 'trigger.fire',
        source: { type: 'self', reason: 'wakeup' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: raw.value,
        auth: { kind: 'internal' },
        ...(raw.headers !== undefined && { meta: { idempotencyKey: '' } }),
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

function buildConfig(overrides: Partial<MqttTriggerConfig> = {}): MqttTriggerConfig {
  return {
    id: 'test-mqtt',
    transport: {
      brokerUrl: 'mqtt://localhost:1883',
      clientId: 'declaragent-test',
      subscriptions: [{ topic: 'sensors/+/temperature', qos: 1 }],
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
  overrides: Partial<MqttTriggerConfig> = {},
  depsOverride?: SourceDependencies,
): { source: MqttSourceInstance; client: StubClient; deps: SourceDependencies } {
  const client = makeStubClient();
  const config = buildConfig(overrides);
  const deps = depsOverride ?? buildDeps();
  const source = new MqttSourceInstance(config, deps, client);
  return { source, client, deps };
}

function msg(partial: Partial<MqttIncomingMessage> = {}): MqttIncomingMessage {
  return {
    topic: 'sensors/room-1/temperature',
    payload: new TextEncoder().encode('{"value":42}'),
    qos: 1,
    retain: false,
    dup: false,
    userProperties: {},
    messageId: 1,
    ...partial,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MqttSourceInstance lifecycle', () => {
  test('start connects client and subscribes to every configured topic', async () => {
    const { source, client } = buildInstance({
      transport: {
        brokerUrl: 'mqtt://broker:1883',
        clientId: 'c1',
        subscriptions: [
          { topic: 'a/+', qos: 0 },
          { topic: 'b/#', qos: 2 },
        ],
      },
    });
    await source.start();
    expect(client.connected).toBe(true);
    expect(client.subscribeCalls).toHaveLength(1);
    expect(client.subscribeCalls[0]).toEqual([
      { topic: 'a/+', qos: 0 },
      { topic: 'b/#', qos: 2 },
    ]);
    await source.stop();
    expect(client.connected).toBe(false);
  });

  test('connection error surfaces + increments connectionErrors counter', async () => {
    const { source, client } = buildInstance();
    client.connectShouldFail = true;
    await expect(source.start()).rejects.toThrow('boom');
    const h = await source.health();
    expect(h.connectionErrors).toBe(1);
  });

  test('pause unsubscribes and resume re-subscribes', async () => {
    const { source, client } = buildInstance({
      transport: {
        brokerUrl: 'mqtt://broker:1883',
        clientId: 'c1',
        subscriptions: [
          { topic: 'a/+', qos: 1 },
          { topic: 'b/#', qos: 2 },
        ],
      },
    });
    await source.start();
    await source.pause();
    expect(client.unsubscribeCalls).toHaveLength(1);
    expect(client.unsubscribeCalls[0]).toEqual(['a/+', 'b/#']);
    await source.resume();
    // 1 initial subscribe on start + 1 on resume.
    expect(client.subscribeCalls).toHaveLength(2);
    await source.stop();
  });

  test('healthDetails reports broker + subscriptions + connected flag', async () => {
    const { source, client } = buildInstance();
    await source.start();
    const h = await source.health();
    expect(h.details).toMatchObject({
      brokerUrl: 'mqtt://localhost:1883',
      subscriptions: [{ topic: 'sensors/+/temperature', qos: 1 }],
      connected: true,
      pendingRetries: 0,
    });
    void client;
    await source.stop();
  });
});

describe('MqttSourceInstance message flow', () => {
  test('successful QoS 1 message is published to the bus', async () => {
    const { source, client, deps } = buildInstance();
    const events: AgentEvent[] = [];
    deps.bus.subscribe('*', (e) => {
      events.push(e);
    });
    await source.start();
    await client.deliver(msg());
    expect(events).toHaveLength(1);
    expect(source.metrics().messagesProcessed).toBe(1);
    await source.stop();
  });

  test('filter-dropped message still "acks" (no side-effects, no error)', async () => {
    const dropAll: MessageNormalizer = {
      async normalize() {
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(dropAll));
    await source.start();
    await client.deliver(msg());
    // Nothing published, counter stays at 0, and no error propagated.
    expect(source.metrics().messagesProcessed).toBe(0);
    expect(source.metrics().messagesFailed).toBe(0);
    await source.stop();
  });

  test('MQTT 5 user-properties land on raw.headers', async () => {
    const captured: Record<string, unknown>[] = [];
    const capturer: MessageNormalizer = {
      async normalize(raw: RawMessage): Promise<AgentEvent | null> {
        captured.push(raw.headers ?? {});
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(capturer));
    await source.start();
    await client.deliver(
      msg({
        userProperties: { 'trace-id': 'abc-123', region: 'us-east-1' },
      }),
    );
    expect(captured[0]).toMatchObject({
      'trace-id': 'abc-123',
      region: 'us-east-1',
      'x-mqtt-qos': '1',
    });
    await source.stop();
  });

  test('failure path: nack increments pendingRetries; exhaustion publishes to DLQ + clears', async () => {
    const config = buildConfig({
      delivery: { ...DEFAULT_DELIVERY, maxRetries: 2 },
      dlq: { topic: 'declaragent/dlq' },
    });
    const client = makeStubClient();
    const deps = buildDeps(failingNormalizer());
    const source = new MqttSourceInstance(config, deps, client);
    await source.start();

    // attempt 0 → nack; attempt 1 → nack; attempt 2 → DLQ.
    await client.deliver(msg({ messageId: 7 }));
    expect(client.published).toHaveLength(0);
    expect((await source.health()).details).toMatchObject({ pendingRetries: 1 });

    await client.deliver(msg({ messageId: 7 }));
    expect(client.published).toHaveLength(0);

    await client.deliver(msg({ messageId: 7 }));
    expect(client.published).toHaveLength(1);
    expect(client.published[0]?.topic).toBe('declaragent/dlq');
    expect(client.published[0]?.opts?.userProperties).toMatchObject({
      'x-declaragent-dlq-reason': 'normalize failed',
      'x-declaragent-origin-topic': 'sensors/room-1/temperature',
    });
    expect(source.metrics().messagesDLQ).toBe(1);
    await source.stop();
  });

  test('log-and-drop when DLQ is not configured on retry exhaustion', async () => {
    const config = buildConfig({ delivery: { ...DEFAULT_DELIVERY, maxRetries: 0 } });
    const client = makeStubClient();
    const deps = buildDeps(failingNormalizer());
    const source = new MqttSourceInstance(config, deps, client);
    await source.start();
    await client.deliver(msg({ messageId: 3 }));
    expect(client.published).toHaveLength(0);
    expect(source.metrics().messagesDLQ).toBe(1);
    await source.stop();
  });

  test('QoS 0 messages drop the retry loop (no redelivery possible)', async () => {
    const config = buildConfig({
      delivery: { ...DEFAULT_DELIVERY, maxRetries: 5 },
    });
    const client = makeStubClient();
    const deps = buildDeps(failingNormalizer());
    const source = new MqttSourceInstance(config, deps, client);
    await source.start();
    // QoS 0 messages have no packet id — the adapter nacks once and then
    // moves on because MQTT can't re-deliver QoS 0.
    await client.deliver(msg({ qos: 0 }));
    // Attempt counter is cleared after nack-qos0, so no pending retries.
    expect((await source.health()).details).toMatchObject({ pendingRetries: 0 });
    await source.stop();
  });
});

describe('topicMatches wildcard helper', () => {
  test('exact topic matches', () => {
    expect(topicMatches('sensors/a/temp', 'sensors/a/temp')).toBe(true);
  });

  test('+ matches a single level', () => {
    expect(topicMatches('sensors/+/temp', 'sensors/a/temp')).toBe(true);
    expect(topicMatches('sensors/+/temp', 'sensors/b/temp')).toBe(true);
    // Two-level mismatch
    expect(topicMatches('sensors/+/temp', 'sensors/a/b/temp')).toBe(false);
    // Empty level — per MQTT spec + does NOT match empty
    expect(topicMatches('sensors/+/temp', 'sensors//temp')).toBe(false);
  });

  test('# matches multiple levels including zero', () => {
    expect(topicMatches('sensors/#', 'sensors/a')).toBe(true);
    expect(topicMatches('sensors/#', 'sensors/a/b/c')).toBe(true);
    expect(topicMatches('#', 'anything/at/all')).toBe(true);
    // Wrong prefix
    expect(topicMatches('sensors/#', 'devices/a')).toBe(false);
  });

  test('different-length topics without wildcard do not match', () => {
    expect(topicMatches('a/b', 'a/b/c')).toBe(false);
    expect(topicMatches('a/b/c', 'a/b')).toBe(false);
  });
});

describe('createMqttAdapter', () => {
  test('validateConfig rejects missing brokerUrl', () => {
    const adapter = createMqttAdapter();
    expect(() =>
      adapter.validateConfig({
        id: 'x',
        transport: { clientId: 'c', subscriptions: [{ topic: 't', qos: 1 }] },
        routing: DEFAULT_ROUTING,
        delivery: DEFAULT_DELIVERY,
        limits: DEFAULT_LIMITS,
      }),
    ).toThrow(/brokerUrl/);
  });

  test('validateConfig rejects invalid qos', () => {
    const adapter = createMqttAdapter();
    expect(() =>
      adapter.validateConfig({
        id: 'x',
        transport: {
          brokerUrl: 'mqtt://b:1883',
          clientId: 'c',
          subscriptions: [{ topic: 't', qos: 9 }],
        },
        routing: DEFAULT_ROUTING,
        delivery: DEFAULT_DELIVERY,
        limits: DEFAULT_LIMITS,
      }),
    ).toThrow(/qos/);
  });

  test('validateConfig rejects empty subscriptions', () => {
    const adapter = createMqttAdapter();
    expect(() =>
      adapter.validateConfig({
        id: 'x',
        transport: {
          brokerUrl: 'mqtt://b:1883',
          clientId: 'c',
          subscriptions: [],
        },
        routing: DEFAULT_ROUTING,
        delivery: DEFAULT_DELIVERY,
        limits: DEFAULT_LIMITS,
      }),
    ).toThrow(/subscriptions/);
  });

  test('validateConfig accepts a minimal valid config', () => {
    const adapter = createMqttAdapter();
    expect(() => adapter.validateConfig(buildConfig())).not.toThrow();
  });

  test('create returns an MqttSourceInstance end-to-end with injected client', async () => {
    const client = makeStubClient();
    const adapter = createMqttAdapter({ client });
    const deps = buildDeps();
    const inst = await adapter.create(buildConfig(), deps);
    expect(inst.type).toBe('mqtt');
    expect(inst.id).toBe('test-mqtt');
    await inst.start();
    expect(client.connected).toBe(true);
    // Deliver one message and confirm it's processed.
    await client.deliver(msg());
    expect(inst.metrics().messagesProcessed).toBe(1);
    await inst.stop();
  });
});
