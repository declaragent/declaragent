# PATCH_0_5_2_PLAN.md — Integration fixes + prod-smoke CI

**Target:** `@declaragent/cli@0.5.2` + `@declaragent/core@0.3.2`, triggered `v0.5.2` tag.
**Scope:** Three integration bugs surfaced by the fleet-test script after 0.5.1 shipped, plus the CI gap that allowed them all through.
**Branch strategy:** All work lands on `main`; single version-bump commit cuts `0.5.2` once every fix is green against the new integration workflow.

Status: **draft** (2026-04-22). Supersedes the ad-hoc patching that produced 0.5.1.

---

## Why a dedicated patch plan

0.5.1 fixed factory-default adapter exports but shipped against a blind spot: no CI ever exercised the path a real user takes — `npm install @declaragent/cli @declaragent/source-kafka`, scaffold, produce a Kafka message, assert the event lands in the store. Slice 1's unit tests used inline fixtures and never imported a published adapter through the discovery machinery. The fleet-test (`/tmp/test-0.5.0-kafka-fleet.sh`) surfaced three consecutive gaps. A patch plan is cheaper than another round of hot-patching.

## Bugs to close

### Bug 1 — `MessageNormalizer` missing from source deps

**Symptom:** Agent receives a Kafka message, log emits `base-source.no-normalizer`, the event is ack'd and dropped. Event store never sees it.

**Root cause:**
- `BaseSourceInstance.handleMessage()` (`packages/core/src/events/base-source.ts:305-315`) requires `deps.normalizer` to convert raw broker payloads into `AgentEvent`s. Without one, it ack-and-drops.
- `startAgentSources()` in `packages/cli/src/run-agent-sources.ts:279-283` builds a `SourceDependencies` object **omitting** `normalizer` entirely.
- Core already exports `createMessageNormalizer()` at `packages/core/src/events/normalizer.ts:75-162` — a format-aware default (JSON/plain/avro/protobuf/msgpack).

**Fix:** In `run-agent-sources.ts::loadAdapters` (or the `deps` construction site for each adapter instance), import `createMessageNormalizer` and include a single shared instance in the deps. Builtin webhook/cron/file-watch sources don't read `deps.normalizer` (they build their own events), so there's no collision.

**Test:** Add a CLI-level test that asserts `SourceDependencies.normalizer` is defined when an adapter's `create` is called via `startAgentSources`. Existing broker-specific source tests in `packages/source-kafka/test/integration.test.ts` already exercise the normalizer path once a real broker is online; the CI smoke workflow in Bug 3 pins end-to-end.

**Blast radius:** CLI-only change. No package republish needed for any source adapter. Only `@declaragent/cli@0.5.2` (and transitively whatever else bumps).

### Bug 2 — compiled `declaragent` binary can't resolve externals

**Symptom:** User runs the globally-installed `declaragent` binary with `@declaragent/source-kafka` locally installed. Discovery tries `await import(pathToFileURL(entry).href)` on the adapter's `dist/index.js`. That file contains `import '@declaragent/core'`. Bun's compiled-binary resolver fails with `Cannot find module '@declaragent/core' from '.../source-kafka/dist/instance.js'` even though `node_modules/@declaragent/core` exists.

**Root cause:** `bun build --compile` produces a single-file executable. Its internal runtime intercepts bare module specifiers and looks them up in the bundled namespace. A dynamically-imported file-URL's `import '@declaragent/core'` is NOT routed through Bun's on-disk `node_modules` walker — the compiled binary has no "disk" to walk.

**Fix options evaluated:**
- ❌ `bun build --compile --external <pkg>`: not supported. External modules need a runtime filesystem the compiled binary doesn't have.
- ❌ Custom `createRequire(entry)` inside `adapter-discovery.ts`: doesn't help; the resolver still runs inside the compiled binary and hits the same bundled-namespace intercept.
- ✅ **Launcher fallback to `bun dist/index.js`** when Bun is installed.

**Chosen fix:**
1. Modify `packages/cli/bin/declaragent.js` (the npm launcher) to check for `bun` on PATH first. If found, spawn `bun node_modules/@declaragent/cli/dist/index.js "$@"` — this path has no compile-time bundling intercept, so external adapters resolve correctly.
2. Fall back to the compiled binary when Bun isn't installed. Compiled binary keeps working for CLI-only commands (`init`, `auth login`, etc.) that don't load external adapters.
3. Document the tradeoff: users who run external source/channel adapters should have Bun installed. Plain `declaragent` commands stay fast via the binary.

**Alternative deferred:** Rearchitecting discovery to load adapters in a subprocess or to preload their deps via a manifest-driven bundle. Either is 0.6.x-scope.

**Blast radius:** `@declaragent/cli@0.5.2` only. Launcher change is Node JS, no binary rebuild strictly needed — but the binary WILL rebuild for the tag and get tarballed.

### Bug 3 — no CI catches the install→run→produce path

**Symptom:** Three slice-1 integration bugs shipped as part of 0.5.0 without a single CI signal. Every unit test stayed green.

