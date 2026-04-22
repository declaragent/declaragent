# `ChannelOutboundP99LatencyHigh`

**Severity:** warning.

## Symptom
p99 of `channel.outbound.latency_ms` on `{{ id }}` is above 5,000 ms
for 10 minutes. Streaming send-then-edit experiences will feel
choppy; typing indicators may stop reflecting reality.

## Likely cause
1. Platform-side latency (Slack / Meta / Discord all publish latency dashboards — check theirs).
2. Adapter concurrency limit is too low for the current volume.
3. Idempotency cache is full and every send is doing a round-trip hash-compare on large payloads.

## Immediate mitigation
Raise the adapter's concurrency limit if headroom allows:

```bash
declaragent channels config set <id> limits.concurrency 20
declaragent channels reload <id>
```

## Root-cause investigation
```bash
# Latency histogram samples:
declaragent metrics scrape --grep channel_outbound_latency_ms

# Grafana: Channels → Outbound latency heatmap.
# Check the platform partner's own latency dashboard alongside.
```

## Post-incident
- Capture: p99 peak, driving workload, mitigation applied.
- Close when: p99 < 2,500 ms sustained for 15 minutes.
