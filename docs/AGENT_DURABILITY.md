# Agent durability — the three execution modes

> **Audience:** operators deciding how a spun-up agent should carry context.
> **TL;DR:** within a single turn an agent is *never* a single-prompt one-shot —
> it runs a real up-to-50-iteration tool loop. *Across events*, the default is
> stateless. If you want an agent that builds context over time, opt into
> **session pinning** with a `sessionKey`.

This document addresses [`PROD_PARITY_ACTIONS.md`](../PROD_PARITY_ACTIONS.md)
**Item A** ("not just one-cycle single-prompt agents"). The fear there is
half-right, and the nuance matters:

| Concern | Reality |
| --- | --- |
| "Agents are single-prompt." | **False within a turn.** The engine runs perceive→reason→act→observe up to `DEFAULT_MAX_ITERATIONS = 50` tool-use iterations, breaking only when the model returns a non-`tool_use` stop reason (`packages/core/src/engine/engine.ts:32`, `:411`). |
| "Agents have no memory." | **True by default across events**, fixable per-route via `sessionKey` (mode 2 below). |

---

## Mode 1 · stateless-reactive (default)

The default inbound route is `{ event, skill }`:

```json
{
  "channels": [
    {
      "id": "slack-main",
      "type": "slack",
      "inbound": {
        "routes": [
          { "event": "chat.mention", "skill": "triage" }
        ]
      }
    }
  ]
}
```

**Flow.** The channel adapter publishes a session-targeted inbound event; the
inbound bridge (`packages/core/src/channels/inbound-bridge.ts`) re-publishes it
with `target: { type: 'skill', name: route.skill }`; the dispatcher's `skill`
case (`packages/core/src/events/dispatcher.ts`) calls `runSkill` with a
**fresh** `createChildSession()` — so every event gets a brand-new transcript.

**What this is NOT.** It is not single-prompt: that one event still drives a
full multi-step tool loop (mode-table row above). It *is* stateless **across**
events — the agent reasons over many steps for one event, then forgets.

**Correct for:** pure event handlers (PR-triage, webhook fan-out, "run this
skill when X happens") where each event is independent and carrying prior
context would be wrong (or a privacy hazard across tenants).

---

## Mode 2 · session-pinned (`sessionKey`) — opt-in, since 0.7.6

Add a stable `sessionKey` to an inbound route. Repeated events that carry the
same key **resolve-or-create one durable session** and append each event as a
**new turn**, so the transcript accumulates:

```json
{
  "channels": [
    {
      "id": "slack-main",
      "type": "slack",
      "inbound": {
        "routes": [
          { "event": "chat.dm", "skill": "support", "sessionKey": "support-thread" }
        ]
      }
    }
  ]
}
```

### What happens

1. The route parser (`packages/cli/src/channels-runtime.ts#parseInboundRoutes`)
   validates `sessionKey` is an optional **non-empty** string and carries it
   onto the `InboundRoute`. An empty or non-string value drops the whole route
   with a `channels.inbound-config.route-invalid` warning.
2. The inbound bridge copies the key onto the bridged skill target
   (`target.sessionKey`).
3. The dispatcher's `skill` case branches on `target.sessionKey`:
   - **non-empty key** → resolve-or-create a durable session via the host
     factories `resolveSessionByKey(key)` (falling back to
     `createSessionForKey(key)` on a miss), then run the **event** as a new
     turn on that session, serialized behind the per-session lock.
   - **absent / empty key** → the unchanged mode-1 path (fresh child session).

### Key choice

Pick a key that scopes the conversation you want to persist:

| Intent | `sessionKey` derivation |
| --- | --- |
| One conversation per Slack thread | the thread's `threadTs` |
| One agent per tenant | the tenant id |
| One agent per tracked entity (ticket, PR, customer) | the entity id |

> **Cardinality is your responsibility.** A key with unbounded cardinality
> (e.g. per message id) defeats the purpose — every event mints a new pinned
> session, which is just mode 1 with extra storage. Choose a key that *repeats*.

### Guarantees

- **Serialization.** Two events with the same `sessionKey` run serially behind
  the dispatcher's per-session lock — no interleaved turns on one transcript.
- **Isolation.** Different `sessionKey`s map to different sessions; transcripts
  never bleed across keys.
- **Durability.** `declaragent up` wires the dispatcher's
  `resolveSessionByKey` / `createSessionForKey` factories to the SQLite
  session store's keyed API (`resolveByKey` / `createForKey` in
  `packages/core/src/session/sqlite.ts`), which persists a
  `(tenant_id, sessionKey) → session_id` mapping. A pinned transcript
  therefore survives process restarts the same way a `target: 'session'`
  dispatch does — re-running `up` and re-firing an event with the same
  `sessionKey` re-opens the same transcript.
