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
declaragent sources config set <id> limits.concurrency 16
declaragent sources reload <id>
```

If the downstream is genuinely overloaded, pause the source instead:

```bash
declaragent sources pause <id>
```

## Root-cause investigation
```bash
# Inflight + received/processed counters:
declaragent sources status <id> --json

# Grafana: Event Sources → "Received vs Processed" + "Inflight" panels.
```

Check the dispatcher's own metrics (`dispatcher_queued_total`,
`dispatcher_rejected_total`) for deferral patterns.

## Post-incident
- Capture: peak lag, root cause, mitigation applied.
- Close when: lag < 0.1 msg/s for 15 minutes.
