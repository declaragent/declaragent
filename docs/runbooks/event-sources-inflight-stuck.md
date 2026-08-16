# `SourceInflightStuck`

**Severity:** critical.

## Symptom
Source `{{ id }}` has > 0 in-flight messages but has published zero
events to the bus in 10 minutes. A handler is deadlocked or the
adapter's ack path is hung.

## Likely cause
1. Adapter's inner handler is awaiting a promise that never resolves.
2. Bus subscriber is blocking publish (rare — `Promise.allSettled` should prevent this).
3. `ackStrategy: after-dispatch` + a missing `hookRegistry` → pending acks never fire (base-source logs this on miswire).

## Immediate mitigation
Restart the adapter — it'll clear pending acks and rebuild its
transport connection:

```bash
declaragent down && declaragent up -d
```

If the issue persists after restart, the bug is in the handler, not
the adapter.

## Root-cause investigation
```bash
# Inflight snapshot:
curl -s http://127.0.0.1:9464/status | jq
curl -s http://127.0.0.1:9464/metrics | grep source_inflight

# Search daemon logs for `base-source.after-dispatch.no-hook-registry`
# — that warn indicates miswire.
```

## Post-incident
- Capture: dump of pending acks, stack trace if captured, restart impact.
- Close when: inflight count matches publish rate again.
- Post-mortem: mandatory — silent hangs are always a regression.
