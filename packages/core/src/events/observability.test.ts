import { describe, expect, test } from 'bun:test';
import {
  BucketedHistogram,
  ObservabilityError,
  POWER_OF_TWO_BUCKETS,
  createNoopMetricsRegistry,
  createNoopTracer,
  createOtelBridge,
  createRecordingMetricsRegistry,
  createRecordingTracer,
} from './observability.js';

// ─── Noop registries ────────────────────────────────────────────────────

describe('createNoopMetricsRegistry', () => {
  test('every operation is a no-op', () => {
    const r = createNoopMetricsRegistry();
    r.counter('x').inc();
    r.counter('x').inc(5, { tenant: 't' });
    r.gauge('y').set(3);
    r.gauge('y').inc();
    r.gauge('y').dec(2);
    r.histogram('z').observe(100);
    // No throw = pass.
  });
});

describe('createNoopTracer', () => {
  test('returns span that no-ops', () => {
    const tracer = createNoopTracer();
    const span = tracer.startSpan('x', { k: 1 });
    span.setAttribute('a', 1).setAttributes({ b: 'two' }).setStatus('ok').end();
    expect(span.traceId).toBe('');
    expect(span.spanId).toBe('');
  });
});

// ─── BucketedHistogram ──────────────────────────────────────────────────

describe('BucketedHistogram', () => {
  test('rejects empty boundaries', () => {
    expect(() => new BucketedHistogram([])).toThrow(/at least one/);
  });

  test('rejects non-ascending boundaries', () => {
    expect(() => new BucketedHistogram([1, 1, 2])).toThrow(/ascending/);
    expect(() => new BucketedHistogram([10, 5])).toThrow(/ascending/);
  });

  test('observe + count + sum', () => {
    const h = new BucketedHistogram([1, 2, 4]);
    h.observe(0.5);
    h.observe(1.5);
    h.observe(3.0);
    expect(h.count).toBe(3);
    expect(h.sum).toBe(5);
    expect(h.avg()).toBeCloseTo(5 / 3, 5);
  });

  test('p99 returns bucket upper boundary', () => {
    const h = new BucketedHistogram([1, 2, 4, 8, 16, 32]);
    // 99 samples in bucket [0..1], 1 sample in bucket [2..4]
    for (let i = 0; i < 99; i += 1) h.observe(0.5);
    h.observe(3);
    // p99 = bucket containing 99th percentile → 99*0.99 = 98 samples in,
    // that falls in the first bucket (boundary 1).
    expect(h.p99()).toBe(1);
  });

  test('p99 returns Infinity when tail overflows', () => {
    const h = new BucketedHistogram([1, 2]);
    for (let i = 0; i < 100; i += 1) h.observe(50);
    expect(h.p99()).toBe(Number.POSITIVE_INFINITY);
  });

  test('snapshot returns a defensive copy', () => {
    const h = new BucketedHistogram([1, 2, 4]);
    h.observe(0.5);
    h.observe(3);
    const snap = h.snapshot();
    expect(snap.boundaries).toEqual([1, 2, 4]);
    expect(snap.buckets).toHaveLength(4); // 3 boundaries + overflow
    expect(snap.sum).toBe(3.5);
    expect(snap.count).toBe(2);
    // Mutating the snapshot doesn't affect the histogram.
    (snap.buckets as number[])[0] = 999;
    expect(h.snapshot().buckets[0]).not.toBe(999);
  });

  test('reset zeroes everything', () => {
    const h = new BucketedHistogram([1, 2]);
    h.observe(0.5);
    h.observe(1.5);
    h.reset();
    expect(h.count).toBe(0);
    expect(h.sum).toBe(0);
    expect(h.avg()).toBe(0);
  });

  test('ignores non-finite values', () => {
    const h = new BucketedHistogram([1]);
    h.observe(Number.NaN);
    h.observe(Number.POSITIVE_INFINITY);
    expect(h.count).toBe(0);
  });

  test('default boundaries are power-of-two', () => {
    const h = new BucketedHistogram();
    expect(h.boundaries).toEqual(POWER_OF_TWO_BUCKETS);
  });
});

// ─── Recording helpers ──────────────────────────────────────────────────

describe('createRecordingMetricsRegistry', () => {
  test('captures every call', () => {
    const r = createRecordingMetricsRegistry();
    r.counter('a').inc();
    r.counter('a').inc(5, { tenant: 't' });
    r.gauge('b').set(3);
    r.histogram('c').observe(100, { id: 'x' });

    expect(r.records).toEqual([
      { kind: 'counter', name: 'a', op: 'inc', value: 1 },
      { kind: 'counter', name: 'a', op: 'inc', value: 5, labels: { tenant: 't' } },
      { kind: 'gauge', name: 'b', op: 'set', value: 3 },
      { kind: 'histogram', name: 'c', op: 'observe', value: 100, labels: { id: 'x' } },
    ]);
  });
});

