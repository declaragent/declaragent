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
declaragent config set events.idempotency.ttlMs 3600000
declaragent daemon reload
```

## Root-cause investigation
```bash
# Dispatcher counters:
declaragent daemon status --json | jq '.dispatcher'

# Recent `rejected` outcomes + reasons:
declaragent events recent --outcome rejected --limit 50 --json
```

## Post-incident
- Capture: dispatch outcome distribution, remediation.
- Close when: new sessions spawning at normal rate.
