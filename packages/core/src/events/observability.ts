import { type PeerDepLoader, defaultPeerLoader } from './schema-registry.js';
import type {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  Span,
  SpanAttributeValue,
  SpanAttributes,
  SpanStatus,
  Tracer,
} from './types.js';

// ─── Default buckets ────────────────────────────────────────────────────
// Power-of-two ms buckets — a practical span for event-processing latency
// (sub-ms normalization up to multi-second downstream waits). Matches
// the grid Prometheus + Grafana dashboards render cleanly.

export const POWER_OF_TWO_BUCKETS: readonly number[] = [
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192,
];

// ─── Noop registries ────────────────────────────────────────────────────

export function createNoopMetricsRegistry(): MetricsRegistry {
  const noopCounter: Counter = { inc() {} };
  const noopGauge: Gauge = {
    set() {},
    inc() {},
    dec() {},
  };
  const noopHistogram: Histogram = { observe() {} };
  return {
    counter: () => noopCounter,
    gauge: () => noopGauge,
    histogram: () => noopHistogram,
  };
}

/** A frozen noop tracer whose spans never end anywhere observable. */
export function createNoopTracer(): Tracer {
  const noopSpan: Span = {
    traceId: '',
    spanId: '',
    setAttribute() {
      return noopSpan;
    },
    setAttributes() {
      return noopSpan;
    },
    recordException() {
      return noopSpan;
    },
    setStatus() {
      return noopSpan;
    },
    end() {},
  };
  return {
    startSpan: () => noopSpan,
  };
}

// ─── BucketedHistogram ──────────────────────────────────────────────────

export interface HistogramSnapshot {
  buckets: readonly number[]; // counts per bucket (same length as boundaries + 1)
  boundaries: readonly number[]; // ascending; last bucket catches all values > final boundary
  sum: number;
  count: number;
}

/**
 * Power-of-two cumulative histogram. Each `observe()` is O(log N) via
 * linear scan (N = bucket count, typically ≤ 20). Memory is fixed at
 * `boundaries.length + 1` counters — concurrent increments are safe
 * under a single-threaded JS event loop.
 *
 * Implements the slice-1 `Histogram` interface (for use with
 * `MetricsRegistry`); also exposes `avg()` / `p99()` helpers for internal
 * diagnostics.
 */
export class BucketedHistogram implements Histogram {
  readonly boundaries: readonly number[];
  private readonly buckets: number[];
  private sumValue = 0;
  private countValue = 0;

  constructor(boundaries: readonly number[] = POWER_OF_TWO_BUCKETS) {
    if (boundaries.length === 0) {
      throw new Error('BucketedHistogram requires at least one boundary');
    }
    // Validate ascending.
    for (let i = 1; i < boundaries.length; i += 1) {
      if ((boundaries[i] as number) <= (boundaries[i - 1] as number)) {
        throw new Error(`BucketedHistogram boundaries must be strictly ascending (at index ${i})`);
      }
    }
    this.boundaries = boundaries;
    this.buckets = new Array(boundaries.length + 1).fill(0);
  }

  observe(value: number): void {
    if (!Number.isFinite(value)) return;
    this.sumValue += value;
    this.countValue += 1;
    for (let i = 0; i < this.boundaries.length; i += 1) {
      if (value <= (this.boundaries[i] as number)) {
        this.buckets[i] = (this.buckets[i] as number) + 1;
        return;
      }
    }
    // Overflow bucket.
    this.buckets[this.boundaries.length] = (this.buckets[this.boundaries.length] as number) + 1;
  }

  get sum(): number {
    return this.sumValue;
  }

  get count(): number {
    return this.countValue;
  }

  avg(): number {
    return this.countValue === 0 ? 0 : this.sumValue / this.countValue;
  }

