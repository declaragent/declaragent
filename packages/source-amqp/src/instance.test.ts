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
import { createAmqpAdapter } from './adapter.js';
import type {
  AmqpChannel,
  AmqpClient,
  AmqpIncomingMessage,
  AmqpMessageHandler,
  AmqpPublishOptions,
} from './client.js';
import type { AmqpTriggerConfig } from './config.js';
import { AmqpSourceInstance } from './instance.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

// ── Stub AmqpClient + AmqpChannel ─────────────────────────────────────────

interface StubChannel extends AmqpChannel {
  readonly assertedExchanges: Array<{ exchange: string; type: string }>;
  readonly assertedQueues: string[];
  readonly bindings: Array<{ queue: string; exchange: string; pattern: string }>;
  readonly prefetchCalls: number[];
  readonly acks: Array<{ deliveryTag: number }>;
  readonly nacks: Array<{ deliveryTag: number; requeue: boolean }>;
  readonly publishes: Array<{
    exchange: string;
    routingKey: string;
    content: Uint8Array;
    options?: AmqpPublishOptions;
  }>;
  consumerTag: string | null;
  deliver(msg: AmqpIncomingMessage): Promise<void>;
  closed: boolean;
}

interface StubClient extends AmqpClient {
  channel: StubChannel;
  connected: boolean;
  connectShouldFail: boolean;
}

function makeStubChannel(): StubChannel {
  let handler: AmqpMessageHandler | null = null;
  let nextTag = 1;
  const state = {
    assertedExchanges: [] as StubChannel['assertedExchanges'],
    assertedQueues: [] as string[],
    bindings: [] as StubChannel['bindings'],
    prefetchCalls: [] as number[],
    acks: [] as StubChannel['acks'],
    nacks: [] as StubChannel['nacks'],
    publishes: [] as StubChannel['publishes'],
    consumerTag: null as string | null,
    closed: false,
  };
  return {
    assertedExchanges: state.assertedExchanges,
    assertedQueues: state.assertedQueues,
    bindings: state.bindings,
    prefetchCalls: state.prefetchCalls,
    acks: state.acks,
    nacks: state.nacks,
    publishes: state.publishes,
    get consumerTag() {
      return state.consumerTag;
    },
    set consumerTag(v: string | null) {
      state.consumerTag = v;
    },
    get closed() {
      return state.closed;
    },
    set closed(v: boolean) {
      state.closed = v;
    },
    async assertExchange(exchange, type) {
      state.assertedExchanges.push({ exchange, type });
    },
    async assertQueue(queue) {
      state.assertedQueues.push(queue);
      return { queue };
    },
    async bindQueue(queue, exchange, pattern) {
      state.bindings.push({ queue, exchange, pattern });
    },
    async prefetch(count) {
      state.prefetchCalls.push(count);
    },
    async consume(_queue, h) {
      handler = h;
      const tag = `ct-${nextTag++}`;
      state.consumerTag = tag;
      return { consumerTag: tag };
    },
    async cancel() {
      handler = null;
      state.consumerTag = null;
    },
    ack(deliveryTag) {
      state.acks.push({ deliveryTag });
    },
    nack(deliveryTag, _allUpTo, requeue) {
      state.nacks.push({ deliveryTag, requeue: requeue ?? true });
    },
    async publish(exchange, routingKey, content, options) {
      state.publishes.push({ exchange, routingKey, content, ...(options && { options }) });
    },
    async close() {
      state.closed = true;
      handler = null;
    },
    async deliver(msg) {
      if (!handler) throw new Error('no consumer registered');
      await handler(msg);
    },
  };
}

