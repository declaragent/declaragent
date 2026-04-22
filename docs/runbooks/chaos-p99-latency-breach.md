# `ChaosSLOP99OutboundLatencyBreached`

**Severity:** critical (fires only during a chaos run).

## Symptom
During the current chaos run, p99 `channel.outbound.latency_ms`
exceeds the 10s SLO.

## Likely cause
1. A `partition-channel` fault longer than the adapter's retry budget pushed queued sends past the SLO.
2. The bus backpressure listener paused a channel adapter and queued sends didn't drain fast enough on resume.
3. An upstream platform's own latency happened to coincide with the fault window.

## Immediate mitigation
Stop the chaos run and review assertions:

```bash
declaragent chaos stop
declaragent chaos report --run <runId>
```

## Root-cause investigation
Correlate the chaos report's fault timeline with the latency histogram
samples. A p99 breach that started within 60s of a fault fire is
almost always caused by that fault.

## Post-incident
- Capture: fault → breach timeline, recovery duration.
- Close when: a targeted test reproduces the breach and a fix stabilizes p99 under the same fault.
