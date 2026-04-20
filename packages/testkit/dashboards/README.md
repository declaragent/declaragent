# Declaragent Grafana dashboards

Ship-ready dashboards for the Phase-4 event-source fleet. Import into Grafana via `Dashboards → Import → Upload JSON` and wire up a Prometheus data source that scrapes your OTel collector (see `../observability/README.md`).

## Dashboards

### `declaragent-event-sources.json`

Main operational view. One row of stat tiles up top (sources, processed, DLQ rate, connection errors, inflight, failed), then per-source timeseries:

- **Throughput — received vs. processed.** Healthy source: processed ≈ received. A persistent gap means handler work is blocking or the normalizer is dropping messages.
- **Processing duration — p50 / p95 / p99.** Derived from the `source_process_duration_ms` histogram. Slice-16 acceptance bar: p99 < 5000 ms at 1K msg/sec.
- **DLQ rate.** Messages/sec that exhausted their retry budget. A spike usually pairs with the failed-rate panel.
- **Failed rate.** Messages/sec that threw during processing (may be retried before hitting DLQ).
- **Inflight handlers.** Bounded above by each adapter's `limits.concurrency`. Persistent saturation → raise concurrency or fix downstream latency.
- **Connection errors.** Transport-level reconnect/auth failures.

All panels key on the `id` label, which the adapter populates with the trigger's configured id. Group-by to see individual sources or leave as-is for fleet-wide totals.

## What's missing + how to extend

- **Kafka lag.** `KafkaSourceInstance.lag()` returns per-partition end offsets but doesn't push to the metrics registry yet. A follow-up (`lag()` → gauge) will wire this up; add a timeseries panel keyed on `{topic,partition}` when that lands.
- **Circuit-breaker state.** `CircuitBreaker` from slice 13 tracks transitions but doesn't emit to the `MetricsRegistry`. Once the bridge is added, a stat-timeseries panel showing `source_circuit_breaker_state{id}` (0=closed, 1=half-open, 2=open) rounds out the operational picture.
- **Bus backpressure.** Slice 13 added high/low watermark listeners but no gauge. An `event_bus_inflight` gauge + a single line chart shows when the dispatcher is falling behind.

All three are ~1-day follow-ups that only touch observability; the dashboard JSON above is structured so adding the panels is additive.

## Importing

```bash
# grafana container + declaragent source fleet up:
docker compose -f ../observability/docker-compose.yml up -d

# then:
curl -X POST http://admin:admin@localhost:3000/api/dashboards/db \
  -H 'Content-Type: application/json' \
  -d "$(jq '{dashboard: ., overwrite: true}' declaragent-event-sources.json)"
```

Or via the UI: `http://localhost:3000` → Dashboards → Import → Upload JSON → paste the datasource name when prompted.
