# Zero-Trust RPC Default Flip — 0.8.0 Migration Plan

**Authored:** 2026-04-23 (post-enterprise Sprint 5 docs pass) · **Target release:** `@declaragent/cli@0.8.0` · **Backlog row:** `docs/POST_ENTERPRISE_BACKLOG.md` #5b (Part B of row #5; Part A shipped at 0.7.3 as `declaragent fleet audit-rpc --suggest-enable`).

**Sibling docs:**
- [`docs/POST_ENTERPRISE_BACKLOG.md`](./POST_ENTERPRISE_BACKLOG.md) — the 52-item follow-up tracker; row #5b points here.
- [`docs/FIRST_PRINCIPLES_VALIDATION.md`](./FIRST_PRINCIPLES_VALIDATION.md) — pillar-level verdict.
- [`../CLAUDE.md`](../CLAUDE.md) §"Upcoming breaking changes" — one-line summary that cross-links here.

---

## 1 · Summary

At **`@declaragent/cli@0.8.0`** the default value of `rpc.auth.enabled` will flip from `false` → `true` for any fleet that declares `rpc-peers.yaml`. Fleets that currently rely on the default-off posture will be required to **either**:

1. Opt **in** by declaring an `auth:` block on every agent with peers (recommended — the secure path), **or**
2. Opt **out** explicitly by setting `rpc.auth.enabled: false` per agent (discouraged — flagged with a boot-time warning).

