import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type PrometheusExporterListenOptions,
  type PrometheusExporterServer,
  type PrometheusHandle,
  createPrometheusRegistry,
  startPrometheusExporter,
} from './prometheus.js';

describe('createPrometheusRegistry', () => {
  it('emits counters with the _total convention is NOT enforced (raw name preserved)', () => {
    // We deliberately preserve the caller's metric name — the daemon
    // already emits names like `source.messages.processed` which maps
    // onto a counter without a `_total` suffix. Prometheus `promtool`
    // warns but does not reject the missing suffix.
    const reg = createPrometheusRegistry();
    const c = reg.counter('my_counter', 'Counts things');
    c.inc(1);
    c.inc(2, { id: 'a' });
    const text = reg.scrape();
    expect(text).toContain('# HELP my_counter Counts things');
    expect(text).toContain('# TYPE my_counter counter');
    expect(text).toContain('my_counter 1');
    expect(text).toContain('my_counter{id="a"} 2');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('accumulates counters per label set', () => {
    const reg = createPrometheusRegistry();
    const c = reg.counter('events_total');
    c.inc(1, { id: 'a', type: 'foo' });
    c.inc(1, { id: 'a', type: 'foo' });
    c.inc(1, { id: 'b', type: 'foo' });
    const text = reg.scrape();
    expect(text).toContain('events_total{id="a",type="foo"} 2');
    expect(text).toContain('events_total{id="b",type="foo"} 1');
  });

  it('rejects negative counter increments', () => {
    const reg = createPrometheusRegistry();
    const c = reg.counter('monotonic');
    c.inc(5);
    c.inc(-3);
    const text = reg.scrape();
    expect(text).toContain('monotonic 5');
  });

  it('supports gauges with set / inc / dec', () => {
    const reg = createPrometheusRegistry();
    const g = reg.gauge('inflight');
    g.set(10);
    g.inc(2);
    g.dec(5);
    const text = reg.scrape();
    expect(text).toContain('# TYPE inflight gauge');
    expect(text).toContain('inflight 7');
  });

  it('emits histogram buckets cumulatively with +Inf last', () => {
    const reg = createPrometheusRegistry({ defaultBuckets: [1, 5, 10] });
    const h = reg.histogram('latency_ms', 'Latency in ms');
    h.observe(0.5);
    h.observe(3);
    h.observe(7);
    h.observe(50); // overflow
    const text = reg.scrape();
    expect(text).toContain('# TYPE latency_ms histogram');
    // Cumulative: [<=1]=1, [<=5]=2, [<=10]=3, [<=Inf]=4
    expect(text).toContain('latency_ms_bucket{le="1"} 1');
    expect(text).toContain('latency_ms_bucket{le="5"} 2');
    expect(text).toContain('latency_ms_bucket{le="10"} 3');
    expect(text).toContain('latency_ms_bucket{le="+Inf"} 4');
    expect(text).toContain('latency_ms_sum 60.5');
    expect(text).toContain('latency_ms_count 4');
  });

  it('stamps const labels on every sample', () => {
    const reg = createPrometheusRegistry({ constLabels: { tenant_id: 'acme-prod' } });
    const c = reg.counter('events_total');
    c.inc(1, { id: 'a' });
    const text = reg.scrape();
    expect(text).toContain('events_total{id="a",tenant_id="acme-prod"} 1');
  });

  it('escapes label values for quotes, backslashes, and newlines', () => {
    const reg = createPrometheusRegistry();
    const c = reg.counter('weird');
    c.inc(1, { msg: 'line\nbreak', quote: 'say "hi"', back: 'c:\\temp' });
    const text = reg.scrape();
    expect(text).toContain('weird{back="c:\\\\temp",msg="line\\nbreak",quote="say \\"hi\\""} 1');
  });

  it('sorts metrics + labels for deterministic output', () => {
    const reg = createPrometheusRegistry();
    reg.counter('zeta').inc(1, { b: '1', a: '2' });
    reg.counter('alpha').inc(1);
    const text = reg.scrape();
    const alphaIdx = text.indexOf('# TYPE alpha');
    const zetaIdx = text.indexOf('# TYPE zeta');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(alphaIdx);
    // Label keys appear alphabetically.
    expect(text).toContain('zeta{a="2",b="1"} 1');
  });

  it('throws on type mismatch', () => {
    const reg = createPrometheusRegistry();
    reg.counter('boom');
    expect(() => reg.gauge('boom')).toThrow(/already registered as counter/);
  });

  it('metricNames returns all registered metrics sorted', () => {
    const reg = createPrometheusRegistry();
    reg.counter('gamma');
    reg.gauge('alpha');
    reg.histogram('beta');
    expect(reg.metricNames).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('scrape emits an empty-ish body when nothing is registered', () => {
    const reg = createPrometheusRegistry();
    // Just the trailing newline the OpenMetrics spec mandates.
    expect(reg.scrape()).toBe('');
  });

  it('normalizes dotted metric names to Prometheus-valid underscores', () => {
    const reg = createPrometheusRegistry();
    reg.counter('source.messages.processed', 'Messages published to the bus').inc(3);
    reg.histogram('channel.outbound.latency_ms').observe(100);
    const text = reg.scrape();
    expect(text).toContain('# TYPE source_messages_processed counter');
    expect(text).toContain('source_messages_processed 3');
    expect(text).toContain('# TYPE channel_outbound_latency_ms histogram');
    expect(text).toContain('channel_outbound_latency_ms_count 1');
  });
});

describe('startPrometheusExporter', () => {
  interface FakeServer extends PrometheusExporterServer {
    readonly fetch: PrometheusExporterListenOptions['fetch'];
  }

  async function startFake(
    registry: ReturnType<typeof createPrometheusRegistry>,
    options: {
      allowRemote?: boolean;
      path?: string;
    } = {},
  ): Promise<{ handle: PrometheusHandle; server: FakeServer }> {
    let captured: FakeServer | null = null;
    const listen: PrometheusExporterOptionsListen = async ({ port, hostname, fetch }) => {
      const server: FakeServer = {
        port,
        hostname,
        fetch,
        stop() {},
      };
      captured = server;
      return server;
    };
    const handle = await startPrometheusExporter({
      registry,
      listen,
      ...(options.allowRemote !== undefined && { allowRemote: options.allowRemote }),
      ...(options.path !== undefined && { path: options.path }),
    });
    if (!captured) throw new Error('listen stub did not run');
    return { handle, server: captured };
  }

  type PrometheusExporterOptionsListen = NonNullable<
    Parameters<typeof startPrometheusExporter>[0]['listen']
  >;

  it('serves /metrics with text/plain content type', async () => {
    const reg = createPrometheusRegistry();
    reg.counter('hits').inc(3);
    const { handle, server } = await startFake(reg);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/metrics', {
        headers: { host: '127.0.0.1:9464' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4');
    const body = await res.text();
    expect(body).toContain('hits 3');
    await handle.close();
  });

  it('returns 404 on non-configured paths', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake(reg);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/other', {
        headers: { host: '127.0.0.1:9464' },
      }),
    );
    expect(res.status).toBe(404);
    await handle.close();
  });

  it('returns 405 on non-GET/HEAD methods', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake(reg);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/metrics', {
        method: 'POST',
        headers: { host: '127.0.0.1:9464' },
      }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    await handle.close();
  });

  it('rejects non-localhost Host headers by default', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake(reg);
    const res = await server.fetch(
      new Request('http://external.tld:9464/metrics', {
        headers: { host: 'external.tld:9464' },
      }),
    );
    expect(res.status).toBe(403);
    await handle.close();
  });

  it('accepts remote Host headers when allowRemote is true', async () => {
    const reg = createPrometheusRegistry();
    reg.counter('hits').inc(1);
    const { handle, server } = await startFake(reg, { allowRemote: true });
    const res = await server.fetch(
      new Request('http://external.tld:9464/metrics', {
        headers: { host: 'external.tld:9464' },
      }),
    );
    expect(res.status).toBe(200);
    await handle.close();
  });

  it('supports a custom path', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake(reg, { path: '/scrape' });
    const metrics = await server.fetch(
      new Request('http://127.0.0.1:9464/metrics', {
        headers: { host: '127.0.0.1:9464' },
      }),
    );
    expect(metrics.status).toBe(404);
    const scrape = await server.fetch(
      new Request('http://127.0.0.1:9464/scrape', {
        headers: { host: '127.0.0.1:9464' },
      }),
    );
    expect(scrape.status).toBe(200);
    await handle.close();
  });

  it('handle.close is idempotent', async () => {
    const reg = createPrometheusRegistry();
    const { handle } = await startFake(reg);
    await handle.close();
    await handle.close();
  });
});

// ── End-to-end over a real Bun.serve port ────────────────────────────────

describe('startPrometheusExporter (real Bun.serve)', () => {
  let handle: PrometheusHandle | null = null;
  const registry = createPrometheusRegistry();

  beforeAll(async () => {
    registry.counter('e2e_hits', 'Scrape e2e').inc(7);
    // biome-ignore lint/suspicious/noExplicitAny: Bun global.
    if (!(globalThis as any).Bun) return;
    handle = await startPrometheusExporter({ registry, port: 0 });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('serves a live HTTP scrape', async () => {
    if (!handle) return;
    const res = await fetch(`http://127.0.0.1:${handle.port}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('e2e_hits 7');
  });
});
