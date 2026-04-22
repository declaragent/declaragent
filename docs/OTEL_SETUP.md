# OpenTelemetry setup

Wiring instructions for exporting Declaragent's event-source metrics + spans to an OpenTelemetry-compatible backend. Covers:

1. [Auto-enable with `declaragent up`](#1-auto-enable-with-declaragent-up) — zero-code, just set env vars
2. [Installing the SDK (peer deps)](#2-install-the-sdk-peer-deps)
3. [Custom hosts — manual bridge](#3-custom-hosts--manual-bridge)
4. [OTLP HTTP to a collector](#4-otlp-http-exporter)
5. [Prometheus scrape](#5-prometheus-scrape)
6. [End-to-end docker recipe](#6-end-to-end-docker-recipe)

As of 0.6.0, `declaragent up` auto-enables the OTel tracer bridge when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `@opentelemetry/api` is installed — there is no code to write.

All of the metrics described below are defined in `packages/core/src/events/base-source.ts` (slice 6). There is nothing to instrument in your adapter — the base class emits the full set whenever `SourceDependencies.metrics` is wired. `declaragent up` wires a shared `PrometheusRegistry` by default (scrapable at `:9464/metrics` in detached mode) and a bridged OTel tracer when the env var is set.

## Metrics reference

Every adapter subclasses `BaseSourceInstance`, which emits these instruments with `{id, type}` labels:

| Metric | Kind | Description |
|---|---|---|
| `source.messages.received` | counter | Messages pulled from the transport. |
| `source.messages.processed` | counter | Messages successfully published to the bus. |
| `source.messages.failed` | counter | Messages that threw during processing. |
| `source.messages.dlq` | counter | Messages that exhausted retries and hit the DLQ. |
| `source.connection.errors` | counter | Transport reconnect / auth failures. |
| `source.inflight` | gauge | In-flight handler count (clamped by `limits.concurrency`). |
| `source.process.duration_ms` | histogram | End-to-end processing latency (transport → bus publish). |

The OTel bridge translates these into OTLP counter / up-down-counter / histogram. Prometheus sees them with underscores: `source_messages_received_total`, `source_process_duration_ms_bucket`, etc.

Spans are also emitted: one `source.message` span per ingested message, with attributes for `message.id`, `message.topic`, `event.id`, `event.kind`, `correlation.id` (when present), and `outcome` (`published` / `filtered` / `no-normalizer`).

## 1. Auto-enable with `declaragent up`

Two steps — no code changes:

1. Install the peer deps (see §2) wherever `declaragent` runs.
2. Set `OTEL_EXPORTER_OTLP_ENDPOINT` in the environment before starting the agent:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
declaragent up -d
```

`up` detects the env var, calls `createOtelBridge()` internally, and threads the bridged tracer into every source + channel via `deps.tracer`. You will see one of these banners at startup:

- `otel: tracing enabled (OTLP endpoint http://localhost:4318)` — peer deps present, tracer active.
- `⚠ OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing could not start: …` — peer dep missing; the up-loop continues with the noop tracer. Install peer deps and re-run.

Metrics are NOT routed through the bridge — `up` keeps its dedicated Prometheus registry for pull-based scraping. If you want metrics in your OTel backend too, run an OTel collector with the Prometheus receiver in front (see §5).

**Unset the env var** to disable auto-enable. There is no other knob.

## 2. Install the SDK (peer deps)

The `@declaragent/core` package declares `@opentelemetry/api` as a peer dep only — nothing is pulled in by default. The auto-enable path in §1 needs at minimum:

```bash
npm install \
  @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http
```

Add `@opentelemetry/auto-instrumentations-node` and `@opentelemetry/exporter-metrics-otlp-http` if you want auto-instrumentation of other Node modules or OTLP metric export. The declaragent-side bridge doesn't need them — the span exporter alone is enough for tracing.

If you're running the declaragent CLI globally, install the peer deps alongside it in the same node_modules: `npm install -g @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http`.

## 3. Custom hosts — manual bridge

When embedding `@declaragent/core` in your own host (not using the `declaragent` CLI), boot the SDK explicitly and call `createOtelBridge` yourself:

```ts
// otel.ts — imported BEFORE any declaragent code so the bridge can pick it up.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes as R } from '@opentelemetry/semantic-conventions';

export const sdk = new NodeSDK({
  resource: new Resource({
    [R.SERVICE_NAME]: 'declaragent-host',
    [R.SERVICE_VERSION]: process.env.APP_VERSION ?? '0.0.1',
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? 'http://localhost:4318/v1/metrics',
    }),
    exportIntervalMillis: 15_000,
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'http://localhost:4318/v1/traces',
  }),
});

sdk.start();
```

Then build the bridge and hand it to every source via `SourceDependencies`:

```ts
import { createOtelBridge, startDaemon } from '@declaragent/core';
import './otel.js'; // starts the SDK

const { metrics, tracer } = await createOtelBridge({
  meterName: '@declaragent/core',
  tracerName: '@declaragent/core',
});

const daemon = await startDaemon({
  registry,
  adapters,
  sources,
  // ... inside the adapter dispatch, supply metrics + tracer through
  // SourceDependencies. The `eventSourceExtension` wrapper forwards them
  // into BaseSourceInstance which lazily wires the instruments.
  busOptions: { logger },
});
```

`BaseSourceInstance.getInstruments()` is lazy — no cost until the first message lands — so adding / removing the bridge is a cheap configuration toggle.

## 4. OTLP HTTP exporter

Endpoints are the standard OTel HTTP paths:

| Signal | Default URL |
|---|---|
| Metrics | `http://<collector>:4318/v1/metrics` |
| Traces | `http://<collector>:4318/v1/traces` |

Environment overrides honored by the SDK:

- `OTEL_EXPORTER_OTLP_ENDPOINT` — applies to both signals.
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` — per-signal overrides.
- `OTEL_EXPORTER_OTLP_HEADERS` — for hosted OTel backends (Honeycomb, New Relic, Datadog).
- `OTEL_RESOURCE_ATTRIBUTES` — extra resource labels, comma-separated.

## 5. Prometheus scrape

The easiest path: run an OTel collector that receives OTLP and exposes a Prometheus endpoint. No host-side Prometheus client library required.

**collector-config.yaml:**

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  prometheus:
    endpoint: 0.0.0.0:9464
    # Strip the metric namespace so `source.messages.received` lands as
    # `source_messages_received_total` (Prom idiom) rather than
    # `otel_source_messages_received_total`.
    namespace: ''
  otlp/jaeger:
    endpoint: jaeger:4317
    tls: { insecure: true }

processors:
  batch: {}

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]
```

**prometheus.yml:**

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: declaragent
    static_configs:
      - targets: ['otel-collector:9464']
```

## 6. End-to-end docker recipe

A ready-to-run stack lives in `packages/testkit/observability/`. Boot everything with a single command:

```bash
cd packages/testkit/observability
docker compose up -d
```

Brings up:

- `otel-collector` at `:4318` (OTLP HTTP receiver) + `:9464` (Prometheus scrape).
- `prometheus` at `:9090`, scraping the collector.
- `grafana` at `:3000` (admin/admin), pre-provisioned with Prometheus as a datasource.
- `jaeger` at `:16686` (UI) + `:4317` (OTLP receiver for traces).

After the stack is up:

1. Run a declaragent host with the OTel SDK pointing at `http://localhost:4318`.
2. Import `packages/testkit/dashboards/declaragent-event-sources.json` into Grafana (`Dashboards → Import`).
3. Watch the panels populate as soon as the first message lands.
4. Traces show up in Jaeger under the `declaragent-host` service.

See `packages/testkit/dashboards/README.md` for the dashboard import command.

## Alerts (optional)

The dashboard's threshold colors are enough for at-a-glance triage; for on-call, promote them to Prometheus alerts:

```yaml
# Example — DLQ burst
groups:
  - name: declaragent-sources
    rules:
      - alert: SourceDLQBurst
        expr: sum by (id) (rate(source_messages_dlq_total[5m])) > 1
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.id }} DLQing > 1 msg/sec sustained for 10 minutes"

      - alert: SourceConnectionErrors
        expr: sum by (id) (rate(source_connection_errors_total[5m])) > 0.5
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.id }} reconnecting > 30 times/hour"

      - alert: SourceLatencyHigh
        expr: histogram_quantile(0.99, sum by (le, id) (rate(source_process_duration_ms_bucket[5m]))) > 5000
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.id }} p99 latency > 5 s (acceptance-bar breach)"
```

## Follow-ups (not in this slice)

- Bridge `CircuitBreaker.onTransition` into a gauge (`source_circuit_breaker_state`).
- Bridge `KafkaSourceInstance.lag()` into a periodic gauge publisher (`source_lag_messages` labeled by `{topic,partition}`).
- Expose bus inflight as `event_bus_inflight` so the dispatcher can drive its own Grafana row.

All three only touch the observability surface — no core protocol changes — and the dashboard JSON is already set up to absorb the new panels.
