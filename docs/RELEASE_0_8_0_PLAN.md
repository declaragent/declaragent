# Release plan — 0.8.0 (coordinated zero-trust cutover)

> Status: **plan authored 2026-08-16** on `main` @ `@declaragent/cli@0.7.7`.
> Companion docs: [`PRODUCTION_READINESS_PLAN.md`](./PRODUCTION_READINESS_PLAN.md) (the program this release closes Phase 6 of), [`ZERO_TRUST_DEFAULT_MIGRATION.md`](./ZERO_TRUST_DEFAULT_MIGRATION.md) (the detailed migration for flip 1).
> Evidence basis: every "current state" claim below was re-verified against live CI/repo state on 2026-08-16, not copied from the June ledger.

## 1 · What 0.8.0 is (and is not)

0.8.0 is the **one coordinated breaking release** that flips Declaragent's four
security defaults from opt-in to on-by-default. Per
`PRODUCTION_READINESS_PLAN.md` §WS10/Phase 6, the four flips ship together, as
one migration, each preceded by a warn/preview window and an inspector:

| # | Flip | Behaviour at 0.8.0 | Warn-window status today (0.7.7) |
|---|------|--------------------|----------------------------------|
| 1 | `rpc.auth.enabled` defaults **true** when `rpc-peers.yaml` is present | Unsigned/unregistered peers rejected (`AUTH_REJECTED`) | ✅ ready — preview env var + `fleet audit-rpc --suggest-enable --strict` shipped 0.7.3, live-verified 2026-06-10 |
| 2 | `allowLoopback` defaults **false** when control-plane auth is configured | `Host: 127.0.0.1` forgery no longer bypasses bearer auth | ◑ code path + config exist; the default flip + boot warning not yet shipped |
| 3 | Strict `agent.yaml` schema **throws** on unknown top-level keys | A `rcp:`/`exprot:` typo fails boot instead of silently disabling security | ◑ `agent validate` + warn-mode shipped; throw deferred to cutover |
| 4 | Tools default flip: declared-only tool set is the only mode | `DECLARAGENT_TOOLS_LEGACY` becomes an explicit, warning, deprecated opt-out | ✅ enforcement + escape hatch landed (WS1); flip = removing the legacy default |

**0.8.0 is *not* the "enterprise production ready" claim.** That claim is
additionally gated on the 7-week soak streak and the remaining
production-readiness tails (traceparent propagation, kind-smoke gate, WS11
parity). Those accrue/ship independently — see §6. Decoupling them keeps the
breaking release from being hostage to a calendar gate, while the soak streak
keeps the *claim* honest.

## 2 · Hard blockers (must land before the flip is even safe)

### B1 · WS2 signer wired into the CLI — *the* critical-path code item
> **✅ DONE 2026-08-16** (`87ae87a`): `buildOutboundSigner` + response-leg signing + fleet-run wiring (both legs, per-agent-wins) + boot-abort on unbuildable signer + `audit-rpc` sign-side findings. Flagship test green: strict + HMAC both sides → delegation succeeds. Remaining nuance: OIDC peers are verify-only for the built-in signer (flagged by the inspector).

Original finding (2026-08-16): `signOutbound` exists only inside
`packages/plugin-agent-rpc` (`request-agent.ts`); neither `up` nor `fleet run`
builds a signer. **Flipping `rpc.auth.enabled` strict without this breaks every
built-in delegation** — the exact failure the plan's WS2 tests call out.

Scope:
- Build a **sign registry** from `<agent>/rpc-peers.yaml` mirroring the
  existing `AuthVerifyRegistry`: per-peer provider (`hmac` first-class;
  OIDC/OAuth2 client-credentials via existing providers), per-peer key
  resolution through the secrets resolver (fail loud on unresolvable ref).
- Wire `signOutbound` into every `RequestAgent` construction site in
  `fleet-run` and (when `rpc-peers.yaml` is present) `up`. Both request and
  response legs signed.
- Extend `fleet audit-rpc` to check the **sign** side (peer declares a
  provider but no signable key resolves → finding).
- Tests (from the PRP): flip-on + HMAC both sides → delegation succeeds;
  peers declared + no signer → boot aborts with an actionable error;
  tampering any signed field fails verification.

### B2 · CI evidence lanes must be green before a breaking release ships
> **✅ RESOLVED 2026-08-16**: the failures predated the June-work landing — current main passes. Proven by workflow-dispatch on main: nightly integration (Kafka + NATS) **green**, bounded 10-min soak **green**; `prod-smoke-kafka` re-enabled. The streak clock starts with the next scheduled Sunday soak. Follow-up owed: a durable biome-format step in the release flow (the changesets Version PR keeps landing npm-formatted package.jsons that red CI lint — re-fixed at `49462c9`).

Original finding (2026-08-16):
- `weekly-soak.yml`: **0 green in all 17 runs ever** (worker exits 1 before
  ready in `testkit/src/fleet-integration/harness/multi-process.ts` on CI;
  the same path passed the June 10 local live-verify).
