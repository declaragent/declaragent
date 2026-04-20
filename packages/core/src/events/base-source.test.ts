import { describe, expect, test } from 'bun:test';
import { createHookRegistry } from '../hooks/registry.js';
import type { Logger } from '../types/logger.js';
import { type AckContext, BaseSourceInstance, LatencyHistogram } from './base-source.js';
import { createEventBus } from './bus.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { createRecordingMetricsRegistry, createRecordingTracer } from './observability.js';
import type {
  AgentEvent,
  DeliveryConfig,
  LimitsConfig,
  MessageNormalizer,
  RawMessage,
  RoutingConfig,
  SourceDependencies,
} from './types.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

// ── Harness ─────────────────────────────────────────────────────────────

interface RecordedAck {
  messageId: string;
  outcome: 'ack' | 'nack';
}

function makeAck(messageId: string, recorded: RecordedAck[]): AckContext {
  return {
    messageId,
    async ack() {
      recorded.push({ messageId, outcome: 'ack' });
    },
    async nack() {
      recorded.push({ messageId, outcome: 'nack' });
    },
  };
}

/**
 * A pass-through normalizer: every RawMessage becomes a broadcast event
 * whose payload is `raw.value`. Used by tests that don't care about
 * routing logic (slice 3) and just want an event on the bus.
 */
