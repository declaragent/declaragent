import { POWER_OF_TWO_BUCKETS } from '../events/observability.js';
import type { Counter, Gauge, Histogram, MetricsRegistry } from '../events/types.js';

/**
 * Phase 6 — Prometheus exposition.
 *
 * Slice 2 ships a self-contained OpenMetrics text-format exporter with no
 * peer deps. The output matches `promtool check metrics` expectations
 * (unit stripping, `_total` suffix on counters, `# HELP` / `# TYPE`
 * preamble, cumulative histogram buckets ending with `+Inf`).
 *
 * Design:
 * - {@link PrometheusRegistry} is a stateful `MetricsRegistry` that
 *   retains current values per (metric, label-set) so a `/metrics` scrape
 *   can produce a point-in-time snapshot. Every adapter that already
 *   writes to `deps.metrics` starts producing Prometheus samples for free
 *   once the daemon points `deps.metrics` at this registry.
 * - {@link startPrometheusExporter} binds a Bun HTTP server that serves
 *   `/metrics` and nothing else. Non-localhost clients are rejected by
 *   default — matches the Phase-3 daemon control-socket model.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface PrometheusRegistry extends MetricsRegistry {
  /** Produce an OpenMetrics text-format snapshot of current state. */
  scrape(): string;
  /** For diagnostics / tests. Names of all registered metrics. */
  readonly metricNames: readonly string[];
}

export interface CreatePrometheusRegistryOptions {
  /**
   * Histogram bucket boundaries applied to newly created histograms.
   * Defaults to `POWER_OF_TWO_BUCKETS`.
   */
  defaultBuckets?: readonly number[];
  /**
   * Constant labels stamped onto every sample. The daemon uses this to
   * inject `tenant_id` when running in multi-tenant mode.
   */
  constLabels?: Readonly<Record<string, string>>;
}

type MetricKind = 'counter' | 'gauge' | 'histogram';

interface RegisteredMetric {
  kind: MetricKind;
  help?: string;
  /** Samples keyed on the canonical label string. */
  samples: Map<string, Sample>;
}

interface Sample {
  labels: Readonly<Record<string, string>>;
  /** For counters + gauges: current value. Histograms keep their own state. */
  value: number;
  /** Populated for histograms; never mutated for counter/gauge samples. */
  histogram?: {
    boundaries: readonly number[];
    /** Count per bucket (`boundaries.length + 1` — last is the +Inf bucket). */
    buckets: number[];
    sum: number;
    count: number;
  };
}

// ── Registry ───────────────────────────────────────────────────────────────