describe('createRecordingTracer', () => {
  test('captures spans + attrs + status + end', () => {
    const t = createRecordingTracer();
    const span = t.startSpan('source.message', { 'source.type': 'kafka' });
    span.setAttribute('event.id', 'e1');
    span.setAttributes({ 'correlation.id': 'run-1' });
    span.setStatus('ok');
    span.end();

    expect(t.spans).toHaveLength(1);
    const rec = t.spans[0];
    expect(rec?.name).toBe('source.message');
    expect(rec?.startAttributes).toEqual({ 'source.type': 'kafka' });
    expect(rec?.attributes).toEqual({ 'event.id': 'e1', 'correlation.id': 'run-1' });
    expect(rec?.status?.status).toBe('ok');
    expect(rec?.ended).toBe(true);
    expect(rec?.traceId).toMatch(/^trace-/);
  });

  test('records exception + error status', () => {
    const t = createRecordingTracer();
    const span = t.startSpan('x');
    const err = new Error('boom');
    span.recordException(err);
    span.setStatus('error', 'boom');
    span.end();
    const rec = t.spans[0];
    expect(rec?.exceptions).toEqual([err]);
    expect(rec?.status).toEqual({ status: 'error', message: 'boom' });
  });
});

// ─── OTel bridge ────────────────────────────────────────────────────────

describe('createOtelBridge', () => {
  test('missing peer → ObservabilityError with install hint', async () => {
    await expect(
      createOtelBridge({
        loader: async () => {
          throw new Error('Cannot find module @opentelemetry/api');
        },
      }),
    ).rejects.toThrow(ObservabilityError);
    await expect(
      createOtelBridge({
        loader: async () => {
          throw new Error('Cannot find module');
        },
      }),
    ).rejects.toThrow(/npm install @opentelemetry\/api/);
  });

  test('bridges counter.inc → meter.add', async () => {
    const added: Array<{ name: string; value: number; attrs?: Record<string, unknown> }> = [];
    const stub = {
      metrics: {
        getMeter: () => ({
          createCounter: (name: string) => ({
            add: (v: number, attrs?: Record<string, unknown>) => {
              added.push({ name, value: v, ...(attrs && { attrs }) });
            },
          }),
          createUpDownCounter: () => ({ add: () => {} }),
          createHistogram: () => ({ record: () => {} }),
        }),
      },
      trace: {
        getTracer: () => ({
          startSpan: () => ({
            spanContext: () => ({ traceId: 'tr', spanId: 'sp' }),
            setAttribute: () => {},
            setAttributes: () => {},
            recordException: () => {},
            setStatus: () => {},
            end: () => {},
          }),
        }),
      },
      SpanStatusCode: { OK: 1, ERROR: 2 },
    };
    const bridge = await createOtelBridge({ loader: async () => stub });
    const c = bridge.metrics.counter('source.messages.received');
    c.inc();
    c.inc(3, { id: 'a' });
    expect(added).toEqual([
      { name: 'source.messages.received', value: 1 },
      { name: 'source.messages.received', value: 3, attrs: { id: 'a' } },
    ]);
  });

  test('gauge.set(v) emits deltas against last-seen per-label', async () => {
    const added: Array<{ v: number; attrs?: Record<string, unknown> }> = [];
    const stub = {
      metrics: {
        getMeter: () => ({
          createCounter: () => ({ add: () => {} }),
          createUpDownCounter: () => ({
            add: (v: number, attrs?: Record<string, unknown>) => {
              added.push({ v, ...(attrs && { attrs }) });
            },
          }),
          createHistogram: () => ({ record: () => {} }),
        }),
      },
      trace: {
        getTracer: () => ({
          startSpan: () => ({
            spanContext: () => ({ traceId: 't', spanId: 's' }),
            setAttribute: () => {},
            setAttributes: () => {},
            recordException: () => {},
            setStatus: () => {},
            end: () => {},
          }),
        }),
      },
      SpanStatusCode: { OK: 1, ERROR: 2 },
    };
    const bridge = await createOtelBridge({ loader: async () => stub });
    const g = bridge.metrics.gauge('source.inflight');
    g.set(5, { id: 'a' }); // delta +5
    g.set(2, { id: 'a' }); // delta -3
    g.set(4, { id: 'b' }); // delta +4 (new label set)
    expect(added).toEqual([
      { v: 5, attrs: { id: 'a' } },
      { v: -3, attrs: { id: 'a' } },
      { v: 4, attrs: { id: 'b' } },
    ]);
  });

  test('tracer.startSpan returns usable Span surface', async () => {
    let called = false;
    const stub = {
      metrics: {
        getMeter: () => ({
          createCounter: () => ({ add: () => {} }),
          createUpDownCounter: () => ({ add: () => {} }),
          createHistogram: () => ({ record: () => {} }),
        }),
      },
      trace: {
        getTracer: () => ({
          startSpan: (_name: string, opts?: unknown) => {
            void opts;
            return {
              spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1' }),
              setAttribute: () => {},
              setAttributes: () => {},
              recordException: () => {},
              setStatus: (arg: { code: number }) => {
                if (arg.code === 1) called = true;
              },
              end: () => {},
            };
          },
        }),
      },
      SpanStatusCode: { OK: 1, ERROR: 2 },
    };
    const { tracer } = await createOtelBridge({ loader: async () => stub });
    const span = tracer.startSpan('x', { k: 'v' });
    expect(span.traceId).toBe('trace-1');
    expect(span.spanId).toBe('span-1');
    span.setStatus('ok');
    span.end();
    expect(called).toBe(true);
  });
});
