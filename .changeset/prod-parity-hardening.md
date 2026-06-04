---
'@declaragent/cli': patch
'@declaragent/core': patch
---

feat(durability): agents accumulate context across events (session pinning) + observable multi-step loop; PROD_parity production hardening

**Agent durability (wired end-to-end through `declaragent up`):**

- **Session pinning.** Inbound routes may declare an optional `sessionKey`; the dispatcher resolves-or-creates a durable session keyed by it (new `session_keys` table in the SQLite session store) and appends each event as a new turn — so a pinned agent accumulates transcript across events instead of starting fresh. Fully back-compatible: no `sessionKey` ⇒ unchanged fresh-per-event behavior.
- **Observable multi-step loop.** The engine's up-to-50-iteration tool loop now records a `declaragent.engine.turn.iterations` histogram + `..max_iterations_hit_total` counter on the runtime's Prometheus registry (served at `/metrics`).
- **Tunable `maxIterations`.** `agent.yaml` now parses an optional `maxIterations` (positive int) onto `AgentSpec`; engine precedence is spec > config > default (50).

**Production hardening (PROD_parity action list):**

- **Release pipeline (P0-1).** `release.yml` now cuts a `v<cli-version>` tag from the changesets-published version so `release-binaries.yml` fires and the npm postinstall binary download resolves; new `npm-install-e2e.yml` validates a real-registry install end-to-end.
- **Packaging (P0-2).** Starter `templates/` now ship in the CLI tarball with a real recursive unpacker + installed-package resolution; `npm-pack-and-run.yml` exercises `init` → `fleet add --template`.
- **Security / governance / positioning.** New `SECURITY.md` + `GOVERNANCE.md`, hardened `THREAT_MODEL.md`, honest `PEN_TEST_SIGNOFF` status banner, right-sized README + AI-authorship disclosure.
- **Docs + status.** Historical plans archived under `docs/archive/`; new `docs/STATUS.md` (single source of truth) + `docs/COMPAT.md` (1.0 surface); CI writes `STATUS.json` + a single rolling failure tracker; CLI error messages now surface a working next action.
