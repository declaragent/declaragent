# `SessionSpawnStall`

**Severity:** warning.

## Symptom
Active sessions exist, inbound traffic continues, but no new sessions
have spawned in 10 minutes.

## Likely cause
1. Dispatcher idempotency cache is saturated — every inbound event
   looks like a duplicate.
2. Session-busy backpressure is holding every incoming event in the
   queue.
3. Session factory is throwing on `createChildSession` and the error
   is being swallowed somewhere.

## Immediate mitigation
Expand the idempotency cache TTL if saturation is the cause:

```bash
# Raise delivery.idempotency.ttlMs on the source in event-sources.yaml,
# then restart to apply:
declaragent down && declaragent up -d
```

## Root-cause investigation
```bash
# Dispatcher counters:
curl -s http://127.0.0.1:9464/metrics | grep -E 'declaragent_dispatcher|source_messages'

# Recent `rejected` outcomes + reasons:
declaragent events list --outcome rejected --last 50 --json
```

## Post-incident
- Capture: dispatch outcome distribution, remediation.
- Close when: new sessions spawning at normal rate.
