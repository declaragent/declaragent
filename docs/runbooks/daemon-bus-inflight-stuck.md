# `BusInflightStuckHigh`

**Severity:** critical.

## Symptom
`bus_inflight` is > 100 with a zero publish rate over 10 minutes. A
subscriber is hung and `Promise.allSettled` is waiting on it.

## Likely cause
1. An extension's subscriber callback never resolves (missing `await`, infinite `await` on a hung promise).
2. A channel adapter's outbound bridge is deadlocked awaiting a platform response that never comes.
3. A plugin-contributed hook is blocking the bus.

## Immediate mitigation
Restart the daemon:

```bash
declaragent daemon restart
```

Bus state is in-process — the restart drops the hung subscriber.

## Root-cause investigation
```bash
# Active subscribers:
declaragent daemon status --json | jq '.bus.subscribers'
```

If the daemon had CPU profiling enabled, pull the profile and identify
the hung handler. Otherwise, reproduce locally with
`DECLARAGENT_LOG_LEVEL=debug`.

## Post-incident
- Capture: hung subscriber id, cause, fix commit.
- Close when: publish rate resumes normal levels after restart.
- Post-mortem: mandatory — silent hangs are always a regression.