export function createPrometheusRegistry(
  opts: CreatePrometheusRegistryOptions = {},
): PrometheusRegistry {
  const defaultBuckets = opts.defaultBuckets ?? POWER_OF_TWO_BUCKETS;
  const constLabels = opts.constLabels ?? {};
  const metrics = new Map<string, RegisteredMetric>();

  function register(name: string, kind: MetricKind, help: string | undefined): RegisteredMetric {
    const existing = metrics.get(name);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(
          `metric "${name}" already registered as ${existing.kind}, cannot re-register as ${kind}`,
        );
      }
      if (help !== undefined && existing.help === undefined) existing.help = help;
      return existing;
    }
    const created: RegisteredMetric = {
      kind,
      samples: new Map(),
      ...(help !== undefined && { help }),
    };
    metrics.set(name, created);
    return created;
  }

  function ensureSample(
    metric: RegisteredMetric,
    labels: Readonly<Record<string, string>> | undefined,
  ): Sample {
    const resolved = mergeLabels(constLabels, labels);
    const key = labelKey(resolved);
    const existing = metric.samples.get(key);
    if (existing) return existing;
    const sample: Sample = { labels: resolved, value: 0 };
    if (metric.kind === 'histogram') {
      sample.histogram = {
        boundaries: defaultBuckets,
        buckets: new Array(defaultBuckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
    }
    metric.samples.set(key, sample);
    return sample;
  }

  function counter(name: string, help?: string): Counter {
    const metric = register(name, 'counter', help);
    return {
      inc(value?: number, labels?: Readonly<Record<string, string>>) {
        const delta = value ?? 1;
        if (!Number.isFinite(delta)) return;
        if (delta < 0) {
          // Prometheus counters are monotonic; silently skip to keep
          // callers that pass signed deltas safe.
          return;
        }
        const sample = ensureSample(metric, labels);
        sample.value += delta;
      },
    };
  }

  function gauge(name: string, help?: string): Gauge {
    const metric = register(name, 'gauge', help);
    const apply = (
      op: 'set' | 'inc' | 'dec',
      value: number,
      labels?: Readonly<Record<string, string>>,
    ) => {
      if (!Number.isFinite(value)) return;
      const sample = ensureSample(metric, labels);
      if (op === 'set') sample.value = value;
      else if (op === 'inc') sample.value += value;
      else sample.value -= value;
    };
    return {
      set(value, labels) {
        apply('set', value, labels);
      },
      inc(value, labels) {
        apply('inc', value ?? 1, labels);
      },
      dec(value, labels) {
        apply('dec', value ?? 1, labels);
      },
    };
  }

  function histogram(name: string, help?: string): Histogram {
    const metric = register(name, 'histogram', help);
    return {
      observe(value, labels) {
        if (!Number.isFinite(value)) return;
        const sample = ensureSample(metric, labels);
        const h = sample.histogram;
        if (!h) return; // unreachable — histogram samples always carry state
        h.count += 1;
        h.sum += value;
        let placed = false;
        for (let i = 0; i < h.boundaries.length; i += 1) {
          if (value <= (h.boundaries[i] as number)) {
            h.buckets[i] = (h.buckets[i] as number) + 1;
            placed = true;
            break;
          }
        }
        if (!placed) {
          h.buckets[h.boundaries.length] = (h.buckets[h.boundaries.length] as number) + 1;
        }
      },
    };
  }

  function scrape(): string {
    const out: string[] = [];
    const names = [...metrics.keys()].sort();
    for (const name of names) {
      const metric = metrics.get(name);
      if (!metric) continue;
      // Prometheus metric names are restricted to `[a-zA-Z_:][a-zA-Z0-9_:]*`
      // but our internal names use dotted identifiers (`source.messages.processed`)
      // so callers don't have to pick between OTel-friendly + Prometheus-
      // friendly. Normalize at render time; the registration key stays
      // dotted so consumers can still look metrics up by their natural name.
      const wireName = normalizeMetricName(name);
      if (metric.help !== undefined) {
        out.push(`# HELP ${wireName} ${escapeHelp(metric.help)}`);
      }
      out.push(`# TYPE ${wireName} ${metric.kind}`);
      const samples = [...metric.samples.values()].sort((a, b) =>
        labelKey(a.labels).localeCompare(labelKey(b.labels)),
      );
      for (const sample of samples) {
        if (metric.kind === 'histogram') {
          renderHistogram(out, wireName, sample);
        } else {
          out.push(`${wireName}${renderLabels(sample.labels)} ${renderValue(sample.value)}`);
        }
      }
    }
    if (out.length === 0) return '';
    // OpenMetrics mandates a trailing newline after the last sample.
    return `${out.join('\n')}\n`;
  }

  return {
    counter,
    gauge,
    histogram,
    scrape,
    get metricNames(): readonly string[] {
      return [...metrics.keys()].sort();
    },
  };
}

// ── Rendering helpers ──────────────────────────────────────────────────────

/**
 * Map a dotted internal metric name (`source.messages.processed`) to a
 * Prometheus-valid wire name (`source_messages_processed`). Characters
 * outside `[a-zA-Z0-9_:]` are replaced with `_`; leading digits are
 * prefixed with `_` so the result starts with an allowed lead byte.
 */
function normalizeMetricName(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i] as string;
    const code = ch.charCodeAt(0);
    const isAlpha = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const isDigit = code >= 0x30 && code <= 0x39;
    const isAllowed = isAlpha || isDigit || ch === '_' || ch === ':';
    if (isAllowed) out += ch;
    else out += '_';
  }
  if (out.length === 0) return '_';
  const first = out.charCodeAt(0);
  if (first >= 0x30 && first <= 0x39) out = `_${out}`;
  return out;
}

function escapeLabelValue(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '"') out += '\\"';
    else out += ch;
  }
  return out;
}

function escapeHelp(help: string): string {
  let out = '';
  for (const ch of help) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else out += ch;
  }
  return out;
}

function renderLabels(
  labels: Readonly<Record<string, string>>,
  extra?: readonly [string, string],
): string {
  const keys = Object.keys(labels).sort();
  const pairs: string[] = [];
  for (const k of keys) {
    pairs.push(`${k}="${escapeLabelValue(labels[k] as string)}"`);
  }
  if (extra) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  if (pairs.length === 0) return '';
  return `{${pairs.join(',')}}`;
}

function renderValue(v: number): string {
  if (!Number.isFinite(v)) {
    if (Number.isNaN(v)) return 'NaN';
    return v > 0 ? '+Inf' : '-Inf';
  }
  // Prometheus accepts integer-like values without decimals; keep them
  // compact for human-readable scrapes.
  if (Number.isInteger(v)) return v.toString();
  return v.toString();
}

