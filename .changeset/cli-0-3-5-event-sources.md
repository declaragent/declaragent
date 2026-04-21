---
'@declaragent/cli': patch
---

Wire `event-sources.yaml` into `declaragent run <dir>`.

0.3.5 closes the second half of Phase A.1 in USABILITY_PLAN.md.
Scaffolded agents that declare webhook, cron, or file-watch sources
in their `event-sources.yaml` now actually bind ports / install
timers / watch directories in-process when the REPL starts, and
land inbound events in the session event store so
`declaragent events list` reflects live activity.

**New file:** `packages/cli/src/run-agent-sources.ts` exports
`startAgentSources({ configPath, storePath?, onEvent? })`:

- Validates the yaml via core's existing
  `validateEventSourcesConfig`.
- Constructs a bus + event store + adapter instances directly (no
  daemon wrapper).
- Subscribes `*` on the bus → records every emitted event to the
  SQLite store and forwards to the optional `onEvent` hook.
- Returns `{ started, unknownTypes, validationErrors, stop() }`.
  Each `started[]` entry carries a human summary ("webhook
  /webhook/contracts", "cron 0 9 * * *", "file-watch /tmp/inbox")
  the CLI prints at startup.

**Integration in `run-agent-cli.ts`:** after `loadAgent`, the verb
looks for `event-sources.{yaml,yml,json}` at the agent root. When
present + `--no-sources` isn't set, it calls `startAgentSources`.
Lifecycle is tied to `renderRepl` — the `finally` block stops every
source after the REPL exits, no port leaks on Ctrl+D.

**External-broker sources** (kafka / nats / sqs / amqp / mqtt) are
surfaced as `unknownTypes` on the result. The REPL prints a hint
that they're daemon-only; the in-process path intentionally skips
them.

**Tests:** +11 new across two files. Full suite: 2071 pass / 0 fail.

**Not in scope (tracked for PR #3):**

- Events don't auto-invoke skills yet. Today the bus records them
  + forwards to the REPL's hook; the model sees inbound events via
  `declaragent events list` but doesn't auto-react. Full
  `EventDispatcher` + skill routing lands next.
- `declaragent daemon` still reads user-global
  `event-sources.json` — unchanged.
