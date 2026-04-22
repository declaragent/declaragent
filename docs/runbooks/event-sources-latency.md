# `SourceP99LatencyHigh`

**Severity:** warning.

## Symptom
p99 of `source.process.duration_ms` on `{{ id }}` (`{{ type }}`) is above
10 seconds for 10 minutes.

## Likely cause
1. Normalizer is doing expensive work (schema-registry round-trip?).
2. Dispatcher latency has grown (a downstream session is slow).
3. The adapter's concurrency limit is too tight and every message waits.

## Immediate mitigation
If schema-registry latency is the cause, bump the registry cache TTL:

```bash
declaragent config set event-sources.schemaRegistry.cacheTtlMs 300000
declaragent daemon reload
```

## Root-cause investigation
```bash
# Histogram bucket distribution:
curl -s localhost:9464/metrics | grep source_process_duration_ms

# Grafana: Event Sources → "Process duration heatmap".
```

Correlate with the dispatcher's own p99 — if both are climbing, the
downstream (sessions / engine) is the bottleneck.

## Post-incident
- Capture: p99 peak, cause, mitigation.
- Close when: p99 < 2,500 ms sustained for 15 minutes.