function passthroughNormalizer(): MessageNormalizer {
  return {
    async normalize(raw: RawMessage): Promise<AgentEvent | null> {
      if (raw.meta?.drop) return null;
      return {
        id: String(raw.meta?.eventId ?? `evt-${Math.random()}`),
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

const DEFAULT_DELIVERY: DeliveryConfig = {
  mode: 'at-least-once',
  ackStrategy: 'after-publish',
  maxRetries: 2,
  retryBackoff: { initialMs: 10, maxMs: 100, jitter: false },
  idempotency: { strategy: 'content-hash', ttlMs: 60_000, store: 'memory' },
};

const DEFAULT_LIMITS: LimitsConfig = {
  concurrency: 4,
  maxInflight: 100,
};

const DEFAULT_ROUTING: RoutingConfig = {
  format: 'json',
  kindSelector: { const: 'trigger.fire' },
  targetSelector: { type: 'broadcast' },
};

interface HarnessOpts {
  delivery?: Partial<DeliveryConfig>;
  limits?: Partial<LimitsConfig>;
  deps?: Partial<SourceDependencies>;
  normalizer?: MessageNormalizer;
  /** When true, the harness omits hookRegistry from deps entirely. */
  omitHookRegistry?: boolean;
  /** When true, the harness omits normalizer from deps entirely. */
  omitNormalizer?: boolean;
  ackDispatchTimeoutMs?: number;
  /** Slice 13 — circuit breaker options, or undefined to skip. */
  circuitBreaker?: ConstructorParameters<typeof CircuitBreaker>[0];
  /** Slice 13 — bus pressure wiring, or undefined to skip. */
  busPressure?: { highWatermark: number; lowWatermark: number };
}

/**
 * Minimal subclass used by every test below. Exposes `emit(raw, ack)`
 * that routes into `handleMessage` (the protected method). Tracks DLQ
 * invocations so tests can assert retry-exhaustion flows.
 */
class TestSource extends BaseSourceInstance {
  dlqCalls: Array<{ raw: RawMessage; err: Error }> = [];
  paused = 0;
  resumed = 0;
  started = 0;
  stopped = 0;

  async emit(raw: RawMessage, ack: AckContext): Promise<void> {
    await this.handleMessage(raw, ack);
  }

  /** Test-only: expose the protected breaker for state assertions. */
  get circuitBreaker(): typeof this.breaker {
    return this.breaker;
  }

  protected async doStart(): Promise<void> {
    this.started += 1;
  }
  protected async doStop(): Promise<void> {
    this.stopped += 1;
  }
  protected async doPause(): Promise<void> {
    this.paused += 1;
  }
  protected async doResume(): Promise<void> {
    this.resumed += 1;
  }
  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {};
  }
  protected async sendToDLQ(raw: RawMessage, err: Error): Promise<void> {
    this.dlqCalls.push({ raw, err });
  }
}

function buildHarness(opts: HarnessOpts = {}): {
  source: TestSource;
  bus: ReturnType<typeof createEventBus>;
  recorded: RecordedAck[];
  hookRegistry: ReturnType<typeof createHookRegistry>;
} {
  const bus = createEventBus();
  const hookRegistry = createHookRegistry();
  const recorded: RecordedAck[] = [];
  const normalizer = opts.normalizer ?? passthroughNormalizer();
  const deps: SourceDependencies = {
    bus,
    logger: NOOP_LOGGER,
    configDir: '/tmp',
    ...(!opts.omitNormalizer && { normalizer }),
    ...(!opts.omitHookRegistry && { hookRegistry }),
    ...opts.deps,
  };
  const source = new TestSource({
    type: 'test',
    config: {
      id: 'test-source',
      routing: DEFAULT_ROUTING,
      delivery: { ...DEFAULT_DELIVERY, ...opts.delivery },
      limits: { ...DEFAULT_LIMITS, ...opts.limits },
    },
    deps,
    ...(opts.ackDispatchTimeoutMs !== undefined && {
      ackDispatchTimeoutMs: opts.ackDispatchTimeoutMs,
    }),
    ...(opts.circuitBreaker !== undefined && { circuitBreaker: opts.circuitBreaker }),
    ...(opts.busPressure !== undefined && { busPressure: opts.busPressure }),
  });
  return { source, bus, recorded, hookRegistry };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('BaseSourceInstance lifecycle', () => {
  test('start → healthy, stop → stopped, pause → degraded, resume → healthy', async () => {
    const { source } = buildHarness();

    expect((await source.health()).status).toBe('starting');

    await source.start();
    expect((await source.health()).status).toBe('healthy');
    expect(source.started).toBe(1);

    await source.pause();
    expect((await source.health()).status).toBe('degraded');
    expect(source.paused).toBe(1);

    await source.resume();
    expect((await source.health()).status).toBe('healthy');
    expect(source.resumed).toBe(1);

    await source.stop();
    expect((await source.health()).status).toBe('stopped');
    expect(source.stopped).toBe(1);
  });

  test('health exposes connectionErrors + lastConnectedAt', async () => {
    const { source } = buildHarness();
    await source.start();
    const h = await source.health();
    expect(h.connectionErrors).toBe(0);
    expect(h.lastConnectedAt).toBeGreaterThan(0);
  });
});

describe('BaseSourceInstance ack strategies', () => {
  test('before-publish: ack fires before bus.publish resolves', async () => {
    const { source, bus, recorded } = buildHarness({
      delivery: { ackStrategy: 'before-publish' },
    });
    await source.start();

    const order: string[] = [];
    bus.subscribe('*', async () => {
      order.push('published');
    });

    const rec: RecordedAck[] = [];
    const ack: AckContext = {
      messageId: 'm1',
      async ack() {
        order.push('acked');
        rec.push({ messageId: 'm1', outcome: 'ack' });
      },
      async nack() {},
    };
    await source.emit({ value: 'hello', meta: { eventId: 'e1' } }, ack);
    await bus.drained();

    // Ack is recorded before the publish fires.
    expect(order[0]).toBe('acked');
    expect(order).toContain('published');
    void recorded; // quiet unused
  });

  test('after-publish: ack fires after publish resolves (default strategy)', async () => {
    const { source, bus, recorded } = buildHarness();
    await source.start();

    let publishOrder = 0;
    bus.subscribe('*', async () => {
      publishOrder = Date.now();
    });

    await source.emit({ value: 'x', meta: { eventId: 'e1' } }, makeAck('m1', recorded));
    await bus.drained();

    expect(recorded).toEqual([{ messageId: 'm1', outcome: 'ack' }]);
    expect(publishOrder).toBeGreaterThan(0);
    expect(source.metrics().messagesProcessed).toBe(1);
    expect(source.metrics().eventsPublished).toBe(1); // phase-3 compat alias
  });

  test('after-dispatch: waits for event.after hook before acking', async () => {
    const { source, bus, recorded, hookRegistry } = buildHarness({
      delivery: { ackStrategy: 'after-dispatch' },
    });
    await source.start();

    await source.emit({ value: 'x', meta: { eventId: 'ev-1' } }, makeAck('m1', recorded));
    await bus.drained();

    // Not acked yet — dispatcher hook hasn't fired.
    expect(recorded).toEqual([]);

    // Simulate the dispatcher's event.after.
    await hookRegistry.fire('event.after', {
      event: {
        id: 'ev-1',
        kind: 'trigger.fire',
        source: { type: 'self', reason: 'wakeup' },
        target: { type: 'broadcast' },
        timestamp: 0,
        payload: null,
        auth: { kind: 'internal' },
      },
      outcome: { kind: 'broadcast' },
    });
    await Promise.resolve();

    expect(recorded).toEqual([{ messageId: 'm1', outcome: 'ack' }]);
  });

  test('after-dispatch: timeout fires nack when outcome never arrives', async () => {
    const { source, recorded } = buildHarness({
      delivery: { ackStrategy: 'after-dispatch' },
      ackDispatchTimeoutMs: 30,
    });
    await source.start();
    await source.emit({ value: 'x', meta: { eventId: 'lost' } }, makeAck('m1', recorded));

    await new Promise((r) => setTimeout(r, 80));
    expect(recorded).toEqual([{ messageId: 'm1', outcome: 'nack' }]);
  });

  test('after-dispatch without hookRegistry degrades to ack + warn', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      ...NOOP_LOGGER,
      warn(event) {
        warnings.push(event);
      },
    };
    const { source, recorded } = buildHarness({
      delivery: { ackStrategy: 'after-dispatch' },
      deps: { logger },
      omitHookRegistry: true,
    });
    await source.start();
    await source.emit({ value: 'x', meta: { eventId: 'ev-1' } }, makeAck('m1', recorded));
    await Promise.resolve();

    expect(recorded).toEqual([{ messageId: 'm1', outcome: 'ack' }]);
    expect(warnings).toContain('base-source.after-dispatch.no-hook-registry');
  });
});

describe('BaseSourceInstance retry + DLQ', () => {
  test('normalizer throwing nacks up to maxRetries, then DLQ + ack', async () => {
    const boom: MessageNormalizer = {
      async normalize() {
        throw new Error('normalize failed');
      },
    };
    const { source, recorded } = buildHarness({
      delivery: { maxRetries: 2 },
      normalizer: boom,
    });
    await source.start();

    // Attempt 0 → nack (retry).
    await source.emit({ value: 'x', meta: { deliveryCount: 0 } }, makeAck('m1', recorded));
    // Attempt 1 → nack (still under budget).
    await source.emit({ value: 'x', meta: { deliveryCount: 1 } }, makeAck('m2', recorded));
    // Attempt 2 → exceeds budget; DLQ + ack.
    await source.emit({ value: 'x', meta: { deliveryCount: 2 } }, makeAck('m3', recorded));

    expect(recorded).toEqual([
      { messageId: 'm1', outcome: 'nack' },
      { messageId: 'm2', outcome: 'nack' },
      { messageId: 'm3', outcome: 'ack' },
    ]);
    expect(source.dlqCalls).toHaveLength(1);
    expect(source.dlqCalls[0]?.err.message).toBe('normalize failed');
    expect(source.metrics().messagesFailed).toBe(3);
    expect(source.metrics().messagesDLQ).toBe(1);
  });

  test('filter returning null → ack + no publish + no counters on processed', async () => {
    const { source, bus, recorded } = buildHarness();
    await source.start();

    const received: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      received.push(e);
    });

    await source.emit({ value: 'noisy', meta: { drop: true } }, makeAck('m1', recorded));
    await bus.drained();

    expect(recorded).toEqual([{ messageId: 'm1', outcome: 'ack' }]);
    expect(received).toHaveLength(0);
    expect(source.metrics().messagesProcessed).toBe(0);
    expect(source.metrics().messagesReceived).toBe(1);
  });

  test('missing normalizer acks and emits warning — does NOT publish', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      ...NOOP_LOGGER,
      warn(event) {
        warnings.push(event);
      },
    };
    const { source, bus, recorded } = buildHarness({
      deps: { logger },
      omitNormalizer: true,
    });
    await source.start();

    const seen: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      seen.push(e);
    });

    await source.emit({ value: 'x' }, makeAck('m1', recorded));
    await bus.drained();

    expect(seen).toHaveLength(0);
    expect(recorded).toEqual([{ messageId: 'm1', outcome: 'ack' }]);
    expect(warnings).toContain('base-source.no-normalizer');
  });
});

