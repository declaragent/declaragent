# `SourceConnectionErrorStorm`

**Severity:** warning.

## Symptom
`source.connection.errors` on `{{ id }}` (`{{ type }}`) is climbing > 0.1/s
for 5 minutes. The adapter will likely trip its circuit breaker soon.

## Likely cause
1. Broker / upstream partner genuinely unreachable (network or partner-side outage).
2. TLS cert / credential rotation broke the adapter's stored auth.
3. A wire-level DNS issue is intermittently blackholing the target hostname.

## Immediate mitigation
If the partner's status page shows an outage, no action — the breaker
will pause the adapter automatically. Otherwise, check credentials:

```bash
# Rotate, then restart so the resolver picks up the new value:
declaragent secrets rotate <ref>
declaragent down && declaragent up -d
```

## Root-cause investigation
```bash
# Health detail + last connection error:
curl -s http://127.0.0.1:9464/status | jq
curl -s http://127.0.0.1:9464/metrics | grep source_connection_errors

# Watch the adapter's own log lines live:
declaragent logs -f
```

## Post-incident
- Capture: error codes, mitigation, partner-side evidence (status page link).
- Close when: connection errors < 1 per 5 minutes.
