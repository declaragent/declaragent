# Phase 7 — Distribution: Implementation Plan

**Status:** Draft for review. Scoped to Phase 7 of `SPEC_AND_PLAN.md` (Distribution → v1.0 GA).
**Last updated:** 2026-04-18.

Phase 6 hardened the runtime against pen tests, chaos, and multi-tenant
leakage — but nothing ships to a new user's laptop. Phase 7 takes the
working runtime and makes it **installable, documented, and frozen**.
Scope is narrow on purpose: no new runtime behavior, no new adapters,
no new tools. Every slice reduces the distance between "a teammate
has an empty laptop" and "a teammate has an agent running against
their production Slack, serving a real skill, on a real cloud host."

The **acceptance bar** from `SPEC_AND_PLAN.md §Phase 7`:

> A new user runs `curl https://get.declaragent.dev | sh && my-agent
> init`, answers the wizard, and has an agent running on GCP Cloud Run
> in under 10 minutes. Measured, not estimated.

Ten minutes is the forcing function. Anything that doesn't directly
reduce first-run latency is deferred. The deferrals list is long on
purpose — Phase 7 is a shipping slice, not a feature slice.

---

## 1. Goals and non-goals

**Goals.**
- **Phase-6 tidy-up** (slice 0). Three deferrals from Phase 6 become
  blockers for GA: session-key `(tenantId, sessionId)` migration,
  daemon's `startDaemon` per-tenant branch + `tenants.yaml` auto-load,
  and the `declaragent tenants / audit / secrets` CLI verbs. Without
  these the multi-tenant primitives from slice 6 aren't reachable
  from a CLI-first deployment.
- **Installers.** Three entry points, all one command:
  - `curl https://get.declaragent.dev | sh` — cross-platform install
    script that detects arch + downloads the right binary tarball
    from the GitHub release.
  - `npm install -g @declaragent/cli` — canonical npm path.
  - `brew install declaragent` — macOS, via a homebrew-core formula or
    a `declaragent/tap` if core review stalls.
- **Single binary.** `bun build --compile` produces a self-contained
  executable per `(platform, arch)` target. No Bun runtime required on
  the host. Binary ships in the release tarball; `curl`-installer
  drops it into `$PREFIX/bin/declaragent`.
- **`declaragent init` wizard.** First-run flow that produces a working
  `agent.yaml` + `.env.example` in ≤ 3 minutes. Picks a provider
  (Anthropic / OpenAI-compat / OpenRouter), runs the auth login flow
  already in `packages/cli/src/auth.ts`, offers a template pack, and
  verifies the result with a live `hello` call.
- **Template packs.** Five starters that exercise the spectrum of
  the runtime:
  1. `concierge` — single-channel Slack bot, Q&A skill with memory.
  2. `oncall-escalator` — webhook → engine → Slack DM, idempotency key.
  3. `pr-review` — GitHub webhook → Claude → review comment.
  4. `kafka-pipeline` — Kafka source + DLQ + cost budget.
  5. `multi-tenant-starter` — `tenants.yaml` with two tenants +
     isolated audit + scoped registry.
- **Docs site.** Docusaurus-based site at `https://declaragent.dev/docs`.
  Four top-level sections:
  - **Quickstart** (10-minute path).
  - **Reference** (spec schema, CLI, env vars, provider matrix).
  - **Cookbook** (per-template walkthrough + cross-cutting recipes).
  - **Troubleshooting** (runbook surface + common error codes).
- **Cloud Run deployment** — one `declaragent deploy gcp-cloud-run`
  path that takes the user's `agent.yaml` + secrets and emits a
  `Dockerfile` + `service.yaml`. No AWS / Azure parity in Phase 7.
- **Config freeze + SemVer.** Every public surface (`agent.yaml`
  schema, `AgentSpec` TS types, engine `ToolContext`, channel +
  source adapter contracts, CLI verbs + flags) is pinned to v1.0.
  Breaking changes after tag require a major-version bump.
- **Release automation.** `.github/workflows/release.yml` builds +
  signs binaries for every target, publishes to npm, updates the
  homebrew formula, and uploads the tarball + checksums to the
  release.
- **Telemetry opt-in.** Anonymous first-run metric ("installed",
  "wizard completed", "deploy succeeded") with strict opt-out via
  `DECLARAGENT_TELEMETRY=0` + documented at install time.

**Non-goals (Phase 7).**
- **New runtime features.** Engine, channels, sources, tools, MCP,
  secrets, audit are all frozen at Phase 6.
- **Managed control plane.** Per-tenant provisioning UI, team RBAC,
  cost dashboards, hosted secret vaults — private beta post-v1.0
  per `SPEC_AND_PLAN.md §Part 7`.
- **Non-GCP cloud deployments.** AWS Fargate + Azure Container Apps
  come in Phase 7.x; parity is a v1.1 concern.
