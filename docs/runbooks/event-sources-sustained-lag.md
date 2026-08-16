# `SourceSustainedLag`

**Severity:** warning.

## Symptom
Source `{{ id }}` (`{{ type }}`) ingress rate exceeds egress by > 1
msg/s for 10 minutes. Grafana's event-sources dashboard shows the lag
widening.

## Likely cause
1. Dispatcher is busy (queue backpressure).
2. Concurrency limit on the adapter is too low.
3. Downstream handler is slower than the producer expected.

## Immediate mitigation
Increase the adapter's concurrency ceiling if the host has capacity:

```bash
# Raise limits.concurrency on the source in event-sources.yaml, then
# restart to apply:
declaragent down && declaragent up -d
```

If the downstream is genuinely overloaded, comment the source out of
`event-sources.yaml` instead and restart — the broker retains the
backlog for redelivery.

## Root-cause investigation
```bash
# Inflight + received/processed counters:
curl -s http://127.0.0.1:9464/metrics | grep -E 'source_inflight|source_messages'

# Grafana: Event Sources → "Received vs Processed" + "Inflight" panels.
```

Check the receive-vs-process gap (`source_messages_received` minus
`source_messages_processed`) and `source_inflight` for deferral patterns;
rejected dispatches surface in `declaragent dlq list --kind dispatch`.

## Post-incident
- Capture: peak lag, root cause, mitigation applied.
- Close when: lag < 0.1 msg/s for 15 minutes.
