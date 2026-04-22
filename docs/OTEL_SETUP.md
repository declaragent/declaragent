# OpenTelemetry setup

Wiring instructions for exporting Declaragent's event-source metrics + spans to an OpenTelemetry-compatible backend. Covers:

1. [Installing the SDK](#1-install-the-sdk)
2. [Booting the host + bridging into the adapter deps](#2-boot-the-sdk-and-bridge-into-the-source)
3. [OTLP HTTP to a collector](#3-otlp-http-exporter)
4. [Prometheus scrape](#4-prometheus-scrape)
5. [End-to-end docker recipe](#5-end-to-end-docker-recipe)

All of the metrics described below are defined in `packages/core/src/events/base-source.ts` (slice 6). There is nothing to instrument in your adapter — the base class emits the full set whenever `SourceDependencies.metrics` is wired.

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

## 1. Install the SDK

The `@declaragent/core` package declares `@opentelemetry/api` as a peer dep only — nothing is pulled in by default. To opt in, install the SDK in your host application:

```bash
npm install \
  @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-metrics-otlp-http \
  @opentelemetry/exporter-trace-otlp-http
```

## 2. Boot the SDK and bridge into the source

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

## 3. OTLP HTTP exporter

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

## 4. Prometheus scrape

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

## 5. End-to-end docker recipe

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