function makeStubClient(): StubClient {
  const channel = makeStubChannel();
  const state = { connected: false, connectShouldFail: false };
  return {
    channel,
    get connected() {
      return state.connected;
    },
    set connected(v: boolean) {
      state.connected = v;
    },
    get connectShouldFail() {
      return state.connectShouldFail;
    },
    set connectShouldFail(v: boolean) {
      state.connectShouldFail = v;
    },
    async connect() {
      if (state.connectShouldFail) throw new Error('boom');
      state.connected = true;
    },
    async createConfirmChannel() {
      if (!state.connected) throw new Error('not connected');
      return channel;
    },
    async close() {
      state.connected = false;
    },
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────

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

function buildConfig(overrides: Partial<AmqpTriggerConfig> = {}): AmqpTriggerConfig {
  return {
    id: 'test-amqp',
    transport: {
      url: 'amqp://guest:guest@localhost:5672',
      queue: 'orders',
      ...overrides.transport,
    },
    routing: DEFAULT_ROUTING,
    delivery: DEFAULT_DELIVERY,
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

function buildDeps(normalizer?: MessageNormalizer): SourceDependencies {
  return {
    bus: createEventBus(),
    logger: NOOP_LOGGER,
    configDir: '/tmp',
    normalizer: normalizer ?? passthroughNormalizer(),
  };
}

function makeMsg(partial: Partial<AmqpIncomingMessage> = {}): AmqpIncomingMessage {
  return {
    content: partial.content ?? new TextEncoder().encode('{}'),
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: '',
      routingKey: 'orders.created',
      consumerTag: 'ct-1',
      ...partial.fields,
    },
    properties: partial.properties ?? {},
  };
}

function buildInstance(
  overrides: Partial<AmqpTriggerConfig> = {},
  depsOverride?: SourceDependencies,
): { source: AmqpSourceInstance; client: StubClient; deps: SourceDependencies } {
  const client = makeStubClient();
  const deps = depsOverride ?? buildDeps();
  const source = new AmqpSourceInstance(buildConfig(overrides), deps, client);
  return { source, client, deps };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AmqpSourceInstance lifecycle', () => {
  test('start connects, declares queue, sets prefetch, starts consumer', async () => {
    const { source, client } = buildInstance({
      limits: { concurrency: 2, maxInflight: 50 },
    });
    await source.start();
    expect(client.connected).toBe(true);
    expect(client.channel.assertedQueues).toEqual(['orders']);
    expect(client.channel.prefetchCalls).toEqual([50]);
    expect(client.channel.consumerTag).toBeTruthy();
    await source.stop();
    expect(client.channel.closed).toBe(true);
    expect(client.connected).toBe(false);
  });

  test('start declares DLX exchange when dlq is configured', async () => {
    const { source, client } = buildInstance({
      dlq: { exchange: 'orders.dlx', routingKey: 'dead', exchangeType: 'topic' },
    });
    await source.start();
    const dlxDecl = client.channel.assertedExchanges.find((e) => e.exchange === 'orders.dlx');
    expect(dlxDecl).toBeDefined();
    expect(dlxDecl?.type).toBe('topic');
    await source.stop();
  });

  test('prefetch override honors transport.prefetch (clamped by maxInflight)', async () => {
    const { source, client } = buildInstance({
      transport: {
        url: 'amqp://x',
        queue: 'orders',
        prefetch: 8,
      },
      limits: { concurrency: 2, maxInflight: 50 },
    });
    await source.start();
    expect(client.channel.prefetchCalls).toEqual([8]);
    await source.stop();
  });

  test('prefetch is clamped DOWN to maxInflight when prefetch is higher', async () => {
    const { source, client } = buildInstance({
      transport: { url: 'amqp://x', queue: 'orders', prefetch: 500 },
      limits: { concurrency: 2, maxInflight: 20 },
    });
    await source.start();
    expect(client.channel.prefetchCalls).toEqual([20]);
    await source.stop();
  });

  test('connection error surfaces + increments connectionErrors', async () => {
    const { source, client } = buildInstance();
    client.connectShouldFail = true;
    await expect(source.start()).rejects.toThrow('boom');
    expect((await source.health()).connectionErrors).toBeGreaterThanOrEqual(1);
  });

  test('exchange binding: exchange + bindingPatterns produces binds', async () => {
    const { source, client } = buildInstance({
      transport: {
        url: 'amqp://x',
        queue: 'orders',
        exchange: 'orders.ex',
        bindingPatterns: ['orders.*', 'orders.created'],
      },
    });
    await source.start();
    expect(client.channel.bindings).toEqual([
      { queue: 'orders', exchange: 'orders.ex', pattern: 'orders.*' },
      { queue: 'orders', exchange: 'orders.ex', pattern: 'orders.created' },
    ]);
    await source.stop();
  });
});

describe('AmqpSourceInstance message flow', () => {
  test('successful message → channel.ack(deliveryTag)', async () => {
    const { source, client } = buildInstance();
    await source.start();
    await client.channel.deliver(makeMsg({ fields: { deliveryTag: 42 } as never }));
    expect(client.channel.acks).toEqual([{ deliveryTag: 42 }]);
    expect(source.metrics().messagesProcessed).toBe(1);
    await source.stop();
  });

  test('filter-dropped message still acks', async () => {
    const normalizer: MessageNormalizer = {
      async normalize() {
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.channel.deliver(makeMsg({ fields: { deliveryTag: 7 } as never }));
    expect(client.channel.acks).toEqual([{ deliveryTag: 7 }]);
    expect(source.metrics().messagesProcessed).toBe(0);
    await source.stop();
  });

  test('failure under budget → nack(requeue=true); past budget → DLX publish + ack', async () => {
    const { source, client } = buildInstance(
      {
        delivery: { ...DEFAULT_DELIVERY, maxRetries: 2 },
        dlq: { exchange: 'orders.dlx', routingKey: 'dead' },
      },
      buildDeps(failingNormalizer()),
    );
    await source.start();
    // attempt 1 → nack
    await client.channel.deliver(
      makeMsg({
        fields: { deliveryTag: 1 } as never,
        properties: { messageId: 'M1' },
      }),
    );
    expect(client.channel.nacks).toHaveLength(1);
    expect(client.channel.nacks[0]).toEqual({ deliveryTag: 1, requeue: true });

    // attempt 2 (same messageId → local counter = 1 already)
    await client.channel.deliver(
      makeMsg({
        fields: { deliveryTag: 2, redelivered: true } as never,
        properties: { messageId: 'M1' },
      }),
    );
    expect(client.channel.nacks).toHaveLength(2);

    // attempt 3 → exceeds budget → DLX publish + ack
    await client.channel.deliver(
      makeMsg({
        fields: { deliveryTag: 3, redelivered: true } as never,
        properties: { messageId: 'M1' },
      }),
    );
    expect(client.channel.publishes).toHaveLength(1);
    expect(client.channel.publishes[0]).toMatchObject({
      exchange: 'orders.dlx',
      routingKey: 'dead',
    });
    expect(client.channel.publishes[0]?.options?.headers).toMatchObject({
      'x-declaragent-dlq-reason': 'normalize failed',
      'x-declaragent-origin-queue': 'orders',
    });
    expect(client.channel.acks).toEqual([{ deliveryTag: 3 }]);
    expect(source.metrics().messagesDLQ).toBe(1);
    await source.stop();
  });

  test('log-and-drop when no DLQ configured on retry exhaustion', async () => {
    const { source, client } = buildInstance(
      { delivery: { ...DEFAULT_DELIVERY, maxRetries: 0 } },
      buildDeps(failingNormalizer()),
    );
    await source.start();
    await client.channel.deliver(makeMsg({ fields: { deliveryTag: 99 } as never }));
    expect(client.channel.publishes).toHaveLength(0);
    expect(client.channel.acks).toEqual([{ deliveryTag: 99 }]);
    await source.stop();
  });

  test('x-death header feeds raw.meta.deliveryCount', async () => {
    const seen: number[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage) {
        seen.push(Number(raw.meta?.deliveryCount ?? -1));
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.channel.deliver(
      makeMsg({
        fields: { deliveryTag: 1, redelivered: true } as never,
        properties: {
          headers: {
            'x-death': [{ count: 3, queue: 'orders', exchange: '', reason: 'rejected' }],
          },
        },
      }),
    );
    expect(seen[0]).toBe(3);
    await source.stop();
  });

  test('app-level x-declaragent-delivery-count header is honored', async () => {
    const seen: number[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage) {
        seen.push(Number(raw.meta?.deliveryCount ?? -1));
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.channel.deliver(
      makeMsg({
        properties: {
          headers: { 'x-declaragent-delivery-count': 5 },
        },
      }),
    );
    expect(seen[0]).toBe(5);
    await source.stop();
  });

  test('headers from amqp.properties.headers flow into raw.headers', async () => {
    const captured: Record<string, unknown>[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage) {
        captured.push(raw.headers ?? {});
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.channel.deliver(
      makeMsg({
        properties: {
          headers: { 'trace-id': 'abc-123', region: 'us-east' },
        },
      }),
    );
    expect(captured[0]).toMatchObject({ 'trace-id': 'abc-123', region: 'us-east' });
    await source.stop();
  });
});

describe('AmqpSourceInstance pause / resume', () => {
  test('pause cancels consumer; resume re-consumes', async () => {
    const { source, client } = buildInstance();
    await source.start();
    const firstTag = client.channel.consumerTag;
    await source.pause();
    expect(client.channel.consumerTag).toBeNull();
    await source.resume();
    expect(client.channel.consumerTag).toBeTruthy();
    expect(client.channel.consumerTag).not.toBe(firstTag);
    await source.stop();
  });
});

describe('createAmqpAdapter', () => {
  test('validateConfig rejects missing url', () => {
    const adapter = createAmqpAdapter();
    expect(() =>
      adapter.validateConfig({
        id: 'x',
        transport: { queue: 'q' },
        routing: DEFAULT_ROUTING,
        delivery: DEFAULT_DELIVERY,
        limits: DEFAULT_LIMITS,
      }),
    ).toThrow(/url/);
  });

  test('validateConfig rejects exchange without bindingPatterns', () => {
    const adapter = createAmqpAdapter();
    expect(() =>
      adapter.validateConfig({
        id: 'x',
        transport: { url: 'amqp://x', queue: 'q', exchange: 'e' },
        routing: DEFAULT_ROUTING,
        delivery: DEFAULT_DELIVERY,
        limits: DEFAULT_LIMITS,
      }),
    ).toThrow(/bindingPatterns/);
  });

  test('validateConfig accepts a minimal config', () => {
    const adapter = createAmqpAdapter();
    expect(() => adapter.validateConfig(buildConfig())).not.toThrow();
  });

  test('create returns an AmqpSourceInstance when client is injected', async () => {
    const client = makeStubClient();
    const adapter = createAmqpAdapter({ client });
    const inst = await adapter.create(buildConfig(), buildDeps());
    expect(inst.type).toBe('amqp');
    expect(inst.id).toBe('test-amqp');
    await inst.start();
    expect(client.connected).toBe(true);
    await inst.stop();
  });
});
