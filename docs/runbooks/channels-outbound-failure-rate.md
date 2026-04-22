# `ChannelOutboundFailureRateHigh`

**Severity:** critical.

## Symptom
More than 1% of outbound sends on channel `{{ id }}` are failing over a
rolling 5-minute window. Dashboards show the `channel.outbound.failed`
rate climbing while `channel.outbound.sent` stays flat or drops.

## Likely cause
1. Platform returned `429` faster than the one-shot retry can absorb.
2. Auth token rotated out-of-band and the adapter is presenting stale credentials.
3. Downstream template / payload validation is failing (WhatsApp, Slack block-kit).

Decision tree:
- 429 codes dominate → rate-limit path. Go to `channels-rate-limit-sustained`.
- 401 / 403 dominate → token invalid. Rotate + redeploy.
- 400 dominates → payload-shape problem; check recent release diffs.

## Immediate mitigation
Disable the offending channel instance temporarily:

```bash
declaragent channels pause <id>
```

This halts outbound dispatch on `<id>` while leaving inbound
consumption running, so queued events keep flowing to other channels.

## Root-cause investigation
```bash
# Error-response samples from the last 15 minutes:
declaragent channels audit query --id <id> --kind outbound --since -15m --outcome failed

# Correlate with the platform's status API (Slack / Meta / Discord).
# Grafana: "Channels" dashboard → "Outbound failure rate" panel.
```

If the adapter supports it, bump `deps.logger` to `debug` level and
capture one round of failed sends verbatim.

## Post-incident
- Capture: channel id, failure mode, top 3 error bodies, restoration action.
- Close when: failure rate < 0.1% sustained for 10 minutes.
- Post-mortem: required for any outage > 30 minutes or any breach of a
  customer-facing SLA window.
