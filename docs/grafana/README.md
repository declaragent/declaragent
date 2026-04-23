# Declaragent — Grafana dashboard bundle

A single importable Grafana dashboard that aggregates the Prometheus counters + gauges + histograms shipped by the runtime through 0.7.6. Target audience: operators standing up an enterprise fleet who don't want to hand-author panels from scratch.

## What you get

[`declaragent-fleet-dashboard.json`](./declaragent-fleet-dashboard.json) — three rows of panels:

| Row | Focus | Metrics |
| --- | --- | --- |
| **1 · MCP health** | Supervisor state + drain + rate-limit rejects | `mcp_server_restarts_total`, `mcp_server_circuit_state`, `mcp_server_circuit_open_total`, `mcp_server_drain_duration_ms`, `mcp_server_rate_limited_total` |
| **2 · Audit + SIEM** | Back-pressure + adaptive batch + export throughput | `declaragent_audit_backpressure_{active,paused_total,backlog_ms}`, `declaragent_audit_batch_{interval_ms,rows}`, `declaragent_audit_export_{acked_total,failures_total,last_seq}` |
| **3 · Rate limits + dispatch** | Provider + per-tool waits, source throughput + DLQ | `declaragent_provider_rate_limit_{waits,wait_ms}`, `declaragent_tool_rate_limit_waits_total`, `source_messages_{received,processed,dlq}`, `source_inflight` |

Default time range: 15m. Refresh: 30s. Three template variables at the top filter by `server_id` / `agent` / `source`.

## Prometheus scrape config

`declaragent up -d` exposes `/metrics` on `127.0.0.1:9464` by default (override with `DECLARAGENT_METRICS_PORT`; `0` disables). Point Prometheus at it:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: declaragent
    static_configs:
      - targets: ['declaragent-host-1:9464', 'declaragent-host-2:9464']
    metrics_path: /metrics
    scrape_interval: 15s
```

Remote-bind requires an `agent.yaml#controlPlane.bind` opt-in plus an OIDC/OAuth2 auth block — see [`/reference/control-plane`](https://docs.declaragent.dev/reference/control-plane). Localhost-only is the default.

When OTel is wired up (`OTEL_EXPORTER_OTLP_ENDPOINT=...`), the same counters are also exported through the collector's Prometheus exporter — in that topology point the scrape job at the collector's port (`:9464` by convention, see `packages/testkit/observability/prometheus.yml`) instead of every CLI host.

## Importing

### Grafana UI

1. Dashboards → Import → Upload JSON file.
2. Pick your Prometheus data source when prompted for `DS_PROMETHEUS`.
3. Dashboard lands under tag `declaragent`.

### Grafana HTTP API

```bash
curl -X POST http://admin:admin@grafana:3000/api/dashboards/db \
  -H 'Content-Type: application/json' \
  -d "$(jq '{dashboard: ., overwrite: true, inputs: [{"name":"DS_PROMETHEUS","type":"datasource","pluginId":"prometheus","value":"Prometheus"}]}' declaragent-fleet-dashboard.json)"
```

### grafana-operator ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: declaragent-fleet-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  declaragent-fleet-dashboard.json: |
    {{ .Files.Get "declaragent-fleet-dashboard.json" | indent 4 }}