**Root cause:** The two existing smoke workflows (`installer-smoke.yml`, `npm-install-smoke.yml`) validate that `declaragent --version` prints. Neither installs `@declaragent/source-kafka`, spins a broker, or asserts an event flows end-to-end.

**Fix:** New workflow `.github/workflows/prod-smoke-kafka.yml`:
1. `docker compose up` Redpanda from the fixture at `packages/source-kafka/test/fixtures/docker-compose.yml`.
2. `npm install @declaragent/cli@latest @declaragent/source-kafka@latest` into a tmpdir.
3. Scaffold a one-agent fleet with a Kafka source consuming `smoke.input`.
4. `bun node_modules/@declaragent/cli/dist/index.js up -f fleet.yaml &` (working around Bug 2 explicitly; the workflow itself serves as documentation of the recommended invocation).
5. Produce a JSON message via `rpk topic produce smoke.input`.
6. Poll `declaragent events list` for ≤30s waiting for the event to appear with `outcome: pending` (no LLM creds in CI).
7. Shut down + tear down.

Triggers: `push` to main + `schedule: '0 */6 * * *'` + `workflow_dispatch`. Scheduled cadence surfaces regressions within 6h of a transitive broken publish (e.g., a dependency bumps in a way that shifts ESM resolution).

**Size budget:** ≤150 lines YAML. No new infrastructure.

**Additional coverage (stretch, same PR if time allows):**
- `prod-smoke-mcp.yml` — install CLI + a reference MCP server, assert tools enumerate at boot. Validates slice 2a.
- `prod-smoke-channel.yml` — install CLI + a mock channel, assert `SendMessage` reaches the mock's inbox. Validates slice 3.

These are optional for 0.5.2; Kafka is the priority because that's the smoke that surfaced the bugs.

---

## Execution order

1. **Bug 1 fix + unit test** — smallest, lowest risk. Ships standalone if Bug 2 blows up.
2. **Bug 2 launcher fallback** — modifies the npm launcher only. Doesn't touch the compiled binary.
3. **CI workflow** — added to `.github/workflows/prod-smoke-kafka.yml`. Runs on every push after merge.
4. **Local validation** — re-run `/tmp/test-0.5.0-kafka-fleet.sh bind-only` against the unreleased-but-built code. Should now pass against the JS-dist path + emit an actual event.
5. **Changeset + version bump** — patch bump on `@declaragent/cli` (bug fixes) and on `@declaragent/core` if Bug 1's normalizer wiring needs any core surface changes (expected: no core change).
6. **Commit + push main** — triggers `release.yml` (npm publish) automatically.
7. **Tag `v0.5.2`** — triggers `release-binaries.yml` (GH release with compiled binaries).
8. **Verification** — `npm install -g @declaragent/cli@0.5.2`, rerun fleet test, watch smoke workflow pass on the commit.

## Non-goals

- Rearchitecting the compiled binary to fully support external adapter discovery. That's plausibly 0.6.0 scope via a subprocess-based loader or an adapter-manifest bundle.
- Automating the binary build + GH release tag from the `release.yml` workflow. Current flow (manual tag push) worked for 0.5.0 + 0.5.1; automation is a separate "release UX polish" item.
- Channel / MCP / plugin smoke workflows. Kafka smoke is the must-have because it covered the specific bugs we saw. The other runtimes can follow in 0.5.3 or when a bug forces the issue.

## Acceptance

0.5.2 is done when:
1. `prod-smoke-kafka.yml` is green on main.
2. `npm install -g @declaragent/cli@0.5.2` + fresh `npm install @declaragent/source-kafka@latest` followed by `declaragent up` on a scaffolded Kafka-source agent → event appears in `declaragent events list` within 10s of a produced message.
3. `/tmp/test-0.5.0-kafka-fleet.sh bind-only` passes against the installed 0.5.2 CLI (no local workarounds needed; the launcher picks the right path automatically).
4. GitHub release v0.5.2 has four platform tarballs uploaded.

## Risks

- **Bun PATH dependency:** users on minimal systems without Bun will get the compiled binary's external-adapter limitation. Installer script + docs should mention this. Non-blocking for 0.5.2 because plain CLI commands still work on the compiled binary.
- **CI resource usage:** prod-smoke-kafka.yml adds Redpanda docker-compose time (~30s cold). Keeping the trigger to push-main + 6h cron keeps monthly minutes low.
- **Normalizer default format assumption:** defaulting every broker adapter to JSON-format normalizer is correct for the shipped adapters but surprises a user who expects Avro/Protobuf without explicit config. Document the `routing.format` override in the Kafka template.

---

## Sizing

| Step | Time |
| --- | --- |
| Bug 1 fix + CLI test | 20 min |
| Bug 2 launcher fallback + test | 30 min |
| prod-smoke-kafka.yml + validate locally | 45 min |
| Version bump + commits + tag + verify | 15 min |
| Live re-run of `/tmp/test-0.5.0-kafka-fleet.sh` | 10 min |
| **Total** | **~2h focused** |