- **Kubernetes operator / Helm chart.** `Dockerfile` + `service.yaml`
  are the GA deliverables; a CRD-based operator is post-v1.0.
- **Windows native binary.** `bun build --compile` emits Linux +
  macOS (x64 + arm64) targets only. Windows users run via WSL2 and
  npm global, documented.
- **Interactive terminal UI for init.** The wizard is prompt-based
  (same Ink framework already in `packages/cli/src/app.tsx`) rather
  than a full TUI. Full TUI is scope creep.
- **SSO / OIDC for the daemon control plane.** Out of scope per the
  resolved-gap decision in SPEC_AND_PLAN §Part 6.
- **Auto-upgrade.** `declaragent upgrade` is a nice-to-have; we
  document "re-run the installer" instead.
- **Signed commits + SLSA level 3.** Release binaries are sha256 +
  checksum-signed; full SLSA provenance is a v1.1 track.
- **Non-English docs.** English only at GA. Translation infrastructure
  ships behind the docs site's Docusaurus config but no translations
  land in Phase 7.

---

## 2. Conceptual architecture

```
   User's laptop                              Registry / CDN
   ─────────────                              ───────────────
                             curl -sL get.declaragent.dev | sh
                             ──────────────────────────────────►
                                                   │ resolves to
                                                   ▼
                                             install.sh (static)
                             ◄─────────────── detects arch, pulls
                                              tarball from GitHub
                                              release

   $PREFIX/bin/declaragent    ────►  declaragent init
                                      │
                                      ├── pick provider  ─► auth flow
                                      ├── pick template  ─► unpack
                                      ├── verify         ─► hello turn
                                      └── hints          ─► docs URL

   agent.yaml                  ────►  declaragent run   (local)
                                      declaragent deploy gcp-cloud-run
                                               │
                                               ▼
                                          GCP Cloud Run
                                          ────────────
                                          container image
                                          (bun-compiled binary
                                           + config dir mount)
```

**Distribution surface:** one binary, three install paths, one wizard,
one deploy command. Every other Phase 7 artifact (docs, templates,
release automation) supports that surface.

**Backward compatibility:** `curl`-bash + npm + Homebrew all resolve
to the same binary + version. The wizard only runs on first start
(marker in `~/.declaragent/.initialized`); re-running is a no-op
upgrade of the template.

**Tenant-aware first-run:** `declaragent init --multi-tenant` takes
the slice-6 primitives and wires `tenants.yaml` into the generated
template. Default single-tenant flow preserves Phase-1-through-5
ergonomics.

---

## 3. Phase-6 carry-over scope (slice 0)

Three primitives from Phase 6 stopped at the unit-test boundary. GA
can't ship without the CLI + daemon paths that surface them.

### 3.1 Session-key `(tenantId, sessionId)` migration

`SessionManager.key()` currently takes `sessionId` only; slice 6's
deferral. Phase 7 slice 0:
- Widens `SqliteSessionStore.key` to `(tenantId, sessionId)` tuples.
- Adds a one-shot migration: on daemon start, any session without a
  `tenant_id` column value is stamped with `__default__`.
- Propagates `tenantId` through `session.spawn()` + `session.open()`
  signatures; existing callers keep working via the default-tenant
  fallback.
- Tests: migration runs on a populated Phase-6 sqlite file; new
  column is non-null + defaults apply; cross-tenant lookup throws
  `TenantBoundaryError`.

### 3.2 Daemon's per-tenant branch

`startDaemon` currently takes a single bus / registry. Slice 0 adds:
- `tenants.yaml` auto-load from the config dir (optional — single-
  tenant still works).
- Per-tenant `TenantRuntime` instantiation via `createTenantRuntime`.
- Each inbound event's `meta.tenantId` routes to the matching
  runtime's bus; the dispatcher is tenant-agnostic because every
  bus already enforces its own scope.
- Quota tracker wired into the engine's tool-call dispatch path: a
  breached quota throws `QuotaExceededError` + a tool-call event
  surfaces with `outcome: 'deny'` + `reason: 'quota_exceeded'`.

### 3.3 CLI verbs: `tenants`, `audit`, `secrets`

Three new command trees in `packages/cli/src/`:

| Verb | Subcommand | Purpose |
| ---- | ---------- | ------- |
| `tenants` | `list` | Show every loaded tenant + its quota + residency. |
| `tenants` | `diff` | Compare `tenants.yaml` to the live runtime — surface drift. |
| `tenants` | `show <id>` | Print one tenant's full config + quota snapshot. |
| `audit` | `query` | Filter records by `--tenant / --kind / --since / --until / --limit`. |
| `audit` | `verify` | Run chain-verify; exit 0 on `ok: true`. |
| `audit` | `erase --user <pid>` | Invoke `erasePlatformUser`. Prints the tombstone count. |
| `audit` | `prune --tenant <id> --retention-days N` | Run retention pruner. |
| `secrets` | `list --provider <name>` | List refs visible to a provider. |
| `secrets` | `describe <ref>` | Print metadata (no value). |
| `secrets` | `rotate <ref>` | Delegate rotation to the provider; audit-record on completion. |