```

(Helm helper syntax shown — the Operator watches `ConfigMap`s with the configured label and side-loads them into Grafana.)

## Suggested alerts

Start with these thresholds; tune to your SLOs after two weeks of soak. Every rule below is a direct prometheus-rule or Alertmanager expression; pair with the runbooks under [`/troubleshooting/runbook-index`](https://docs.declaragent.dev/troubleshooting/runbook-index) where they exist.

| Panel | Suggested alert | Severity |
| --- | --- | --- |
| MCP restarts (total) | `increase(mcp_server_restarts_total[15m]) > 3` | warning |
| Circuit state | `max(mcp_server_circuit_state) >= 2 for 1m` | page |
| Circuit-open transitions | `increase(mcp_server_circuit_open_total[5m]) > 0` | page (this is the canonical "a tool just broke" signal — see `packages/core/src/mcp/supervisor.ts` doc block) |
| Drain duration p99 | `histogram_quantile(0.99, rate(mcp_server_drain_duration_ms_bucket[5m])) > 1500 for 5m` | warning |
| MCP rate-limit rejections | `sum(rate(mcp_server_rate_limited_total[5m])) > 0.1 for 10m` | warning (the cap is too low _or_ a skill is hot-looping) |
| Audit backlog (ms) | `max(declaragent_audit_backpressure_backlog_ms) > 60000 for 5m` | page (SIEM is 1+ minute behind) |
| Back-pressure active | `max(declaragent_audit_backpressure_active) == 1 for 2m` | page |
| Batch interval pinned at min | `declaragent_audit_batch_interval_ms <= 1000 for 15m` | warning (exporter chasing a growing backlog) |
| Export failures | `sum(rate(declaragent_audit_export_failures_total[5m])) > 0 for 5m` | page |
| Exporter last_seq flat | `deriv(declaragent_audit_export_last_seq[10m]) == 0` while audit writes are nonzero | page |
| Provider rate-limit waits | `sum(rate(declaragent_provider_rate_limit_waits[5m])) > 1 for 10m` | warning (quota pressure) |
| Tool rate-limit waits | `sum by (agent, tool) (rate(declaragent_tool_rate_limit_waits_total[5m])) > 0.5 for 15m` | warning |
| Source DLQ rate | `sum(rate(source_messages_dlq[5m])) > 0 for 5m` | page — dispatch DLQ growing is always a regression |
| Source inflight saturation | `max(source_inflight) >= <your limits.concurrency> for 10m` | warning |

## What this dashboard does _not_ cover (yet)

- **Channel outbound health.** Use [`packages/testkit/dashboards/channels.json`](../../packages/testkit/dashboards/channels.json) — separate dashboard, scoped to inbound/outbound per channel type, not in this bundle to keep the fleet-level JSON importable in one shot.
- **Event-source deep dive.** Use [`packages/testkit/dashboards/declaragent-event-sources.json`](../../packages/testkit/dashboards/declaragent-event-sources.json) for per-source latency + connection errors; the row 3 panels here are a fleet-wide overview, not a replacement.
- **WhatsApp 24h service-window telemetry.** Use [`packages/testkit/dashboards/whatsapp-windows.json`](../../packages/testkit/dashboards/whatsapp-windows.json).
- **`audit_export_queue_depth` (by that name).** The runtime exposes the semantically equivalent `declaragent_audit_backpressure_backlog_ms` (backlog as time, not row count). If an operator has rigged Prometheus recording rules for a `_queue_depth` gauge, map it to the backlog panel.
- **Per-host fan-out across a fleet.** This dashboard scrapes `:9464` per host and aggregates via Prometheus `sum()`; cross-host split (if you run the managed control plane) is the operator's job — split by the `instance` label or add a `host` dimension via relabel configs.

## Version compatibility

- Grafana 9.x or 10.x. `schemaVersion: 38` is the 10.0 baseline.
- Prometheus 2.x (any reasonably recent).
- Declaragent CLI ≥ 0.7.6. Earlier versions are missing some of the audit + MCP metrics referenced here; panels that can't find their series will render as "No data" but the dashboard will still import cleanly.

## Where the metric names come from

- MCP: `packages/core/src/mcp/supervisor.ts`
- Audit exporter + back-pressure + adaptive batch: `packages/core/src/audit/exporter-loop.ts`
- Provider rate-limit: `packages/cli/src/up-cli.ts` (registers `declaragent.provider.rate_limit.{waits,wait_ms}`); bucket impl in `packages/core/src/providers/rate-limit.ts`
- Tool rate-limit: `packages/cli/src/up-cli.ts` (registers `declaragent.tool.rate_limit.{waits_total,wait_ms}`); gate impl in `packages/core/src/tools/rate-limit-gate.ts`
- Event sources: `packages/core/src/events/base-source.ts`

Prometheus wire names are the dotted internal identifiers with non-alphanumeric characters normalized to `_` — see `normalizeMetricName` in `packages/core/src/observability/prometheus.ts`.