  /**
   * Approximate p99 — returns the upper boundary of the bucket that
   * contains the 99th percentile sample. For the overflow bucket we
   * return `Infinity`; callers can clamp for display.
   */
  p99(): number {
    if (this.countValue === 0) return 0;
    const target = this.countValue * 0.99;
    let running = 0;
    for (let i = 0; i < this.buckets.length; i += 1) {
      running += this.buckets[i] as number;
      if (running >= target) {
        return i < this.boundaries.length
          ? (this.boundaries[i] as number)
          : Number.POSITIVE_INFINITY;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  snapshot(): HistogramSnapshot {
    return {
      buckets: [...this.buckets],
      boundaries: this.boundaries,
      sum: this.sumValue,
      count: this.countValue,
    };
  }

  reset(): void {
    for (let i = 0; i < this.buckets.length; i += 1) this.buckets[i] = 0;
    this.sumValue = 0;
    this.countValue = 0;
  }
}

// ─── OTel bridge ────────────────────────────────────────────────────────
//
// `@opentelemetry/api` is a peer dep — loaded only when the bridge is
// requested. The bridge maps our neutral surface onto OTel primitives:
//
//   Counter          → Counter
//   Gauge            → UpDownCounter  (set(v) is implemented as an
//                      internal delta; see "Gauge semantics" note below)
//   Histogram        → Histogram (OTel's own, no buckets surfaced here)
//   Span             → Span
//
// Gauge semantics: OTel's synchronous instruments don't have a `set()`.
// We simulate it with an internal `lastValue` and emit the delta on every
// set(). `inc()` / `dec()` translate directly. For adapters that need
// precise gauge semantics (observable callbacks), use OTel's
// `ObservableGauge` directly — the bridge intentionally keeps surface
// minimal.

export interface OtelBridgeOptions {
  /** Defaults to `@declaragent/core`. */
  meterName?: string;
  meterVersion?: string;
  tracerName?: string;
  tracerVersion?: string;
  loader?: PeerDepLoader;
}

export class ObservabilityError extends Error {
  readonly code = 'EOBSERVABILITY';
  constructor(message: string) {
    super(message);
    this.name = 'ObservabilityError';
  }
}

interface OtelApiModule {
  metrics: {
    getMeter: (
      name: string,
      version?: string,
    ) => {
      createCounter: (
        name: string,
        opts?: { description?: string },
      ) => {
        add: (v: number, attrs?: Record<string, unknown>) => void;
      };
      createUpDownCounter: (
        name: string,
        opts?: { description?: string },
      ) => {
        add: (v: number, attrs?: Record<string, unknown>) => void;
      };
      createHistogram: (
        name: string,
        opts?: { description?: string },
      ) => {
        record: (v: number, attrs?: Record<string, unknown>) => void;
      };
    };
  };
  trace: {
    getTracer: (
      name: string,
      version?: string,
    ) => {
      startSpan: (
        name: string,
        opts?: { attributes?: Record<string, unknown> },
      ) => {
        spanContext: () => { traceId: string; spanId: string };
        setAttribute: (k: string, v: unknown) => unknown;
        setAttributes: (a: Record<string, unknown>) => unknown;
        recordException: (err: Error) => void;
        setStatus: (s: { code: number; message?: string }) => void;
        end: () => void;
      };
    };
  };
  SpanStatusCode: { OK: number; ERROR: number };
}

/**
 * Load `@opentelemetry/api` at runtime and wrap its primitives into our
 * `MetricsRegistry` + `Tracer` surface. The package is NOT a core
 * runtime dep — if it isn't installed, `createOtelBridge` throws with a
 * clear "`npm install @opentelemetry/api`" message.
 */
export async function createOtelBridge(
  opts: OtelBridgeOptions = {},
): Promise<{ metrics: MetricsRegistry; tracer: Tracer }> {
  const loader = opts.loader ?? defaultPeerLoader;
  let mod: OtelApiModule;
  try {
    mod = (await loader('@opentelemetry/api')) as OtelApiModule;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ObservabilityError(
      `createOtelBridge requires the \`@opentelemetry/api\` peer dependency. Run \`npm install @opentelemetry/api\`. (load error: ${reason})`,
    );
  }

  const meter = mod.metrics.getMeter(opts.meterName ?? '@declaragent/core', opts.meterVersion);
  const tracer = mod.trace.getTracer(opts.tracerName ?? '@declaragent/core', opts.tracerVersion);

  const counterCache = new Map<string, Counter>();
  const gaugeCache = new Map<string, Gauge>();
  const histogramCache = new Map<string, Histogram>();

  const metrics: MetricsRegistry = {
    counter(name, help) {
      const cached = counterCache.get(name);
      if (cached) return cached;
      const inst = meter.createCounter(
        name,
        help !== undefined ? { description: help } : undefined,
      );
      const c: Counter = {
        inc(value?: number, labels?: Readonly<Record<string, string>>) {
          inst.add(value ?? 1, labels);
        },
      };
      counterCache.set(name, c);
      return c;
    },
    gauge(name, help) {
      const cached = gaugeCache.get(name);
      if (cached) return cached;
      const inst = meter.createUpDownCounter(
        name,
        help !== undefined ? { description: help } : undefined,
      );
      // Per-label-set last-value tracking for `set(v)`.
      const last = new Map<string, number>();
      const labelKey = (labels?: Readonly<Record<string, string>>): string =>
        labels
          ? Object.keys(labels)
              .sort()
              .map((k) => `${k}=${labels[k]}`)
              .join(',')
          : '';
      const g: Gauge = {
        set(value: number, labels?: Readonly<Record<string, string>>) {
          const key = labelKey(labels);
          const prev = last.get(key) ?? 0;
          inst.add(value - prev, labels);
          last.set(key, value);
        },
        inc(value?: number, labels?: Readonly<Record<string, string>>) {
          const delta = value ?? 1;
          const key = labelKey(labels);
          last.set(key, (last.get(key) ?? 0) + delta);
          inst.add(delta, labels);
        },
        dec(value?: number, labels?: Readonly<Record<string, string>>) {
          const delta = value ?? 1;
          const key = labelKey(labels);
          last.set(key, (last.get(key) ?? 0) - delta);
          inst.add(-delta, labels);
        },
      };
      gaugeCache.set(name, g);
      return g;
    },
    histogram(name, help) {
      const cached = histogramCache.get(name);
      if (cached) return cached;
      const inst = meter.createHistogram(
        name,
        help !== undefined ? { description: help } : undefined,
      );
      const h: Histogram = {
        observe(value, labels) {
          inst.record(value, labels);
        },
      };
      histogramCache.set(name, h);
      return h;
    },
  };

  const tracerOut: Tracer = {
    startSpan(name, attributes) {
      const raw = tracer.startSpan(
        name,
        attributes ? { attributes: { ...attributes } } : undefined,
      );
      const ctx = raw.spanContext();
      const span: Span = {
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        setAttribute(k, v) {
          raw.setAttribute(k, v);
          return span;
        },
        setAttributes(attrs) {
          raw.setAttributes({ ...attrs });
          return span;
        },
        recordException(err) {
          raw.recordException(err);
          return span;
        },
        setStatus(status, message) {
          raw.setStatus({
            code: status === 'ok' ? mod.SpanStatusCode.OK : mod.SpanStatusCode.ERROR,
            ...(message !== undefined && { message }),
          });
          return span;
        },
        end() {
          raw.end();
        },
      };
      return span;
    },
  };

  return { metrics, tracer: tracerOut };
}

// ─── Test helper: recording registry ────────────────────────────────────
//
// Returned from `createRecordingMetricsRegistry()` is a registry whose
// operations are forwarded to buffers callers can assert on. This ships
// in core rather than testkit so adapter authors writing their own tests
// don't need testkit as a peer dep.

export interface MetricRecord {
  kind: 'counter' | 'gauge' | 'histogram';
  name: string;
  /** 'inc' / 'set' / 'dec' / 'observe' — the operation invoked. */
  op: string;
  value: number;
  labels?: Readonly<Record<string, string>>;
}

export interface RecordingMetricsRegistry extends MetricsRegistry {
  readonly records: readonly MetricRecord[];
}

export function createRecordingMetricsRegistry(): RecordingMetricsRegistry {
  const records: MetricRecord[] = [];
  function makeCounter(name: string): Counter {
    return {
      inc(value?: number, labels?: Readonly<Record<string, string>>) {
        records.push({
          kind: 'counter',
          name,
          op: 'inc',
          value: value ?? 1,
          ...(labels && { labels }),
        });
      },
    };
  }
  function makeGauge(name: string): Gauge {
    return {
      set(value: number, labels?: Readonly<Record<string, string>>) {
        records.push({ kind: 'gauge', name, op: 'set', value, ...(labels && { labels }) });
      },
      inc(value?: number, labels?: Readonly<Record<string, string>>) {
        records.push({
          kind: 'gauge',
          name,
          op: 'inc',
          value: value ?? 1,
          ...(labels && { labels }),
        });
      },
      dec(value?: number, labels?: Readonly<Record<string, string>>) {
        records.push({
          kind: 'gauge',
          name,
          op: 'dec',
          value: value ?? 1,
          ...(labels && { labels }),
        });
      },
    };
  }
  function makeHistogram(name: string): Histogram {
    return {
      observe(value: number, labels?: Readonly<Record<string, string>>) {
        records.push({ kind: 'histogram', name, op: 'observe', value, ...(labels && { labels }) });
      },
    };
  }
  return {
    records,
    counter: makeCounter,
    gauge: makeGauge,
    histogram: makeHistogram,
  };
}

// ─── Test helper: recording tracer ──────────────────────────────────────

export interface RecordedSpan {
  name: string;
  startAttributes?: SpanAttributes;
  attributes: Record<string, SpanAttributeValue>;
  exceptions: Error[];
  status?: { status: SpanStatus; message?: string };
  ended: boolean;
  traceId: string;
  spanId: string;
}

export interface RecordingTracer extends Tracer {
  readonly spans: readonly RecordedSpan[];
}

export function createRecordingTracer(): RecordingTracer {
  const spans: RecordedSpan[] = [];
  let counter = 0;
  return {
    spans,
    startSpan(name, attrs) {
      counter += 1;
      const rec: RecordedSpan = {
        name,
        ...(attrs && { startAttributes: attrs }),
        attributes: {},
        exceptions: [],
        ended: false,
        traceId: `trace-${counter}`,
        spanId: `span-${counter}`,
      };
      spans.push(rec);
      const span: Span = {
        traceId: rec.traceId,
        spanId: rec.spanId,
        setAttribute(k, v) {
          rec.attributes[k] = v;
          return span;
        },
        setAttributes(a) {
          Object.assign(rec.attributes, a);
          return span;
        },
        recordException(err) {
          rec.exceptions.push(err);
          return span;
        },
        setStatus(status, message) {
          rec.status = { status, ...(message !== undefined && { message }) };
          return span;
        },
        end() {
          rec.ended = true;
        },
      };
      return span;
    },
  };
}