- **Back-compat.** Absent `sessionKey` is byte-for-byte the old behavior — no
  `sessionKey` key is emitted anywhere, so rate-limiting (`targetIdentity`
  still returns `target.name`), target validation, and every existing test are
  unaffected.

### Pinned runs the *event*, not the re-rendered skill prompt

A pinned skill route runs `frameEvent(event)` as the turn's user message (the
same pattern as `target: 'session'` / `new-session`), **not** the rendered skill
prompt that mode 1 passes through `runSkill`. This is intentional: a pinned
conversation accumulates real event turns, not a re-rendered prompt on every
event. Plan your skill prompt accordingly — for a pinned route the skill's
prompt establishes the agent's role once (at session creation, via the host's
`createSessionForKey` spec) and each event is a turn in that ongoing
conversation.

### Wiring status — live through `declaragent up`

Session pinning fires end-to-end on a real `declaragent up` today. The full
chain is wired:

1. **Route config + dispatcher** accept `sessionKey` (route parser →
   inbound bridge → `target.sessionKey`).
2. **Session store** exposes a keyed API — `resolveByKey(key)` /
   `createForKey(key, spec)` on `SqliteSessionStore`
   (`packages/core/src/session/sqlite.ts`) — persisting a
   `(tenant_id, sessionKey) → session_id` mapping.
3. **`declaragent up`** (`packages/cli/src/up-cli.ts`) passes those two
   methods into `createEventDispatcher` as `resolveSessionByKey` /
   `createSessionForKey`, with `createSessionForKey` binding the new pin to
   the agent's own `spec`.
4. **The daemon path** (`packages/core/src/events/daemon.ts`) derives the
   same factories from an optional `sessionStore` + `sessionSpecForKey`, so
   the bus-driven path is pinned too.

A `sessionKey` route still **fails safe** when no keyed factories are wired
(e.g. a host that omits the session store): the dispatcher returns
`rejected: no-handler` rather than silently reverting to a fresh session, so
you can never wrongly believe pinning is on when it is not. On a normal
`declaragent up` the factories are always present, so the safe-fail path is
not reached in production.

> **Iteration metrics also fire through `up`.** Independently of pinning,
> the engine's per-turn durability signal — the
> `declaragent_engine_turn_iterations` histogram and the
> `declaragent_engine_turn_max_iterations_hit_total` counter — now registers
> on the shared Prometheus registry that backs the control-plane `/metrics`
> route, because `up-cli.ts` passes `metrics: runtime.metrics` into
> `createEngine`. And `maxIterations` set in `agent.yaml` is parsed by
> `loadAgent` onto `AgentSpec.maxIterations`, which the engine honours with
> precedence `spec > EngineConfig > default (50)` — so an operator's
> per-agent cap actually takes effect.

---

## Mode 3 · durable-with-memory (future)

Session pinning keeps the *whole* transcript. For long-lived agents that need
to stay under `maxTokens` indefinitely, mode 3 adds:

- a long-term memory store with `recall` / `store` tools (or turn-start context
  injection), and
- transcript summarization / pruning so the working context stays bounded while
  durable facts survive.

This is **not yet implemented**. It is steps 2–4 of
[`PROD_PARITY_ACTIONS.md`](../PROD_PARITY_ACTIONS.md) Item A. Track it there.

---

## Choosing a mode

```
Is each event independent (no benefit from prior context)?
  └─ yes → Mode 1 (default). Do nothing.
  └─ no  → Does the conversation fit in the model's context window over its lifetime?
            └─ yes → Mode 2: add a stable `sessionKey`.
            └─ no  → Mode 3 (future): pinning + memory/summarization.
```

The point of documenting all three is so you pick **deliberately** instead of
inheriting "fresh every time" silently.
