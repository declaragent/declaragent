---
'@declaragent/cli': patch
'@declaragent/core': patch
---

Platform sprint 2 — post-enterprise backlog items #43, #44, #45, #48, #49:

- **#43** Memoize `loadAgent` across `fleetRun` boot. The `rpcAuthEnabled`
  probe and the LLM handler factory now share one per-path cache
  (`createMemoizedLoadAgent`), cutting agent.yaml + `skills/` reads from
  2×N to N per boot. Failed loads stay cached so the probe's `try/catch`
  does not re-read a known-bad disk path.

- **#44** Stamp `cliVersion` onto `UpState` at boot. Previously
  `/status` read `DECLARAGENT_CLI_VERSION` from the env var on every
  scrape; now the value is written once at boot (from
  `packages/cli/src/version.ts` → `CLI_VERSION`) and read from state.
  The env var is still honoured as an override for release tooling +
  tests. The new `UpState.cliVersion` field is optional so pre-0.7.2
  state files continue to load.

- **#45** Per-agent pid fidelity on `status.agents[]`. Added an optional
  `hostedBy: { pid, index }` field to `UpAgentStatus` that makes the
  single-process-hosts-many-agents collapsing explicit. Today every
  `hostedBy.pid` equals the daemon pid; a future out-of-process-per-
  agent topology can populate distinct pids without a schema break.

No behavioural change for single-machine users beyond the observable
`cliVersion` + `hostedBy` fields on `/status`.
