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
declaragent down && declaragent up -d
```

Bus state is in-process — the restart drops the hung subscriber.

## Root-cause investigation
```bash
# Daemon snapshot (agents + sources):
declaragent ps
curl -s http://127.0.0.1:9464/status | jq

# In-flight gauge:
curl -s http://127.0.0.1:9464/metrics | grep source_inflight
```

If the daemon had CPU profiling enabled, pull the profile and identify
the hung handler. Otherwise, reproduce locally while tailing
`declaragent logs -f`.

## Post-incident
- Capture: hung subscriber id, cause, fix commit.
- Close when: publish rate resumes normal levels after restart.
- Post-mortem: mandatory — silent hangs are always a regression.