Every verb ships a `--json` flag for scriptability. Tests cover
the happy path + one error per verb.

### 3.4 Per-tenant metrics labels auto-stamping

`createPrometheusRegistry` already accepts `constLabels`. Slice 0
wires the daemon to build one registry per tenant with
`constLabels: { tenant_id: tenant.id }` (or one shared registry
when `strategy.bus === 'shared-with-filter'`). Dashboards +
alert rules in `packages/testkit/alerts/` key on `tenant_id`
already — the change is in the daemon, not the rules.

---

## 4. Installer strategy

### 4.1 `curl`-bash installer

One script at `scripts/install.sh`. Served from
`https://get.declaragent.dev/install.sh` (Cloudflare Workers +
static asset in the first cut; edge-caching is fine, the binary
URL is version-pinned).

```sh
#!/bin/sh
set -euo pipefail
VERSION="${DECLARAGENT_VERSION:-latest}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
# Normalize macOS arm64, Linux arm64, Linux x86_64, Linux aarch64.
case "$OS-$ARCH" in
  linux-x86_64)   TARGET=linux-x64 ;;
  linux-aarch64)  TARGET=linux-arm64 ;;
  darwin-x86_64)  TARGET=darwin-x64 ;;
  darwin-arm64)   TARGET=darwin-arm64 ;;
  *) echo "unsupported OS/arch: $OS $ARCH"; exit 2 ;;
esac
PREFIX="${DECLARAGENT_PREFIX:-$HOME/.local}"
URL="https://github.com/declaragent/declaragent/releases/${VERSION}/download/declaragent-${TARGET}.tar.gz"
# Download, verify checksum, extract, install.
...
```

Non-negotiable properties:
- Exits non-zero on checksum mismatch (checksum file signed with the
  GitHub Actions release key).
- Works behind an HTTP proxy via `HTTPS_PROXY`.
- Prints the exact command to add `$PREFIX/bin` to PATH on first run.
- Never requires `sudo`; defaults to `$HOME/.local`.
- Respects `DECLARAGENT_VERSION=v1.0.2` for pinned installs.

### 4.2 npm global

`packages/cli/package.json` already has a `bin` entry. The GA
version bumps + publishes to public npm. `npm install -g
@declaragent/cli` drops a Node wrapper that shells to the Bun
runtime.

Complication: Bun isn't guaranteed on every developer's machine.
For npm installs, the wrapper detects `bun` in `$PATH`; if absent,
it downloads the bundled single-binary via the postinstall script
(same binary as the `curl` path). `DECLARAGENT_NO_POSTINSTALL=1`
opts out for air-gapped installs.

### 4.3 Homebrew

Two-track plan:
- **Primary:** submit a formula to homebrew-core. Review typically
  takes 1–2 weeks.
- **Fallback:** `brew tap declaragent/tap && brew install declaragent`
  served from `github.com/declaragent/homebrew-tap`. Tap is live from
  day 1 of Phase 7; core submission runs in parallel.

Formula installs the single-binary + a man page + shell-completion
files (bash, zsh, fish).

---

## 5. Single-binary via `bun build --compile`

Every target binary produced by:

```
bun build --compile \
  --target=bun-${TARGET} \
  --outfile=declaragent-${TARGET} \
  packages/cli/src/index.tsx
```

Targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`.
Windows users install via npm-global wrapper (documented).

Size budget: ≤ 120 MB per binary (Bun runtime + our code). The
release workflow fails if any target exceeds the budget.

### 5.1 Static asset packaging

Assets embedded into the binary:
- **Template packs** (§7) — every starter's files bundled so the
  `init` wizard can unpack without a network call.
- **Docs quickstart** (subset, for `declaragent help`).
- **Default Grafana dashboard + alert rule files** — reused by
  `declaragent deploy` to provision observability config.

Bundling uses Bun's `Bun.embeddedFiles` API. A slice-7 CI check
verifies every referenced asset is actually embedded (greps the
manifest).

### 5.2 Runtime-level checks at first run

- Detect truncated binary (sha256 against the embedded expected
  hash) and refuse to run with a clear "re-install" message.
- Detect missing `~/.declaragent` and create it with 0700 perms.
- Detect a mid-incompat config (`agent.yaml` from v0.x) and point at
  `declaragent migrate`.

---

## 6. `declaragent init` wizard

Five-step flow built on the existing Ink + `ink-text-input`
stack. Total target: ≤ 3 minutes with a good network connection.

1. **Welcome + telemetry opt-out prompt.** One screen, one key:
   accept (default) or opt out. Never re-prompts.
2. **Provider picker.** Reuses `packages/cli/src/auth-provider-picker.tsx`.
   Anthropic / OpenAI-compat / OpenRouter. Picks the provider +
   calls into the existing auth flow.
3. **Template picker.** The 5 template packs (§7), each with a
   one-line description + estimated cost ceiling. Default:
   `concierge`.
4. **Config write.** Writes `agent.yaml`, `.env.example`,
   `README.md` (template's own), and `tenants.yaml` if
   `--multi-tenant`. Targets `./` by default; `-o <dir>` for an
   explicit path.
5. **Verify.** Runs one `hello` turn against the configured LLM
   provider. A 200 response = wizard complete. Failure = actionable
   error with the fix.

**Nonexistence check:** step 4 refuses to overwrite an existing
`agent.yaml`. `declaragent init --force` flag for power users.

### 6.1 Anti-gotchas

- **Corp proxies:** detect + surface at step 2, point at the
  `HTTPS_PROXY` env var.
- **Missing API key on restart:** step 2's auth flow writes to
  `~/.declaragent/credentials`; re-running the wizard reuses it.
- **Multi-tenant mode mid-wizard:** pressing `T` at step 3 toggles
  `--multi-tenant` and adds a "tenant id" prompt before template
  pick.

---

## 7. Template packs

Each template is a directory with a canonical layout:

```
templates/<name>/
├── agent.yaml
├── channels.yaml            # optional — only when the template uses a channel
├── tenants.yaml             # optional — only for the multi-tenant starter
├── .env.example
├── README.md                # written to project root on unpack
├── skills/
│   └── <skill>.md
└── plugin-manifest.json     # when plugins are required
```

The five templates:

### 7.1 `concierge`

Minimal Slack bot. One channel, one skill (`concierge.md`) that
answers Q&A using provider-default tools (Read, Glob, Grep). Wires
`channels.yaml` with Socket Mode (no public URL required). Goal:
prove the end-to-end loop works in under 2 minutes.

### 7.2 `oncall-escalator`

Webhook source (`webhook:alertmanager`) → engine → Slack DM.
Demonstrates idempotency keys (`X-Alertmanager-Fingerprint`) and
the `SendMessage` tool. Ships with a mock alertmanager payload
and a local-run instruction.

### 7.3 `pr-review`

GitHub webhook → Claude reviews the PR diff → posts review comments
via a plugin-contributed `GitHubReviewComment` tool. Uses
`@declaragent/plugin-github` from the Phase-2 ecosystem (already
in the plugin registry).

### 7.4 `kafka-pipeline`

Kafka source with JSON-path routing, DLQ config, and a daily
token budget. Demonstrates the Phase-4 adapter surface + Phase-6
cost enforcement. Ships with a Docker Compose file for Redpanda.

### 7.5 `multi-tenant-starter`

`tenants.yaml` with two tenants (`acme-prod` + `beta-tenant`),
each with scoped extensions + quotas. Demonstrates the Phase-6
primitives end-to-end. Includes an `audit verify` + `tenants list`
call in the README's "smoke test" section.

Every template ships with a `README.md` that walks through:
- What this agent does.
- What secrets are required (referenced by name; `.env.example`
  covers the matching env vars).
- The `declaragent run` / `declaragent deploy` invocation.
- Typical cost per month (estimated, clearly labeled as a lower
  bound — per resolved gap #15).

---

## 8. Docs site (Docusaurus)

Lives in `docs-site/` at repo root (sibling to `packages/`). Not
published to npm; deployed via Cloudflare Pages on every push to
`main`.

Four top-level sections:

### 8.1 Quickstart

One page. The 10-minute path. Mirrors `README.md` but with
screenshots. Links to the Cookbook for the five templates.

### 8.2 Reference

- **`agent.yaml` schema** — auto-generated from the Zod + JSON
  schema in core. Every field has a type, example, and a "since"
  version.
- **CLI reference** — auto-generated from the help strings in
  `packages/cli/src/*`. `declaragent help --json` emits the
  machine-readable source. CI runs the extraction + diffs vs. the
  committed MDX.
- **Env vars** — every `process.env.*` read + its purpose.
- **Provider matrix** — which provider supports which feature
  (streaming, function-calling, image-in, audio-in). Tested nightly
  against each provider.
- **Event / channel / source adapter registry** — kind catalog with
  each extension's id, source, and link to its repo.

### 8.3 Cookbook

Per-template walkthroughs + cross-cutting recipes:
- "Deploy to GCP Cloud Run in 10 minutes."
- "Add a GitHub webhook source."
- "Rotate a Vault secret without downtime."
- "Run two tenants on one daemon."
- "Trace a request end-to-end in Grafana."

### 8.4 Troubleshooting

- Every `runbook_url` from `packages/testkit/alerts/` surfaces as
  a doc page.
- Every error code emitted by core (`EEXTCONFLICT`,
  `TENANT_BOUNDARY`, `EQUOTA`, etc.) gets a page with cause +
  fix.
- A "my install failed" flowchart.
- A "my `declaragent deploy` got 403" flowchart.

### 8.5 Versioning

Docusaurus supports per-version docs. v1.0 is the first tagged
version; subsequent minors get their own sidebar. Older content
stays readable after v1.1 ships.

---

## 9. Cloud Run deployment

`declaragent deploy gcp-cloud-run` takes the user's config + emits
artifacts the user applies with `gcloud run deploy`. We deliberately
stop short of invoking `gcloud` ourselves — the user's GCP auth
flow is theirs to own.

### 9.1 Generated artifacts

```
.declaragent/deploy/
├── Dockerfile
├── service.yaml            # Cloud Run service manifest
├── .dockerignore
└── README.md               # "run these three commands"
```

**`Dockerfile`** (abridged):

```dockerfile
FROM alpine:3.19
ARG BINARY=declaragent-linux-x64
COPY bin/${BINARY} /usr/local/bin/declaragent
COPY config /etc/declaragent
RUN chmod +x /usr/local/bin/declaragent \
  && addgroup -S agent && adduser -S agent -G agent
USER agent
ENV DECLARAGENT_CONFIG_DIR=/etc/declaragent
EXPOSE 8787 9464
ENTRYPOINT ["/usr/local/bin/declaragent", "run"]
```

**`service.yaml`**:
- CPU / memory presets mirror the agent's declared concurrency.
- Secret Manager bindings stamp every `${secret:...}` ref into
  env vars.
- One volume mount per `tenants.yaml` tenant's data dir.
- Minimum instances = 1 (daemon must stay warm; events can arrive
  any time).

### 9.2 Verification step

`declaragent deploy gcp-cloud-run --verify` runs `gcloud run
services describe` + hits the daemon's `/health` endpoint. On
200, wizard prints a shareable URL + the Slack / Telegram /
WhatsApp webhook configuration snippet.

### 9.3 Documented cost

Each template's README surfaces an estimated monthly cost at
Cloud Run's `cpu=1, memory=512MiB, minInstances=1` baseline:
roughly $40–$60 / month plus provider tokens. Clearly labeled as
lower-bound.

---

## 10. Config freeze + SemVer promise

### 10.1 Frozen surfaces

Every interface the spec touches becomes v1.0-stable:
- **`agent.yaml`** — every field validated by a Zod schema; schema
  version is `1`. New optional fields allowed in minors; removals +
  renames require a major.
- **TS types** in `@declaragent/core` exported from `index.ts`:
  `AgentSpec`, `ToolContext`, `ChannelDependencies`,
  `SourceDependencies`, `TenantContext`, etc.
- **CLI verbs + flags** — help strings get an attribution (`since
  v1.0`); breaking renames require a major.
- **Event kinds** (`chat.message`, `assistant.final`, etc.).
- **Audit record `kind`** values.
- **Channel adapter `ChannelAdapter<C>` + source adapter
  `EventSourceAdapter<C>` contracts.**
- **Plugin manifest schema.**

### 10.2 Versioning policy

- Repo-wide version sync via changesets (already in place).
- `v1.0.0` → `v1.0.x` for patches (bug fixes, docs).
- `v1.1.0` for minor features (new optional fields, new adapters).
- `v2.0.0` for anything breaking.
- Pre-releases during the GA-cutoff window: `v1.0.0-rc.N` gets one
  day of soak before promotion.

### 10.3 Migration story

`declaragent migrate` walks pre-v1.0 configs forward. For v1.0,
the migration is from v0.9.x (internal) to v1.0.0 — covers the
session-key rename + the tenant block addition. Migration runs
dry by default; `--apply` writes the change.

---

## 11. Slice breakdown

Same approach as Phases 3–6: thin vertical slices, each independently
mergeable, critical path serialized with parallel legs.

### Slice 0 — Phase-6 tidy-up (~4 days)
- Session-key `(tenantId, sessionId)` migration + Phase-1 sqlite
  schema bump.
- Daemon's `startDaemon` per-tenant branch + `tenants.yaml`
  auto-load.
- `declaragent tenants list / diff / show`, `audit query / verify /
  erase / prune`, `secrets list / describe / rotate` CLIs.
- Per-tenant metrics-label auto-stamping in the Prometheus exporter.
- Tests: two tenants in one daemon end-to-end (slice-6 tests
  promoted to integration); CLI contract tests.

### Slice 1 — Release automation skeleton (~2 days)
- `.github/workflows/release.yml` extension: matrix-build
  linux/darwin × x64/arm64 binaries with `bun build --compile`.
- SHA-256 checksums + release notes auto-generated from changesets.
- Tag-triggered; dry-run on `workflow_dispatch`.
- Homebrew tap repo initialized (`declaragent/homebrew-tap`).

### Slice 2 — `curl`-bash installer (~2 days)
- `scripts/install.sh` with arch detection + checksum verification.
- Static hosting: Cloudflare Workers serving `install.sh` + the
  redirect to the GitHub release.
- Integration test: hermetic Docker container runs the installer
  from scratch + exercises `declaragent --version`.

### Slice 3 — npm + Homebrew packaging (~2 days)
- npm postinstall shim that downloads the single-binary on first
  run.
- Homebrew tap formula + manual-install script for submission to
  homebrew-core.
- End-to-end test matrix on CI: ubuntu-latest / macos-13 /
  macos-14 all install + run `declaragent --version`.

### Slice 4 — `declaragent init` wizard (~3 days)
- Wizard flow orchestrator (`packages/cli/src/init-wizard.tsx`).
- Template picker + unpack (templates bundled in the binary per
  §5.1).
- Verify step (one LLM call + shutdown).
- Tests: every template unpacks without errors; verify step
  handles network failures gracefully.

### Slice 5 — Template packs (~4 days; parallel with slice 4)
- Author five templates under `templates/` in the repo root.
- Each template has its own unit test suite that validates
  `agent.yaml` parses + every declared skill compiles.
- One-shot "try every template" CI job that runs every template's
  `verify` flow against a mock LLM.

### Slice 6 — Cloud Run deploy path (~3 days)
- `declaragent deploy gcp-cloud-run` command.
- Dockerfile + service.yaml generators with Zod-validated input.
- Local dry-run test that emits the artifacts + asserts the
  Dockerfile `BUILDKIT` linter passes.
- Nightly job: real Cloud Run deploy of the `concierge` template
  to a test GCP project + a synthetic Slack workspace ping.

### Slice 7 — Docusaurus docs site (~4 days)
- `docs-site/` Docusaurus project initialization.
- Quickstart + Reference + Cookbook + Troubleshooting pages.
- Auto-extraction of CLI help + `agent.yaml` schema into MDX.
- Cloudflare Pages deploy on every push to `main`.

### Slice 8 — Config freeze + release candidates (~2 days)
- `declaragent migrate` verb + v0.9 → v1.0 migration logic.
- Mark every frozen type with a `@since 1.0.0` JSDoc tag.
- Tag `v1.0.0-rc.1`.
- Soak the release candidate for 7 days across the Phase-6 chaos
  suite + pen-test-fixed surface.
- Promote to `v1.0.0` after soak.

### Slice 9 — Launch (~1 day)
- Announcement blog post.
- Release notes aggregated from changesets.
- Hacker News / Reddit / Twitter coordination.
- On-call rotation for first 72 hours post-launch.

**Critical path:** 0 → 1 → 2 → {3 ∥ 4 ∥ 5} → 6 → 7 → 8 → 9.
Slices 3–5 parallelize once the installer machinery is in place.
Slice 6 needs slice 5 so the concierge template ships alongside
the deploy path that uses it.

**Total estimate:** ~21 days of focused work, matching the spec's
2–3 week guidance.

---

## 12. File layout

```
scripts/
└── install.sh                        # slice 2

packages/cli/src/
├── init-wizard.tsx                   # slice 4
├── tenants-cli.ts                    # slice 0
├── audit-cli.ts                      # slice 0
├── secrets-cli.ts                    # slice 0
├── deploy-cli.ts                     # slice 6
└── migrate-cli.ts                    # slice 8

packages/core/src/
├── session/
│   └── sqlite.ts                     # slice 0 — tenant-key migration
├── events/
│   └── daemon.ts                     # slice 0 — per-tenant branch
└── (no other core changes — runtime is frozen)

templates/                            # slice 5
├── concierge/
├── oncall-escalator/
├── pr-review/
├── kafka-pipeline/
└── multi-tenant-starter/

docs-site/                            # slice 7
├── docs/
│   ├── quickstart/
│   ├── reference/
│   ├── cookbook/
│   └── troubleshooting/
├── docusaurus.config.js
└── src/

.github/workflows/
├── release.yml                       # slice 1 (major extension)
├── installer-smoke.yml               # slice 2
├── templates-verify.yml              # slice 5
├── cloud-run-soak.yml                # slice 6 (nightly)
└── docs-site.yml                     # slice 7
```

---

## 13. Touch points into existing code

Phase 7 is deliberately minimal-touch on the runtime. The non-
installer work touches:

- `packages/core/src/session/sqlite.ts` — schema bump + tenant-
  keyed lookups (slice 0).
- `packages/core/src/events/daemon.ts` — per-tenant runtime
  assembly (slice 0).
- `packages/core/src/observability/prometheus.ts` — honor
  `constLabels` per-tenant at daemon startup (slice 0).
- `packages/cli/src/index.tsx` — new verb registrations for
  `init` / `tenants` / `audit` / `secrets` / `deploy` / `migrate`
  (slices 0, 4, 6, 8).
- `packages/cli/package.json` — `bin` + `postinstall` script
  (slice 3).
- Repo-level: `scripts/install.sh`, `docs-site/`, `templates/`,
  `.github/workflows/` — all new.

No public contracts change. The CLI grows new verbs; existing
verbs stay bit-compatible.

---

## 14. Testing strategy

Six tiers — same as Phase 6 plus one docs-site tier:

1. **Unit.** Every new slice 0 CLI verb gets its own `*.test.ts`.
   Template authors write per-template config tests.

2. **Integration.** Two-tenant daemon test in slice 0 exercises
   the full session / audit / metrics path. Slice 4 tests the
   wizard end-to-end against a mock LLM.

3. **Install smoke.** Slice 2's `installer-smoke.yml` spins a
   hermetic Docker container per target arch + runs
   `./install.sh && declaragent --version`. Failure on any target
   blocks the release tag.

4. **Template verify.** Slice 5's `templates-verify.yml` runs
   every template through the `init` → `verify` flow against a
   mock LLM. One config regression in any template fails the gate.

5. **Nightly Cloud Run soak.** Slice 6 deploys the `concierge`
   template to a dedicated GCP project nightly; a synthetic Slack
   ping validates the end-to-end loop. Failed deploy pages
   platform oncall.

6. **Docs-site linting.** Slice 7 runs Docusaurus' link-checker
   + a custom extractor that diff's auto-generated sections
   against the shipped source of truth (Zod schema, CLI help).

No new test-runner. Bun + Playwright (for docs e2e) cover every
tier.

---

## 15. Open questions

1. **Installer domain.** `get.declaragent.dev` requires the product
   name to be finalized (per Part 7 of the spec). Fallback:
   `get.declaragent.org` + redirect once the name lands.
   - **My lean:** unblock slice 2 with a GitHub Pages install.sh
     at `https://declaragent.github.io/install.sh`; switch to the
     vanity domain when DNS lands.

2. **Windows first-class support.** npm-global wrapper works but
   doesn't ship a native binary. Do we ship WSL-only at GA?
   - **My lean:** WSL-only at GA; document loudly. A native
     Windows binary lands post-v1.0 once `bun build --compile`
     has stable Windows support.

3. **Telemetry scope.** What's the minimum event set?
   - **My lean:** three events (`installed`, `wizard_completed`,
     `deploy_invoked`) with a random client id, no IP, no config
     contents. Opt-out documented at install time.

4. **Homebrew-core timing.** If review is slow, do we block GA on
   the formula?
   - **My lean:** no. Tap ships at day 1 of Phase 7; homebrew-core
     is a follow-up PR that can land in v1.0.1.

5. **Signing.** macOS binaries need notarization to run without
   Gatekeeper warnings. Apple Developer account + notarization
   pipeline.
   - **My lean:** ship notarized binaries from day 1. A separate
     slice-1.5 sets up the signing / notarization workflow.

6. **Template dependency locking.** Every template ships a
   `bun.lock`. Do we regenerate at install time?
   - **My lean:** ship lockfiles; `declaragent init` never
     regenerates them. Security updates flow via `declaragent
     upgrade` (post-v1.0) or a manual `bun install`.

7. **Docs-site search.** Algolia DocSearch is the industry
   default; the application process takes 2 weeks.
   - **My lean:** local search (minisearch plugin) ships at GA;
     swap for Algolia once the application clears.

8. **Cloud Run cold-start behavior.** Daemons need to stay warm
   for webhooks. Minimum instances = 1 adds a constant cost.
   - **My lean:** document it, ship it, surface the cost in the
     template README. Users running occasional workloads opt to
     use `gcloud scheduler` to keep the service warm.

9. **SemVer "additive" policy for adapters.** Can a new optional
   field on `ChannelAdapter` contract land in v1.x?
   - **My lean:** yes, and we ship a conformance test that breaks
     on a non-optional addition. Major version required for
     required-field adds.

10. **Announcement channel.** HN + Reddit + Twitter + dev.to.
    Coordinated or staggered?
    - **My lean:** HN first, within 24h of tag; Reddit + Twitter
      within 2h; dev.to within 1 day. Any failure (launch-day
      regression) triggers a written post-mortem as slice 9's
      exit artifact.

---

## 16. Risks

- **Name finalization.** Product name (`declaragent` is a working
  placeholder) blocks the installer domain + the Homebrew formula
  name. Mitigation: settle the name before slice 2 starts.
- **Single-binary size creep.** Bun's compile output has been
  trending up; 120 MB is tight. Mitigation: CI size budget with
  an explicit failure message + a per-slice `bun build --analyze`
  run.
- **Template dependency rot.** Five templates × several
  dependencies each = ten or more packages that could rot
  between tag and user install. Mitigation: nightly
  `templates-verify.yml` runs every template end-to-end; a
  broken template auto-files a regression issue.
- **Cloud Run auth flows.** `gcloud` CLI auth is user-owned; a
  user without `roles/run.admin` gets a cryptic 403. Mitigation:
  `declaragent deploy` runs a preflight that surfaces the exact
  missing IAM role.
- **npm postinstall flake.** Some networks block GitHub release
  downloads. Mitigation: `DECLARAGENT_OFFLINE=1` env var opt-out
  + a documented `declaragent install` manual command.
- **Notarization latency.** Apple's notary service occasionally
  takes hours. Mitigation: release workflow awaits notarization
  with a 2-hour timeout; a failed notary step pages the release
  manager but does not auto-retry.
- **Docusaurus churn.** Docusaurus has breaking minors. Mitigation:
  pin to `3.x` exact at GA + document the upgrade path.
- **Telemetry misuse.** A single bad commit that logs config to
  the telemetry sink is a security incident. Mitigation: a
  `no-secret-in-telemetry` property test alongside the Phase-6
  `no-secret-in-logs.test.ts`.
- **First-run LLM cost.** The verify step in slice 4 calls the
  user's provider. A user who accidentally types an invalid API
  key burns nothing; one who types a valid key burns ≤ $0.001
  per verify. Mitigation: loud + documented; verify uses the
  cheapest model available (`haiku-4.5` on Anthropic).
- **Homebrew-core reviewer pushback.** Reviewers sometimes request
  changes that conflict with our packaging conventions.
  Mitigation: tap ships day 1 regardless; core submission is
  non-blocking.

---

## 17. Acceptance check

The spec's acceptance bar:

> A new user runs `curl https://get.declaragent.dev | sh && my-agent
> init`, answers the wizard, and has an agent running on GCP Cloud
> Run in under 10 minutes. Measured, not estimated.

Practical (slice 9, measured):

1. **Fresh laptop** — a clean macOS arm64 or Ubuntu 22.04 x64 VM.
2. **Stopwatch start** — user runs
   `curl https://get.declaragent.dev | sh` (slices 1 + 2).
3. **Install complete** at ≤ 2 minutes — binary in `$PATH`,
   `declaragent --version` prints the tag.
4. **Wizard complete** at ≤ 5 minutes — provider + template picked,
   `agent.yaml` written, verify step passes (slice 4).
5. **Deploy complete** at ≤ 9 minutes — `declaragent deploy
   gcp-cloud-run && gcloud run deploy ...` emits a URL; the URL's
   `/health` endpoint returns 200 (slice 6).
6. **First message** at ≤ 10 minutes — user DMs the Slack bot
   (concierge template) and gets a reply.

We record every run in the launch rehearsal week (slice 8 soak).
Three consecutive green runs = ship.

Additional Phase-6 invariants (from `docs/runbooks/phase-6-exit-criteria.md`):
- Every slice ships a changeset.
- `release-gate.yml` stays green on every merge.
- The chaos + pen-test exit criteria from Phase 6 remain green
  throughout the slice-8 soak.

---

## 18. Next step

Slice 0 (Phase-6 tidy-up) is the unblocker. Without the session-key
migration + daemon's per-tenant branch + CLI verbs, the
`multi-tenant-starter` template has nothing to point at and
`declaragent deploy` can't write a correct `service.yaml`.

Once slice 0 lands:

- Slice 1 (release automation skeleton) unblocks every binary-
  producing path.
- Slices 3, 4, 5 parallelize — installer packaging, the wizard,
  and templates are independent once the binary is producible.
- Slice 6 (Cloud Run) depends on slice 5's templates being real
  artifacts on disk.
- Slice 7 (docs) can start any time after slice 0; it catches up
  with content generated by later slices through its auto-
  extraction pipeline.
- Slices 8 + 9 are the release train — config freeze, rc → GA,
  launch.

**First concrete PR:** `packages/core/src/session/sqlite.ts`
schema bump + the single-tenant-fallback migration, with tests
covering the upgrade path against a pre-v1.0 sqlite fixture file.
Expect ~1.5 days to land; every Phase-1-through-6 test stays
green via the `__default__` tenant path.

The launch moment (slice 9) is the product checkpoint. We do
not declare Phase 7 done until the ten-minute clock is green on
three consecutive fresh-laptop runs in the slice-8 soak.