describe('BaseSourceInstance metrics', () => {
  test('counters reflect received/processed/failed/DLQ', async () => {
    const { source, recorded } = buildHarness();
    await source.start();

    await source.emit({ value: 'ok' }, makeAck('m1', recorded));
    await source.emit({ value: 'ok2' }, makeAck('m2', recorded));

    const m = source.metrics();
    expect(m.messagesReceived).toBe(2);
    expect(m.messagesProcessed).toBe(2);
    expect(m.messagesFailed).toBe(0);
    expect(m.messagesDLQ).toBe(0);
    expect(m.inflightCount).toBe(0);
    expect(m.lastEventAt).toBeGreaterThan(0); // phase-3 alias
  });

  test('concurrency limit pins inflightCount', async () => {
    // Each normalizer call blocks on its own latch so we can inspect
    // inflight while held, then release them one at a time.
    const pending: Array<() => void> = [];
    const gated: MessageNormalizer = {
      async normalize(raw) {
        await new Promise<void>((r) => pending.push(r));
        return {
          id: `e-${Math.random()}`,
          kind: 'trigger.fire',
          source: { type: 'self', reason: 'wakeup' },
          target: { type: 'broadcast' },
          timestamp: 0,
          payload: raw.value,
          auth: { kind: 'internal' },
        };
      },
    };
    const { source, recorded } = buildHarness({
      limits: { concurrency: 2, maxInflight: 100 },
      normalizer: gated,
    });
    await source.start();

    const pA = source.emit({ value: 'a' }, makeAck('a', recorded));
    const pB = source.emit({ value: 'b' }, makeAck('b', recorded));
    const pC = source.emit({ value: 'c' }, makeAck('c', recorded));

    // Give microtasks time; concurrency=2 means only 2 normalizers run.
    await new Promise((r) => setTimeout(r, 10));
    expect(pending).toHaveLength(2);
    expect(source.metrics().inflightCount).toBe(2);

    // Release the first; the waiter (C) enters the normalizer.
    pending.shift()?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(pending.length).toBeGreaterThan(0);

    // Drain the rest.
    while (pending.length > 0) {
      pending.shift()?.();
      await new Promise((r) => setTimeout(r, 10));
    }

    await Promise.all([pA, pB, pC]);
    expect(source.metrics().messagesProcessed).toBe(3);
    expect(source.metrics().inflightCount).toBe(0);
  });
});