- `nightly-integration.yml` (fleet RPC over Kafka + NATS): **0 green in the
  last 50 runs.**
- `prod-smoke-kafka`: **auto-disabled by GitHub 2026-08-09**
  (`disabled_inactivity`) — needs `gh workflow enable prod-smoke-kafka.yml`.

Debugging the worker-boot exit-1 fixes both red lanes (same harness). Until
nightly is green, the flip-1 strict-mode CI window (§3) produces no signal.

### B3 · Branch protection on `main`
> **✅ DONE 2026-08-16**: protection active. Required checks (strict up-to-date): `Lint, typecheck, test, build` (CI), `OSV scan` (Dependency scan), `Release gate summary` (aggregates chaos/tenant/secret-leak/sentinel jobs), `bun pm audit`. All four run unfiltered on every PR targeting main, so no PR can deadlock on a skipped check. `enforce_admins` is OFF — the documented solo-maintainer break-glass (direct admin pushes still land; PRP risk 7). Enable it after the sentinel is verified on a throwaway release PR. Force pushes + deletions blocked; no required reviews (solo maintainer).

Original finding: still absent (404 on the protection API, verified 2026-08-16). `gh` now has
admin scope, so this is minutes of work: required checks = CI, Release gate,
Dependency scan, plus the hermetic E2E once it's split into a named check.
Heed PRP risk 7: bootstrap out-of-band, verify the sentinel on a throwaway
PR before enabling `enforce_admins`, and keep a documented break-glass.

## 3 · The strict-mode CI window (flip 1 pre-flight)
> **✅ WIRED 2026-08-16**: the harness fleet now runs the full zero-trust posture — hmac auth on every peer (driver included), driver-signed requests, fail-closed verify + signed responses in the workers, `unsignedResponses === 0` asserted over the whole soak. `DECLARAGENT_RPC_AUTH_DEFAULT=on` set on the nightly + weekly lanes, and an always-on drift-guard test runs `fleet audit-rpc --strict --dry-run-with-flag` against the scaffold on every CI run. **The ≥14-green-night clock starts with the next scheduled nightly.** Both 0.7.8 warn-windows (flip-2 allowLoopback, flip-3 unknown-key) shipped in the same change, plus the release-flow Biome format fix.


`ZERO_TRUST_DEFAULT_MIGRATION.md` §5 recommends **2–3 weeks** of
`fleet audit-rpc --strict` (plus the preview env var on the integration
fleet) in CI before taking 0.8.0. Wire both into `nightly-integration.yml`
the moment it is green:
1. `declaragent fleet audit-rpc --strict --json` over the integration fleet —
   fails the lane on any agent missing `rpc.auth`.
2. Run the nightly Kafka/NATS round-trip **with the 0.8.0 preview mode on**
   (the env-var rehearsal from migration doc §3a) — the flip is exercised
   nightly for the whole window, not just on cutover day.

The window's clock starts at the first green nightly with these on. Target:
**≥14 consecutive green nights** before the cutover PR merges.

## 4 · Cutover engineering (the 0.8.0 PR itself)

One PR (plus its changesets), containing the four flips together:
1. **Flip defaults**: `rpc.auth.enabled` resolution (present-peers ⇒ true);
   `allowLoopback` (auth-configured ⇒ false); `agent.yaml` unknown-top-level
   key handling warn → **throw**; remove the legacy tools default
   (`DECLARAGENT_TOOLS_LEGACY=1` still works, logs a deprecation warning,
   and is documented for removal at 0.9.0).
2. **Migration guide**: `docs/MIGRATION_0_8_0.md` — one document covering all
   four flips with before/after YAML, the three inspectors
   (`fleet audit-rpc`, `agent validate`, the boot warnings), and the
   escape hatches. The zero-trust doc stays the deep-dive for flip 1.
3. **Templates + fixtures**: all shipped templates, `init`/`fleet-add`
   scaffolds, and builder recorded fixtures pass `agent validate` and boot
   under all four flips (PRP Phase 6 exit condition).
4. **Changesets**: `@declaragent/cli` **minor → 0.8.0** (the number is
   reserved for exactly this); core minor. **Note the satellite blast
   radius**: a core minor (0.x) is a breaking peer bump, so channels/sources/
   testkit/plugin-agent-rpc will auto-major 5.0.0 → 6.0.0 — same mechanism as
   the 0.7.7 release; call it out in the release notes so it doesn't read as
   an accident.
5. **Release notes** lead with the one-line upgrade decision tree: fleet with
   peers + no `auth:` blocks → run the inspector first; single-agent no-peers
   fleets → no action.

