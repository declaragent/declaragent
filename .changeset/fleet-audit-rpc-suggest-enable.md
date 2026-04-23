---
'@declaragent/cli': patch
---

feat(rpc): `declaragent fleet audit-rpc [--suggest-enable] [--strict] [--json]` — pre-flight inspector for `rpc.auth.enabled` across every agent in the fleet

Adds a new read-only fleet verb that walks `fleet.yaml` + each per-agent `agent.yaml` + `rpc-peers.yaml` and reports which agents have RPC envelope auth on, off, or unconfigured. Three output modes:

- **default** — human-readable table with one line per agent and a hint to re-run with `--suggest-enable` for a copy-pasteable migration snippet.
- `--suggest-enable` — emits the exact YAML diff operators paste into each agent's `agent.yaml` to opt in. When a matching peer entry in `rpc-peers.yaml` already specifies an auth provider, the snippet echoes that provider in a comment so the suggestion is actionable, not a stub.
- `--strict` — exits non-zero on any agent whose `rpc.auth.enabled` is absent or false. Safe for CI pre-flight gates.
- `--json` — structured report for programmatic consumers.

**Scope note:** This ships Part A of `docs/POST_ENTERPRISE_BACKLOG.md` row #5. Part B (flipping the `rpc.auth.enabled: false` default to `true`) is **deferred to a 0.8.0 minor** — a behavioural-default flip in a patch would surprise consumers that don't yet configure an IdP in `rpc-peers.yaml`. Shipping the inspector first gives operators at least one release cycle to run `declaragent fleet audit-rpc --suggest-enable` in CI, close the gap in config, then pick up the default flip without a downtime surprise. Row #5 in the backlog has been split to reflect this.
