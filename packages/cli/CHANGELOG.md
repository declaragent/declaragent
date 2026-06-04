# @declaragent/cli

## 0.7.6

### Patch Changes

- 5fca34b: feat(rpc): 0.8.0 zero-trust preview mode — `DECLARAGENT_RPC_AUTH_DEFAULT=on` env var + `fleet audit-rpc --dry-run-with-flag` (#5b prep)

  Operators can now rehearse the 0.8.0 RPC auth default flip against their fleets 2–4 weeks before the behavioural change ships. Nothing changes by default at 0.7.6.

  - `@declaragent/core` exposes `isRpcAuthDefaultFlagOn()`, `resolveEffectiveRpcAuth()`, and a new `LoadedAgent.rpcAuthPosture: 'enabled' | 'disabled' | 'absent'` tri-state so call sites can distinguish explicit-opt-out from no-block.
  - `@declaragent/cli` pre-boot gate in `up` + `fleet run`: when `DECLARAGENT_RPC_AUTH_DEFAULT=on`, agents with peers declared but no explicit `rpc.auth.enabled` value abort boot with `AUTH_REJECTED`. Agents with `rpc.auth.enabled: false` are honoured (Path B) with a boot-time warning.
  - New `declaragent fleet audit-rpc --dry-run-with-flag` flag — non-mutating simulation of the 0.8.0 flip. Reports per-agent `would-fail`, `intentional-optout`, or `exempt (memory-only)` verdicts. Pairs with `--strict` for CI use.
  - See `docs/ZERO_TRUST_DEFAULT_MIGRATION.md` §3a for the recommended rollout. The default flip still ships at 0.8.0.

- fcfc864: feat(builder): tool_result capture + cache-token usage fields + stable RecordingProviderHandle (#36, #37, #38)

  Three post-enterprise backlog polish items land together in the builder fixture surface (`packages/cli/src/builder/**`):

  - **#36 `tool_result` block capture.** `BUILDER_RECORD=1` JSONL now persists any `tool_result` blocks observed in an assistant response under a new optional `toolResults` field on `FixtureEntry`. The replay harness merges recorded `toolResults` into the emitted `LLMResponse.content` so a future provider that surfaces tool results as first-class assistant content (or a streamed content_block event) round-trips faithfully. Forward-compat: the engine's current non-streaming `complete()` path never emits `tool_result` directly, so existing fixtures carry no `toolResults` and replay unchanged.

  - **#37 cost-regression usage fields.** `FixtureEntry.usage` grows `cacheCreationInputTokens`, `cacheReadInputTokens`, and `serverTimestamps: { firstToken, lastToken }` so prompt-cache efficiency + TTFT regressions can be asserted against recorded fixtures. New helpers `computeCacheHitRate(entries)` and `expectCacheHitRateAtLeast(fixturePath, threshold)` in `__tests__/replay-harness.ts`. New fixture `06-cache-usage-regression.jsonl` wires a 0.8-threshold assertion into the regression suite.

  - **#38 stable `RecordingProviderHandle`.** The outer handle now survives engine rebuilds (mode / model / auditSink changes). `handle.swapInnerProvider(next)` rotates the wrapped provider without recreating the observer, preserving output-path + any turn-id → fixture bookkeeping the caller has accumulated. In-flight `complete()` calls pin the pre-swap inner at call time so a mid-turn rebuild doesn't fork the transcript across two providers.

- f70c436: docs(observability): ready-made Grafana dashboard aggregating the key fleet counters (#51)

  Ships `docs/grafana/declaragent-fleet-dashboard.json` — a single importable Grafana dashboard with three rows: **MCP health** (`mcp_server_restarts_total`, `mcp_server_circuit_state`, `mcp_server_circuit_open_total`, `mcp_server_drain_duration_ms`, `mcp_server_rate_limited_total`), **Audit + SIEM** (back-pressure active + backlog*ms, adaptive batch interval + rows, export acked / failures / last_seq), and **Rate limits + dispatch** (provider + tool waits, `source_messages*\*`, `source_inflight`). Default 15m range, 30s refresh, three template variables (`server_id`/`agent`/`source`).

  Companion files:

  - `docs/grafana/README.md` — UI / HTTP-API / grafana-operator ConfigMap import flavors, Prometheus scrape config for the CLI's `127.0.0.1:9464`, panel-by-panel alert thresholds keyed to the runbook index.
  - `docs-site/docs/reference/observability.mdx` — canonical Prometheus metric index (MCP, audit, rate-limit, source, channel) with file:line source pointers, cross-linked to the dashboard.
  - `docs/grafana/dashboard.test.ts` — lightweight structural validator (JSON parse, three expected row titles, every README-promised metric referenced by at least one panel target, template-variable presence).

  Operators importing the dashboard only need `DS_PROMETHEUS` pointed at a Prometheus scraping `declaragent up`'s `/metrics` endpoint — no CLI flags added, no runtime behaviour change.

  Naming call-out: the runtime exposes `declaragent_audit_backpressure_backlog_ms` (age of oldest unshipped audit row, in ms) as the time-based analogue to the backlog-row-name `audit_export_queue_depth` referenced in earlier planning docs. The dashboard + README call this out explicitly.

- 56c7f8d: feat(durability): agents accumulate context across events (session pinning) + observable multi-step loop; PROD_parity production hardening

  **Agent durability (wired end-to-end through `declaragent up`):**

  - **Session pinning.** Inbound routes may declare an optional `sessionKey`; the dispatcher resolves-or-creates a durable session keyed by it (new `session_keys` table in the SQLite session store) and appends each event as a new turn — so a pinned agent accumulates transcript across events instead of starting fresh. Fully back-compatible: no `sessionKey` ⇒ unchanged fresh-per-event behavior.
  - **Observable multi-step loop.** The engine's up-to-50-iteration tool loop now records a `declaragent.engine.turn.iterations` histogram + `..max_iterations_hit_total` counter on the runtime's Prometheus registry (served at `/metrics`).
  - **Tunable `maxIterations`.** `agent.yaml` now parses an optional `maxIterations` (positive int) onto `AgentSpec`; engine precedence is spec > config > default (50).

  **Production hardening (PROD_parity action list):**

  - **Release pipeline (P0-1).** `release.yml` now cuts a `v<cli-version>` tag from the changesets-published version so `release-binaries.yml` fires and the npm postinstall binary download resolves; new `npm-install-e2e.yml` validates a real-registry install end-to-end.
  - **Packaging (P0-2).** Starter `templates/` now ship in the CLI tarball with a real recursive unpacker + installed-package resolution; `npm-pack-and-run.yml` exercises `init` → `fleet add --template`.
  - **Security / governance / positioning.** New `SECURITY.md` + `GOVERNANCE.md`, hardened `THREAT_MODEL.md`, honest `PEN_TEST_SIGNOFF` status banner, right-sized README + AI-authorship disclosure.
  - **Docs + status.** Historical plans archived under `docs/archive/`; new `docs/STATUS.md` (single source of truth) + `docs/COMPAT.md` (1.0 surface); CI writes `STATUS.json` + a single rolling failure tracker; CLI error messages now surface a working next action.

- c8df2a7: fix(security): clear OSV advisories blocking the release gate

  Bump four dependencies flagged by `osv-scanner` to their fixed versions:

  - `@anthropic-ai/sdk` 0.89.0 → 0.91.1 (GHSA-p7fg-763f-g4gf, core direct dep).
  - `fast-xml-builder` 1.1.4 → 1.2.0 (GHSA-5wm8-gmm8-39j9, CVSS 8.7 — transitive via `fast-xml-parser`/aws-sdk).
  - `ip-address` 10.1.0 → 10.2.0 (GHSA-v2v4-37r5-5v8g — transitive via `socks`).
  - `ws` 8.20.0 → 8.21.0 (GHSA-58qx-3vcg-4xpx — transitive via `ink`/`mqtt`).

  The three transitive bumps are pinned via a root `overrides` block. No
  public API changes.

- e17abfc: feat(control-plane): Slice 6b — `fleet dlq drop/requeue` cross-host mutations (#50 follow-up)

  Slice 3 shipped snapshot fan-out across `fleet.yaml#hosts[]` at 0.7.4. Slice 6a
  added live `fleet logs -f` multiplex at 0.7.5. This closes the remaining half
  with destructive mutations over the same control-plane transport.

  **Core:**

  - New `dlqDropRoute(store, { onAudit? })` bound at `POST /dlq/drop?kind=dispatch&id=<id>`.
  - New `dlqRequeueRoute({ store, bus }, { onAudit? })` bound at `POST /dlq/requeue?kind=dispatch&id=<id>`.
    Mirrors the semantics of the per-agent `dlq.requeue` control-socket op over HTTP.
  - New `DlqOperationAuditRecord` audit kind. Wired into the shared `TenantAuditSink` via `onAudit`
    so every operator-initiated drop/requeue leaves a hash-chained receipt with `op`, `host` (added
    by the cross-host CLI before rendering), `initiator` (from `x-declaragent-initiator`), and
    `attemptsBeforeOp`.
  - 200 on success, 404 with typed `reason` (`not-found` / `dlq-miss` / `event-miss`) for
    idempotent no-ops, 400 on missing / invalid params.

  **CLI:**

  - `CrossHostControlPlaneClient` extended with `dropDlqEntry(host, args)` + `requeueDlqEntry(host, args)`.
    Both treat 404 as a typed-miss body (no throw) so callers can distinguish fresh mutations from
    silent retries.
  - `declaragent fleet dlq drop --id <id> [--kind dispatch] [--host <name> | --all-hosts --yes] [--json]`
    and `declaragent fleet dlq requeue ...` verbs. Default is single-host; fleets with >1 host
    refuse to fan out without explicit `--host <name>` OR `--all-hosts` (which requires a
    confirmation prompt, bypassable with `--yes`). Exit codes: 0 success / 1 partial failure /
    2 ambiguous target / 3 user cancelled.
  - One-host fleets skip the ambiguity check and drop/requeue directly.

  No breaking changes. `declaragent up` binds the new routes automatically when an event store
  is available; operators using a reverse-proxy need to allow `POST /dlq/drop` and `POST /dlq/requeue`
  (same loopback-by-default / auth-by-config posture as every other control-plane endpoint).

- Updated dependencies [5fca34b]
- Updated dependencies [56c7f8d]
- Updated dependencies [c8df2a7]
- Updated dependencies [e17abfc]
  - @declaragent/core@0.5.5

## 0.7.5

### Patch Changes

- 7858f66: feat(control-plane): fleet.yaml controlPlane block + fleet logs -f live multi-host SSE

  Sprint 5 post-enterprise backlog: two deliverables on the cross-host
  control-plane surface shipped in 0.7.4 (#50).

  **#17 — `fleet.yaml`-level `controlPlane:` block.** Single source of
  truth for how every agent on a fleet's hosts exposes its control-plane
  HTTP listener. When set, the fleet-level block wins over per-agent
  `agent.yaml#controlPlane` blocks (deprecation warning on overrides).
  When absent, legacy per-agent fallback is preserved bit-for-bit —
  `up-cli` picks the first agent's block with auth enabled and warns
  about any others. Orthogonal to the `hosts[]` block (#50): `hosts[]`
  is the CLIENT-side address book the CLI fans out TO;
  `controlPlane:` is the SERVER-side config each host exposes.

  - `fleet.yaml#controlPlane` accepts the same auth discriminated
    union as `agent.yaml#controlPlane.auth`
    (`{enabled:false} | oidc | oauth2-client`), plus the
    `bindAddress` + `idleTimeout` advisory hints.
  - New `parseControlPlaneAuth` + `controlPlaneAuthSchema` exports on
    `@declaragent/core` so the fleet loader doesn't duplicate the
    discriminated-union narrowing.
  - New pure `resolveControlPlaneAuth` helper in
    `packages/cli/src/fleet-control-plane-resolver.ts` — unit-testable
    precedence logic decoupled from the `up-cli` happy path.

  **Slice 6a — `fleet logs -f` live multi-host SSE.** Follow-mode
  counterpart to the snapshot-only `fleet logs` shipped in 0.7.4.
  `tailLogsMultiHost` opens one long-lived SSE connection per
  configured host, renders each frame as `[host/agent] <text>`, and
  survives mid-stream disconnects with per-host exponential backoff
  (500ms → 30s cap). `SIGINT`/`SIGTERM` tears every socket down
  cleanly via the returned handle's `stop()`. Streams are ordered by
  arrival — no timestamp merge layer.

- 07957e2: feat(gitops): config-split ConfigMaps + Kustomize render target (#32, #33)

  - `fleet render --target k8s` gains a new `--config-split` flag (#32). When enabled, each agent's `agent.yaml` is fanned out into dedicated ConfigMaps per concern — `<agent>-channels-config`, `<agent>-sources-config` (matches `event-sources` or `sources`), `<agent>-plugins-config` — and the Deployment mounts each via `envFrom: [{configMapRef:...}]`. Operators can now rotate channel / source / plugin config via `kubectl edit configmap` without rebuilding the container image. Sections absent from the agent's `agent.yaml` are skipped (no empty ConfigMaps). The existing monolithic `<agent>-config` ConfigMap (full `agent.yaml` as one key) is preserved so the runtime's file-mount boot path still works. The fleet-wide Secret `envFrom` entry stays LAST in the composition so `${secret:...}` values deterministically override any stray config key.
  - Flag-gated, default-off at 0.7.5 so pre-0.7.5 GitOps repos render byte-identical. Helm rendering mirrors the split behind a new `.Values.configSplit.enabled` toggle — per-agent templates emit a `{{- if .Values.configSplit.enabled }}`-guarded ConfigMap doc alongside the main `agent.yaml` ConfigMap, and the Deployment's `envFrom` block picks the right combination of configMap + secret refs at chart-install time without re-rendering.
  - `fleet render --target k8s --format kustomize` (#33) adds Kustomize as a first-class packaging wrapper alongside Helm (the existing k8s default). Output layout: `base/` (Namespace + per-agent ConfigMap/Deployment/Service/ServiceMonitor resources + `base/kustomization.yaml` listing them as resources), `overlays/{dev,staging,prod}/kustomization.yaml` (each references `../../base`, applies a per-env `commonLabels` + namespace + strategic-merge patches sizing Deployment replicas + container resource limits), and a root `kustomization.yaml` pointing at `./base` so a plain `kubectl apply -k <dir>` deploys the un-overlayed baseline. Overlay defaults — dev: replicas=1 + memory 512Mi + namespace `<fleet>-dev`; staging: replicas=2 + 1Gi + namespace `<fleet>-staging`; prod: replicas=3 + 2Gi + namespace `<fleet>` (prod keeps the base namespace). Operators tune by editing the overlay in their GitOps repo.
  - The Kustomize renderer reuses the existing pure `renderK8sFromSources` output so base manifests are byte-identical to the direct k8s render — one rendering pipeline, two packaging wrappers. `--config-split` applies to the Kustomize base too.
  - CLI surface: new `--format <helm|kustomize>` flag on `fleet render`; new `--config-split` flag; default output directory for Kustomize is `./kustomize`; `--format=kustomize` on `--target helm` is rejected with a helpful error; `--json` summary includes the resolved format. Help text + auto-extracted `docs-site/docs/reference/cli.mdx` updated.
  - Snapshot goldens for k8s/helm/kustomize × default/split under `packages/cli/src/fleet-render/__snapshots__/fleet-starter-{k8s,helm,kustomize}[-config-split]/`; `packages/cli/scripts/regen-k8s-snapshot.ts` regenerates all six trees. 29 new tests across `kustomize-renderer.test.ts`, `k8s-renderer.test.ts`, `helm-renderer.test.ts`, `fleet-render-cli.test.ts`.

  Backlog: POST_ENTERPRISE_BACKLOG.md #32, #33.

- Updated dependencies [0bfc5a7]
- Updated dependencies [7858f66]
  - @declaragent/core@0.5.4

## 0.7.4

### Patch Changes

- 2375c18: feat(rpc): fleet-side per-agent auth registry (#18)

  `declaragent fleet run` now threads a distinct `AuthVerifyRegistry` per
  agent when an agent directory contains its own `rpc-peers.yaml`,
  replacing the single fleet-wide registry that collapsed when two agents
  needed to trust disjoint peer sets.

  - `StartFleetDaemonOptions.authRegistryByAgent?: ReadonlyMap<string, AuthVerifyRegistry>` —
    per-agent override map keyed by `agent.id`; agents without an entry
    fall back to the existing `authRegistry` (fleet-root), which in turn
    falls back to the legacy `internal`/`hmac` pass-through.
  - `FleetDaemon.authRegistryFor(agentId)` accessor — returns the
    effective registry the worker bound to, exposed for control-plane
    Slice 3 cross-host fan-out consumers.
  - `FleetAgentRpcContext.authRegistry` — the effective registry is also
    threaded into the handler factory so handlers (and future RPC tools)
    can evaluate auth with the same verifier the worker does.
  - CLI behaviour: `fleetRun` walks every agent at boot and loads
    `<agentPath>/rpc-peers.yaml` when present. Failures on one agent
    never poison the others — that agent falls back to the fleet-root
    registry with a warning.

  Back-compat: fleets with only a fleet-root `rpc-peers.yaml` continue
  to work unchanged.

- 0649786: feat(control-plane): Slice 3 — cross-host `fleet ps/events/dlq/logs` fan-out (#50)

  Adds `fleet.yaml#hosts[]` config block — one `{name, url, auth?: {bearer}, timeoutMs?}` entry per remote `up` process. When present, four new `declaragent fleet` verbs fan out across every host's HTTP control-plane endpoints, merge by timestamp, and tag each row with its host (and `agentId` when the host is itself multi-agent):

  - `declaragent fleet ps [--host <name>] [--json]`
  - `declaragent fleet events [...filters] [--all] [--json]`
  - `declaragent fleet dlq [...filters] [--all] [--json]` — read-only (drop/requeue still single-host)
  - `declaragent fleet logs [--host] [--agent] [--max-lines] [--json]` — snapshot-only; `-f` follow deferred to Slice 6

  Per-host bearer tokens support `env:NAME` / `file:/path` / literal strings. One host failure is isolated to a tagged trailer; survivors keep flowing. No `hosts:` block = no behaviour change.

- Updated dependencies [0649786]
- Updated dependencies [606f8c2]
- Updated dependencies [fe2a3c2]
  - @declaragent/core@0.5.3
  - @declaragent/plugin-agent-rpc@4.0.3

## 0.7.3

### Patch Changes

- aa93017: feat(rpc): `declaragent fleet audit-rpc [--suggest-enable] [--strict] [--json]` — pre-flight inspector for `rpc.auth.enabled` across every agent in the fleet

  Adds a new read-only fleet verb that walks `fleet.yaml` + each per-agent `agent.yaml` + `rpc-peers.yaml` and reports which agents have RPC envelope auth on, off, or unconfigured. Three output modes:

  - **default** — human-readable table with one line per agent and a hint to re-run with `--suggest-enable` for a copy-pasteable migration snippet.
  - `--suggest-enable` — emits the exact YAML diff operators paste into each agent's `agent.yaml` to opt in. When a matching peer entry in `rpc-peers.yaml` already specifies an auth provider, the snippet echoes that provider in a comment so the suggestion is actionable, not a stub.
  - `--strict` — exits non-zero on any agent whose `rpc.auth.enabled` is absent or false. Safe for CI pre-flight gates.
  - `--json` — structured report for programmatic consumers.

  **Scope note:** This ships Part A of `docs/POST_ENTERPRISE_BACKLOG.md` row #5. Part B (flipping the `rpc.auth.enabled: false` default to `true`) is **deferred to a 0.8.0 minor** — a behavioural-default flip in a patch would surprise consumers that don't yet configure an IdP in `rpc-peers.yaml`. Shipping the inspector first gives operators at least one release cycle to run `declaragent fleet audit-rpc --suggest-enable` in CI, close the gap in config, then pick up the default flip without a downtime surprise. Row #5 in the backlog has been split to reflect this.

- e7e487d: fleet render: ServiceMonitor splits into `agents/<id>-servicemonitor.yaml` so operators on vanilla Prometheus can delete the Prometheus Operator CRD without touching core workload manifests. Default-on preserved; `--no-servicemonitor` still opts out, and `--with-servicemonitor` is documented as the explicit positive form. (#31)

  audit sink: `TenantAuditSink` handle is now ref-counted across `up` and `fleet run`. The new `acquireTenantAuditSink({ path, owner })` / `releaseTenantAuditSink({ path, owner })` API in `audit-sink-singleton.ts` keeps same-path callers on ONE SQLite connection; the underlying sink closes only after the last owner releases. (#40)

  CI: `prod smoke — kafka source end-to-end` workflow was failing on every push-to-main because its inline `event-sources.yaml` lacked the `delivery` + `limits` blocks that the kafka source config validator has required since 0.6.x. Both blocks now supplied. (#47)

- eda26e5: control-plane: multi-agent fan-out for `/events` + `/dlq` + `/logs` via
  `?all=1`, plus `idleTimeout` narrowing so only `/logs` holds long-lived
  streams (backlog #19, #20, #21).

  - `/events` + `/dlq` accept `?all=1` when a `fanOut` provider is wired.
    Rows are merged DESC by timestamp across every hosted agent's store
    and tagged with `agentId`. Single-agent responses stay byte-identical
    to the pre-0.7.3 wire shape (no `agentId` key, back-compat).
  - `/logs` accepts `?all=1` and enforces a `fanOutLimit` soft cap
    (default 50) — returns HTTP 413 with `{error, limit, requested}` when
    the hosted-agent count exceeds the cap. Operators raise the cap via
    `logs.fanOutLimit`. Per-agent chunk emission is coalesced within a
    configurable `coalescePerAgentMs` window (CLI default 25ms) so a
    chatty agent can't saturate the SSE socket during a fan-out.
  - Fan-out scope gating: the server surfaces a synthetic
    `${path}?all=1` key to the auth middleware so operators can require
    a dedicated scope on the fan-out variant via
    `controlPlane.auth.routeScopes: { "/events?all=1": ["control:fan-out"] }`
    without tightening the single-agent floor.
  - `idleTimeout` narrowed from a global `0` (every route) to `30s`
    server-level with `server.timeout(req, 0)` applied per-request only
    for streaming routes in `STREAMING_ROUTE_PATHS` (today just `/logs`).
    Short-lived JSON routes now get idle-abort protection back.

- Updated dependencies [cfb5dbe]
- Updated dependencies [eda26e5]
  - @declaragent/plugin-agent-rpc@4.0.2
  - @declaragent/core@0.5.2

## 0.7.2

### Patch Changes

- c8e87e6: Platform sprint 2 — post-enterprise backlog items #43, #44, #45, #48, #49:

  - **#43** Memoize `loadAgent` across `fleetRun` boot. The `rpcAuthEnabled`
    probe and the LLM handler factory now share one per-path cache
    (`createMemoizedLoadAgent`), cutting agent.yaml + `skills/` reads from
    2×N to N per boot. Failed loads stay cached so the probe's `try/catch`
    does not re-read a known-bad disk path.

  - **#44** Stamp `cliVersion` onto `UpState` at boot. Previously
    `/status` read `DECLARAGENT_CLI_VERSION` from the env var on every
    scrape; now the value is written once at boot (from
    `packages/cli/src/version.ts` → `CLI_VERSION`) and read from state.
    The env var is still honoured as an override for release tooling +
    tests. The new `UpState.cliVersion` field is optional so pre-0.7.2
    state files continue to load.

  - **#45** Per-agent pid fidelity on `status.agents[]`. Added an optional
    `hostedBy: { pid, index }` field to `UpAgentStatus` that makes the
    single-process-hosts-many-agents collapsing explicit. Today every
    `hostedBy.pid` equals the daemon pid; a future out-of-process-per-
    agent topology can populate distinct pids without a schema break.

  No behavioural change for single-machine users beyond the observable
  `cliVersion` + `hostedBy` fields on `/status`.

- e44a78b: Robustness sprint 2 — shared audit-sink singleton, `up-cli` tenant wiring, in-process log rotation.

  - **#52 — Dedupe SIEM loop + `/audit` route** (`packages/cli/src/audit-sink-singleton.ts`, `up-cli.ts`):
    Module-level `getOrOpenSharedAuditSink({ path })` memoises `createSqliteAuditSink` handles by absolute path. Concurrent first-time callers share the in-flight open promise; release is idempotent and clears the cache so a subsequent `up` in the same process opens a fresh handle. `up-cli` now opens its shared audit sink through this helper, guaranteeing the `/audit` route, per-agent rate-limit gate, and SIEM export loop share one SQLite connection even if a future caller lands a second `createSqliteAuditSink` call-site on the same DB.

  - **#16 — `TenantAuditSink` threaded through `up-cli` engine path** (`up-cli.ts`):
    The `attachDispatcherToAgent` engine construction now passes `DEFAULT_TENANT_CONTEXT` explicitly so single-process deployments key `rate_limited` audit records and quota tracking on the same `tenantId` fleet-run uses. No behavioural change for existing fleets (engine previously defaulted `undefined` → `'default'` inside the loop); the explicit wiring makes the symmetry obvious and keeps downstream SIEM queries portable between `up` and `fleet run` topologies.

  - **#22 — In-process log rotation for `openAgentLog`** (`up-lifecycle.ts`):
    `openAgentLog(agentId, dir)` now returns a logger with a `rotate()` method that flushes the active stream, renames the log to `<agentId>-<ISO>.log` (colons squashed to `-` for Windows portability), and opens a fresh append-mode stream at the original path. Writes issued concurrently during rotation are buffered and drained onto the new stream — no records dropped. Complements the external-rotation inode re-check already in `logs-cli.ts`. Tests cover archive-plus-active, post-rotation tail, buffered concurrent writes, and the closed-logger guard.

- e9abb80: **Security sprint 2 follow-ups from `POST_ENTERPRISE_BACKLOG.md` — items #6 + #7.**

  - **#6 — Per-route scope overrides on the control-plane HTTP surface.** `controlPlane.auth` now accepts a `routeScopes: Record<path, string[]>` map so operators can gate `/audit` on `read:audit`, `/events` on `read:events`, etc., without weakening the global scope floor. Enforcement lives inside `applyControlPlaneAuth` and fires AFTER the verifier's own scope check, returning `reason: 'insufficient-scope'` with a detail string naming the mismatched route. Routes not listed in the map fall back to the verifier's scopes (no breaking change). New `ControlPlaneAuthContext` carries the matched route path from the server down to the middleware. One test per enforced route lives in `packages/core/src/observability/control-plane-auth.test.ts`.

  - **#7 — `allowLoopback` reverse-proxy semantics.** `controlPlane.auth.allowLoopback` now accepts `boolean | { trustedProxies: string[] }`. Scalar `true` (the default) preserves today's Host-header-based bypass — no breaking change. The object form flips on proxy-aware evaluation: the middleware inspects the immediate TCP peer (via Bun's `server.requestIP(req)`) and only promotes the leftmost `X-Forwarded-For` hop to "real client" when the peer is explicitly trusted. An untrusted peer presenting XFF headers is rejected with a new typed reason `untrusted-proxy` (401) before the verifier runs — this closes the "behind nginx every request looks like 127.0.0.1" bypass vulnerability. IPv4-mapped IPv6 peers (`::ffff:10.0.0.5`) are normalised against the trusted list so operators don't need both forms.

  CLI wiring: the startup banner prints `allowLoopback: trustedProxies=[10.0.0.5,…]` when the object form is used, and appends `, routeScopes: /audit,/events,…` when per-route overrides are configured. `buildControlPlaneAuth` in `packages/cli/src/control-plane-auth-factory.ts` propagates both fields.

  No breaking changes — both knobs are opt-in additions on top of the existing `controlPlane.auth` block.

- Updated dependencies [11c494d]
- Updated dependencies [c8e87e6]
- Updated dependencies [e9abb80]
  - @declaragent/plugin-agent-rpc@4.0.1
  - @declaragent/core@0.5.1

## 0.7.1

### Patch Changes

- 1bc842d: **Extract `packages/cli/src/control-socket-client.ts` shared helper (backlog #42).**

  The connect → call → close dance for the per-agent control socket bound by `declaragent up` was inlined across `ps-cli.ts` (silent `status` probe with ~500ms timeout + snapshot fallback) and `dlq-dispatch-cli.ts` (`dlq.requeue` with rich exit-code semantics). Slice 3 of `docs/CONTROL_PLANE_PLAN.md` adds a third caller for cross-host fleet status fan-out; before that lands, fold the duplicated pattern into one module.

  New module exposes:

  - `resolveAgentControlSocketPath` — re-export of `controlSocketPath` so every CLI caller imports one module for "talk to a control socket."
  - `withControlSocketClient(socketPath, options, fn)` — connect → invoke `fn` → always close (even on throw). Replaces the hand-rolled `try/finally` both callers duplicated.
  - `tryFetchControlSocketStatus(socketPath, options)` — the silent-probe pattern from `ps-cli`: any error collapses to `null` so the caller falls back to the on-disk `up-state.json` snapshot.
  - `unwrapOpResult(expected, response)` — typed narrowing helper that returns the response's `result` slot if the op matches and no error was set, else `null`.

  Both existing callers refactored to consume the helper. No behavior change — `ps` still falls back to snapshot on a silent timeout; `dlqDispatchRequeue` preserves its four-exit-code contract (0/1/2/3/4). Test delta: +6 focused tests in `control-socket-client.test.ts` exercising the three surfaces against a real `startControlSocket`-bound daemon.

- 2e60de4: **Security sprint follow-ups from `POST_ENTERPRISE_BACKLOG.md` — items #8 + #9.**

  - **#8 — `AUTH_REJECTED` promoted to `RPC_ERROR_CODES`.** Previously the envelope auth-reject path in `packages/cli/src/fleet-run.ts` stamped a bare `'AUTH_REJECTED'` string on the response envelope. The constant now lives on `@declaragent/core`'s canonical `RPC_ERROR_CODES` map alongside `AUTH_FAILED`, `VERSION_SKEW`, etc. The wire value is intentionally preserved (unprefixed `'AUTH_REJECTED'`) for back-compat with 3.0.0 receivers that pattern-match the literal — callers migrating should import `RPC_ERROR_CODES.AUTH_REJECTED` from `@declaragent/core`. Covered by `packages/core/src/rpc/errors.test.ts`.

  - **#9 — Capability schema-violation audit cardinality pinned per-envelope.** The emit contract on `CapabilitySchemaViolationEmitter` (in `@declaragent/plugin-agent-rpc`) + the `capability_schema_violation` audit record (in `@declaragent/core`) was already batched per envelope, but the decision was only implicit. Added explicit `POST_ENTERPRISE_BACKLOG.md #9` JSDoc + a regression test in `request-agent.test.ts` that trips 3 violations in one payload and asserts the emitter fires exactly once with all violations in the array. This caps SIEM volume under bad-actor / mass-rejection traffic — a single misconfigured envelope can trip every field in a large schema, and a per-violation emit would multiply audit rows by the schema's field count.

  No breaking changes. `@declaragent/cli` patch bump picks up the `RPC_ERROR_CODES.AUTH_REJECTED` wire swap in `fleet-run.ts`.

- Updated dependencies [1bc842d]
- Updated dependencies [8651c54]
- Updated dependencies [b69d717]
- Updated dependencies [2e60de4]
  - @declaragent/core@0.5.0
  - @declaragent/plugin-agent-rpc@4.0.0

## 0.6.0

### Minor Changes

- 8bddcc1: **Slice 1 of 0.6.0 production hardening — Prometheus `/metrics` endpoint wired into `declaragent up`.**

  `up` now constructs a shared `PrometheusRegistry` and threads it through `startAgentSources` + `startChannelRuntime` via `deps.metrics`. Every source and channel adapter that already writes to `deps.metrics` (external broker adapters, `BaseChannelInstance` counters) automatically surfaces samples through `/metrics` with no adapter changes.

  An HTTP exporter binds to `127.0.0.1:9464` (OTel convention) by default in detached mode (`up -d`). Foreground mode stays quiet unless `DECLARAGENT_METRICS_PORT` is set. Set `DECLARAGENT_METRICS_PORT=0` to disable entirely; any other valid port number overrides the default.

  Exposition format is OpenMetrics text, served by the existing `startPrometheusExporter` from `@declaragent/core/observability/prometheus`. Remote scrapes are rejected by default (localhost only) — matches the Phase-3 daemon control-socket posture.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 1 (PR 1.2; PR 1.1 shipped previously as Phase 6 slice 2).

- 8bddcc1: **Slice 2 of 0.6.0 production hardening — OpenTelemetry auto-enable.**

  `declaragent up` now auto-wires `createOtelBridge()` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No code changes, no flags — install the peer deps (`@opentelemetry/api` + an SDK + OTLP trace exporter) and set the env var. Every source and channel receives the bridged tracer via `deps.tracer`, so `BaseSourceInstance`'s `source.message` spans export to your OTLP collector.

  Fallback behavior: if the env var is set but `@opentelemetry/api` isn't installed, `up` prints a one-line warning with the exact `npm i` command and continues with the noop tracer. The boot loop never blocks on OTel.

  Metrics stay in the Prometheus registry (Slice 1) — we keep OTel for tracing only. Operators who want metrics in OTel too should run an OTel collector with the Prometheus receiver in front; the existing `OTEL_SETUP.md` §5 recipe still applies.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 2. Docs: `docs/OTEL_SETUP.md` §1.

- 8bddcc1: **Slice 3 of 0.6.0 production hardening — circuit breakers in the dispatcher.**

  ### Core (@declaragent/core)

  `createEventDispatcher` grows an optional `targetBreaker(targetName): CircuitBreaker | undefined` callback. When supplied, `target.type === 'skill'` routing consults the breaker:

  - `breaker.allow()` checked before `runSkill`. If the breaker is `open` (post-cooldown state not yet elapsed), the dispatcher short-circuits to `{ kind: 'rejected', reason: 'circuit-open', details }` without invoking the skill.
  - The call outcome is recorded via `breaker.record(success)` — success on a clean turn, failure on a thrown error. The error is re-thrown so the dispatcher's existing catch-and-map-to-`invalid` path still fires.

  `DispatchOutcome`'s rejected-reason union gains `'circuit-open'`. Existing consumers compile unchanged — the union widens, callers that exhaustively switch need to add a case (documented in the CHANGELOG).

  Scope: only `case 'skill'` is wrapped. `sub-agent` + `session` targets fall through without breaker protection. Extending breakers to those targets is a follow-up once an operator need appears.

  ### CLI (@declaragent/cli)

  `declaragent up` lazily creates one `CircuitBreaker` per skill target (10 consecutive failures → 30-s cooldown). Every transition bumps:

  - `declaragent_dispatcher_breaker_transitions_total{agent, target, from, to}` (counter)
  - `declaragent_dispatcher_breaker_state{agent, target}` gauge (0=closed / 1=half-open / 2=open)

  Both are scrapable through the `/metrics` endpoint shipped in Slice 1. Transitions also log at warn/info level through `declaragent logs <agent>` so operators don't need a Prometheus stack to notice a trip.

  `declaragent events list --state circuit-open` filters persisted events down to those whose dispatch was rejected by a breaker. Combinable with `--kind` / `--correlation`; supersedes `--outcome` when both are passed.

  ### Intentional deferrals

  - **`agent.yaml#reliability.circuitBreaker` schema** — plan called for `failureThreshold` / `cooldownMs` / `halfOpenProbes` override fields. The breakers are on by default with sane values; adding the schema is a small follow-up that doesn't block the slice's goal. Deferred to an 0.6.x patch once operators request tuning.
  - **`declaragent ps` column** — reporting live breaker state would need a runtime query surface up-state doesn't have today. Deferred alongside the Slice 5 store work that's about to add `rejected_events` anyway.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 3.

- 8bddcc1: **Slice 4 of 0.6.0 production hardening — default provider rate limits.**

  ### Core (@declaragent/core)

  New `withProviderRateLimit(provider, options)` wrapper at `packages/core/src/providers/rate-limit.ts`. Applies a token-bucket limiter before every `complete()` call (and the first chunk of a streaming call). When the bucket is empty, the call awaits the refill — no events dropped, no synthetic 429s thrown. `ProviderTokenBucket` + `defaultRateForProvider(providerId)` helpers exported alongside for users composing their own stacks.

  Published steady-state defaults:

  | Provider   | Rate (requests/sec) | Source                                       |
  | ---------- | ------------------- | -------------------------------------------- |
  | Anthropic  | 50                  | Tier-4 Opus published rate                   |
  | OpenRouter | 20                  | Conservative cap below their proxy throttles |
  | Unknown    | 10                  | Fallback — safe for a fresh key              |

  The wrapper fires an `onWait(ms)` hook when a call queues for a token. The hook must not throw; if it does, the wrapper swallows the error and still serves the call. Calling `take()` on a healthy bucket returns synchronously with `waitedMs === 0` so the happy path carries zero overhead beyond a map-lookup.

  ### CLI (@declaragent/cli)

  `declaragent up` now wraps the per-process `LLMProvider` with the new limiter using `defaultRateForProvider(creds.providerId)`. Every wait bumps:

  - `declaragent_provider_rate_limit_waits_total{provider}` (counter)
  - `declaragent_provider_rate_limit_wait_ms{provider}` (histogram)

  Scrapable through the `/metrics` endpoint from Slice 1. The startup banner prints the active rate + the env-var escape hatches so operators see the limit immediately.

  **Migration note:** existing loud-dev workloads that hammer the provider will now queue instead of burning tokens against the ratelimiter server-side. Two escape hatches:

  ```bash
  # Opt out entirely (load tests, backfills)
  export DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE=1

  # Override the rate (floating-point rps)
  export DECLARAGENT_PROVIDER_RATE_LIMIT_RPS=200
  ```

  ### Intentional deferrals

  - **`agent.yaml#reliability.rateLimits` schema** — consistent with Slices 2 + 3, the schema extension is a follow-up once operators ask. Env vars are the MVP surface.
  - **Streaming rate-limit + per-model granularity** — streams go through the same limiter (first-chunk gated), but finer-grained limits (e.g. `claude-opus-4-7` faster than `haiku`) are a future feature once we have real operator data on which models get throttled.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 4.

- 8bddcc1: **Slice 5 of 0.6.0 production hardening — dispatch DLQ with requeue ledger.**

  ### Core (@declaragent/core)

  New `rejected_events` SQLite table shipped as part of the event store schema. Narrow on purpose: event bodies stay in `events`, this overlay tracks only `event_id`, `rejection_reason`, `details`, `attempt_count`, `first_seen_ms`, `last_seen_ms`. Indexed by `rejection_reason` and `last_seen_ms` for fast admin queries.

  `EventStore` grows four methods backed by the new table:

  - `upsertRejection(eventId, reason, details, nowMs?)` — idempotent insert / update. First call creates the row with attempt=1; subsequent calls bump `attempt_count` + `last_seen_ms` while preserving `first_seen_ms`.
  - `getRejection(eventId)` — single lookup.
  - `listRejections({ reason?, sinceMs?, minAttempts?, limit? })` — newest-first enumeration with filter support.
  - `deleteRejection(eventId)` — removes the ledger row (used automatically when a subsequent dispatch of the same event id succeeds).

  Dispatcher changes: every `{ kind: 'rejected', … }` outcome now upserts a DLQ row (loop / rate-limit / target-execution errors / circuit-open / invalid). Dispatched + broadcast outcomes auto-delete any stale DLQ row for the event id so the list reflects only currently-stuck events.

  ### CLI (@declaragent/cli)

  New `declaragent dlq --kind dispatch` surface (falls back to the legacy source DLQ when `--kind` is omitted):

  | Verb                                                                                        | Description                                                                            |
  | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | `dlq list --kind dispatch [--reason <r>] [--min-attempts <n>] [--since <ms>] [--limit <n>]` | Enumerate rejected events, newest-first.                                               |
  | `dlq show --kind dispatch <eventId>`                                                        | JSON dump — rejection ledger + original event body + last outcome.                     |
  | `dlq drop --kind dispatch <eventId>`                                                        | Acknowledge / abandon. Removes the DLQ row; leaves the event + outcome history intact. |

  ### Intentional deferral — active requeue

  `dlq requeue --kind dispatch <eventId>` is **not wired** in 0.6.0. Active requeue requires a control socket on the running `up` process so the verb can publish the requeued event onto the live in-memory bus. `up` doesn't expose one today (metrics HTTP + signal-driven shutdown only). When the CLI detects `dlq requeue --kind dispatch`, it prints a clear deferral message + exit code 1.

  This is why AGENTS.md §7 "Event dispatch DLQ" flips from ❌ to 🟡 rather than ✅: the _tracking_ is complete, but the automated requeue loop is a follow-up. `dlq drop` is the current escape hatch for abandoning stuck events.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 5.

- 8bddcc1: **Slice 6 of 0.6.0 production hardening — inbound channel routing.**

  ### Core (@declaragent/core)

  New `createChannelInboundBridge({ bus, routesByChannel, logger? })` at `packages/core/src/channels/inbound-bridge.ts`. Adapter-agnostic: matches on `source.channelId` + `event.kind`, so Slack / Telegram / Discord / WhatsApp all work through the same wiring without adapter changes.

  For every session-targeted channel event that matches a configured route, the bridge publishes an additional event with `target: { type: 'skill', name: route.skill }` and `meta.causedBy` linking back to the original. The original session-target event still flows through — bridged dispatch is **additive**, not a replacement. `target.type === 'skill'` events skip the bridge (re-entry guard).

  ### CLI (@declaragent/cli)

  `channels-runtime.ts` (used by `declaragent up`) parses an optional `inbound.routes` block from each channel entry in `channels.json`:

  ```jsonc
  {
    "channels": [
      {
        "id": "slack-main",
        "type": "slack",
        "config": {
          /* … */
        },
        "inbound": {
          "routes": [
            { "event": "chat.mention", "skill": "triage" },
            { "event": "chat.dm", "skill": "chat" }
          ]
        }
      }
    ]
  }
  ```

  One bridge per up-process, shared across every configured channel. Detaches cleanly on shutdown. Malformed route entries log a warning and skip — one bad block doesn't prevent the rest of the config from loading.

  ### What unlocks

  A Slack mention → skill invocation now works end-to-end with no plugins and no custom routing code:

  1. User @mentions the bot in a Slack workspace.
  2. Slack adapter emits `chat.mention` onto the bus with `target: session`.
  3. The bridge matches the channel id + kind and publishes a skill-target copy.
  4. The dispatcher routes to the configured skill, which replies via `SendMessage` (shipped in 0.5.x).

  Same flow for Telegram, Discord, and WhatsApp — no adapter-specific deltas needed. The "PR 6.2" portion of the plan (Telegram/Discord/WhatsApp inbound) is subsumed by PR 6.1's adapter-agnostic design, shipped in a single changeset.

  ### Intentional scope cuts

  - **Inbound auth / principal pass-through** — the bridged event copies the original's `auth` + `meta.principal`, so skill-level permission checks see the right channel user. No new work needed.
  - **Fan-out across multiple channels** — not yet tested in production with 4+ active channels. The design supports it (single bridge instance, O(routes) per event), but real-world fan-out gets proven during Slice 7's fleet integration soak.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 6.

- 8bddcc1: **Slice 8 of 0.6.0 production hardening — fleet deploy canary strategy.**

  ### Core (@declaragent/core)

  `FleetDeployStrategy` union widens with `'canary'`. The manifest schema (`fleet.yaml → deploy.strategy`) accepts the new value; existing `'rolling'` / `'all-or-nothing'` / `'per-agent'` strategies are unchanged.

  ### CLI (@declaragent/cli)

  `executeDeploy` gains a `canary` branch:

  1. Deploy the first agent in the plan.
  2. Soak for `canaryWaitMs` (default 60_000).
  3. Re-run the adapter's health probe post-soak.
  4. If healthy, roll out the remaining agents one-at-a-time (same semantics as `rolling`, including per-agent health probe + cascade rollback on any failure).
  5. If the canary deploy fails OR the post-soak probe fails, roll back the canary and skip the rest.

  The post-soak probe is the key value add: a crash loop often needs a minute to manifest after startup, so re-probing after the soak catches "looked healthy at deploy time, dies seconds later" regressions that a plain rolling deploy would propagate across the whole fleet.

  CLI flags:

  ```bash
  declaragent fleet deploy --canary                    # strategy=canary, 60s soak
  declaragent fleet deploy --strategy canary           # equivalent
  declaragent fleet deploy --canary --canary-wait-ms 120000   # 2-minute soak
  ```

  New `sleep` injection on `FleetDeployDeps` + `ExecuteDeployOptions` keeps tests deterministic — the harness passes a synchronous stub so the soak window doesn't slow the suite.

  ### Tests

  Three new canary tests in `fleet-deploy-cli.test.ts`:

  - Happy path: canary deploys, soaks, re-probes, rest roll out.
  - Post-soak failure: canary survives deploy but dies during soak → rollback + skip rest.
  - Pre-soak deploy failure: canary fails immediately → no soak, no downstream deploys.

  ### Intentional deferrals

  - **`templates/fleet-starter/` docker-compose integration test** — the plan asked for a live local rollback test. The canary logic is exercised by unit tests against `MemoryDeployTarget`, and the existing `rolling`/`all-or-nothing` pattern is already covered by an integration path. A docker-compose rollback drill is follow-up infra work, better slotted with Slice 7's nightly soak.
  - **Canary traffic-splitting** — today's canary is "deploy one, wait, verify, then deploy rest" at the fleet level. True traffic-splitting (10% of requests to canary) needs target-adapter support; Cloud Run revisions do this natively, K8s needs an ingress controller, Docker Compose can't. Deferred until the `gcp-cloud-run` adapter lands.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 8.

### Patch Changes

- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
  - @declaragent/core@0.4.0
  - @declaragent/plugin-agent-rpc@3.0.0

## 0.5.21

### Patch Changes

- Fleet-run RPC reply plumbing (Bug 4 from the 0.5.x integration series).

  `createLLMHandlerFactory` built every agent's `RequestAgent` tool without a `replyTo` and without subscribing to its own responses topic. Any `mode: sync` RPC would therefore block forever: the peer's `createRespondHook` saw `envelope.replyTo === undefined` and skipped publishing the response, and even if it had published, no-one was listening on `agents.<self>.responses` to settle the caller's pending-registry. The `agent-inbox` source path used by the `fleet-starter` template happened to dodge this (it owns the subscription + pending wiring itself), but the scaffold-plus-`fleet run` pattern never worked end-to-end. A 3-agent orchestrator → classifier → reporter triage test timed out at 150s per hop until this fix.

  `fleet-run-llm-handler.ts` now computes `responsesTopic = agents.<agentId>.responses`, subscribes the shared memory transport to that topic with a handler that settles a per-agent pending-registry, and passes `replyTo: memory://<responsesTopic>` to `createRequestAgentTool`. Subscriptions live for the handler's lifetime and get torn down when the transport closes at daemon shutdown.

  Validated by `/tmp/test-0.5.2-triage-fleet.sh` — an in-process 3-agent fleet where the orchestrator reads feedback, delegates classification to a Haiku agent, delegates Markdown-report writing to a Sonnet agent, and returns in 29s (was: 150s timeout, no report produced).

  Version jumps directly from 0.5.2 → 0.5.21 at operator request.

## 0.5.2

### Patch Changes

- 130ec96: Patch 0.5.2 — three integration fixes surfaced by the fleet-test run against 0.5.1.

  - **Bug 1 — `MessageNormalizer` missing from source deps.** `startAgentSources` now constructs a shared `createMessageNormalizer()` and threads it through `SourceDependencies.normalizer` when creating every adapter instance. Before this fix, `BaseSourceInstance.handleMessage()` saw `deps.normalizer === undefined`, logged `base-source.no-normalizer`, and silently ack'd + dropped every Kafka/NATS/SQS/AMQP/MQTT message — the event never reached the store. Built-in webhook/cron/file-watch adapters don't consume `deps.normalizer`, so the change is additive.

  - **Bug 2 — compiled `declaragent` binary couldn't resolve external adapters.** `bun build --compile` produces a single-file executable whose internal resolver intercepts bare module specifiers and has no on-disk `node_modules` to walk. A dynamically-imported adapter's `import '@declaragent/core'` failed with `Cannot find module`. The npm launcher at `packages/cli/bin/declaragent.js` now prefers `bun dist/index.js` whenever `bun` is on `PATH` and the JS dist is present — that path runs against the real filesystem, so external adapters load. The compiled binary remains the fallback when Bun isn't installed. Override with `DECLARAGENT_USE_BINARY=1` to force the old path.

  - **Bug 3 — new `prod-smoke-kafka.yml` CI workflow.** `npm install @declaragent/cli@latest @declaragent/source-kafka@latest`, scaffold a one-agent Kafka-source fleet, produce a JSON message on `smoke.input`, assert the event appears in `declaragent events list` within 30s. Triggers on push to main + a 6h cron + manual dispatch. The two pre-existing smoke workflows only exercised `declaragent --version`; this one is the first lane that exercises an adapter discovery + broker round-trip against the published tarballs.

## 0.5.1

### Patch Changes

- Fix external adapter discovery regression introduced in 0.5.0. All nine shipped source + channel packages default-exported the **factory function** (`createKafkaAdapter`, `createSlackAdapter`, etc.) rather than the adapter instance, so slice 1's discovery (which did `mod.default ?? mod`) rejected them with "did not export an EventSourceAdapter" at runtime.

  **Two-sided fix**:

  - **Core** (`adapter-discovery.ts`, `channels/adapter-discovery.ts`) now resolves the export permissively: if `mod.default` is already an adapter, use it; if it's a zero-arg factory, invoke it; otherwise walk named exports looking for an adapter-shaped value, preferring one whose `.type` matches the manifest's declared type. Covers every package shape we've seen in the wild.
  - **9 adapter packages** now default-export the adapter instance (`kafkaAdapter as default`, `slackAdapter as default`, …) — semantically correct and matches what slice 1's inline fixtures always did. The factory stays as a named export for callers who need to override options.

  Regression tests: `adapter-discovery.test.ts` + `channels/adapter-discovery.test.ts` each gain a factory-default-export case that would have caught the bug pre-ship.

- Updated dependencies
  - @declaragent/core@0.3.1

## 0.5.0

### Minor Changes

- da8f330: `declaragent up` now discovers external event-source adapter packages from `<agentDir>/node_modules/@declaragent/source-*`, `<cwd>/node_modules/@declaragent/source-*`, and the user config dir. Previously only the three built-in adapters (`webhook`, `cron`, `file-watch`) were available — community adapters shipped as npm packages with `declaragent.kind: 'event-source-adapter'` in their package.json are now bound automatically.

  Built-ins take precedence on type collision. A broken adapter package is skipped with a `adapter-discovery.package-failed` warning instead of killing boot — healthy siblings still load. Two packages claiming the same type throw, because users need to see the conflict.

- 63482b1: `declaragent up` now spawns configured MCP servers at boot and exposes their tools to the agent (`mcp__<server>__<tool>`). Three-scope config with Claude-Code-style precedence: local (`<agentDir>/.declaragent/mcp.local.json`) > project (`<agentDir>/.mcp.json`, git-tracked for teams) > user (`~/.declaragent/mcp-servers.json`).

  First-run servers prompt for consent interactively; detached / CI boots skip un-consented servers with a warning instead of blocking. `mcp add` now auto-records consent for the server it installs and accepts `--scope user|project|local`. New `mcp approve <name>` / `mcp revoke <name>` verbs let operators pre-consent before a detached launch.

  Stdio transport only in this slice — HTTP/SSE/streamable lands in 2b/2c. Per-server handshake is timeboxed (10s default); a slow or broken server is soft-failed so it doesn't block the rest of the agent from booting.

- 579362c: Add HTTP transport for MCP clients. `createHTTPMCPClient` + `createHTTPConnection` in `@declaragent/core` implement plain JSON-RPC over HTTP POST — each request is one fetch, response body is the JSON-RPC reply. Custom headers from `transport.headers` are forwarded verbatim (covers static bearer-token auth; OAuth PKCE lands in slice 2d). Notifications are no-op on the client side since plain HTTP has no server→client push channel.

  `declaragent up` now dispatches on `transport.type`: `stdio` servers spawn subprocesses (unchanged), `http` servers bind a remote endpoint. This lights up hosted MCP servers configured with `{ type: 'http', url: '...' }` in any of the three scopes.

  SSE + streamable HTTP transports (needed for most 2026-era remote servers that push notifications) land in slice 2c; OAuth in 2d.

- 778f505: Add SSE (2024-11-05 spec) and streamable HTTP (2025-03-26 spec) MCP transports.

  **SSE** — `createSSEMCPClient` opens a GET `text/event-stream` to the configured URL, waits for the server's `event: endpoint` frame, then POSTs outbound JSON-RPC messages to the discovered endpoint URL. Inbound responses + notifications flow back on the SSE stream. Covers the older remote transport that many 2024-era hosted MCP servers still use.

  **Streamable HTTP** — `createStreamableHTTPMCPClient` uses a single URL for both directions. Each `request()` POSTs a message; the server responds with either `application/json` (single reply) or `text/event-stream` (one or more JSON-RPC frames bundled on the response — typically the matching reply plus any notifications the server wants to piggyback). `Mcp-Session-Id` response header is captured and echoed on subsequent requests for server-side session continuity.

  `declaragent up`'s `defaultSpawn` dispatches across all four transports (stdio, http, sse, http-streamable). `PluginMCPServerSpec.transport` now uses the full `MCPTransportConfig` union.

  Not yet implemented: session resumption via `Last-Event-Id`, dedicated server→client notification streams on streamable HTTP, OAuth PKCE auth (slice 2d).

- a4ba7a4: Add OAuth 2.1 + PKCE for remote MCP servers. Remote servers that require auth (Atlassian MCP, hosted github.com MCP, etc.) now work without users hand-crafting tokens.

  **Flow** (matches Claude Code's MCP story):

  1. `declaragent mcp login <name>` discovers the auth server via `/.well-known/oauth-protected-resource` → `/.well-known/oauth-authorization-server` (with OpenID Connect fallback).
  2. If the server advertises a `registration_endpoint`, dynamic client registration (RFC 7591) happens automatically so users don't need to hand-register an app.
  3. PKCE S256 flow against the advertised authorization endpoint with a localhost callback on ports 38700–38705.
  4. Token persisted per-server in `~/.declaragent/mcp-oauth.json` (mode 0600).

  **Runtime integration**: http / sse / http-streamable transports accept `getAuthHeader` (re-read on every request, enabling token rotation) and `onAuthError` (called on 401 to trigger refresh). `declaragent up` wires these automatically against the stored tokens. A 401 triggers a refresh_token grant; if that fails, the request propagates up so the user sees a clear error and can re-run `mcp login`.

  **New verbs**: `declaragent mcp login <name>` + `declaragent mcp logout <name>`. `oauth-pkce.ts` extracts the PKCE primitives (code_verifier, code_challenge, callback server, browser open) into a provider-agnostic module so the same code path powers future OAuth flows.

  Not yet implemented: automatic login on first-401 if no token exists (user must run `mcp login` once first), confidential clients (only `token_endpoint_auth_method: none` is supported today).

- 9a6c64f: Add `@<server>:<uri>` MCP resource references. Skills (and REPL messages) can write tokens like `@github:issue://42` and have the referenced resource fetched + inlined as a fenced block at send-time — the same shape as `@<path>` file refs.

  **Core additions**:

  - `MCPClient.readResource(uri, signal?)` — new method on every transport (stdio/http/sse/streamable) that issues the MCP `resources/read` JSON-RPC call and returns the `MCPResourceContents[]` payload.
  - `MCPResourceContents` type exported.

  **CLI additions**:

  - `MCPRuntime.getClient(serverName)` — look up a live MCP client so callers (REPL/pipeline) can expand resource refs on demand.
  - `expandAgentRefs(text, options)` — async extension of `expandFileRefs` that handles BOTH `@<path>` and `@<server>:<uri>` in one pass. Composes a single "Attached references" block at the end of the message. Unknown server → ref is reported as a miss + original text preserved. Bodies cap at `MAX_ATTACHMENT_BYTES` (256 KB), same as file refs.

  The file-ref regex now uses a negative lookahead `(?![A-Za-z0-9_./~:-])` so `@github:issue://1` is steered into the resource-ref parser instead of being truncated as a file ref at `@githu`.

  Pipeline wiring (substituting `expandAgentRefs` for `expandFileRefs` at the builder REPL send-path + the dispatcher's skill-invocation path) lands in a follow-up once the engine's turn-input hook is touched; this slice ships the library primitives + tests.

- de99d4c: `declaragent up` now brings channels online. It loads `~/.declaragent/channels.json`, discovers every `@declaragent/channel-*` adapter installed in `node_modules`, instantiates each configured channel into a shared `ChannelRegistry`, and wires the `SendMessage` tool into the engine so skills can post to Slack / Telegram / Discord / WhatsApp end-to-end without any manual plumbing.

  **What works now**:

  - `SendMessage({ kind: 'channel', channelId, conversationId, content })` delivers to the matching adapter via the registry.
  - `SendMessage({ kind: 'agent', agent, payload })` enqueues on the mailbox backed by the shared sessions db.
  - A missing `channels.json` → empty runtime; a missing adapter package → skipped with a clear banner; a broken adapter (throws on `create`) → skipped, healthy siblings still start.
  - Per-agent lifecycle: channels are torn down on `declaragent up`'s shutdown alongside sources + MCP runtimes.

  Changes: new `channels-runtime.ts` (+ test), `up-cli.ts` loads channels between sources and dispatcher attach, `buildRuntimeTools({ extra })` threads the `SendMessage` tool into the engine.

  The optional `ChannelOutboundBridge` layer that auto-forwards `assistant.final` events to the bound conversation is NOT wired in this slice — skill-driven sends via the `SendMessage` tool are sufficient for the first-principles vision. Bridge wiring can land later once the streaming / typing-indicator story is ready.

- fad5977: `declaragent up` now activates consented plugins at boot. Every entry in `~/.declaragent/plugins.json` with a `consentedAt` timestamp gets loaded via the core `loadPlugin` machinery, and its contributions merge into the per-agent runtime:

  - **Tools** — registered in the per-agent `ExtensionRegistry` and appended to the engine's tool array via `buildRuntimeTools({ extra })`, so the model can call them immediately.
  - **Skills** — registered alongside scaffold skills; the dispatcher's skill lookup sees both kinds transparently.
  - **Hooks** — subscribed to the shared `HookRegistry` that the engine now threads through `createEngine({ hookRegistry })`.
  - **MCP servers** — activated via the plugin loader's stdio spawn (HTTP/SSE/streamable plugin-contributed servers still land in a follow-up; the scope-based slice-2a loader is the primary path for remote MCP).

  An un-consented plugin (in the store but never approved) is skipped with a warning: the CLI banner prints `note: plugin "X" skipped — not consented — run \`declaragent plugin install\``. A broken plugin (missing module, activation error) is soft-failed so healthy siblings still activate. `stopAll` deactivates every plugin in reverse order alongside sources, MCP, and channels.

  New module: `packages/cli/src/plugins-runtime.ts`. `attachDispatcherToAgent` now returns `{ detach, plugins }` so the caller can track plugin lifecycle in `RunningAgent.plugins` and close it on shutdown.

- 4d120b1: `declaragent fleet run` now respects every transport kind declared in `capabilities.yaml` and wires a `RequestAgent` built-in into each agent's engine.

  **Transport dispatch**: the daemon builds a shared `transports: Map<RpcTransportKind, RpcTransport>` keyed on kind. `memory` is always present (the in-process dev loop still works). Other kinds (kafka/nats/sqs/amqp/mqtt) pull from a new `transportFactories?` option on `startFleetDaemon`. When a declared kind has no factory wired, the daemon warns + skips that kind instead of silently ignoring it — the 0.4.x behavior that made non-memory transports look supported when they weren't.

  **Per-agent RPC context**: the `makeHandler` signature expanded from `(agent)` to `(agent, rpcContext)`. The new `FleetAgentRpcContext` carries `selfAddress`, the shared `transports` map, and — when `rpc-peers.yaml` was supplied — the parsed `LoadedPeers` table. The existing single-arg handler shape remains compatible.

  **RequestAgent built-in**: when `rpc-peers.yaml` is present in the fleet root, `createLLMHandlerFactory` appends a `RequestAgent` tool to the per-agent tool list via `buildRuntimeTools({ extra })`. Skills can now call peers declaratively without any manual plugin wiring. A fresh pending-registry is constructed per handler for correlation bookkeeping.

  **`fleetRun` verb**: loads `<fleet-root>/rpc-peers.yaml` when present; warns and continues when the file exists but is malformed.

  Non-memory transport implementations (`@declaragent/plugin-agent-rpc-kafka`, etc.) are not published in this slice — the hooks let callers or a future slice plug them in.

### Patch Changes

- Updated dependencies [da8f330]
- Updated dependencies [579362c]
- Updated dependencies [778f505]
- Updated dependencies [a4ba7a4]
- Updated dependencies [9a6c64f]
  - @declaragent/core@0.3.0
  - @declaragent/plugin-agent-rpc@2.0.0

## 0.4.16

### Patch Changes

Fix self-inflicted duplicate detection. The 0.4.14 wrapper exposed the outcome — every event came back `outcome: duplicate`. Root cause: `startAgentSources` subscribed a "record every event" handler against the event store, then the dispatcher's `handleInternal` called `findDuplicate`, which does a direct `id` lookup — hitting the row the source subscriber had just written and rejecting the event as a duplicate of itself.

Fix: `startAgentSources` now takes a `recordToStore` option (default `true` for backwards compat). `declaragent up` passes `false` when it will attach a dispatcher — the dispatcher's own `handleInternal` step 2.5 owns the record call, so there's no race and no self-duplicate. Creds-less fallback (no dispatcher wired) keeps the old behavior so events still persist to the store for `events list`.

With this + 0.4.14's explicit-handle wrapper, webhook/cron/file-watch events now flow cleanly: `dispatcher.handling` → `dispatcher.outcome outcome=dispatched sessionId=…`, and `events list` shows `dispatched→<sessionId>`.

## 0.4.15

### Patch Changes

Republish of 0.4.14 — the npm registry lost the 0.4.14 tarball (metadata landed, blob 404s). No code changes vs 0.4.14; see that entry for actual behavior deltas.

## 0.4.14

### Patch Changes

Fix events stuck at `outcome: null` — dispatcher never received bus events through `dispatcher.attach(bus)`. Replaces the attach path with an explicit `bus.subscribe('*', ...)` wrapper that calls `dispatcher.handle(event)` and logs the full life cycle: `dispatcher.handling` (event arrived), `dispatcher.outcome` (dispatched/rejected/broadcast/duplicate), or `dispatcher.error` (unexpected throw). Every webhook / cron / file-watch event now produces a visible trace in the per-agent log, and outcomes persist via the dispatcher's own `markOutcome` path.

## 0.4.13

### Patch Changes

Surfaced by the fleet test showing events stuck at `outcome: null` despite the dispatcher path being wired in 0.4.11:

- **Await skill registration before dispatcher attach.** The per-agent extension registry's `register` calls were fire-and-forget (`void registry.register(...)`). If the bus published a webhook event before every skill finished registering, the dispatcher's `lookupSkill` returned `undefined` and the event sat forever with no outcome. Now awaited, then `dispatcher.attach()` subscribes — guaranteed ordering.
- **`dispatcher.attached` + `dispatcher.attach-failed` now log.** Previously the attach path was silent on success, so "event never dispatched" was impossible to tell apart from "dispatcher never attached." Per-agent log now records the attach + skill count, and any thrown error during attach lands with `level: error`.
- **`declaragent logs [-f] [<id>]` works post-`down`.** The verb used to refuse with "nothing up" when no state file was present — wrong, since log files persist across lifecycle cycles. Now falls back to listing `~/.declaragent/logs/*.log` when state is absent. Errors cleanly when the requested agent id has no log file on disk.
- **`ps` renders file-watch summaries correctly.** Previously rendered `file-watch ?` because `summariseSource` only read `cfg.dir` / `cfg.path`; the canonical adapter config uses `cfg.paths: string[]`. Now shows the first watched path with a `+N more` hint for multi-path configs.

## 0.4.12

### Patch Changes

Fix `declaragent up -d` under compiled Bun binaries. For a `bun build --compile` output, `process.argv[0]` returns the embedded interpreter name (`bun`), not the binary path — so `detachSelf` was spawning `bun up --__detached`, which Bun interprets as "run a script called `up`" and crashes with `Script not found "up"`. Swap to `process.execPath`, which for compiled binaries is the actual binary path. No other behavior changed; 0.4.11's dispatcher + observability fixes are still in place.

## 0.4.11

### Patch Changes

Event dispatch end-to-end + four bug fixes surfaced by the first 0.4.1 E2E run. The version number jumps from 0.4.1 → 0.4.11 intentionally.

**Dispatcher wired into `declaragent up` (the headline)**

`up` previously bound sources + recorded events to the store with `outcome: pending` — nothing pulled events off the bus and invoked the matching skill. Webhooks fired into the void. This release attaches core's `createEventDispatcher` to each agent's bus, builds a per-agent extension registry from the scaffolded skills, and constructs an engine bound to the user's provider + built-in tools. Events with `target: {type: skill, name: X}` now run as real LLM turns; `ps` / `events list` / the per-agent log all show the dispatched outcome. When no creds are configured the startup banner warns that dispatch is skipped but sources still bind.

**Observability + correctness fixes**

- **`kind: skill` → `type: skill` in templates.** `pr-review` and `oncall-escalator` shipped with the wrong target discriminator — `EventTarget` uses `type:`, not `kind:`. Events silently tripped a SQLite `NOT NULL` constraint on `events.target_type` and the bus subscriber's NOOP logger ate the error. Both templates fixed; `kafka-pipeline` already had it right.
- **Webhook / cron / file-watch adapters reject unknown target types at bind time.** New shared helper `assertEventTarget(target, sourceType)` in core catches the `kind`→`type` typo with a specific rewrite hint ("your config uses `kind` — replace with `type: skill`") so the next `declaragent up` fails fast instead of silently dropping every event.
- **Per-agent logger wired into `startAgentSources`.** The default `NOOP_LOGGER` used to eat `event-store.record-failed` warnings; `up` now passes a bridge that routes core's `Logger` calls into the per-agent log file. `declaragent logs <agent>` surfaces bus-level failures.
- **`up -d` detach is observable + synchronous.** Child stdout/stderr append to `~/.declaragent/up-startup.log` instead of `/dev/null`, and the parent polls the state file for up to 8s before returning. `up -d` now only prints `✓ up` once sources are actually bound; a crash mid-startup surfaces a tail of the log automatically.

**Test footprint**

5 new target-validator tests in core; 2 new `up-lifecycle` waiters. All 2166 tests pass, 0 regressions.

## 0.4.1

### Patch Changes

- 5692b12: Docker-Compose-style lifecycle verbs + `d9t` alias.

  **Four new verbs** replace the per-agent REPL path (`declaragent run <dir>`, removed) with a true multi-agent lifecycle story:

  - `declaragent up [-d|--detach] [-f <path>]` — discovers `fleet.yaml` or `agent.yaml` in the cwd (or takes `-f` explicitly), loads every agent, brings their declared in-process sources (webhook / cron / file-watch) online via the same `startAgentSources` path that `run` used to drive, and persists a state snapshot at `~/.declaragent/up-state.json`. Default is foreground with a banner + Ctrl+C shutdown; `-d` detaches via `child_process.spawn({detached: true})` and returns the child pid. Re-running `up` while something's already up gracefully stops the old process first (reload semantics).
  - `declaragent down` — sends SIGTERM to the pid recorded in `up.pid`, waits up to 5s for a clean exit, escalates to SIGKILL, and clears state. No-op + 0 exit when nothing is up.
  - `declaragent ps` — reads the state snapshot, reaps stale state if the pid is dead, and prints the bound agents + their sources with a relative-time `up since …`.
  - `declaragent logs [-f|--follow] [<agent-id>]` — tails `~/.declaragent/logs/<id>.log` (newline-delimited JSON appended by the `up` process's event subscriber). `-f` watches the files for appends via `fs.watch`.

  **`d9t` alias** both `declaragent` and `d9t` now point at the same launcher. Existing scripts keep working; the shorter name is there when you want it.

  **Removed** `declaragent run <dir>`. The skill-only REPL scope is covered by `declaragent up` for a bound, event-driven agent, and by the plain `declaragent` REPL for interactive builder work. The underlying modules (`run-agent-cli.ts`, `run-agent-sources.ts`) are still exported for downstream reuse.

## 0.4.0

### Minor Changes

- fa676a6: Complete the builder-tool matrix (Phase B of USABILITY_PLAN.md). Four new authoring tools ship in this release — `DeclaraAddSource` (per-agent `event-sources.yaml` with round-trip adapter validation for webhook/cron/file-watch), `DeclaraAddChannel` (user-global `channels.json`), `DeclaraAddMCP` (user-global `mcp-servers.json`), `DeclaraAddPlugin` (user-global `plugins.json` with consent captured via the proposal flow). Every scaffolded capability — skill, source, channel, MCP, plugin, secret, peer — is now reachable through conversational authoring; `DeclaraApplyChange` no longer returns "step kind not supported" for these four kinds.

### Patch Changes

- fa676a6: Wire `declaragent fleet run` to the real LLM engine (Phase A.2 of USABILITY_PLAN.md). Previously the multi-agent dev loop echoed every capability request via a slice-3 stub; now each scaffolded agent loads its `agent.yaml` + `skills/`, builds a per-agent extension registry, and answers RPC calls by running the matching skill against a real engine turn. Tests that want a deterministic no-LLM path keep working via `deps.makeHandler = () => defaultHandler`.
- fa676a6: REPL UX polish (Phase C / P2 of USABILITY_PLAN.md). Four conversational-flow items shipping together:

  - **Bracketed-paste support.** Multi-line pastes no longer submit after the first line. Architecture mirrors Claude Code's tokenizer: `CSI ?2004h` is enabled on mount; a parallel `process.stdin` listener runs a two-state FSM that detects `CSI 200~` / `CSI 201~` markers (spanning chunk boundaries), buffers the content, and flushes it via `setInput(prior + body)` once the end marker arrives. Ink's own pre-parser continues to route keystrokes as usual, but TextInput's `onChange` / `onSubmit` are gated on an `inPaste` flag so the embedded `\n` mid-paste never fires a submit and the first line never leaks into the controlled input. `\x1b[?2004l` is written on unmount.
  - **`/prompt <path>`** reads a file and submits its contents verbatim as the next user message. Stays useful for pastes that exceed terminal buffering, or terminals without bracketed-paste support.
  - **`@<path>` file refs** inline file contents into any user message. Supports absolute + relative + `~/` paths, deduplicates repeated tokens, truncates oversized attachments at 256KB, and surfaces per-ref hit/miss system lines so the user sees what got attached. Emails (`user@host.com`) are left alone.
  - **Y/N keypress shortcuts for pending proposals** — a bare `y` / `yes` / `n` / `no` submission is routed as `/yes` / `/no` while a proposal is outstanding. The typed flow (including `/yes <phrase>` for explicit-yes proposals and `/edit <n> <replacement>`) keeps working unchanged. A new hint line renders above the input when a proposal is pending.

## 0.3.5

### Patch Changes

- 2168cff: Wire `event-sources.yaml` into `declaragent run <dir>`.

  0.3.5 closes the second half of Phase A.1 in USABILITY_PLAN.md.
  Scaffolded agents that declare webhook, cron, or file-watch sources
  in their `event-sources.yaml` now actually bind ports / install
  timers / watch directories in-process when the REPL starts, and
  land inbound events in the session event store so
  `declaragent events list` reflects live activity.

  **New file:** `packages/cli/src/run-agent-sources.ts` exports
  `startAgentSources({ configPath, storePath?, onEvent? })`:

  - Validates the yaml via core's existing
    `validateEventSourcesConfig`.
  - Constructs a bus + event store + adapter instances directly (no
    daemon wrapper).
  - Subscribes `*` on the bus → records every emitted event to the
    SQLite store and forwards to the optional `onEvent` hook.
  - Returns `{ started, unknownTypes, validationErrors, stop() }`.
    Each `started[]` entry carries a human summary ("webhook
    /webhook/contracts", "cron 0 9 \* \* \*", "file-watch /tmp/inbox")
    the CLI prints at startup.

  **Integration in `run-agent-cli.ts`:** after `loadAgent`, the verb
  looks for `event-sources.{yaml,yml,json}` at the agent root. When
  present + `--no-sources` isn't set, it calls `startAgentSources`.
  Lifecycle is tied to `renderRepl` — the `finally` block stops every
  source after the REPL exits, no port leaks on Ctrl+D.

  **External-broker sources** (kafka / nats / sqs / amqp / mqtt) are
  surfaced as `unknownTypes` on the result. The REPL prints a hint
  that they're daemon-only; the in-process path intentionally skips
  them.

  **Tests:** +11 new across two files. Full suite: 2071 pass / 0 fail.

  **Not in scope (tracked for PR #3):**

  - Events don't auto-invoke skills yet. Today the bus records them
    - forwards to the REPL's hook; the model sees inbound events via
      `declaragent events list` but doesn't auto-react. Full
      `EventDispatcher` + skill routing lands next.
  - `declaragent daemon` still reads user-global
    `event-sources.json` — unchanged.

## 0.3.4

### Patch Changes

- 826a0bd: Fix `declaragent run` rejecting agents scaffolded by `declaragent init`.

  **The bug:** 0.3.3's agent.yaml zod schema required `model` and
  `systemPrompt`, but `declaragent init --template <name>` emits a
  slim yaml that omits both — they're expected to come from runtime
  defaults (provider-configured model; synthesised system prompt). So
  `declaragent run .` on any freshly-scaffolded agent failed validation
  before it could even start.

  **The fix:**

  - `model` and `systemPrompt` are now optional in the agent.yaml
    schema.
  - When `model` is absent from the yaml, `loadAgent` returns an
    empty string on `spec.model`. `declaragent run`'s CLI layer
    falls back to `--model` > auth-config default > provider preset
    default — same precedence as a plain `declaragent` REPL launch.
  - When `systemPrompt` is absent, `loadAgent` synthesises
    `"You are <name>, a declaragent-authored agent. Help the user.
Use your skills when they apply to the user's request."` —
    good enough to get a new agent talking; users can edit
    agent.yaml to add a real prompt.

  Only `name` remains hard-required.

  **Tests:** +3 cases covering the slim-yaml shape. 2062 pass / 0
  fail.

- Updated dependencies [826a0bd]
  - @declaragent/core@0.2.2

## 0.3.3

### Patch Changes

- c270520: Add `declaragent run <dir>` — load a scaffolded agent + drop into a REPL as that agent.

  Closes the biggest usability gap: until 0.3.3, a user could scaffold
  an agent via the builder conversationally, land the files on disk,
  and then have no first-class way to _run_ that agent. The only
  workaround was telling the builder-REPL to read the skill file and
  apply it as text — exposing the wrong mental model + the wrong
  persona.

  **`@declaragent/core`**

  - New `agents/load-agent.ts`: - `loadAgent({ agentDir })` — parses `agent.yaml` against a Zod
    schema (name / model / systemPrompt required; temperature /
    maxTokens / subagentDepthCap / skills / tools.defaults
    optional; `passthrough()` so channels / sources / plugin refs
    don't trip validation yet). - Walks `<agentDir>/skills/*.md` via the existing `loadSkills`. - Returns `{ spec: AgentSpec, skills, toolNames, agentDir,
agentYamlPath, skillConflicts }`. - `AgentConfigError` for typed failure surfaces.
  - New `composeSystemPromptWithSkills(basePrompt, skills)` —
    appends skill bodies into the prompt under an `# Available
skills` section. Simplest way to let a runtime agent _use_ its
    skills without waiting for the core skill-invocation channel
    to mature.

  **`@declaragent/cli`**

  - New `src/run-agent-cli.ts` exporting `runAgent(args, deps)`.
  - New `run` subcommand wired in `src/index.tsx`:
    - `declaragent run [<dir>]` (default `.`).
    - Respects `--model` and `--mode`.
    - Accepts `--no-sources` for forward-compat; PR #1 is skill-
      only regardless. Source-wiring lands in PR #2 once the
      daemon's per-agent model (backlog #15) is ready.
  - `src/app.tsx` — `App` accepts an optional `agentSpec` prop.
    When supplied, it overrides the builder-REPL persona used by
    every `store.create()` call (initial session, `/clear` reset,
    `createChildSession`). The builder persona remains the default
    for plain `declaragent` (no verb).

  **Tests:**

  - `load-agent.test.ts` — 9 cases covering valid load, missing
    agent.yaml, malformed yaml, schema violations, passthrough
    keys, skill-frontmatter errors, relative-path resolution, and
    empty tool defaults.
  - `run-agent-cli.test.ts` — 7 cases covering happy path, missing
    directory, missing agent.yaml, injected renderRepl (verifies
    composed system prompt), `--no-sources` semantics, sources-
    not-wired hint, and default-to-cwd behaviour.

  **Not in scope this patch:**

  - No `event-sources.yaml` wiring (declared + validated; not yet
    routed to the REPL session). Tracked as backlog #15.
  - No tool-name → `Tool` object resolution (each tool name today
    is just read from yaml and surfaced to the caller; core + CLI
    keep their own tool registries). Tracked as a follow-up.
  - No `fleet run` engine integration (backlog #16) — separate
    work.

  **Next ship:** PR #2 adds `event-sources.yaml` loading to the `run`
  verb so `declaragent run <dir>` registers the scaffolded agent's
  webhook / file-watch sources in-process and dispatches real events
  to the session.

- Updated dependencies [c270520]
  - @declaragent/core@0.2.1

## 0.3.2

### Patch Changes

- 38878e9: Fix REPL hangs when the agent-builder's propose flow blocks on user input.

  `DeclaraProposeChange.execute` intentionally awaits the user's
  `/yes` / `/no` / `/edit` via a Promise the proposal registry
  resolves — but the REPL's render path was unmounting the
  `TextInput` whenever `busy === true`, leaving no way to type the
  confirming slash command. The only escape was a double Ctrl+C
  exit; users lost the proposal and any in-progress work.

  **Render path** (`packages/cli/src/app.tsx`)

  - `TextInput` is now always mounted unless a model-picker or
    permission prompt is claiming exclusive focus.
  - When `busy`, a "…working… (Ctrl+C to abort)" status line
    renders above the input box + the border turns yellow, so the
    user sees the engine is still running but can still type.
  - Slash-suggestion + history-navigation `useInput` handlers no
    longer gate on `!busy`, so Up/Down + tab-complete work during
    a turn.

  **Ctrl+C abort** — first press now has three behaviours:

  1. Turn in flight → abort via an `AbortController` wired through
     `engine.runAgent({ abortSignal })`. The `DeclaraProposeChange`
     tool's `raceWithAbort` rejects the pending proposal so the
     engine unwinds cleanly + `busy` clears.
  2. Pending proposal with no live turn (edge case) → reject it.
  3. Nothing to abort → warn; second press within 2s exits as
     before.

  **Unmount cleanup** — the registry-listener useEffect now
  rejects any dangling pending proposals on component unmount so
  closing the REPL doesn't leak a listener or a half-resolved
  Promise.

  No API changes; patch bump.

## 0.3.0

### Minor Changes

- f374273: Agent-builder toolkit (phases 1–6 of `docs/BUILDER_PLAN.md`).

  The REPL ships an in-process builder: schema-validated, scope-
  confined, audit-tracked tools that let the user author agents + fleets
  through conversation instead of hand-rolled YAML. Every multi-file
  change flows through a propose → confirm → apply loop; rollback runs
  off a git HEAD captured before each apply.

  Loaded only when `DECLARAGENT_BUILDER=on` — production agents shipped
  as dependencies never see the toolkit.

  **Toolkit** (11 tools under `packages/cli/src/builder/`)

  - Authoring — `DeclaraAddSkill`, `DeclaraAddSecret`,
    `DeclaraFleetAdd`, `DeclaraAddPeer`, `DeclaraAuthPlaybook`.
  - Plan/apply — `DeclaraProposeChange` (awaits the user's
    `/yes`/`/no`/`/edit` + returns the resolved steps),
    `DeclaraApplyChange` (captures git HEAD, dispatches per step,
    emits audit records, marks the proposal applied with rollback
    metadata on the registry).
  - Read-only inspection — `DeclaraEventsTail`, `DeclaraFleetStatus`,
    `DeclaraAuditVerify`, `DeclaraDlqShow`.

  **Slash commands** (`src/slash-commands.ts`)

  - `/plan <description>` — ask the builder to propose. Empty-arg form
    stays as the `/mode plan` alias.
  - `/yes [<phrase>]`, `/no`, `/edit <n> <replacement>` — drive the
    proposal state machine.
  - `/diff [<path>]`, `/scope` — surface git + scope context inline.
  - `/fleet graph [mermaid|dot|json]` — inline peer-graph renderer.
  - `/undo` — revert the last apply via scoped `git checkout`.
  - `/history [<limit>]` — render recent builder actions from the
    audit chain.

  **Safety** (phases 2 + 6)

  - Pre-turn secret-leak redactor — 7 pattern detectors run before
    every user message. The original value is discarded; model only
    ever sees `<redacted:label>` markers.
  - `DeclaraAddSecret` never accepts a value — derives a placeholder
    env-var, appends a commented block to `.env.example`, returns an
    actionable hint.
  - Scope confinement — every file-writing tool checks
    `path.startsWith(scopeRoot + sep)`. Explicit breach requires
    `confirmOutsideScope: true` routed through the proposal flow.
  - Deploy deny floor — `Bash:declaragent deploy*` and
    `Bash:declaragent fleet deploy*` are bottom-of-stack `deny` rules
    in the permission gate. Users flip to `/mode bypass` intentionally.
  - Git-backed undo — `captureHead` + `revertPaths` in
    `src/builder/git.ts`. Non-git trees surface a clear "no git"
    message instead of attempting a homegrown snapshot.

  **Audit**

  Each `DeclaraApplyChange` writes one `tool_call` record per step
  (`tool: 'Declara:<stepKind>'`) plus a summary (`tool:
'DeclaraApplyChange'`), sharing a correlation id. `/history` filters
  the audit sink by the `Declara` tool-name prefix; hash-chain
  verification via `DeclaraAuditVerify` stays green because we append,
  never mutate. (The `builder.*` discriminated kind the plan envisions
  requires a core schema bump; it lands with the next core minor.)

  **Integration**

  - `packages/cli/src/app.tsx` — session-scoped `ProposalRegistry`,
    async-opened SQLite audit sink, extended `SYSTEM_PROMPT` with
    plan-confirm-execute, fleet-heuristic, monitoring, and phase-6
    deploy-gate guidance. Pre-turn `redactSecrets` hook wired in
    `handleSubmit`.
  - `packages/cli/package.json` — adds `zod` + `yaml` as direct deps
    (already transitive via core; listing here makes the manifest
    honest).
  - `packages/cli/src/fleet-add-cli.ts` — `defaultTemplatesDir`
    promoted to an export so `DeclaraFleetAdd` reuses the same walk.

  **Docs**

  - `docs-site/docs/cookbook/build-an-agent.mdx` — end-to-end
    annotated transcript for "Building a PR-review Slack bot through
    conversation."
  - `docs-site/docs/reference/builder.mdx` — tool catalog + slash
    command reference + safety-model summary.
  - Cookbook + reference index pages gain rows linking to the new
    surface.
  - `website/app.js` — hero terminal extended with a 3-line builder
    fragment (propose → `/yes` → apply).

  **Tests**

  +195 tests under `packages/cli/src/builder/` covering every tool, the
  proposal state machine (register, confirm, reject, edit, expire,
  apply, revert), secret-guard patterns + redaction, scope
  confinement (including the `/foo` vs `/foo-bar` prefix bug), git
  helpers, the fleet-add + add-peer surgical YAML append, the propose
  → apply end-to-end flow, and the phase-4 "concierge + pr-reviewer
  fleet" acceptance scenario.

  Baseline `bun test` count at v0.1.8: 1845 pass. After phase 7:
  **2042 pass / 0 fail**.

  **Deferred to v0.3+**

  - `/monitor` bottom-of-screen Ink live-tail — needs daemon-side push
    semantics first (event bus has `.subscribe()` but no push hook
    the REPL can wire into). The four read-only tools cover the
    "check state" need.
  - Multi-step `/undo` stacking.
  - Snapshot fallback for non-git projects.
  - Core-side `builder.*` audit-record discriminator.
  - `runCommand` step runner — deploys still require `/mode bypass`
    - manual invocation after the plan is confirmed.

  **Next.** Soak + tag `@declaragent/cli@v0.2.0`.

- 4309000: Fleet slice 1 — `declaragent fleet list / validate / capabilities`.

  First set of fleet-aware CLI verbs. Every verb is read-only; mutations
  (`init --fleet`, `add`, `promote`, `run`, `deploy`) land in later slices.

  - **`fleet list [--json]`** — prints the fleet name, root, and one line
    per agent (id, env, capability count or "client-only"). `--json` emits
    a structured shape suitable for scripted workflows.
  - **`fleet capabilities [--json]`** — aggregated capability table
    grouped by agent. The JSON form is keyed on `agent://<id>` and
    includes `clientOnly` so downstream tooling can differentiate agents
    that offer RPC from pure consumers.
  - **`fleet validate [--json]`** — schema + peer-graph dry-run. Surfaces:
    - `peer.dangling` (error) — a `rpc-peers.yaml` entry points at an
      agent id the fleet doesn't declare.
    - `peer.client-only` (warning) — an in-fleet peer has no
      `capabilities.yaml`; callers will fault at request time.
    - `capability.duplicate` (warning) — the same capability name is
      declared by >1 agent.
    - `deploy.target.missing` (error) — an agent deploys to a target
      that isn't in `deploy.targets{}`.
      Non-zero exit on any `error` severity finding.

  Each verb walks up from cwd via `findFleetRoot`, so it works from
  anywhere inside a fleet tree. Outside a fleet it errors with a hint at
  `declaragent init --fleet <name>`.

  **Tests.** 13 new tests in `packages/cli/src/fleet-cli.test.ts`, each
  driven off a real tmpdir-backed fixture fleet.

  **Next.** Slice 2 — `init --fleet` scaffolder + `fleet add --template`.

- 4309000: Fleet slice 2 — `declaragent init --fleet` + `declaragent fleet add`.

  First mutating verbs in the fleet family. Turns the slice-0 manifest
  schema + slice-1 read-only verbs into a usable bootstrap loop:

  ```
  declaragent init --fleet my-fleet          # or: declaragent fleet new my-fleet
  cd my-fleet
  declaragent fleet add --template rpc-client --id concierge
  declaragent fleet add --template rpc-server --id pr-reviewer
  declaragent fleet validate                 # ✓ fleet validates clean
  ```

  **Schema.** `fleet.yaml.agents` is now `z.array(...)` (was `.min(1)`) so
  a freshly-scaffolded empty fleet loads cleanly. `fleet validate` will
  flag empty fleets as informational in a later slice; slice 2 leaves
  them as-is since an empty scaffold is the expected zero-step state.

  **`packages/cli/src/fleet-scaffold.ts`** — pure scaffolding helpers,
  fully tested against tmpdir fixtures:

  - `scaffoldFleet({root, name, force?})` writes `fleet.yaml`,
    `package.json` (with `"workspaces": ["agents/*"]`), `.gitignore`,
    `.env.example`, `rpc-peers.yaml` stub, `README.md`, and
    `agents/.gitkeep`. Refuses to overwrite `fleet.yaml` or
    `package.json` unless `force: true`.
  - `addAgentFromTemplate({fleetRoot, template, templatesDir, id?, force?})`
    walks the template tree into `agents/<id>/`, rewrites `agent.yaml`'s
    `name:` + `capabilities.yaml`'s `agent: agent://<id>` so the §14.4
    invariant holds, then surgically appends the new entry to
    `fleet.yaml` (preserves surrounding comments + formatting).
  - `addAgentFromPath({fleetRoot, sourceDir, id?})` — same as above for
    an external single-agent directory. Copy semantics; the move/promote
    flow is slice 4.

  **`packages/cli/src/fleet-init-cli.ts` + `fleet-add-cli.ts`** — thin
  wrappers that handle arg parsing, error reporting, and (for `add`)
  walking up from cwd via `findFleetRoot`. Both default their templates
  directory to the repo's `templates/` but accept an explicit
  `templatesDir` so tests + future packaged-template deploys can inject
  their own.

  **`packages/cli/src/index.tsx`** — new verb router entries:

  - `declaragent fleet new <name> [--out <dir>] [--force]`
  - `declaragent fleet add --template <name> [--id <id>] [--force]`
  - `declaragent fleet add --path <dir> [--id <id>] [--force]`
  - `declaragent init --fleet <name>` — shortcut that routes into the
    same `fleetInit` handler.

  **Tests.** 25 new tests across `fleet-scaffold.test.ts`,
  `fleet-init-cli.test.ts`, `fleet-add-cli.test.ts`, plus a one-shot
  `fleet-e2e.test.ts` that runs `fleet new` → `fleet add` ×2 →
  `fleet list` → `fleet capabilities` → `fleet validate` end-to-end,
  satisfying FLEET_PLAN.md §16 acceptance check #1 for slice 2's scope.

  **Next.** Slice 3 — `fleet run` single-daemon multi-agent dev loop.

- 4309000: Fleet slice 3 — `declaragent fleet run`.

  Single-process multi-agent dev loop. Boots one memory bus + one worker
  per agent, wires each agent's `capabilities.yaml → memory` transport
  onto the shared bus, and dispatches incoming requests to a pluggable
  handler. Inter-agent RPC round-trips in one process — no broker needed.

  ```bash
  declaragent fleet run                 # every agent
  declaragent fleet run --agent pr-reviewer --agent concierge   # subset
  ```

  **`packages/cli/src/fleet-run.ts`**

  - `startFleetDaemon({fleet, bus?, makeHandler?})` — test-driveable
    entry point. Returns a `FleetDaemon` with `agents` (per-worker
    metrics + topics), `bus`, `shutdown()`, `waitForShutdown()`. Partial
    boot failures stop the workers that did start before re-throwing so
    callers don't need cleanup logic in their error paths.
  - `FleetAgentHandler` — per-agent request handler signature. The slice-3
    **defaultHandler** echoes `{ agent, capability, echoed: payload }`
    back to the caller so wiring is observable without an LLM provider.
    Slice 3.5 will plug the engine loop behind `makeHandler`.
  - `fleetRun(args, deps)` — CLI verb. Loads the fleet (with
    `findFleetRoot` discovery), filters to `--agent` subset when
    supplied, prints the ready line, and installs `SIGINT`/`SIGTERM`
    handlers that call `daemon.shutdown()`.

  **Transport scope.** Only `memory` transports are wired in this slice.
  Agents whose `capabilities.yaml` declares a `kafka` / `nats` / `sqs`
  / `amqp` / `mqtt` transport are loaded cleanly (they surface in
  `fleet list` + `fleet capabilities`) but the dev loop silently skips
  them — production fleets wire those via their existing source adapters.

  **CLI integration.** Added `fleet run` verb; help text updated.
  `packages/cli/package.json` adds a `workspace:*` dep on
  `@declaragent/plugin-agent-rpc` for the memory bus + respond hook.

  **Tests.** 10 new tests in `fleet-run.test.ts` covering:

  - per-worker subscription wiring (memory topics + client-only agents).
  - full end-to-end RPC round-trip (concierge → pr-reviewer → response)
    via the actual `RequestAgent` producer tool + a shared bus.
  - `makeHandler` override.
  - handler exception → `HANDLER_ERROR` RPC response.
  - clean shutdown unsubscribes from the bus.
  - CLI verb's error paths (no fleet, empty fleet, no matching `--agent`).

  **Not in scope for slice 3 (tracked for a follow-up):**

  - File-watch hot reload per agent (§9 slice-3 bullet 4).
  - Engine-loop integration — agents respond via the default echo stub.
  - Per-agent `event-sources.yaml` wiring (the broader Phase-3 daemon is
    not yet hosted here; each agent's sources + dispatcher will land
    once `makeHandler` ties into the engine).
  - Non-memory transports.

  **Next.** Slices 4 / 5 / 6 parallelize — `fleet promote`, `fleet deploy`,
  `fleet graph`/`fleet peers`.

- 4309000: Fleet slice 4 — `declaragent fleet promote` + `declaragent fleet demote`.

  Turns an existing single-agent directory into a fleet-of-one (and
  back). Dry-run is the default; `--apply` mutates. Demote is strictly
  the inverse and refuses for fleets with N > 1 agent (per FLEET_PLAN.md
  §14.10).

  ```bash
  declaragent fleet promote ./my-agent              # preview the plan
  declaragent fleet promote ./my-agent --apply      # mutate
  declaragent fleet promote ./my-agent --apply --id reviewer
  declaragent fleet demote                          # fleet-of-one → single agent
  ```

  **`packages/cli/src/fleet-promote-cli.ts`** — new verb helpers:

  - `fleetPromote({path, dryRun, apply, force, id?}, deps)` — detects the
    target (refuses when `<path>` already has `fleet.yaml` or is missing
    `agent.yaml`), builds a step-by-step mv/rewrite plan, and either
    prints it (`dryRun`, default) or executes it (`apply`). Apply moves
    per-agent files under `agents/<id>/`, rewrites the moved
    `agent.yaml` + `capabilities.yaml` to reflect the id, writes a
    fleet-of-one `fleet.yaml`, updates root `package.json` to add
    `"workspaces": ["agents/*"]` (preserves `name`, `dependencies`,
    `scripts`), and drops a `PROMOTED.md` note at the fleet root.
  - `fleetDemote({id, force}, deps)` — inverse of promote. Walks up from
    `cwd` via `findFleetRoot` (or accepts an explicit `fleetRoot`), moves
    every child of `agents/<id>/` back to the fleet root, deletes
    `fleet.yaml` + `PROMOTED.md`, strips the `workspaces` field from the
    root `package.json`. Refuses when the fleet has more than one agent.
  - Re-exports `FleetPromoteIO`, `FleetPromoteArgs`, `FleetPromoteDeps`,
    `FleetDemoteArgs`, `FleetDemoteDeps` for the CLI router + tests.

  **Moved into `agents/<id>/`:** `agent.yaml`, `capabilities.yaml`,
  `event-sources.yaml`, `rpc-peers.yaml`, `channels.yaml`, `tenants.yaml`,
  `secrets.yaml`, `skills/`, every root-level `*.md` (except
  `PROMOTED.md` itself).

  **Stay at the fleet root:** `.env`, `.env.example`, `.gitignore`,
  `bun.lock`, `package.json` (rewritten).

  **Warned about but never rewritten:** `Dockerfile`, `deploy*.yaml`,
  `cloud-run*.yaml`, and every `.github/workflows/*.yml` file — per
  FLEET_PLAN.md §7.1 these often reference paths we're moving and the
  user has to decide whether to rewrite them.

  **Tests.** 18 new tests in `fleet-promote-cli.test.ts`, all against
  tmpdir fixtures, covering:

  - dry-run prints a plan without touching disk (+ mentions per-agent
    files + shared-root exceptions).
  - `--dry-run` + `--apply` together errors.
  - apply produces the expected tree (agents/<id>/ + fleet.yaml +
    PROMOTED.md + package.json workspaces).
  - apply prints a success banner with `fleet validate` + `fleet run`
    hints.
  - refuses when source already has `fleet.yaml`.
  - refuses when source has no `agent.yaml`.
  - refuses when source path does not exist.
  - refuses a malformed agent id.
  - custom `--id` rewrites `agent.yaml → name` and (when present)
    `capabilities.yaml → agent: agent://<id>`.
  - existing `package.json` is rewritten (adds workspaces, preserves
    name + deps + scripts).
  - creates a minimal `package.json` when none exists.
  - warns on Dockerfile + deploy YAML + `.github/workflows/*.yml`
    without rewriting them.
  - demote reverses promote cleanly — post-demote tree is equivalent to
    pre-promote (byte-for-byte agent-file contents, minus PROMOTED.md).
  - demote refuses when fleet has >1 agent.
  - demote refuses when `--id` does not match the sole fleet member.
  - demote errors when no `fleet.yaml` is found.

  **Not in scope for slice 4 (tracked for a follow-up):**

  - Git-dirty refusal + `--force` wiring. `force` is accepted on the
    args shape so the CLI router can pass it through, but slice 4 leans
    on the dry-run-first flow as the primary safety net.
  - Cross-repo promote (moving an external dir in + promoting in one
    step). Users do this today via `fleet add --path` then `fleet promote`
    on the resulting layout if needed.
  - Revert-on-validation-failure (§7 step 5). Today's apply is
    straight-line; users run `fleet validate` explicitly post-promote.

  **Next.** Slices 5 + 6 parallelize — `fleet deploy` + `fleet graph` /
  `fleet peers`.

- 4309000: Fleet slice 5 — `declaragent fleet deploy` (rolling + per-agent,
  with rollback history).

  Coordinated multi-agent deploys driven by the manifest's
  `deploy.strategy`. Rolling (default) walks agents sequentially and
  rolls back every agent deployed so far on failure; all-or-nothing
  deploys in parallel and rolls back all on any failure; per-agent
  fires without coordination. Every deploy stamps a fleet version
  (`v${pkg.version}-${gitSha.slice(0,7)}`, or `v0.0.0-nosha` fallback)
  and appends a record to `<root>/.declaragent/fleet-deploys.jsonl`.
  `--rollback` reads the history and re-invokes the previous
  successful deploy's target set.

  ```bash
  declaragent fleet deploy                       # rolling, every agent
  declaragent fleet deploy --target cloud-run    # override per-agent target
  declaragent fleet deploy --agent concierge     # subset
  declaragent fleet deploy --dry-run             # print plan, write nothing
  declaragent fleet deploy --rollback            # re-run previous version
  declaragent fleet deploy --json                # machine-readable output
  ```

  **`packages/cli/src/fleet-deploy-cli.ts`** — pure helpers + CLI wrapper:

  - `FleetDeployTarget` — adapter interface: `kind`, `deploy`, optional
    `healthCheck`, optional `rollback`. `DeployContext` carries the
    loaded fleet, fleet version, resolved target config, and an IO
    logger. `DeployOutcome` is a tagged `{ok: true, artifact} | {ok:
false, error}`.
  - `createMemoryDeployTarget({failFor?})` — hermetic in-memory target
    used by every test. Records deploy + rollback order, exposes a
    per-agent health flag tests can flip to simulate probe failure.
  - `planDeploy(fleet, opts)` — pure ordering pass. Walks manifest
    agents in order, applies `agents` subset + `targetOverride` +
    `extraTargets`, validates target keys resolve.
  - `executeDeploy(plan, targets, opts)` — runs the plan per strategy
    and returns `{ok, deployed, failed?, rolledBack, outcomes}`.
  - `readDeployHistory` / `appendDeployRecord` — newline-delimited
    JSON at `.declaragent/fleet-deploys.jsonl`.
  - `computeFleetVersion(root, fs)` — derives the version from
    `package.json` + `.git/HEAD` (follows `ref:`), with `v0.0.0-nosha`
    fallback.
  - `fleetDeploy(args, deps)` — top-level CLI verb. Loads fleet,
    builds plan, executes (unless `--dry-run`), appends history.
    `--rollback` reverses the most recent `deployed` record.

  **Scope cut.** A real `createGcpCloudRunTarget()` adapter (Docker
  build + `gcloud run deploy` shell-outs) lands in a follow-up PR once
  that surface solidifies. Slice 5 ships the `memory` adapter only;
  production deploys wire their own adapters via
  `FleetDeployDeps.targets` / `targetFactory`.

  **Tests.** 20+ new tests in `fleet-deploy-cli.test.ts`: plan
  ordering + subset filter, rolling rollback, all-or-nothing rollback,
  per-agent no-coordination, history jsonl round-trip,
  `computeFleetVersion` resolution paths, CLI verb error + `--dry-run`

  - `--target` override + `--json` + `--rollback`.

  **Next.** Slice 6 — `fleet graph` + `fleet peers [--verify]`.

- 4309000: Fleet slice 6 — `declaragent fleet graph` + `declaragent fleet peers [--verify]`.

  Two read-only verbs that surface the aggregated inter-agent RPC
  topology. Slot into the slice-1 read-only verb family; neither boots a
  daemon.

  ```bash
  declaragent fleet graph                    # mermaid (default)
  declaragent fleet graph --format=dot       # graphviz
  declaragent fleet graph --format=json      # structured edges for CI
  declaragent fleet peers                    # print aggregated rpc-peers.yaml
  declaragent fleet peers --verify           # + reachability check
  declaragent fleet peers --verify --json    # machine-readable report
  ```

  **`packages/cli/src/fleet-graph-cli.ts`**

  - `buildGraph(fleet): GraphModel` — pure, test-friendly transform from a
    `LoadedFleet` into `{ nodes, edges }`. Nodes per agent (plus any
    external peer the fleet talks to), edges from every potential caller
    to each peer target tagged with transport kind + single-capability
    label when the callee declares exactly one.
  - `renderMermaid` / `renderDot` / `renderJson` — format emitters.
    Mermaid edges are color-coded per transport (memory=blue, kafka=red,
    nats=green, sqs=amber, amqp=violet, mqtt=pink) via `linkStyle`.
  - `fleetGraph(args, deps)` — CLI verb. Default format is mermaid.

  **`packages/cli/src/fleet-peers-cli.ts`**

  - `buildPeersReport(fleet, {verify})` — pure transform. Classifies each
    peer + transport as `reachable`, `unreachable`, `external`, or
    `not-yet-probed`. Memory peers verify by checking that the named
    agent declares matching capabilities on the expected topic;
    non-memory peers are deferred to a follow-up slice with live broker
    wiring. External peers are informational only.
  - `fleetPeers(args, deps)` — CLI verb. Prints grouped sections
    (reachable / not-yet-probed / unreachable / external). `--verify`
    makes the verb exit non-zero on any in-fleet peer that fails to
    resolve (dangling id or missing matching memory transport). `--json`
    emits a machine-readable report keyed the same way.

  **Tests.** 19 new tests across `fleet-graph-cli.test.ts` and
  `fleet-peers-cli.test.ts` covering `buildGraph` shape, mermaid / dot /
  json emitter well-formedness, verb exit codes, `--verify` behavior on
  dangling vs external peers, and `--json` parse shape.

  **Not in scope for slice 6.** Live broker probing (kafka, nats, sqs,
  amqp, mqtt) — slice 7 extends `fleet peers --verify` once broker
  adapters ship. Caller annotations on peers are still the slice-6
  approximation: every in-fleet agent is a potential caller of any peer
  target. A later slice replaces the approximation with explicit caller
  manifests once `capabilities.yaml` grows a `calls:` block.

  **Next.** Slice 7 all-or-nothing deploys + version-skew wiring.

- 4309000: Fleet slice 7 — all-or-nothing deploy polish + version-skew wiring.

  Closes the RPC + deploy loop for FLEET_PLAN.md §8.2 / §8.3 / §14.8 —
  fleets can now detect and optionally reject callers running an older
  code version than the receiver will accept.

  **`@declaragent/core`**

  New module `packages/core/src/fleet/version-skew.ts`:

  - `FLEET_VERSION_HEADER` — constant `'x-fleet-version'`.
  - `FLEET_VERSION_ENV` — constant `'DECLARAGENT_FLEET_VERSION'`.
  - `parseFleetVersion(raw)` → parses `vMAJOR.MINOR.PATCH-sha` or
    returns undefined.
  - `compareFleetVersions(a, b)` → `-1 | 0 | 1` over `(major, minor, patch)`
    (sha is informational and ignored — a rolling deploy mid-flip doesn't
    spuriously register skew).
  - `stampFleetVersionHeader(envelope, version)` — non-mutating clone that
    adds `x-fleet-version` to `headers`.
  - `readFleetVersionHeader(envelope)` — extractor.
  - `checkFleetVersionSkew({callerVersion, selfVersion, minFleetVersion?})`
    → `{status: 'match' | 'older-caller' | 'newer-caller' | 'rejected' | 'unknown', caller?, self?, message?}`.
    `minFleetVersion` is a hard gate: caller below it returns `rejected`
    regardless of self's version.
  - `injectFleetVersionEnv(env, version)` / `readFleetVersionFromEnv(env)`
    — env-var helpers for deploy adapters.

  Also: `RPC_ERROR_CODES.VERSION_SKEW = 'EVERSION_SKEW'` — the code
  receivers return when rejecting a too-old caller (§14.8).

  **`@declaragent/plugin-agent-rpc`**

  - `createRequestAgentTool({...fleetVersion?})` — new **opt-in** option.
    When supplied, every outbound request envelope carries
    `headers: { 'x-fleet-version': <value> }`. Omit to leave envelopes
    unstamped (the default — §14.8 says the stamp is opt-in per
    `fleet.yaml → rpc.stampFleetVersion: true`).

  **`@declaragent/cli`**

  - `startFleetDaemon({...selfFleetVersion?})` — new option lets tests
    inject the receiver's version without touching ambient env.
    Production callers let it default to
    `readFleetVersionFromEnv(process.env)`.
  - `fleet-run` workers now consult `fleet.manifest.rpc.minFleetVersion`
    - the caller's `x-fleet-version` header on every request:
    * `match` / `older-caller` / `unknown` → proceed silently.
    * `newer-caller` → process the request + increment `versionSkewNewer`
      - log `fleet.version.skew agent=… caller=… self=…`.
    * `rejected` → respond with `{ok: false, error: {code: 'EVERSION_SKEW'}}`
      - increment `versionRejected` + log `fleet.version.skew.reject`.
  - `FleetAgentWorkerMetrics` gains `versionRejected` + `versionSkewNewer`.
  - `fleet-deploy-cli.DeployContext` gains `injectedEnv:
Record<string, string>` containing `DECLARAGENT_FLEET_VERSION` (§8.2).
    The in-memory deploy target records the env map per agent on
    `envForAgent` so tests can assert the contract.

  **Out of scope for slice 7 (noted):** `fleet status --history` already
  lists deploy records (slice 5); a Prometheus `fleet.version.skew`
  histogram is a follow-up — slice 7 emits the signal via the stdio
  logger until the metrics registry wire-up lands.

  **Tests.** 27 new: 23 `version-skew.test.ts` units (parse/compare/stamp/
  read/check/env), 3 `fleet-run.test.ts` integration (reject older,
  accept newer with metric, unstamped passes through), 1 `fleet-deploy-
cli.test.ts` assertion that `DECLARAGENT_FLEET_VERSION` flows into
  adapter env.

  **Next.** Slice 8 — `fleet status` + live health.

- 4309000: Fleet slice 8 — `declaragent fleet status`.

  Composes slice 0 / 5 / 6 primitives into a single read-only snapshot of
  a fleet's health: per-agent config files, capability summary, peer
  reachability, and an optional deploy-history tail. Satisfies
  FLEET_PLAN.md §16 acceptance check #7.

  ```bash
  declaragent fleet status                # static snapshot
  declaragent fleet status --history      # + last 5 deploys
  declaragent fleet status --history --limit 20 --json
  ```

  **`packages/cli/src/fleet-status-cli.ts`**

  - `buildFleetStatus(fleet, options)` — pure, fs-injectable builder.
    Returns:
    - `fleet: { name, root, selfVersion? }` — name + absolute root +
      resolved `DECLARAGENT_FLEET_VERSION` (from env override by default).
    - `agents[]` — `{id, env, capabilities[], files: {agentYaml, capabilitiesYaml, eventSourcesYaml, skills}, deployTarget?, lastDeploy?}`.
      `lastDeploy` is the newest record in `.declaragent/fleet-deploys.jsonl`
      that touched that agent (preserving ok / error / artifact).
    - `peers` — slice-6 `FleetPeersReport` verbatim.
    - `history?` — present when `options.history` is set; newest-first,
      capped at `historyLimit` (default 5 per §16 check #7).
  - `fleetStatus(args, deps)` — CLI verb. Accepts `--history`, `--limit N`,
    `--json`. Human renderer groups agents + peers + history with
    coloured-neutral tags (`✓ ✗ ℹ ?`).

  **CLI wiring.** `declaragent fleet status [--history] [--limit <n>] [--json]`
  routed through `runFleetSubcommand`; help text updated.

  **Tests.** 13 new in `fleet-status-cli.test.ts`:

  - builder: file discovery, capability summary, peer mirror, history
    flag + limit ordering, last-deploy-per-agent merging across records,
    `selfVersion` override.
  - CLI verb: human output shape, `--json` parses, `--history` includes
    tail, error paths (no fleet / broken manifest), env var + explicit
    `selfVersion` precedence.

  **Deliberately out of scope for slice 8 (noted in the file header):**
  Live daemon introspection (attach to a running `fleet run`, pull
  `source.health()` + channel health) is slice 8.1. Today's output is a
  static config + history snapshot; the `--json` shape is stable so
  dashboards can consume now and pick up live fields later.

  **Next.** Slice 9 — `fleet-starter` template.

- 4309000: Phase 7 slice 0.3: `declaragent tenants / audit / secrets` CLI verbs.

  Third of the Phase-6 carry-over PRs. The multi-tenant + audit + secrets
  primitives are now driveable from a terminal without writing a script.
  Every verb ships a `--json` flag for scripted workflows.

  **`declaragent tenants …`**

  - `list [--json]` — summary of every tenant declared in `tenants.yaml`
    (strategy + id + displayName + residency + quota count).
  - `show <id> [--json]` — full context for one tenant: quotas, labels,
    extension allow/deny, secret scopes.
  - `diff [--json]` — parses the local config and reports the tenants that
    would be loaded. Live-vs-disk drift surfacing needs a daemon
    control-plane method and is tracked for slice 0.5.

  **`declaragent audit …`**

  - `query [--tenant X] [--kind Y] [--since ms] [--until ms] [--limit N]
[--json]` — runs `TenantAuditSink.query` against the default sqlite
    sink at `${configDir}/audit.db`.
  - `verify [--tenant X] [--json]` — runs chain-verify; exit 0 on
    `ok: true`, 1 on violations (with the first 10 violation messages on
    stderr).
  - `erase --user <platformUserId> [--reason R] [--json]` — wraps
    `erasePlatformUser`. Prints the tombstone count.
  - `prune --tenant <id> --retention-days <N> [--json]` — wraps
    `TenantAuditSink.prune`.

  **`declaragent secrets …`**

  - `list [--provider <name>] [--json]` — prints providers declared in
    `secrets.yaml`. Enumerating individual refs per provider needs a
    provider-surface change and is tracked for slice 0.5.
  - `describe <ref> [--json]` — splits the ref into `(provider, path)`,
    calls `provider.metadata()` when available, prints version / TTL /
    last-rotated. Providers without metadata support surface a clear
    "not supported" line.
  - `rotate <ref> [--tenant X] [--reason R] [--json]` — verifies provider
    reachability via one `resolve()` call, then writes a `secret_access`
    audit record (`outcome: 'resolved'`). Real rotation stays
    provider-owned (Vault / AWS-SM rotate themselves); the CLI traces the
    moment in the audit chain.

  **Paths**

  - `tenantsConfigPath()` → `${configDir}/tenants.yaml`
  - `secretsConfigPath()` → `${configDir}/secrets.yaml`
  - `auditDbPath()` → `${configDir}/audit.db`

  **Tests**

  - `tenants-cli.test.ts` — 9 tests covering list/show/diff happy paths +
    one error per verb (missing config, unknown id, loader throws).
  - `audit-cli.test.ts` — 8 tests covering query (unfiltered + filtered +
    missing DB), verify (intact chain + violations), erase (channel
    records + sink-open error), and prune (retention window).
  - `secrets-cli.test.ts` — 8 tests covering list (human + JSON +
    unknown provider error), describe (metadata + no-metadata +
    unknown provider), and rotate (audit entry + resolve-fail abort).

  **Remaining slice 0:** 0.4 — per-tenant Prometheus `constLabels`
  auto-stamping in the daemon's metrics exporter.

- 4309000: Phase 7 slice 8: config freeze + `declaragent migrate`.

  - **`declaragent migrate` verb** (`packages/cli/src/migrate-cli.ts`).
    Walks pre-v1.0 configs forward. Dry-run by default; `--apply`
    writes. Every migration is idempotent. Covers three surfaces:
    - **`agent.yaml`** — stamps `schemaVersion: 1` when absent; bumps
      `0` / `"0.9"` / legacy pre-v1.0 markers up to `1`. Leaves
      unknown future versions (>= 2) untouched.
    - **`tenants.yaml`** — advises only. When multi-tenant hints
      exist on disk but no `tenants.yaml` is present, prints a
      pointer to `declaragent tenants diff` + hand-authoring.
      Never writes a tenant topology automatically.
    - **`sessions.db`** — read-only pre-flight that confirms the
      Phase-7-slice-0.1 on-open migration will add the `tenant_id`
      column and backfill the default tenant on next daemon/CLI
      open.
  - **Pure transforms** exported from
    `packages/cli/src/migrate-transforms.ts` for reuse + tests:
    `migrateAgentYaml`, `migrateTenantsYaml`, `migrateSessionSchema`.
  - **Frozen surfaces — `@since 1.0.0` JSDoc tags** added to every
    public type the spec pins: `AgentSpec`, `SessionHandle`,
    `SessionLedger`, `TurnStatus`, `ToolContext`, `Tool`,
    `PendingToolCall`, `CompletedToolCall`, `ToolError`, `ToolEvent`,
    `TenantContext`, `TenantQuotas`, `TenantResidency`,
    `AgentEvent`, `AgentEventMeta`, `EventKind`,
    `SourceDependencies`, `EventSourceAdapter`, `ChannelAdapter`,
    `ChannelDependencies`, `TenantAuditRecord`,
    `TenantAuditRecordKind`, `TenantAuditSink`, `PluginManifest`.
  - **Conformance test**
    (`packages/core/src/conformance.test.ts`). Minimal-surface
    fixtures assert `satisfies ChannelAdapter<unknown>` /
    `EventSourceAdapter<unknown>` — a new required field on either
    contract refuses to compile.
  - **`docs/VERSIONING.md`** documents the v1.0 stability contract
    and the release cadence.

### Patch Changes

- 4309000: Fleet slice 10 — docs-site `reference/fleet` + `cookbook/fleet-starter`.

  First public documentation of the v1.2 fleet surface. Two new pages
  wired into the sidebar + linked from the reference + cookbook indices.

  **`docs-site/docs/reference/fleet.mdx`**

  - When to use a fleet vs keep the single-agent layout.
  - Directory layout + promote/demote invariant.
  - Full `fleet.yaml` v1 schema with per-section field tables
    (top-level, agent entry, environments, deploy strategies).
  - Config precedence order (per-agent → env override → fleet-root →
    defaults).
  - Every CLI verb in one table (new / add / promote / demote / run /
    deploy / list / validate / capabilities / graph / peers / status).
  - Promote + demote walkthrough, "when NOT to promote", and the risks
    the flow flags (CI workflow paths, Dockerfiles, published npm).
  - Version skew decision matrix (match / older / newer / rejected)
    with the `EVERSION_SKEW` error code.
  - The ten §14 design decisions as a lookup table.
  - Mermaid sequence diagram for the rolling deploy health-gate +
    rollback flow.

  **`docs-site/docs/cookbook/fleet-starter.mdx`**

  - End-to-end walkthrough of the `templates/fleet-starter/` template
    (scaffold → validate → explore → run → deploy → day-two ops).
  - Single-process dev loop via `fleet run`.
  - Cross-process swap to Kafka (memory → kafka in `rpc-peers.yaml` +
    `capabilities.yaml`).
  - Opt-in version-skew wiring.
  - Cost estimate table per agent + deployed.

  **Sidebar + index wiring**

  - `sidebars.ts` — `reference/fleet` added after `reference/rpc`;
    `cookbook/fleet-starter` added to the Templates sub-category.
  - `reference/index.mdx` gains a table row linking to the new page.
  - `cookbook/index.mdx` gains a table row for `fleet-starter`.

  **Verification.** `cd docs-site && bun run build` — static build
  completes cleanly; no new warnings beyond the pre-existing
  `vscode-languageserver-types` notice that ships with Docusaurus.

  **Next.** Slice 11 — soak + release candidate.

- 4309000: Fleet slice 9 — `templates/fleet-starter/` + verifier recursion.

  First fleet template ships the full §9 reference: a two-agent fleet
  pairing **concierge** (RPC producer, Haiku 4.5) with **pr-reviewer**
  (RPC consumer, Sonnet 4.6). Completes FLEET_PLAN.md §16 acceptance
  check #1 for the `fleet new` + `fleet add` bootstrap loop — the
  `--template fleet-starter` path now produces a working fleet without a
  single further edit.

  **New under `templates/fleet-starter/`**

  ```
  fleet.yaml               # 2 agents + shared env + rolling deploy + optional RPC knobs
  package.json             # bun workspaces + fleet:* scripts + core/plugin-agent-rpc pins
  rpc-peers.yaml           # fleet-level peer table (memory default, kafka commented)
  .env.example             # ANTHROPIC_API_KEY + KAFKA_BROKERS (opt)
  .gitignore
  README.md                # dev + cross-process + deploy + cost sections
  agents/concierge/        # agent.yaml + event-sources.yaml + skills/delegate.md
  agents/pr-reviewer/      # agent.yaml + capabilities.yaml + event-sources.yaml + skills/review-pr.md
  ```

  **`scripts/verify-templates.ts` extension**

  - Detects a fleet template by presence of a top-level `fleet.yaml`.
  - Parses the manifest, walks every `agents[].path` as a nested
    single-agent template (`verifyAgentDirectory(nestedInFleet: true)`).
  - Threads the fleet-root `.env.example` keys through so fleet members
    don't need their own `.env.example` / `README.md`.
  - Enforces the §14.4 invariant (`fleet.yaml → agents[].id ==
agent.yaml.name`) as a verification failure, not a runtime surprise.

  `bun run scripts/verify-templates.ts` now verifies 8 templates (was 7).

  **Tests.** 3 integration tests in `fleet-starter-template.test.ts`:
  shape assertions, `loadFleet` + `aggregateCapabilities` round-trip
  against a tmpdir copy of the template, and a full `startFleetDaemon`
  RPC round-trip (concierge → pr-reviewer → response).

  **Next.** Slice 10 — docs-site `docs/reference/fleet.mdx` +
  `cookbook/fleet.mdx`.

- 4309000: Phase 7 slice 2: `curl`-bash installer.

  `declaragent` now ships a one-command install path. Ops teams can run
  `curl -sSL https://get.declaragent.dev | sh` on a clean laptop and
  land a working binary in under two minutes.

  - **`scripts/install.sh`**. Portable `/bin/sh` installer. Detects OS

    - arch (`linux-{x64,arm64}` / `darwin-{x64,arm64}`), fetches the
      tarball + `.sha256` from GitHub releases, verifies the hash, and
      extracts into `$HOME/.local/bin/declaragent` (override via
      `DECLARAGENT_PREFIX`). Environment knobs:

    * `DECLARAGENT_VERSION` — pin to a tag (default `latest`).
    * `DECLARAGENT_PREFIX` — install prefix (default `$HOME/.local`).
    * `DECLARAGENT_BASE_URL` — release base URL (used by the CI smoke
      test; defaults to the GitHub release origin).
    * `DECLARAGENT_NO_CHECKSUM` — explicit escape hatch, never advised.
    * `HTTPS_PROXY` — honored transparently via `curl` / `wget`.
      Exits non-zero on checksum mismatch (`1`), unsupported OS/arch
      (`2`), or any download / extraction failure (`1`).
      macOS 14+'s `com.apple.provenance` xattr (Gatekeeper kill) is
      stripped at install time so the extracted binary runs immediately
      until the slice-1.5 notarization pipeline lands.

  - **`declaragent --version` / `-v`**. New CLI flag that prints
    `declaragent <version>` + exits 0. Reuses the existing
    `@declaragent/core` `VERSION` constant — both packages version in
    lockstep via changesets, so the source of truth stays single.

  - **`.github/workflows/installer-smoke.yml`**. Three jobs:
    - `shellcheck` — lints `install.sh` (`-s sh`) and `build-binary.sh`
      (`-s bash`). Catches bashisms sneaking into the POSIX script.
    - `install` — hermetic end-to-end: builds a `linux-x64` tarball via
      `scripts/build-binary.sh`, serves it with a local
      `python3 -m http.server`, runs `install.sh` against it, and
      asserts `declaragent --version` prints `declaragent X.Y.Z`.
    - `checksum-mismatch` — corrupts the `.sha256` file and verifies
      `install.sh` refuses to install.

  **Locally validated.** Ran the installer end-to-end against a
  darwin-arm64 tarball served from `python3 -m http.server`:

  - Happy path: download → sha256 verify → extract → install.
    Prints a PATH-export hint when the prefix isn't on `$PATH`.
  - Checksum mismatch: aborts cleanly with non-zero exit + no
    binary written to the prefix.
  - Unsupported arch: exits 2 with the fix hint
    (`Windows users: install via npm`).

  **Still open (slice 1.5 + 3).**

  - macOS binaries are not yet notarized. The `xattr -cr` hack keeps
    slice-2 local installs working on modern macOS; the real fix is
    `codesign` + `notarytool` in the release pipeline.
  - The `declaragent.dev` / `get.declaragent.dev` domain isn't live
    yet. Until then, installers served from the GitHub release origin
    still work via `curl -sSL <raw-install.sh-url> | sh`.

- 4309000: Phase 7 slice 3: npm + Homebrew packaging.

  `@declaragent/cli` now ships via both canonical paths. Users on
  ubuntu / macos-13 / macos-14 can `npm install -g @declaragent/cli`
  (or `brew install declaragent/tap/declaragent`, once the tap repo is
  live) and land the same single-file binary the curl-installer writes.

  - **npm postinstall shim** (`packages/cli/bin/postinstall.js`). Pure
    Node (no deps). Detects `(process.platform, process.arch)` and maps
    to `linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64`,
    mirroring `scripts/install.sh`. Downloads the tarball + `.sha256`
    from the matching GitHub release, verifies the hash, and extracts
    the binary into `bin/declaragent-binary/declaragent` inside the
    installed npm package. Strips the `com.apple.provenance` xattr on
    macOS so Gatekeeper doesn't SIGKILL the binary on first run.

  - **Node launcher** (`packages/cli/bin/declaragent.js`). Registered
    as the `bin` entry. Exec's the downloaded binary, forwarding argv,
    stdio, and env. Prints a one-line recovery hint if the postinstall
    was skipped (e.g. `DECLARAGENT_NO_POSTINSTALL=1` or a sandboxed
    install blocked the network).

  - **Opt-outs** (documented in `packages/cli/bin/README.md`):

    - `DECLARAGENT_NO_POSTINSTALL=1` — skip the download; `npm install`
      still succeeds so air-gapped installs can bring their own binary.
    - `DECLARAGENT_BASE_URL=<url>` — override the release origin.
      Accepts `file://<dir>` for mirrors + the CI smoke test.
    - `DECLARAGENT_VERSION=vX.Y.Z` — pin a specific tag.
    - Windows: prints a "run under WSL2" hint and exits 0 (never fails
      `npm install`).

  - **Homebrew formula stamper** (`scripts/stamp-homebrew-formula.sh`).
    POSIX `/bin/sh`, `shellcheck -s sh` clean, idempotent. Takes
    `--version` + the four per-target SHA-256 flags, validates each
    hash is a 64-char hex digest, and writes a stamped copy of
    `homebrew-tap/Formula/declaragent.rb`. Uses `awk` (not `sed`) for
    the literal `{{TOKEN}}` swap to dodge BSD/GNU delimiter quirks.

  - **`release-binaries.yml` stamp-homebrew job**. New tail job on the
    tag-triggered pipeline: downloads the SHA-256 artifacts, extracts
    the first-column hash from each, calls the stamper, validates the
    output with `ruby -c`, and uploads the stamped formula as a
    `homebrew-formula` artifact. The PR-open step against
    `declaragent/homebrew-tap` is stubbed until that repo + its deploy
    token exist.

  - **`.github/workflows/npm-install-smoke.yml`**. Two jobs:
    - `npm-install` — matrix on ubuntu-latest / macos-13 / macos-14.
      Each runner compiles its own target via `build-binary.sh`,
      stages a release-layout tree, `npm pack`s the CLI, sets
      `DECLARAGENT_BASE_URL=file://<stage>`, `npm install -g`s the
      tarball, and asserts `declaragent --version` prints
      `declaragent X.Y.Z`. Uses a user-writable `npm config set prefix`
      to avoid `sudo`.
    - `stamp-formula` — runs shellcheck + the stamper against fixture
      hashes, asserts no `{{...}}` placeholders remain, `ruby -c`s the
      output, and re-runs the stamper to verify byte-for-byte idempotency.

  **Notes.**

  - `packages/cli/package.json` now pinpoints `"bin": { "declaragent":
"./bin/declaragent.js" }` instead of `./dist/index.js`. The old
    entry point is still valid for the `bun run dev` path; `dist/` is
    still published in `files` for programmatic importers.
  - Locally validated `bun run typecheck`, `bun test`, `bun run lint`,
    `bun run build`, `/bin/sh -n scripts/stamp-homebrew-formula.sh`,
    and `npm pack --dry-run` (confirmed `bin/postinstall.js` +
    `bin/declaragent.js` are included, 1520 existing tests still pass).

- 4309000: Phase 7 slice 4: `declaragent init` wizard.

  First-run flow built on the existing Ink + `ink-text-input` stack. Walks the
  user through telemetry opt-out → provider pick → (optional) tenant id →
  template pick → config write → verify in under three minutes. Targets `./`
  by default, `-o <dir>` for an explicit path, `--force` to overwrite an
  existing `agent.yaml`, `--multi-tenant` to scaffold `tenants.yaml` alongside.

  - **`packages/cli/src/init-wizard.tsx`** — orchestrator + Ink components.
    Exports `runInit(options, deps?)` that returns `0 | 1` so the top-level
    `index.tsx` routes cleanly. When both `--provider` and `--template` are
    passed, runs fully non-interactive. Missing flags without a
    `launchInteractive` dep exit 1 with a fix hint (the real interactive
    launcher lands when the Ink flow is wired end-to-end — the orchestrator
    already accepts it via DI).

  - **`packages/cli/src/init-template-unpacker.ts`** — pure
    `unpackTemplate(opts, fs)` that writes `agent.yaml` + `.env.example` +
    `README.md` (and `tenants.yaml` when `multiTenant`). Idempotency guard
    checks every target before the first write and aborts unless `force`.
    Template bodies are stubbed; the five template names match the slice-5
    roster (`concierge`, `oncall-escalator`, `pr-review`, `kafka-pipeline`,
    `multi-tenant-starter`). TODO marker points at `templates/<name>/` for
    the real packs.

  - **`packages/cli/src/init-paths.ts`** — `initializedMarkerPath()` +
    `telemetryOptOutPath()` helpers anchored on `configDir()`. The marker
    lands after a successful run; the telemetry opt-out is a pure-file
    sentinel (no network writes — slice 8's job).

  - **`packages/cli/src/index.tsx`** — new `runInitSubcommand` that parses
    `--out / -o`, `--force`, `--multi-tenant`, `--template`, `--provider`,
    `--tenant-id`, `--skip-verify`, and `--help`. Help block grew one line
    under the `secrets` entry.

  - **Verify step.** One `hello` turn against the resolved provider. Anthropic
    routes through `createAnthropicProvider`; every OpenAI-compat preset goes
    through `createOpenAICompatProvider`. Injectable via `deps.verify` or
    `deps.makeVerifyProvider` for tests. Errors are classified: `401` →
    `auth login` hint; network/timeout → `HTTPS_PROXY` hint; else → the
    `--skip-verify` escape.

  - **Tests.** `init-wizard.test.ts` covers the non-interactive path,
    `--force` overwrite guard, `--multi-tenant` toggle, verify success +
    failure paths (injected provider + injected verify hook), and the
    interactive-gate fallback. Uses the same captured-IO + injected-FS
    pattern as `tenants-cli.test.ts` — no Ink is mounted.

  **Not yet landed.**

  - `templates/<name>/` real packs (slice 5's territory).
  - Full interactive Ink orchestration that chains auth → tenant id →
    template pick → verify inside one render; slice 4 ships the Ink
    components + the non-interactive orchestrator and the `launchInteractive`
    DI seam, but the end-to-end chaining needs the auth flows to yield a
    continuation token rather than exiting their Ink instance — tracked for
    a slice 4.5 polish pass.
  - Telemetry upload side of the opt-out sentinel — slice 8.

- 4309000: Phase 7 slices 6 + 8 — CLI dispatch wiring.

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

- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
  - @declaragent/core@0.2.0
  - @declaragent/plugin-agent-rpc@1.0.0