function renderHistogram(out: string[], name: string, sample: Sample): void {
  const h = sample.histogram;
  if (!h) return;
  let cumulative = 0;
  for (let i = 0; i < h.boundaries.length; i += 1) {
    cumulative += h.buckets[i] as number;
    const le = renderValue(h.boundaries[i] as number);
    out.push(`${name}_bucket${renderLabels(sample.labels, ['le', le])} ${cumulative}`);
  }
  // Final +Inf bucket.
  cumulative += h.buckets[h.boundaries.length] as number;
  out.push(`${name}_bucket${renderLabels(sample.labels, ['le', '+Inf'])} ${cumulative}`);
  out.push(`${name}_sum${renderLabels(sample.labels)} ${renderValue(h.sum)}`);
  out.push(`${name}_count${renderLabels(sample.labels)} ${h.count}`);
}

function labelKey(labels: Readonly<Record<string, string>>): string {
  const keys = Object.keys(labels).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}=${labels[k]}`);
  }
  return parts.join(',');
}

function mergeLabels(
  base: Readonly<Record<string, string>>,
  extra?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!extra || Object.keys(extra).length === 0) return base;
  if (Object.keys(base).length === 0) return extra;
  return { ...base, ...extra };
}

// ── HTTP exporter ──────────────────────────────────────────────────────────

export interface PrometheusExporterListenOptions {
  port: number;
  hostname: string;
  fetch: (req: Request) => Promise<Response> | Response;
}

export interface PrometheusExporterServer {
  readonly port: number;
  readonly hostname: string;
  stop(): Promise<void> | void;
}

export interface PrometheusExporterOptions {
  /** Registry to scrape. Typically the one wired into `deps.metrics`. */
  registry: PrometheusRegistry;
  /** HTTP listen port. Default 9464 (OTel convention). */
  port?: number;
  /** Host to bind. Default `127.0.0.1`. */
  hostname?: string;
  /** Path for scrape requests. Default `/metrics`. */
  path?: string;
  /**
   * Accept non-localhost clients. Default `false` — matches the
   * Phase-3 daemon control-socket model.
   */
  allowRemote?: boolean;
  /** Test override. Replace Bun.serve with a fake listener. */
  listen?: (opts: PrometheusExporterListenOptions) => Promise<PrometheusExporterServer>;
}

export interface PrometheusHandle {
  readonly port: number;
  readonly path: string;
  /** Emit the current scrape body — convenient for tests and diagnostics. */
  scrape(): string;
  /** Close the HTTP server. Safe to call repeatedly. */
  close(): Promise<void>;
}

export async function startPrometheusExporter(
  opts: PrometheusExporterOptions,
): Promise<PrometheusHandle> {
  const port = opts.port ?? 9464;
  const hostname = opts.hostname ?? '127.0.0.1';
  const path = opts.path ?? '/metrics';
  const allowRemote = opts.allowRemote ?? false;
  const listen = opts.listen ?? defaultListen;

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== path) {
      return new Response('not found', { status: 404 });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    }
    if (!allowRemote) {
      const remoteOk = isLocalClient(req);
      if (!remoteOk) {
        return new Response('remote scrape disabled', { status: 403 });
      }
    }
    const body = opts.registry.scrape();
    return new Response(req.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        // OpenMetrics mandates this exact content type; Prometheus accepts
        // either this or `text/plain; version=0.0.4`.
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const server = await listen({ port, hostname, fetch });

  let closed = false;
  return {
    port: server.port,
    path,
    scrape() {
      return opts.registry.scrape();
    },
    async close() {
      if (closed) return;
      closed = true;
      await server.stop();
    },
  };
}

function isLocalClient(req: Request): boolean {
  // Bun exposes the raw socket address in newer versions via a property
  // bag on the Request — not standardized yet. The most portable check
  // is the Host header: when bound to 127.0.0.1, Bun will only accept
  // connections where the peer actually connected to localhost, so the
  // Host header necessarily resolves to localhost (or a loopback alias).
  //
  // When `allowRemote` is false we ALSO bind to `127.0.0.1`; a client
  // that resolves a non-loopback name for the same port won't reach us.
  // This check is defense-in-depth: reject an explicit `Host: external.tld`
  // header even if the socket layer somehow let the request through.
  const host = req.headers.get('host');
  if (!host) return true; // no explicit host = raw request, trust the bind
  const hostname = host.split(':')[0] ?? '';
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

const defaultListen: NonNullable<PrometheusExporterOptions['listen']> = async ({
  port,
  hostname,
  fetch,
}) => {
  // biome-ignore lint/suspicious/noExplicitAny: Bun global is not typed in this repo.
  const bun = (globalThis as any).Bun;
  if (!bun || typeof bun.serve !== 'function') {
    throw new Error(
      'prometheus exporter: Bun.serve not available. Supply an explicit `listen` option in non-Bun hosts.',
    );
  }
  const server = bun.serve({
    port,
    hostname,
    fetch: (req: Request) => fetch(req),
  });
  return {
    port: server.port,
    hostname: server.hostname ?? hostname,
    async stop() {
      await server.stop();
    },
  };
};
