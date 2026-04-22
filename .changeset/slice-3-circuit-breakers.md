---
'@declaragent/core': minor
'@declaragent/cli': minor
---

**Slice 3 of 0.6.0 production hardening — circuit breakers in the dispatcher.**

### Core (@declaragent/core)

`createEventDispatcher` grows an optional `targetBreaker(targetName): CircuitBreaker | undefined` callback. When supplied, `target.type === 'skill'` routing consults the breaker:

- `breaker.allow()` checked before `runSkill`. If the breaker is `open` (post-cooldown state not yet elapsed), the dispatcher short-circuits to `{ kind: 'rejected', reason: 'circuit-open', details }` without invoking the skill.
- The call outcome is recorded via `breaker.record(success)` — success on a clean turn, failure on a thrown error. The error is re-thrown so the dispatcher's existing catch-and-map-to-`invalid` path still fires.

`DispatchOutcome`'s rejected-reason union gains `'circuit-open'`. Existing consumers compile unchanged — the union widens, callers that exhaustively switch need to add a case (documented in the CHANGELOG).

Scope: only `case 'skill'` is wrapped. `sub-agent` + `session` targets fall through without breaker protection. Extending breakers to those targets is a follow-up once an operator need appears.

### CLI (@declaragent/cli)

`declaragent up` lazily creates one `CircuitBreaker` per skill target (10 consecutive failures → 30-s cooldown). Every transition bumps:

- `declaragent_dispatcher_breaker_transitions_total{agent, target, from, to}` (counter)
- `declaragent_dispatcher_breaker_state{agent, target}` gauge (0=closed / 1=half-open / 2=open)

Both are scrapable through the `/metrics` endpoint shipped in Slice 1. Transitions also log at warn/info level through `declaragent logs <agent>` so operators don't need a Prometheus stack to notice a trip.

`declaragent events list --state circuit-open` filters persisted events down to those whose dispatch was rejected by a breaker. Combinable with `--kind` / `--correlation`; supersedes `--outcome` when both are passed.

### Intentional deferrals

- **`agent.yaml#reliability.circuitBreaker` schema** — plan called for `failureThreshold` / `cooldownMs` / `halfOpenProbes` override fields. The breakers are on by default with sane values; adding the schema is a small follow-up that doesn't block the slice's goal. Deferred to an 0.6.x patch once operators request tuning.
- **`declaragent ps` column** — reporting live breaker state would need a runtime query surface up-state doesn't have today. Deferred alongside the Slice 5 store work that's about to add `rejected_events` anyway.

Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 3.
