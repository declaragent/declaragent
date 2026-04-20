---
'@declaragent/cli': patch
---

Phase 7 slices 6 + 8 — CLI dispatch wiring.

Orchestrator step that follows the three parallel slice agents. Wires
the `deploy` and `migrate` subcommand routers into
`packages/cli/src/index.tsx`:

- `declaragent deploy gcp-cloud-run` — forwards to
  `deployGcpCloudRun` / `verifyGcpCloudRunDeploy` from slice 6's
  `deploy-cli.ts`. Flags: `--out`, `--force`, `--project`, `--region`,
  `--service`, `--agent-yaml`, `--cpu`, `--memory-mib`,
  `--min-instances`, `--verify`, `--json`.
- `declaragent migrate` — forwards to `migrateConfig` from slice 8's
  `migrate-cli.ts`. Flags: `--config-dir`, `--apply`, `--json`.
- Help text updated to surface both verbs.
- Top-level `--help` intercept extended to pass through `init`,
  `deploy`, and `migrate` so each subcommand's own `--help` path fires.

This changeset only bumps `@declaragent/cli` because neither `deploy`
nor `migrate` changed any public core export — the runtime surface
was already frozen by slice 8's `@since 1.0.0` pass.
