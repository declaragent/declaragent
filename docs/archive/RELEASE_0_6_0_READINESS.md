# Release 0.6.0 — operator checklist

**Status:** code complete across Slices 1–8 (eight `.changeset/slice-*-*.md` entries on disk). Tag + publish are **user-gated** actions.

This doc is the punch list for promoting 0.6.0 through beta → rc → stable. None of the steps here have been taken by the automation that wrote Slices 1–9; each is a conscious human decision.

---

## 1 · Pre-flight

Before touching `changeset version` or the npm registry:

- [ ] **Full test suite green:** `bun install && bun run typecheck && bun test && bun run build && bun run lint`
- [ ] **Smoke against `templates/fleet-starter/`:** manual end-to-end — init, auth, up, fire an event, watch `/metrics` tick, verify DLQ path with a deliberately-broken skill, `down`.
- [ ] **Nightly Kafka integration run:** first green run from `.github/workflows/nightly-integration.yml` lands. (Plan asks for 7 consecutive greens before beta → rc; if you're comfortable with fewer, record that decision in the release notes.)
- [ ] **Review each changeset:** `.changeset/slice-{1..8}-*.md` — confirm the stated bump levels still match the scope. 0.6.0 expects all entries at `minor` for core + cli.

---

## 2 · Version bump + CHANGELOG

```bash
# Consolidates every .changeset/ entry into per-package CHANGELOG.md updates
# and bumps package.json versions.
bun run changeset version

# Re-run tests against the bumped workspace.
bun install
bun run typecheck
bun test
```

- [ ] Expected diff: `packages/core/package.json` and `packages/cli/package.json` bump to `0.6.0`; `packages/plugin-agent-rpc/package.json` bumps to `2.1.0` (minor from Slice 7's new `createKafkaTransport` export); `packages/testkit/package.json` bumps to `2.0.1` (patch from Slice 7's peer-dep addition).
- [ ] Each package's `CHANGELOG.md` picks up a `0.6.0` section drawn from the slice changesets.
- [ ] Commit the version bump as `chore: version packages (0.6.0)` — matches the existing release-bot convention in `git log --grep "version packages"`.

---

## 3 · Tag + push

```bash
git tag @declaragent/cli@0.6.0 -m "0.6.0 — production hardening"
git push --tags
```

- [ ] Confirm the tag name matches the CLI version. Other packages get their tags automatically from the changeset publish pipeline.

---

## 4 · Publish

`release.yml` handles this through the changeset publish action on merge to main. Manual fallback:

```bash
# Per-package dry-run first.
for p in packages/*/package.json; do
  dir="$(dirname "$p")"
  (cd "$dir" && npm publish --dry-run)
done

# When every dry-run is clean:
bun run changeset publish
```

- [ ] Confirm `@declaragent/cli@0.6.0` surfaces on npm (~60s after publish).
- [ ] Verify the installer: `npm i -g @declaragent/cli@0.6.0 && declaragent --version`.

---

## 5 · Post-release

- [ ] **Refresh `AGENTS.md` header:** change "0.5.21 on disk, 0.6.0 pending tag + publish" to "0.6.0 released <date>".
- [ ] **Create GitHub milestone `v0.6.x`** — collect follow-up issues for:
  - Dispatch-DLQ active requeue (Slice 5 deferral)
  - Full `fleet run` over Kafka with mocked LLM (Slice 7 deferral)
  - `agent.yaml#reliability.*` schema (Slices 3/4 deferrals)
  - `declaragent ps` live breaker column (Slice 3 deferral)
- [ ] **Create GitHub milestone `v1.1 Agent Graph`** — collect:
  - NATS / SQS / AMQP / MQTT RPC transport factories
  - Cross-broker integration tests
  - Typed `capabilities.yaml` schema work per `AGENT_RPC_PLAN.md`
- [ ] **Update `docs-site/`** with a 0.6.0 release post and any new `declaragent dlq --kind dispatch` / `events list --state circuit-open` / `fleet deploy --canary` examples.

---

## Rollback path

If a blocking issue surfaces within 24h of publish:

```bash
# Deprecate 0.6.0 with a clear message pointing users at the prior stable.
npm deprecate @declaragent/cli@0.6.0 "regressed; roll back to 0.5.21 while we fix"
```

Then cut `0.6.1` with the fix rather than republishing `0.6.0`. Never force-republish a version that's already live on npm — cache invalidation is unreliable and integrity checks will fail for users who already downloaded the bad version.

---

## What this doc is NOT

- A substitute for `AGENTS.md`. If the feature list drifts between the two, **AGENTS.md wins** — it's the evidence-backed source of truth for current state.
- A substitute for `docs/RELEASE_0_6_0_PLAN.md`. That doc is the "why + how we built 0.6.0"; this doc is "how to ship it."
- An invitation to skip the nightly soak. The plan asks for 7 consecutive greens on `nightly-integration.yml` before beta → rc for good reason — integration flake tends to surface on day 3–5 of a soak run.