describe('BaseSourceInstance circuit breaker (slice 13)', () => {
  test('successful messages record into the breaker and keep it closed', async () => {
    const { source } = buildHarness({
      circuitBreaker: { failureThreshold: 2 },
    });
    await source.start();
    const recorded: RecordedAck[] = [];
    await source.emit({ value: 'hi', meta: { eventId: 'e1' } }, makeAck('m1', recorded));
    expect(source.circuitBreaker?.state).toBe('closed');
    await source.stop();
  });

  test('consecutive failures open the breaker and pause the source', async () => {
    const { source } = buildHarness({
      normalizer: {
        async normalize() {
          throw new Error('boom');
        },
      },
      circuitBreaker: { failureThreshold: 2 },
      // Keep retries off so failures always flow through to handleFailure.
      delivery: { maxRetries: 0 },
    });
    await source.start();
    const recorded: RecordedAck[] = [];
    await source.emit({ value: 'x', meta: { eventId: 'a' } }, makeAck('a', recorded));
    expect(source.circuitBreaker?.state).toBe('closed');
    await source.emit({ value: 'x', meta: { eventId: 'b' } }, makeAck('b', recorded));
    // Second consecutive failure opens the breaker + auto-pauses.
    expect(source.circuitBreaker?.state).toBe('open');
    // Give the async pause promise a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect((await source.health()).status).toBe('degraded');
    expect(source.paused).toBeGreaterThanOrEqual(1);
    await source.stop();
  });

  test('breaker close resumes the source', async () => {
    // Custom clock so we can flip open → half-open deterministically.
    let t = 0;
    const { source } = buildHarness({
      normalizer: {
        async normalize() {
          throw new Error('boom');
        },
      },
      circuitBreaker: {
        failureThreshold: 1,
        successThreshold: 1,
        resetTimeoutMs: 10,
        now: () => t,
      },
      delivery: { maxRetries: 0 },
    });
    await source.start();
    const recorded: RecordedAck[] = [];
    await source.emit({ value: 'x', meta: { eventId: 'a' } }, makeAck('a', recorded));
    // 1 failure → open → auto pause.
    await new Promise((r) => setTimeout(r, 0));
    expect(source.circuitBreaker?.state).toBe('open');
    expect((await source.health()).status).toBe('degraded');

    // Advance past cool-down + manually call reset() to emulate a
    // successful probe without running another emit (which would still
    // fail because the normalizer still throws).
    t = 20;
    source.circuitBreaker?.reset();
    // Allow the onTransition listener to run.
    await new Promise((r) => setTimeout(r, 0));
    expect((await source.health()).status).toBe('healthy');
    await source.stop();
  });
});

