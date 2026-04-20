# Phase 6 exit-criteria runbook

**Audience:** platform team closing out a Phase-6 soak run + preparing
the signoff packet for Phase-7 kickoff.

**When to invoke:** at the end of every nightly chaos soak and the
final pre-release full soak.

## Exit criteria (copy from `SPEC_AND_PLAN.md` §Phase 6)

> Pen test passes; chaos test (random pod kill every 60s for 1h) shows
> zero data loss; multi-tenant isolation test shows zero cross-tenant
> leakage.

## Capture checklist

Every soak run produces an attestation folder named
`soak-<YYYY-MM-DD>/` containing:

1. **Chaos report (JSON + markdown)**
   - Produced automatically by `bun run chaos:soak`.
   - JSON is diff-consumed by the dashboard's "last 30 soaks" widget.
   - Markdown is the human-readable artifact committed to the folder.

2. **Assertion results**
   - `no-event-loss` — MUST pass. Any failure is a blocking regression.
   - `no-cross-tenant-leak` — MUST pass. Any boundary violation requires
     a post-mortem before close.
   - `no-secret-in-logs` — MUST pass. Record the population size of the
     watched-values list.
   - `slos-held` — p99 outbound latency + DLQ rate. Record values
     verbatim; any breach requires a post-mortem.
   - `dedup-never-drops` — MUST pass.

3. **Grafana snapshots**
   - Event-sources dashboard: ingress + processed + DLQ rate over the
     soak window.
   - Channels dashboard: outbound latency heatmap + failure rate.
   - Daemon dashboard: bus inflight + heartbeat + session spawn.
   - WhatsApp dashboard (if applicable): tier health + template reject.
   - Export every panel as PNG + include them in the attestation folder.

4. **Audit-sink verification**
   - Run `declaragent audit verify --since <soak-start>` against every
     tenant's scope. Report MUST return `ok: true` for every tenant.
   - Capture the `totalEntries` + `verifiedEntries` counts verbatim.

5. **Secret rotation status**
   - Run the rotation monitor in one-shot mode (`check()` without
     starting the interval). Any secret past `errorAfterDays` is a
     hard block — rotate before release.

## Multi-tenant isolation attestation

Run the harness under `packages/testkit/src/chaos/` configured with
3 tenants. For each tenant:
1. Drive 1,000 inbound events over a 5-minute window.
2. Capture metrics + audit records.
3. Assert every outbound event's `tenantId` matches its inbound.
4. Assert zero cross-tenant audit records surface on any query.
5. Run the `no-cross-tenant-leak` assertion per tenant.

Record results in `soak-<date>/isolation.md`.

## Pen-test attestation

Check [PEN_TEST_SIGNOFF.md](../PEN_TEST_SIGNOFF.md):
- Every CRITICAL finding MUST be remediated + linked to a merged PR.
- Every HIGH finding MUST have either a remediation PR or a documented
  residual-risk sign-off from the platform lead.

## Close-out actions

When every criterion passes:

1. Tag the repo: `git tag phase-6-signoff-<date>`.
2. Post the attestation folder to the platform team's archive (link
   lives in the team handbook, not the public repo).
3. Open the Phase-7 kickoff issue with links to:
   - Tag
   - Chaos report (markdown)
   - Isolation attestation
   - Pen-test sign-off
4. Announce in the `#platform-announce` channel with the tag + a
   one-paragraph summary of observed SLOs.

## Failure paths

- **Any MUST-pass assertion fails:** open a Phase-6 regression issue
  against the blast-radius component, retro the run, and do NOT ship.
- **SLO breach without an assertion failure:** ticket it as HIGH
  priority; ship with documented residual-risk sign-off from the
  platform lead.
- **Pen-test CRITICAL finding lands post-tag:** retract the tag,
  remediate, re-run soak, re-tag.
