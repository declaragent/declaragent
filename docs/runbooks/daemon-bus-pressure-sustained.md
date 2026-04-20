# `BusPressureSustained`

**Severity:** warning.

## Symptom
Bus in-flight count has held above 200 for 10 minutes. Source adapters
with `busPressure` wiring will be continuously paused; non-wired
sources may be blocking `bus.publish` on every call.

## Likely cause
1. Downstream handler capacity shrank (scaled-in replicas, slow session).
2. A subscriber is slow but not hung — publishes stay in-flight longer.
3. A burst of legitimate traffic overwhelmed the configured capacity.

## Immediate mitigation
Raise the bus's high-watermark temporarily or scale handler capacity:

```bash
declaragent config set events.bus.highWatermark 500
declaragent daemon reload
```

## Root-cause investigation
```bash
declaragent daemon status --json | jq '.bus'
```

Grafana: `Daemon` dashboard → `Bus inflight` + `Publish rate` panels.

## Post-incident
- Capture: pressure peak, driving workload, mitigation (capacity vs threshold).
- Close when: inflight < 50 for 15 minutes.
