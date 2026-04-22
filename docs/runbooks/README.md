# Runbooks

One runbook per Prometheus alert shipped in `packages/testkit/alerts/`.
Every runbook follows the §4.4 template from `docs/PHASE_6_PLAN.md`:

1. **Symptom** — what the operator sees on the dashboard.
2. **Likely cause** — top 3 causes with a decision tree.
3. **Immediate mitigation** — the shortest safe action.
4. **Root-cause investigation** — specific commands.
5. **Post-incident** — what to capture + when to close / post-mortem.

Files are named `<component>-<symptom>.md` matching the `runbook_url`
annotation on each rule. The annotation resolves to a path relative to
the repo root; most alertmanager setups will prepend a public URL.

## Conventions

- Commands assume the `declaragent` CLI is on `$PATH` and `$DECLARAGENT_CONFIG_DIR`
  points at the active config directory.
- Where a runbook calls out a Grafana dashboard, the assumption is the
  `packages/testkit/dashboards/` bundle is loaded.
- Severity `critical` alerts page oncall. `warning` alerts raise a
  ticket and decay after 1h if unresolved; SLA review at 24h.