## 5 · Rolling-upgrade rehearsal (gate, not paperwork)
> **✅ BUILT 2026-08-16**: `packages/testkit/src/fleet-integration/rolling-upgrade.test.ts` + dispatchable `rolling-upgrade.yml`. Verified live against Redpanda with old=published **0.7.7**: signed round-trips to both sides green; old side's response comes back `internal` (0.7.7 has no signer — the assertion is version-aware and flips to requiring `hmac` at ≥0.7.8, which is the pre-tag bar); unsigned + unregistered senders get explicit signed/`internal` `AUTH_REJECTED` replies. **Pre-tag gate: dispatch with `old-version=0.7.8` after 0.7.8 ships — must be fully green including the signed leg B.**


PRP risk 2 requires a **passing mixed-version rehearsal** before tagging:
- Scripted in testkit (service-container Kafka): a two-agent fleet where
  agent A runs the 0.7.7 published CLI (via the npm-install harness) and
  agent B runs the 0.8.0 release candidate, `rpc.auth` on, HMAC both sides.
- Must prove: B→A and A→B delegation both succeed mid-upgrade (0.7.7 signs
  when configured, 0.8.0 requires it), and a deliberately unsigned envelope
  is rejected by B with `AUTH_REJECTED` + a SIEM-visible audit event.
- Runs once as a required pre-tag check; kept as a manual-dispatch workflow
  afterwards for future majors.

## 6 · Explicitly *not* gating 0.8.0 (tracked, rides along if ready)

- **7-week soak streak** — gates the *production-ready claim*, not the
  version. Clock starts at the first green Sunday after B2; earliest claim
  ≈ 7 weeks later. The release-gate-consumes-streak wiring (WS9 tail) lands
  when a streak exists to consume.
- **WS7 traceparent propagation + engine spans** (backlog #57), **WS6
  kind-smoke gate + `fleet deploy` kubectl adapter + published image**,
  **WS11 channel/transport parity tail**, **real `/status` counters (WS3)**,
  **`RequestAgent` in `up` (WS4)** — production-readiness tails; none changes
  the 0.8.0 config contract, so none blocks the cutover.
- **Front door** (`get.declaragent.dev` NXDOMAIN; `install.sh` is served from
  declaragent.dev) — fix DNS or repoint docs any time before the release
  announcement.

## 7 · Timeline (aggressive but honest: ~5–6 weeks)

| Week | Work | Exit signal |
|------|------|-------------|
| **W1** | B2: debug worker-boot exit-1; re-enable prod-smoke; B3 branch protection. Start B1 signer. | Nightly green; first green Sunday possible; protection on |
| **W2** | Finish B1 (signer in `fleet run` + `up`, audit-rpc sign-side). Ship a **0.7.8** carrying: flip-2 boot warning, flip-3 unknown-key warning promoted to loud, signer available. Turn on §3 strict window in nightly. **Correction (2026-08-16, first live firing of the release gate):** the nightly-green sentinel requires the LAST 7 nightly runs green before a release PR may merge — PR #124 (cli 0.7.8, plugin 5.1.0, testkit 6.0.0) is staged with every other required check green and merges ~Aug 21 as greens accrue (maintainer chose to respect the gate over dispatch-filling or admin bypass). Known wart: the npm-install-e2e checks fail on release PRs by construction (they install the not-yet-published version); not in the required set. | 0.7.8 on npm; strict-window clock starts |
| **W3–W4** | Build the §5 rehearsal harness; write `MIGRATION_0_8_0.md`; template/fixture validate sweep; cutover PR drafted behind the window. | Rehearsal passing against 0.7.8 vs RC; ≥14-night window accruing |
| **W5** | Window complete → merge cutover PR → Version Packages PR → **tag 0.8.0**. Post-release: announcement, docs-site + website auto-update (version stamping is already automated). | 0.8.0 `latest` on npm; migration guide live |
| **W6+** (background) | Soak streak accrues toward the production-ready claim; WS7/WS6/WS11 tails proceed on their own tracks. | 7 consecutive green Sundays → flip the claim with evidence |

Slip conditions: if the worker-boot bug takes >1 week, everything shifts
week-for-week (it gates the strict window, the rehearsal substrate, and the
soak). It is the single highest-leverage item in the program.

## 8 · Go/no-go checklist for tagging

- [ ] Signer wired + tested in both runtimes (B1), `fleet audit-rpc` checks sign side
- [ ] Nightly integration green ≥14 consecutive nights **with preview mode + `--strict` on** (§3)
- [ ] Weekly soak: most recent Sunday green (streak accrual underway; full streak not required)
- [ ] Branch protection active; sentinel verified on a throwaway release PR
- [ ] Mixed-version rolling-upgrade rehearsal passing (§5)
- [ ] All templates/scaffolds/fixtures pass `agent validate` + boot under all four flips
- [ ] `MIGRATION_0_8_0.md` merged; release notes drafted with the satellite 6.0.0 majors called out
- [ ] `CLAUDE.md`/`AGENTS.md` scoreboard rows updated in the same PR (docs-policy-lint keeps them single-sourced)
