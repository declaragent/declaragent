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
import { createNatsAdapter } from './adapter.js';
import type {
  ConsumeOptions,
  NatsAckHandle,
  NatsClient,
  NatsConsumerHandle,
  NatsIncomingMessage,
} from './client.js';
import type { NatsTriggerConfig } from './config.js';
import { NatsSourceInstance } from './instance.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

// ── Stub NatsClient ───────────────────────────────────────────────────────

interface StubConsumerHandle extends NatsConsumerHandle {
  stopped: boolean;
}

interface StubClient extends NatsClient {
  /** Deliver a message to the currently-active consumer. */
  deliver(msg: NatsIncomingMessage): Promise<{ acks: number; naks: number; terms: number }>;
  readonly consumeCalls: ConsumeOptions[];
  readonly published: Array<{
    subject: string;
    data: Uint8Array;
    headers?: Record<string, string>;
  }>;
  readonly closed: () => boolean;
  /** Last handle returned; useful for asserting stop()/closed state. */
  readonly currentHandle: () => StubConsumerHandle | null;
}

function makeStubClient(): StubClient {
  const state = {
    connected: true,
    closed: false,
    currentHandle: null as StubConsumerHandle | null,
    currentHandler: null as
      | ((msg: NatsIncomingMessage, ack: NatsAckHandle) => Promise<void> | void)
      | null,
  };
  const consumeCalls: ConsumeOptions[] = [];
  const published: StubClient['published'] = [];

  return {
    consumeCalls,
    published,
    closed: () => state.closed,
    currentHandle: () => state.currentHandle,
    isConnected() {
      return state.connected && !state.closed;
    },
    async consume(opts, onMessage) {
      consumeCalls.push(opts);
      state.currentHandler = onMessage;
      let stopped = false;
      let resolveClosed!: () => void;
      const closedPromise = new Promise<void>((r) => {
        resolveClosed = r;
      });
      const handle: StubConsumerHandle = {
        get stopped() {
          return stopped;
        },
        set stopped(v: boolean) {
          stopped = v;
        },
        async stop() {
          stopped = true;
          state.currentHandler = null;
          resolveClosed();
        },
        closed: closedPromise,
      };
      state.currentHandle = handle;
      return handle;
    },
    async publish(subject, data, headers) {
      published.push({ subject, data, ...(headers && { headers }) });
    },
    async close() {
      state.closed = true;
      state.connected = false;
    },
    async deliver(msg) {
      let acks = 0;
      let naks = 0;
      let terms = 0;
      const ack: NatsAckHandle = {
        async ack() {
          acks += 1;
        },
        async nak() {
          naks += 1;
        },
        async term() {
          terms += 1;
        },
        async working() {},
      };
      const handler = state.currentHandler;
      if (!handler) throw new Error('no consumer handler registered');
      await handler(msg, ack);
      return { acks, naks, terms };
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

function buildConfig(overrides: Partial<NatsTriggerConfig> = {}): NatsTriggerConfig {
  return {
    id: 'test-nats',
    transport: {
      servers: ['nats://localhost:4222'],
      stream: 'ORDERS',
      durableConsumer: 'orders-consumer',
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

function makeMsg(partial: Partial<NatsIncomingMessage> = {}): NatsIncomingMessage {
  return {
    subject: partial.subject ?? 'orders.created',
    data: partial.data ?? new TextEncoder().encode('hello'),
    streamSequence: partial.streamSequence ?? 1,
    deliverySequence: partial.deliverySequence ?? 1,
    redeliveryCount: partial.redeliveryCount ?? 1,
    ...(partial.headers !== undefined && { headers: partial.headers }),
    ...(partial.timestampMs !== undefined && { timestampMs: partial.timestampMs }),
  };
}

function buildInstance(
  overrides: Partial<NatsTriggerConfig> = {},
  depsOverride?: SourceDependencies,
): { source: NatsSourceInstance; client: StubClient; deps: SourceDependencies } {
  const client = makeStubClient();
  const deps = depsOverride ?? buildDeps();
  const source = new NatsSourceInstance(buildConfig(overrides), deps, client);
  return { source, client, deps };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('NatsSourceInstance lifecycle', () => {
  test('start creates a JetStream consumer with the configured opts', async () => {
    const { source, client } = buildInstance({
      transport: {
        servers: ['nats://localhost:4222'],
        stream: 'ORDERS',
        durableConsumer: 'orders-consumer',
        subjectFilters: ['orders.*'],
        ackWaitSeconds: 5,
        maxDeliver: 10,
      },
    });
    await source.start();
    expect(client.consumeCalls).toHaveLength(1);
    expect(client.consumeCalls[0]).toMatchObject({
      stream: 'ORDERS',
      durableName: 'orders-consumer',
      filterSubjects: ['orders.*'],
      ackWaitMs: 5000,
      maxDeliver: 10,
    });
    await source.stop();
    expect(client.closed()).toBe(true);
  });

  test('stop halts consumer and closes client', async () => {
    const { source, client } = buildInstance();
    await source.start();
    const handle = client.currentHandle();
    await source.stop();
    expect(handle?.stopped).toBe(true);
    expect(client.closed()).toBe(true);
  });

  test('pause stops the consumer; resume restarts', async () => {
    const { source, client } = buildInstance();
    await source.start();
    const first = client.currentHandle();
    await source.pause();
    expect(first?.stopped).toBe(true);
    await source.resume();
    const second = client.currentHandle();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await source.stop();
  });
});

describe('NatsSourceInstance message flow', () => {
  test('successful message → ack', async () => {
    const { source, client } = buildInstance();
    await source.start();
    const { acks, naks } = await client.deliver(makeMsg({ streamSequence: 42 }));
    expect(acks).toBe(1);
    expect(naks).toBe(0);
    expect(source.metrics().messagesProcessed).toBe(1);
    await source.stop();
  });

  test('failure under budget → nak; past budget → DLQ publish + ack', async () => {
    const { source, client } = buildInstance(
      { dlq: { subject: 'orders.dlq' } },
      buildDeps(failingNormalizer()),
    );
    await source.start();
    // redeliveryCount=1 → deliveryCount=0 (0 < 2) → nak
    const r1 = await client.deliver(makeMsg({ streamSequence: 1, redeliveryCount: 1 }));
    expect(r1).toEqual({ acks: 0, naks: 1, terms: 0 });

    // redeliveryCount=2 → deliveryCount=1 (1 < 2) → nak
    const r2 = await client.deliver(makeMsg({ streamSequence: 1, redeliveryCount: 2 }));
    expect(r2).toEqual({ acks: 0, naks: 1, terms: 0 });

    // redeliveryCount=3 → deliveryCount=2 (2 >= 2) → DLQ + ack
    const r3 = await client.deliver(makeMsg({ streamSequence: 1, redeliveryCount: 3 }));
    expect(r3).toEqual({ acks: 1, naks: 0, terms: 0 });
    expect(client.published).toHaveLength(1);
    expect(client.published[0]?.subject).toBe('orders.dlq');
    expect(client.published[0]?.headers?.['x-declaragent-dlq-reason']).toBe('normalize failed');
    expect(client.published[0]?.headers?.['x-declaragent-origin-stream']).toBe('ORDERS');
    expect(source.metrics().messagesDLQ).toBe(1);
    await source.stop();
  });

  test('log-and-drop when DLQ is not configured on retry exhaustion', async () => {
    const { source, client } = buildInstance(
      { delivery: { ...DEFAULT_DELIVERY, maxRetries: 0 } },
      buildDeps(failingNormalizer()),
    );
    await source.start();
    const { acks, naks } = await client.deliver(makeMsg({ redeliveryCount: 1 }));
    expect(client.published).toHaveLength(0);
    expect(acks).toBe(1);
    expect(naks).toBe(0);
    await source.stop();
  });

  test('redeliveryCount from msg.info is stamped into raw.meta.deliveryCount', async () => {
    const seen: number[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage) {
        seen.push(Number(raw.meta?.deliveryCount ?? -1));
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.deliver(makeMsg({ redeliveryCount: 5 }));
    // Semantics: redeliveryCount=5 → deliveryCount=4 (redeliveryCount is 1-indexed per JetStream docs).
    expect(seen[0]).toBe(4);
    await source.stop();
  });

  test('headers flow into raw.headers', async () => {
    const captured: Record<string, unknown>[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage) {
        captured.push(raw.headers ?? {});
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.deliver(
      makeMsg({
        headers: { 'trace-id': 'abc-123', region: 'us-east' },
      }),
    );
    expect(captured[0]).toMatchObject({ 'trace-id': 'abc-123', region: 'us-east' });
    await source.stop();
  });

  test('subject + streamSequence surface on RawMessage', async () => {
    const captured: RawMessage[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage) {
        captured.push(raw);
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    await client.deliver(makeMsg({ subject: 'orders.created', streamSequence: 99 }));
    expect(captured[0]?.topic).toBe('orders.created');
    expect(captured[0]?.offset).toBe('99');
    expect(captured[0]?.meta?.streamSequence).toBe(99);
    await source.stop();
  });
});

describe('NatsSourceInstance seek', () => {
  test('seek by offset rebuilds consumer with startSequence', async () => {
    const { source, client } = buildInstance();
    await source.start();
    expect(client.consumeCalls).toHaveLength(1);
    await source.seek({ kind: 'offset', offset: 500 });
    expect(client.consumeCalls).toHaveLength(2);
    expect(client.consumeCalls[1]).toMatchObject({ stream: 'ORDERS', startSequence: 500 });
    await source.stop();
  });

  test('seek beginning rebuilds consumer with startSequence=1', async () => {
    const { source, client } = buildInstance();
    await source.start();
    await source.seek({ kind: 'beginning' });
    expect(client.consumeCalls[1]).toMatchObject({ startSequence: 1 });
    await source.stop();
  });

  test('seek end rebuilds consumer with deliverPolicy=new', async () => {
    const { source, client } = buildInstance();
    await source.start();
    await source.seek({ kind: 'end' });
    expect(client.consumeCalls[1]).toMatchObject({ deliverPolicy: 'new' });
    await source.stop();
  });

  test('seek timestamp rebuilds consumer with startTime (ISO string)', async () => {
    const { source, client } = buildInstance();
    await source.start();
    const ts = Date.parse('2026-01-15T12:00:00Z');
    await source.seek({ kind: 'timestamp', timestampMs: ts });
    const rebuilt = client.consumeCalls[1];
    expect(rebuilt).toMatchObject({ stream: 'ORDERS' });
    expect(rebuilt?.startTime).toBe(new Date(ts).toISOString());
    await source.stop();
  });
});

describe('createNatsAdapter', () => {
  test('validateConfig rejects missing stream', () => {
    const adapter = createNatsAdapter();
    expect(() =>
      adapter.validateConfig({
        id: 'x',
        transport: { servers: ['nats://x'] },
        routing: DEFAULT_ROUTING,
        delivery: DEFAULT_DELIVERY,
        limits: DEFAULT_LIMITS,
      }),
    ).toThrow(/stream/);
  });

  test('validateConfig rejects empty servers', () => {
    const adapter = createNatsAdapter();
    expect(() =>
      adapter.validateConfig({
        id: 'x',
        transport: { servers: [], stream: 'S' },
        routing: DEFAULT_ROUTING,
        delivery: DEFAULT_DELIVERY,
        limits: DEFAULT_LIMITS,
      }),
    ).toThrow(/servers/);
  });

  test('validateConfig accepts a minimal valid config', () => {
    const adapter = createNatsAdapter();
    expect(() => adapter.validateConfig(buildConfig())).not.toThrow();
  });

  test('create returns a NatsSourceInstance when client is injected', async () => {
    const client = makeStubClient();
    const adapter = createNatsAdapter({ client });
    const inst = await adapter.create(buildConfig(), buildDeps());
    expect(inst.type).toBe('nats');
    expect(inst.id).toBe('test-nats');
    await inst.start();
    expect(client.consumeCalls).toHaveLength(1);
    await inst.stop();
  });
});
