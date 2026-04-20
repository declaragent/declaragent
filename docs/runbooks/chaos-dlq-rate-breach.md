# `ChaosDLQRateExceeded`

**Severity:** critical (fires only during a chaos run).

## Symptom
During the current chaos run, DLQ volume exceeded 1% of ingress.

## Likely cause
1. A fault exhausted the adapter's retry budget faster than the idempotency cache could absorb the replay.
2. `expire-idempotency-cache` fired while a burst of retries was in flight.
3. The adapter's `nack` semantics don't actually requeue under the injected fault (adapter bug).

## Immediate mitigation
```bash
declaragent chaos stop
```

## Root-cause investigation
```bash
declaragent chaos report --run <runId>
declaragent dlq list --source <id> --limit 50 --json
```

## Post-incident
- Capture: DLQ sample, fault correlation, adapter + config under test.
- Close when: a regression test reproduces the DLQ breach and a fix keeps the rate below 0.1%.
- Post-mortem: **mandatory** — DLQ breaches under chaos block Phase-6 exit.