describe('BaseSourceInstance bus pressure (slice 13)', () => {
  test('onHigh pauses the source; onLow resumes it', async () => {
    const { source, bus } = buildHarness({
      busPressure: { highWatermark: 2, lowWatermark: 1 },
    });
    // A slow bus subscriber that we can drive manually — keeps inflight
    // above the high watermark until we release it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    bus.subscribe('*', async () => {
      await gate;
    });
    await source.start();

    // Emit three messages concurrently. Each goes through normalize +
    // bus.publish; inflight crosses highWatermark=2 on the second one.
    const recorded: RecordedAck[] = [];
    const p1 = source.emit({ value: '1', meta: { eventId: '1' } }, makeAck('1', recorded));
    const p2 = source.emit({ value: '2', meta: { eventId: '2' } }, makeAck('2', recorded));
    const p3 = source.emit({ value: '3', meta: { eventId: '3' } }, makeAck('3', recorded));

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect((await source.health()).status).toBe('degraded');

    release();
    await Promise.all([p1, p2, p3]);
    await new Promise((r) => setTimeout(r, 0));
    expect((await source.health()).status).toBe('healthy');
    await source.stop();
  });

  test('manual pause is not resumed by bus-pressure onLow', async () => {
    const { source, bus } = buildHarness({
      busPressure: { highWatermark: 1, lowWatermark: 0 },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    bus.subscribe('*', async () => {
      await gate;
    });
    await source.start();
    await source.pause(); // 'manual' reason
    expect((await source.health()).status).toBe('degraded');

    const recorded: RecordedAck[] = [];
    const p1 = source.emit({ value: '1', meta: { eventId: '1' } }, makeAck('1', recorded));
    await new Promise((r) => setTimeout(r, 0));
    expect((await source.health()).status).toBe('degraded'); // still paused

    release();
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    // Bus pressure cleared but 'manual' reason still holds — stay paused.
    expect((await source.health()).status).toBe('degraded');
    await source.resume();
    expect((await source.health()).status).toBe('healthy');
    await source.stop();
  });
});

describe('LatencyHistogram', () => {
  test('avg + p99 are stable under small samples', () => {
    const h = new LatencyHistogram(16);
    for (const v of [10, 20, 30, 40, 50]) h.observe(v);
    expect(h.avg()).toBe(30);
    expect(h.p99()).toBe(50);
    expect(h.count).toBe(5);
  });

  test('start/stop measures elapsed', async () => {
    const h = new LatencyHistogram(16);
    const stop = h.start();
    await new Promise((r) => setTimeout(r, 15));
    stop();
    expect(h.avg()).toBeGreaterThan(10);
    expect(h.count).toBe(1);
  });

  test('empty histogram returns 0', () => {
    const h = new LatencyHistogram(16);
    expect(h.avg()).toBe(0);
    expect(h.p99()).toBe(0);
  });

  test('reservoir evicts oldest when full', () => {
    const h = new LatencyHistogram(3);
    h.observe(1);
    h.observe(2);
    h.observe(3);
    h.observe(100);
    // First sample dropped; avg is mean of {2, 3, 100}.
    expect(h.avg()).toBeCloseTo((2 + 3 + 100) / 3, 5);
  });
});

// ─── Observability emission (slice 6) ───────────────────────────────────

