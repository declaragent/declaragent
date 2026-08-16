# `ChannelInboundFailureRateHigh`

**Severity:** warning.

## Symptom
`channel.inbound.failed` on `{{ id }}` is growing faster than 0.1/s.
Inbound events from the channel are arriving but failing to publish
onto the bus.

## Likely cause
1. Bus backpressure — the bus is already at the high-watermark.
2. A registered subscriber is throwing on every inbound — pressure
   propagates back to publish.
3. A malformed inbound event is failing schema validation inside the
   dispatcher.

## Immediate mitigation
If bus pressure is the cause, pause non-critical sources so pressure drops:

```bash
# Comment the noisy source out of event-sources.yaml and restart —
# there is no source-pause verb; brokers retain the backlog:
declaragent down && declaragent up -d
```

## Root-cause investigation
```bash
# Most recent inbound channel audit records (filter in jq):
declaragent audit query --kind channel_event --since -15m --json

# Daemon snapshot + inbound-failure counter:
curl -s http://127.0.0.1:9464/status | jq
curl -s http://127.0.0.1:9464/metrics | grep channel_inbound_failed
```

Grafana: `Channels` dashboard → `Inbound failure rate`.

## Post-incident
- Capture: failure rate, likely root cause (bus / subscriber / schema), fix action.
- Close when: failure rate < 0.01/s for 15 minutes.
- If a subscriber was the cause, file a regression against the subscribing skill / plugin.
