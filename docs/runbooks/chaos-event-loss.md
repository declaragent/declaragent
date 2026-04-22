# `ChaosNoEventLoss`

**Severity:** critical (fires only during a chaos run).

## Symptom
During the current chaos soak, `source.messages.received` exceeds
`(processed + dlq)` by a positive margin. An event has been silently
dropped on the floor.

## Likely cause
1. A fault implementation is ack'ing a message without publishing.
2. The adapter's pause/resume is dropping in-flight messages on state transitions.
3. The bus watermark logic is swallowing a publish under high backpressure.

## Immediate mitigation
Stop the chaos run:

```bash
declaragent chaos stop
```

Chaos runs are explicitly bounded — don't try to "mitigate" the
symptom during the run; the run itself is the experiment.

## Root-cause investigation
```bash
# Chaos report for the current run:
declaragent chaos report --run <runId> --out chaos-report.json

# Diff against the prior clean run:
diff <(jq -S '.assertions' chaos-report.prior.json) \
     <(jq -S '.assertions' chaos-report.json)
```

The fault timeline in the report identifies exactly which fault window
preceded the loss.

## Post-incident
- Capture: chaos report, fault timeline, hypothesized cause.
- Close when: a targeted unit test reproduces the fault and a fix
  lands with that test green.
- Post-mortem: **mandatory** — any event loss under Phase 6's chaos
  harness blocks the phase's release gate.