The capability has existed since 0.7.1 ([PR #17](https://github.com/declaragent/declaragent/pull/17)) — this flip changes only the *default posture* so the zero-trust path is the on-by-default path instead of the opt-in path.

This is a **minor-version behavioural change** under the `0.x` SemVer rule Declaragent has been following since 0.1.0: anything that changes on-disk config semantics gets a dedicated minor. 0.8.0 is signalled explicitly so operators can plan CI / pin windows around it.

---

## 2 · Who is affected

**You are affected if** any of the following is true for your fleet:

- You have at least one agent whose directory contains `rpc-peers.yaml`.
- That agent's `agent.yaml` does **not** include `rpc.auth.enabled: true` at the root of the `rpc` block (or equivalent `rpc.auth.enabled: false` opt-out).
- The fleet boots via `declaragent up` (single-process) or `declaragent fleet run` (multi-agent daemon).

**You are not affected if:**

- Your fleet uses only the memory transport for testing (no `rpc-peers.yaml`). Memory transport bypasses the envelope-auth gate by design — see `packages/plugin-agent-rpc/src/memory-transport.ts`.
- You are running mock-mode builder tests (`DECLARAGENT_BUILDER=on` REPL with recorded fixtures). Fixtures do not exercise the RPC auth path.
- Your `agent.yaml` already has `rpc.auth.enabled: true` — you are *already* on the zero-trust path and 0.8.0 is a no-op for you.
- Your `agent.yaml` has `rpc.auth.enabled: false` set explicitly — you are opting out of the flip. You will see a new boot-time warning on 0.8.0, but behaviour is unchanged.

**Quick self-check:**

```bash
declaragent fleet audit-rpc
```

If the report shows every agent in state `enabled`, you are ready for 0.8.0. Any `absent` or `disabled` rows are the gap the default flip will expose.

---

## 3 · Pre-flight — run the inspector

Shipped at 0.7.3, branch `agent-a/security-sprint-3-item-5` (backlog #5a):

```bash
# Human-readable report — fleet root auto-detected from nearest `fleet.yaml`
declaragent fleet audit-rpc

# Copy-pasteable YAML diff suggestions, pre-filled with each peer's declared provider
declaragent fleet audit-rpc --suggest-enable

# CI-safe: exits non-zero if any agent is not fully `enabled`
declaragent fleet audit-rpc --strict

# Structured output for scripting
declaragent fleet audit-rpc --json
```

### Interpreting the four states

- **`enabled`** — `rpc.auth.enabled: true` is set and the block is otherwise valid. **Pass.** No action needed.
- **`disabled`** — `rpc.auth.enabled: false` is set explicitly. Operator has chosen to opt out; `--suggest-enable` still emits a suggestion but the warning is informational. This row will continue to work at 0.8.0 but will emit a boot-time warning (see §6).
- **`absent`** — no `rpc.auth` block at all. **Most new fleets are here.** This is the row that *changes behaviour* at 0.8.0 — without remediation the agent will fail to boot with `AUTH_REJECTED` on the first inbound RPC call.
- **`unreadable`** — the YAML file could not be parsed (syntax error, permission denied, etc.). Inspector skips without blocking the rest of the audit; a `reason` field is included in `--json` output. Fix the underlying read error before taking 0.8.0.

### `--suggest-enable` output shape

For each `absent` or `disabled` agent, the inspector walks peers that *reference this agent as a callee* in any other `rpc-peers.yaml` and pre-fills a YAML diff using that peer's declared provider. Example:

```yaml
# Paste under `rpc:` in <agentDir>/agent.yaml
rpc:
  auth:
    enabled: true
    provider: oidc
    issuer: https://sso.example.com
    audience: fleet.reviewer
    jwksUri: https://sso.example.com/.well-known/jwks.json
```

When no peer references this agent (e.g. external-only callers or dangling peer graph), the suggestion falls back to a commented stub so the operator can fill in provider details manually.

---

## 4 · Migration paths

### Path A — enable auth now (recommended)

1. Run `declaragent fleet audit-rpc --suggest-enable` and save the output.
2. For each `absent`/`disabled` agent, paste the suggested block under `rpc:` in `<agentDir>/agent.yaml`. Verify:
   - `issuer` matches your IdP.
   - `audience` matches the envelope audience your peers will mint tokens for.
   - `jwksUri` is reachable from the agent host.
3. Commit the diff. Run the inspector again — every row should now read `enabled`.
4. Run `declaragent fleet validate` and your existing test suite. Envelope auth kicks in immediately after the paste, not at 0.8.0 — so any CI that was passing before will catch token / audience / JWKS misconfiguration *now*, before the default flip forces the issue.
5. Take 0.8.0 as a **no-op upgrade**. The default flip simply matches what your config already declares.

### Path B — opt out explicitly (discouraged)

Only choose this if you have an existing non-auth RPC contract that cannot be retired in the 0.8.0 window (e.g. a legacy pilot that hasn't been cut over to SSO yet).

1. For each agent you cannot remediate, add:
   ```yaml
   rpc:
     auth:
       enabled: false
   ```
2. At 0.8.0 boot, the runtime will emit a **boot-time warning** per agent:
   ```
   [agent: <id>] WARN rpc.auth.enabled=false explicitly set. This agent accepts
   unauthenticated envelopes — not recommended for cross-host or cross-tenant
   deploys. See docs/ZERO_TRUST_DEFAULT_MIGRATION.md §4 Path B.
   ```
3. Track the remediation in your own backlog. The opt-out is **not** planned for removal at 1.0 — but Declaragent reserves the right to re-review at 2.0.

### Path C — split the difference (per-agent posture)

Large fleets often want to enable auth on external-facing agents first and defer on internal-only agents. Because the registry is per-agent (backlog #18, shipped 0.7.4), this works without cross-agent coupling:

- External-facing agent gets `rpc.auth.enabled: true`.
- Internal-only agent gets `rpc.auth.enabled: false` with a TODO.

The per-agent `AuthVerifyRegistry` honours each posture independently.

---

## 5 · Rollout timeline (recommended)

This is the recommended sequencing for any fleet currently in `absent` state. Calendar times are suggestions — adjust to your change-window cadence.

| Week | Action | Gate |
| --- | --- | --- |
| T−3 | Run `fleet audit-rpc --suggest-enable` locally. Share output with the team. | Baseline captured. |
| T−2 to T−1 | Apply Path A diffs. Wire `fleet audit-rpc --strict` into CI as a required check on your fleet repo. Let it run for **2–3 weeks** before taking 0.8.0. | `--strict` exits 0 on every PR. |
| T−0 | Upgrade to `@declaragent/cli@0.8.0`. No further config change required — the default now matches your explicit config. | Smoke test passes. |
| T+1 | Remove `rpc.auth.enabled: true` literals if you want to rely on the default (optional cosmetic cleanup — the literal is never wrong). | — |

**Why 2–3 weeks of `--strict` in CI?** Most JWKS / audience / issuer misconfigurations surface only when the first real token is minted — typically on a PR merge, not on a config edit. Two to three weeks is empirically long enough to catch the "we rotated the IdP cert last Tuesday" class of bug before production takes the 0.8.0 upgrade.

---

## 6 · Breaking-change scope — what stops working

When the default flips at 0.8.0, here is the exact surface that changes for an agent in the `absent` state before the upgrade:

- **Inbound envelope behaviour.** Any envelope arriving without a valid `auth` block (OIDC bearer, OAuth2 token, or explicit `kind: internal` when configured) is rejected with:
  ```
  RpcError {
    code: 'AUTH_REJECTED',           // from RPC_ERROR_CODES (#8, shipped 0.7.1)
    message: '<reason from verifier>'
  }
  ```
  Evidence in code: `packages/cli/src/fleet-run.ts:675` + `:716` already emits `RPC_ERROR_CODES.AUTH_REJECTED` on the reject path.
- **Scope-mismatch detail is preserved.** The per-route scope override work (#6, shipped 0.7.3) means a token that is otherwise valid but scoped wrong emits the same `AUTH_REJECTED` code with a scope-mismatch `message` — the same shape operators already see on 0.7.x if they opt in early. See `packages/core/src/observability/control-plane-auth.test.ts:539` for the test that pins this surface.
- **Audit log entries.** `auth-check` records land in the SIEM-exported audit stream with `result: 'reject'` and the reject reason — either `auth-rejected` (token invalid) or `idp-unreachable` (JWKS fetch failure). This is the shape already shipping at 0.7.4; the flip only changes *how often* you see it when you've mis-migrated.

**What does NOT change:**

- Memory transport — always bypasses envelope auth by design.
- Mock-mode builder fixtures — fixtures replay through the fixture provider, not through the RPC path.
- Channel auth (Slack / Telegram / Discord / WhatsApp) — unrelated to RPC envelope auth.
- Control-plane listener auth (`controlPlane.auth`) — already opt-in since Slice 2; default unchanged at 0.8.0.

---

## 7 · FAQ

### Why not a major-version bump?

Declaragent is pre-1.0. The project follows an internal rule that any **semantics-changing** config default gets a minor (not a patch) so the SemVer signal reaches operators via lockfile audits. A major is reserved for API-shape changes (e.g. `packages/core` export surface renames). At 1.0 the same behaviour will move to major-version signalling — this is documented in `docs/VERSIONING.md`.

### Does this affect the memory transport?

No. `packages/plugin-agent-rpc/src/memory-transport.ts` explicitly bypasses envelope auth because it is in-process and cannot cross a trust boundary. The flip is scoped to transports that traverse a network hop: Kafka, NATS, JetStream, SQS, AMQP, MQTT.

### Does this affect mock-mode builder tests / recorded fixtures?

No. Builder fixtures (PR #24, shipped 0.7.1) replay through the fixture provider at the LLM-call boundary — they never exercise the RPC envelope path. Your `BUILDER_RECORD=1` captures and `packages/cli/src/builder/fleet-e2e.test.ts` replays are safe through the upgrade.

### What happens if my IdP is briefly unreachable at boot on 0.8.0?

Same as today (0.7.1+): the agent emits an `auth-check` audit record with `reason: 'idp-unreachable'` and rejects the envelope. `authRejectSink` (if wired) fires; the synchronous caller sees `AUTH_REJECTED`. There is no new IdP-outage failure mode introduced by the default flip — 0.8.0 just makes the zero-trust path the non-opt-in path.

### Can I stage the flip across a multi-host fleet?

Yes. The per-agent `AuthVerifyRegistry` (backlog #18, shipped 0.7.4) means each agent declares its own auth posture in its own `agent.yaml`. Set `rpc.auth.enabled: true` on the external-facing agents first; keep internal-only agents on `false` with a TODO. Roll to 0.8.0 host-by-host if you use the cross-host fan-out (`fleet.yaml#hosts[]`, Slice 3 / #50).

### How do I verify the flip happened correctly post-upgrade?

1. `declaragent fleet audit-rpc --strict` — should exit 0.
2. `declaragent audit export --to <your-siem>` — look for `auth-check` rows with `result: 'accept'` on the first real RPC flow.
3. Scrape `/metrics` for the existing `rpc_auth_checks_total{result="accept"}` counter; it should tick on every peer call.

### What if I'm running `rpc.auth.enabled: true` on some agents today but rely on defaults for others?

Path C in §4 is your story. Per-agent posture is honoured; the flip at 0.8.0 only moves the *default* for the agents that inherit it. Agents with an explicit value keep that value.

### Does the 0.8.0 companion package cascade affect me?

Yes — `core`, `plugin-agent-rpc`, and the six transport packages will each get a minor bump along with the CLI. The *only* capability change is the default; there are no new wire-format or schema changes planned for 0.8.0 beyond this one. If you pin the companion versions in `package.json`, update them together. If you take `@declaragent/cli@0.8.0`, the other packages are peer-dep-resolved — the installer will pull matching minors automatically.

---

## 8 · Timeline for this doc

- **0.7.5** (Sprint 5, in progress) — this doc authored; `CLAUDE.md` §"Upcoming breaking changes" cross-link added; `POST_ENTERPRISE_BACKLOG.md` #5b Evidence pointer updated to cite this file.
- **0.7.6–0.7.8** (subsequent sprints) — any follow-up clarification from early migrators lands here as §7 FAQ additions. No breaking-change surface added in patch releases.
- **0.8.0** (target 2–3 weeks after 0.7.5) — default flip ships. This doc is the canonical upgrade reference from this release forward. No further edits required unless a migration edge case surfaces.
- **0.9.0+** — this doc transitions to "historical — see CHANGELOG" once upgrade feedback settles. Not removed.

---

## 9 · Escape hatch for 0.8.0 blockers

If you hit a blocker during the 0.8.0 upgrade that `--suggest-enable` does not anticipate, your options in order of preference:

1. Open a backlog row on `POST_ENTERPRISE_BACKLOG.md` describing the gap. The Agent A (Security & RPC Auth) rotation owns this surface and will triage within a sprint.
2. Pin to `@declaragent/cli@0.7.x` on your production lockfile while you remediate. 0.7.x will continue to receive security patches for 90 days after 0.8.0 ships (per the informal support window — no formal LTS policy exists pre-1.0).
3. Set `rpc.auth.enabled: false` explicitly on the blocked agent (Path B above) and remediate in a later sprint. The boot-time warning is informational, not blocking.

---

**Bottom line:** `fleet audit-rpc --suggest-enable` exists to make this a copy-paste migration for 95%+ of fleets. The other 5% have per-agent posture needs that the per-agent registry (shipped 0.7.4) already solves. 0.8.0 is the SemVer signal that the zero-trust default is now the right default — nothing more, nothing less.
