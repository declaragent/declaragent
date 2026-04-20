# `ChannelRateLimitRetriesSustained`

**Severity:** warning.

## Symptom
`channel.outbound.rate_limit_retries` on channel `{{ id }}` holds above
0.5/s for 10 minutes. The platform is continuously returning `429`.

## Likely cause
1. Broadcast campaign volume exceeds the platform's per-workspace ceiling.
2. Audience includes unsubscribed / invalid recipients the platform is deliberately throttling.
3. The adapter's token is shared with another caller outside Declaragent.

## Immediate mitigation
Reduce the outbound rate:

```bash
declaragent channels config set <id> outbound.rateLimit.qps 1
declaragent channels reload <id>
```

If the surge is a campaign, pause the skill emitting it.

## Root-cause investigation
```bash
# Recent retry samples:
declaragent channels audit query --id <id> --kind outbound --outcome rate-limited --since -30m

# Grafana: "Channels" dashboard → "Rate-limit retries" panel.
```

Compare against the platform's published rate-limit tiers (Slack Tier
4, Meta Business messaging tier, etc.).

## Post-incident
- Capture: peak retries/s, driving skill, effective QPS after mitigation.
- Close when: retries/s < 0.1 sustained for 10 minutes.
- If the incident was tier-related, open an escalation ticket with the
  platform partner team.
