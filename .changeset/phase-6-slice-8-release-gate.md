---
'@declaragent/testkit': minor
---

Phase 6 slice 8: release gate + threat-model signoff. Phase-closer.

- **`.github/workflows/release-gate.yml`**. Merges to `main` block on
  failure in any of: chaos:quick smoke, tenant isolation tests, secret-
  leak property tests, HMAC anti-pattern guard, or osv-scanner's
  CRITICAL findings. A final summary job wires the individual concerns
  into a single release-gate verdict.
- **`chaos:quick` runner**
  (`packages/testkit/scripts/chaos-quick.ts`). In-process smoke test
  that injects every fault kind once against the in-memory runtime
  stubs, runs the `no-event-loss` / `no-cross-tenant-leak` /
  `dedup-never-drops` assertions, and writes dual JSON + markdown
  reports with a timestamped name. `bun run chaos:quick` exits non-
  zero on any assertion or timeline failure.
- **Fault-factory return types tightened**. Every `createXxxFault`
  factory now returns `Required<Pick<ChaosTargetRuntime, 'xxx'>>`
  instead of the optional-method picked form — the tests no longer
  need `?.` guards and the typechecker catches missing implementations
  at compose-time.
- **`docs/THREAT_MODEL.md`**. STRIDE walkthrough per component (core
  engine, event bus + sources, channel adapters, built-in tools, MCP
  client, secret resolver, daemon + control plane, audit sink) with
  each threat paired to its mitigation + residual risk. Cross-links to
  every Phase-6 slice that added a mitigation.
- **`docs/PEN_TEST_SIGNOFF.md`** template. Engagement scope, findings
  table, reviewer attribution placeholders, and a residual-risk sign-
  off matrix. Populated by the third-party firm at engagement close.
- **`docs/runbooks/phase-6-exit-criteria.md`**. The close-out runbook
  for every soak run: what attestation folder to produce, which
  assertions are MUST-pass vs. retrospective-only, which Grafana
  snapshots to capture, and the tag + announce protocol.

**Phase 6 is closed**. Every slice (1 — tenancy primitives, 2 —
observability, 3 — secrets, 4 — security hardening, 5 — audit, 6 —
multi-tenant primitives, 7 — chaos, 8 — release gate) landed with
green CI. 1477 tests pass across the monorepo with the full Phase-6
assertion surface in place.
