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
import { createSqsAdapter } from './adapter.js';
import type {
  ReceiveMessageRequest,
  SendMessageRequest,
  SqsClient,
  SqsIncomingMessage,
} from './client.js';
import type { SqsTriggerConfig } from './config.js';
import { SqsSourceInstance } from './instance.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

// ── Stub SqsClient ────────────────────────────────────────────────────────

interface StubSqsClient extends SqsClient {
  /** Queue up messages to be returned by the next `receiveMessage` call. */
  enqueue(messages: SqsIncomingMessage[]): void;
  readonly deletes: Array<{ queueUrl: string; receiptHandle: string }>;
  readonly visibilityChanges: Array<{
    queueUrl: string;
    receiptHandle: string;
    visibilityTimeoutSeconds: number;
  }>;
  readonly sends: SendMessageRequest[];
  readonly receiveCalls: ReceiveMessageRequest[];
  receiveShouldFail: boolean;
  disconnected: boolean;
  /** Number of polls to wait for. Tests use this to await the loop. */
  waitForReceiveCalls(n: number, timeoutMs?: number): Promise<void>;
}

function makeStubClient(): StubSqsClient {
  const queued: SqsIncomingMessage[][] = [];
  const deletes: StubSqsClient['deletes'] = [];
  const visibilityChanges: StubSqsClient['visibilityChanges'] = [];
  const sends: StubSqsClient['sends'] = [];
  const receiveCalls: StubSqsClient['receiveCalls'] = [];
  const state = { receiveShouldFail: false, disconnected: false };

  return {
    enqueue(messages) {
      queued.push([...messages]);
    },
    deletes,
    visibilityChanges,
    sends,
    receiveCalls,
    get receiveShouldFail() {
      return state.receiveShouldFail;
    },
    set receiveShouldFail(v: boolean) {
      state.receiveShouldFail = v;
    },
    get disconnected() {
      return state.disconnected;
    },
    set disconnected(v: boolean) {
      state.disconnected = v;
    },
    async receiveMessage(req) {
      receiveCalls.push(req);
      if (state.receiveShouldFail) throw new Error('receive-failed');
      const batch = queued.shift();
      if (!batch || batch.length === 0) {
        // Simulate long-poll behavior by waiting briefly, so tests don't
        // hot-spin on an empty queue.
        await new Promise((r) => setTimeout(r, 5));
        return [];
      }
      return batch;
    },
    async deleteMessage(queueUrl, receiptHandle) {
      deletes.push({ queueUrl, receiptHandle });
    },
    async changeMessageVisibility(queueUrl, receiptHandle, visibilityTimeoutSeconds) {
      visibilityChanges.push({ queueUrl, receiptHandle, visibilityTimeoutSeconds });
    },
    async sendMessage(req) {
      sends.push(req);
      return { messageId: `sent-${sends.length}` };
    },
    async disconnect() {
      state.disconnected = true;
    },
    async waitForReceiveCalls(n, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (receiveCalls.length < n) {
        if (Date.now() > deadline) {
          throw new Error(
            `waitForReceiveCalls: wanted ${n}, got ${receiveCalls.length} within ${timeoutMs}ms`,
          );
        }
        await new Promise((r) => setTimeout(r, 5));
      }
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

function buildConfig(overrides: Partial<SqsTriggerConfig> = {}): SqsTriggerConfig {
  return {
    id: 'test-sqs',
    transport: {
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
      waitTimeSeconds: 0,
      visibilityTimeoutSeconds: 30,
      visibilityRenewalMs: 0,
      maxMessages: 10,
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

function makeMsg(partial: Partial<SqsIncomingMessage> = {}): SqsIncomingMessage {
  return {
    messageId: partial.messageId ?? `m-${Math.random()}`,
    receiptHandle: partial.receiptHandle ?? `rh-${Math.random()}`,
    body: partial.body ?? 'hello',
    attributes: partial.attributes ?? { ApproximateReceiveCount: '1' },
    messageAttributes: partial.messageAttributes ?? {},
    ...(partial.messageGroupId !== undefined && { messageGroupId: partial.messageGroupId }),
    ...(partial.messageDeduplicationId !== undefined && {
      messageDeduplicationId: partial.messageDeduplicationId,
    }),
    ...(partial.md5OfBody !== undefined && { md5OfBody: partial.md5OfBody }),
  };
}

function buildInstance(
  overrides: Partial<SqsTriggerConfig> = {},
  depsOverride?: SourceDependencies,
): { source: SqsSourceInstance; client: StubSqsClient; deps: SourceDependencies } {
  const client = makeStubClient();
  const deps = depsOverride ?? buildDeps();
  const source = new SqsSourceInstance(buildConfig(overrides), deps, client);
  return { source, client, deps };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('SqsSourceInstance lifecycle', () => {
  test('start kicks off a poll loop, stop halts it + disconnects client', async () => {
    const { source, client } = buildInstance();
    await source.start();
    await client.waitForReceiveCalls(1);
    expect(client.receiveCalls[0]?.queueUrl).toBe(
      'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
    );
    await source.stop();
    expect(client.disconnected).toBe(true);
    const pollsBefore = client.receiveCalls.length;
    // Give a grace window and confirm the loop actually stopped.
    await new Promise((r) => setTimeout(r, 30));
    expect(client.receiveCalls.length).toBe(pollsBefore);
  });

  test('receive error is logged and the loop backs off', async () => {
    const { source, client } = buildInstance();
    client.receiveShouldFail = true;
    await source.start();
    await client.waitForReceiveCalls(1);
    const h = await source.health();
    expect(h.connectionErrors).toBeGreaterThanOrEqual(1);
    await source.stop();
  });

  test('pause suppresses polling but does not disconnect', async () => {
    const { source, client } = buildInstance();
    await source.start();
    await client.waitForReceiveCalls(1);
    await source.pause();
    const snapshot = client.receiveCalls.length;
    await new Promise((r) => setTimeout(r, 50));
    // While paused, fewer / no new polls should happen; the sleep in
    // pause mode is 200ms so we won't see dozens more calls.
    expect(client.receiveCalls.length - snapshot).toBeLessThan(5);
    expect(client.disconnected).toBe(false);
    await source.resume();
    await source.stop();
  });
});

describe('SqsSourceInstance message flow', () => {
  test('success → deleteMessage; metrics.processed increments', async () => {
    const { source, client } = buildInstance();
    await source.start();
    client.enqueue([makeMsg({ body: 'ok', receiptHandle: 'rh-1' })]);
    await waitFor(() => client.deletes.length >= 1);
    expect(client.deletes[0]).toEqual({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
      receiptHandle: 'rh-1',
    });
    expect(source.metrics().messagesProcessed).toBe(1);
    await source.stop();
  });

  test('failure + transport-native DLQ → nack (visibility 0), never deletes', async () => {
    const { source, client } = buildInstance({}, buildDeps(failingNormalizer()));
    await source.start();
    client.enqueue([makeMsg({ receiptHandle: 'rh-native' })]);
    await waitFor(() => client.visibilityChanges.length >= 1);
    expect(client.visibilityChanges[0]).toEqual({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
      receiptHandle: 'rh-native',
      visibilityTimeoutSeconds: 0,
    });
    expect(client.deletes).toHaveLength(0);
    expect(client.sends).toHaveLength(0);
    await source.stop();
  });

  test('failure + agent-managed DLQ → retries nack until budget; then sendMessage + delete', async () => {
    const { source, client } = buildInstance(
      {
        delivery: {
          ...DEFAULT_DELIVERY,
          maxRetries: 2,
          dlq: {
            kind: 'agent-managed',
            destination: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-dlq',
          },
        },
      },
      buildDeps(failingNormalizer()),
    );
    await source.start();
    // attempt=1 → nack (1 < maxRetries=2), delete should NOT happen.
    client.enqueue([makeMsg({ receiptHandle: 'a', attributes: { ApproximateReceiveCount: '1' } })]);
    await waitFor(() => client.visibilityChanges.length >= 1);
    expect(client.deletes).toHaveLength(0);
    expect(client.sends).toHaveLength(0);

    // attempt=2 (2 >= maxRetries=2) → sendMessage to DLQ + delete.
    client.enqueue([makeMsg({ receiptHandle: 'b', attributes: { ApproximateReceiveCount: '2' } })]);
    await waitFor(() => client.sends.length >= 1);
    expect(client.sends[0]?.queueUrl).toBe(
      'https://sqs.us-east-1.amazonaws.com/123456789012/test-dlq',
    );
    expect(client.sends[0]?.messageAttributes?.['x-declaragent-dlq-reason']).toBe(
      'normalize failed',
    );
    await waitFor(() => client.deletes.some((d) => d.receiptHandle === 'b'));
    expect(source.metrics().messagesDLQ).toBe(1);
    await source.stop();
  });

  test('ApproximateReceiveCount is stamped into raw.meta.deliveryCount', async () => {
    const seen: number[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage) {
        seen.push(Number(raw.meta?.deliveryCount ?? -1));
        return null;
      },
    };
    const { source, client } = buildInstance({}, buildDeps(normalizer));
    await source.start();
    client.enqueue([makeMsg({ attributes: { ApproximateReceiveCount: '3' } })]);
    await waitFor(() => seen.length >= 1);
    expect(seen[0]).toBe(3);
    await source.stop();
  });
});

describe('SqsSourceInstance FIFO ordering', () => {
  test('messages in the same MessageGroupId are serialized', async () => {
    const order: string[] = [];
    const normalizer: MessageNormalizer = {
      async normalize(raw: RawMessage) {
        // Stagger work so a naive parallel implementation would reorder.
        const delay = raw.value === 'first' ? 40 : 5;
        await new Promise((r) => setTimeout(r, delay));
        order.push(String(raw.value));
        return null;
      },
    };
    const { source, client } = buildInstance(
      {
        transport: {
          queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/orders.fifo',
          waitTimeSeconds: 0,
          visibilityRenewalMs: 0,
        },
        limits: { concurrency: 10, maxInflight: 100 },
      },
      buildDeps(normalizer),
    );
    await source.start();
    client.enqueue([
      makeMsg({ body: 'first', receiptHandle: 'r1', messageGroupId: 'g1' }),
      makeMsg({ body: 'second', receiptHandle: 'r2', messageGroupId: 'g1' }),
    ]);
    await waitFor(() => order.length === 2);
    expect(order).toEqual(['first', 'second']);
    await source.stop();
  });
});

describe('SqsSourceInstance visibility renewal', () => {
  test('renewal timer fires while the handler is in-flight', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const normalizer: MessageNormalizer = {
      async normalize(): Promise<AgentEvent | null> {
        await blocker;
        return null;
      },
    };
    const { source, client } = buildInstance(
      {
        transport: {
          queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
          waitTimeSeconds: 0,
          visibilityTimeoutSeconds: 30,
          visibilityRenewalMs: 20,
        },
      },
      buildDeps(normalizer),
    );
    await source.start();
    client.enqueue([makeMsg({ receiptHandle: 'rh-renew' })]);
    await waitFor(
      () =>
        client.visibilityChanges.some(
          (c) => c.receiptHandle === 'rh-renew' && c.visibilityTimeoutSeconds === 30,
        ),
      1000,
    );
    release();
    await waitFor(() => client.deletes.some((d) => d.receiptHandle === 'rh-renew'));
    await source.stop();
  });

  test('renewal is cleaned up on ack', async () => {
    const { source, client } = buildInstance({
      transport: {
        queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
        waitTimeSeconds: 0,
        visibilityTimeoutSeconds: 30,
        visibilityRenewalMs: 5,
      },
    });
    await source.start();
    client.enqueue([makeMsg({ receiptHandle: 'rh-fast' })]);
    await waitFor(() => client.deletes.some((d) => d.receiptHandle === 'rh-fast'));
    const snapshot = client.visibilityChanges.filter((c) => c.receiptHandle === 'rh-fast').length;
    await new Promise((r) => setTimeout(r, 30));
    expect(client.visibilityChanges.filter((c) => c.receiptHandle === 'rh-fast').length).toBe(
      snapshot,
    );
    await source.stop();
  });
});

describe('createSqsAdapter', () => {
  test('validateConfig rejects missing queueUrl', () => {
    const adapter = createSqsAdapter();
    expect(() => adapter.validateConfig({ id: 'x', transport: {} })).toThrow(/queueUrl/);
  });

  test('validateConfig rejects endpoint without region inference', () => {
    const adapter = createSqsAdapter();
    expect(() =>
      adapter.validateConfig({
        id: 'x',
        transport: { queueUrl: 'http://localhost:4566/000000000000/q' },
        routing: DEFAULT_ROUTING,
        delivery: DEFAULT_DELIVERY,
        limits: DEFAULT_LIMITS,
      }),
    ).toThrow(/region/);
  });

  test('validateConfig accepts a minimal AWS URL (region inferred)', () => {
    const adapter = createSqsAdapter();
    expect(() => adapter.validateConfig(buildConfig())).not.toThrow();
  });

  test('create returns an SqsSourceInstance when an injected client is supplied', async () => {
    const client = makeStubClient();
    const adapter = createSqsAdapter({ client });
    const deps = buildDeps();
    const inst = await adapter.create(buildConfig(), deps);
    expect(inst.type).toBe('sqs');
    expect(inst.id).toBe('test-sqs');
    await inst.start();
    await client.waitForReceiveCalls(1);
    await inst.stop();
  });

  test('create respects explicit region override for LocalStack endpoints', async () => {
    let seenRegion: string | undefined;
    const adapter = createSqsAdapter({
      createClient(opts) {
        seenRegion = opts.region;
        return makeStubClient();
      },
    });
    const config = buildConfig({
      transport: {
        queueUrl: 'http://localhost:4566/000000000000/q',
        region: 'us-west-2',
        endpoint: 'http://localhost:4566',
        waitTimeSeconds: 0,
        visibilityRenewalMs: 0,
      },
    });
    const inst = await adapter.create(config, buildDeps());
    expect(seenRegion).toBe('us-west-2');
    await inst.start();
    await inst.stop();
  });
});