describe('BaseSourceInstance observability', () => {
  test('emits received/processed counters + duration histogram + inflight gauge', async () => {
    const metrics = createRecordingMetricsRegistry();
    const { source, bus, recorded } = buildHarness({
      deps: { metrics },
    });
    await source.start();
    await source.emit({ value: 'x', meta: { eventId: 'e1' } }, makeAck('m1', recorded));
    await bus.drained();

    const names = metrics.records.map((r) => `${r.kind}:${r.name}:${r.op}`);
    expect(names).toContain('counter:source.messages.received:inc');
    expect(names).toContain('counter:source.messages.processed:inc');
    expect(names).toContain('histogram:source.process.duration_ms:observe');
    expect(names).toContain('gauge:source.inflight:set');

    // Every metric carries {id, type} labels.
    const received = metrics.records.find((r) => r.name === 'source.messages.received');
    expect(received?.labels).toEqual({ id: 'test-source', type: 'test' });
  });

  test('emits failed + dlq counters on retry exhaustion', async () => {
    const boom: MessageNormalizer = {
      async normalize() {
        throw new Error('blow up');
      },
    };
    const metrics = createRecordingMetricsRegistry();
    const { source, recorded } = buildHarness({
      delivery: { maxRetries: 0 }, // fail immediately → DLQ
      normalizer: boom,
      deps: { metrics },
    });
    await source.start();
    await source.emit({ value: 'x', meta: { deliveryCount: 0 } }, makeAck('m1', recorded));

    const kinds = metrics.records.map((r) => r.name);
    expect(kinds).toContain('source.messages.failed');
    expect(kinds).toContain('source.messages.dlq');
  });

  test('starts source.message span with transport attributes + ends it', async () => {
    const tracer = createRecordingTracer();
    const { source, bus, recorded } = buildHarness({
      deps: { tracer },
    });
    await source.start();
    await source.emit(
      {
        value: 'x',
        topic: 'orders',
        partition: 3,
        offset: '100',
        meta: { eventId: 'e-kafka' },
      },
      makeAck('m1', recorded),
    );
    await bus.drained();

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0];
    expect(span?.name).toBe('source.message');
    expect(span?.startAttributes).toEqual({
      id: 'test-source',
      type: 'test',
      'message.id': 'm1',
      'message.topic': 'orders',
      'message.partition': 3,
      'message.offset': '100',
    });
    expect(span?.attributes.outcome).toBe('published');
    expect(span?.status?.status).toBe('ok');
    expect(span?.ended).toBe(true);
  });

  test('span captures correlation id from event meta', async () => {
    const tracer = createRecordingTracer();
    // Custom normalizer that stamps a correlation id.
    const normalizer: MessageNormalizer = {
      async normalize(raw) {
        return {
          id: 'evt',
          kind: 'trigger.fire',
          source: { type: 'self', reason: 'wakeup' },
          target: { type: 'broadcast' },
          timestamp: 0,
          payload: raw.value,
          auth: { kind: 'internal' },
          meta: { correlationId: 'run-42' },
        };
      },
    };
    const { source, bus, recorded } = buildHarness({ deps: { tracer }, normalizer });
    await source.start();
    await source.emit({ value: 'x' }, makeAck('m1', recorded));
    await bus.drained();

    const span = tracer.spans[0];
    expect(span?.attributes['correlation.id']).toBe('run-42');
    expect(span?.attributes['event.id']).toBe('evt');
    expect(span?.attributes['event.kind']).toBe('trigger.fire');
  });

  test('span records exception + error status on failure', async () => {
    const tracer = createRecordingTracer();
    const boom: MessageNormalizer = {
      async normalize() {
        throw new Error('normalize failed');
      },
    };
    const { source, recorded } = buildHarness({
      deps: { tracer },
      delivery: { maxRetries: 0 },
      normalizer: boom,
    });
    await source.start();
    await source.emit({ value: 'x' }, makeAck('m1', recorded));

    const span = tracer.spans[0];
    expect(span?.exceptions.map((e) => e.message)).toContain('normalize failed');
    expect(span?.status?.status).toBe('error');
    expect(span?.ended).toBe(true);
  });

  test('filtered messages get outcome=filtered on the span', async () => {
    const tracer = createRecordingTracer();
    const { source, recorded } = buildHarness({
      deps: { tracer },
      normalizer: {
        async normalize(raw) {
          if (raw.meta?.drop) return null;
          return null; // always filter for this test
        },
      },
    });
    await source.start();
    await source.emit({ value: 'x' }, makeAck('m1', recorded));
    const span = tracer.spans[0];
    expect(span?.attributes.outcome).toBe('filtered');
  });

  test('metrics registry is resolved lazily — not called when unused', async () => {
    let counterCalls = 0;
    const lazyMetrics = {
      counter() {
        counterCalls += 1;
        return { inc() {} };
      },
      gauge() {
        return { set() {}, inc() {}, dec() {} };
      },
      histogram() {
        return { observe() {} };
      },
    };
    // Construct without emitting; counters shouldn't be created.
    buildHarness({ deps: { metrics: lazyMetrics } });
    expect(counterCalls).toBe(0);
  });
});
