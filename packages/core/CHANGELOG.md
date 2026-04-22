# @declaragent/core

## 0.3.1

### Patch Changes

- Fix external adapter discovery regression introduced in 0.5.0. All nine shipped source + channel packages default-exported the **factory function** (`createKafkaAdapter`, `createSlackAdapter`, etc.) rather than the adapter instance, so slice 1's discovery (which did `mod.default ?? mod`) rejected them with "did not export an EventSourceAdapter" at runtime.

  **Two-sided fix**:

  - **Core** (`adapter-discovery.ts`, `channels/adapter-discovery.ts`) now resolves the export permissively: if `mod.default` is already an adapter, use it; if it's a zero-arg factory, invoke it; otherwise walk named exports looking for an adapter-shaped value, preferring one whose `.type` matches the manifest's declared type. Covers every package shape we've seen in the wild.
  - **9 adapter packages** now default-export the adapter instance (`kafkaAdapter as default`, `slackAdapter as default`, …) — semantically correct and matches what slice 1's inline fixtures always did. The factory stays as a named export for callers who need to override options.

  Regression tests: `adapter-discovery.test.ts` + `channels/adapter-discovery.test.ts` each gain a factory-default-export case that would have caught the bug pre-ship.

## 0.3.0

### Minor Changes

- da8f330: Add `onPackageError` option to `discoverAdapters`. When supplied, per-package load failures (bad import, agent_compat mismatch, malformed export) invoke the callback instead of aborting discovery, letting callers keep booting with the healthy adapters. Duplicate-type claims across packages still throw — those are correctness issues, not package-health issues. Omitting the hook preserves the strict throw-on-first-error behavior.
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

## 0.2.2

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

## 0.2.1

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

## 0.2.0

### Minor Changes

- 4309000: Fleet slice 0 — `fleet.yaml` v1 manifest schema + loader.

  First concrete PR from `docs/FLEET_PLAN.md`. Adds the v1.2 multi-agent
  monorepo primitive: one git-versioned manifest declaring N agents, their
  environments, shared config references (tenants / peers / secrets /
  channels), and deploy targets.

  **New under `packages/core/src/fleet/`**

  - `manifest-schema.ts` — Zod schema frozen at v1.2, `@since 1.2.0`.
    Strict-mode on every object; unknown keys fail load. Deploy target
    configs are `passthrough` so per-target adapters (slice 5) can validate
    their own fields without modifying this schema.
  - `manifest-loader.ts` — `loadFleet({root})` + `findFleetRoot(cwd)`.
    Flattens `environments[].inherit:` chains (cycles rejected), resolves
    every agent path to absolute, and enforces the §14.4 invariant
    (`fleet.yaml → agents[].id == agents/<id>/agent.yaml.name`). Loads
    per-agent `capabilities.yaml` plus the first env's `peersRef`; tenants /
    secrets / channels land in later slices when consumers need them.
  - `aggregator.ts` — `aggregateCapabilities(fleet)` builds the fleet-wide
    capability table that drives `fleet capabilities` + `fleet graph`.
    `aggregatePeers(fleet)` classifies every `rpc-peers.yaml` entry as
    in-fleet, dangling, or external — the slice-1 `fleet validate` verb
    promotes danglings to errors.
  - `types.ts` + `index.ts` — `LoadedFleet`, `LoadedAgentEntry`,
    `LoadedEnvironment`, `FleetConfigError`.

  **Back-compat.** Single-agent layouts are untouched. `findFleetRoot`
  returns `undefined` when no `fleet.yaml` is found walking up — callers
  fall back to today's single-agent mode.

  **Tests.** 33 new tests across schema, loader, and aggregator. Fixture
  fleets live in per-test temp directories.

  **Next.** Slice 1 — read-only CLI verbs (`fleet list`, `fleet validate`,
  `fleet capabilities`).

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

- 4309000: Phase 6 slice 1: tenancy primitives. New `TenantContext`, `TenantRuntime`, `TenantBoundaryError`, `DEFAULT_TENANT_CONTEXT`, and `stampTenantId` exports land under `@declaragent/core`. `SourceDependencies`, `ChannelDependencies`, and `ToolContext` grow an optional `tenant?: TenantContext` field; when set, `BaseSourceInstance`, `BaseChannelInstance`, the engine's `turn.started` / `assistant.message` / `assistant.final` emits, and the built-in webhook / cron / file-watch adapters auto-stamp `event.meta.tenantId`. Fully backward-compatible: every Phase-1-through-5 caller keeps working under the implicit default tenant.
- 4309000: Phase 6 slice 2: observability maturation.

  - **Prometheus exposition**. New `createPrometheusRegistry()` +
    `startPrometheusExporter()` in `@declaragent/core`. Registry is a
    stateful `MetricsRegistry` that retains per-(metric, label-set) state
    so scrapes produce a point-in-time snapshot. Exporter binds a Bun
    HTTP server (default `127.0.0.1:9464/metrics`) with localhost-only
    gating. Metric-name normalization maps dotted internal identifiers
    (`source.messages.processed`) to Prometheus-valid wire names
    (`source_messages_processed`).
  - **Alert rule files**. `packages/testkit/alerts/` ships six rule
    documents (channels, event-sources, whatsapp-windows, security,
    chaos-assertions, daemon) keyed on metrics emitted by Phase-4 and -5.
    Every alert includes `severity`, `summary`, `description`, and
    `runbook_url` — locked in by a new `packages/testkit/test/alerts.test.ts`.
  - **Runbooks**. 23 operator runbooks under `docs/runbooks/` following
    the §4.4 Symptom → Cause → Mitigation → RCA → Post-incident template.
  - **Correlation-id audit**. `ToolContext` grows an optional
    `correlationId` field; the engine threads `input.causedBy` through.
    The Agent tool now inherits the parent's correlation id on sub-agent
    spawn instead of re-rooting on the parent session id.
  - Wires `yaml` (2.8.3) as a runtime dep of `@declaragent/testkit`.

- 4309000: Phase 6 slice 3: secret providers + rotation audit.

  - **SecretProvider contract** (`packages/core/src/secrets/types.ts`) — typed
    `resolve()` / `metadata()` / `close()` with `SecretResolveContext`
    (tenant + requester) and a `SecretAccessAuditRecord` that never
    carries the secret value.
  - **Four fetch-based providers**, no peer deps:
    - **Vault** — token + AppRole auth, KV v1/v2 support, `#field` fragment
      selector, lease-aware TTL cache.
    - **AWS Secrets Manager** — inline SigV4 signing (Web Crypto HMAC),
      env-based credential chain, JSON `#field` extraction.
    - **GCP Secret Manager** — bearer-token flow with metadata-server
      fallback, version pinning via `/versions/N`.
    - **Kubernetes Secrets** — in-cluster SA token, base64-decoded fields,
      cached per Secret so multi-field reads are one HTTP call.
    - Plus an env-backed provider for local dev.
  - **Resolver integration** — `createDefaultSecretResolver` grows a
    `providers: SecretProvider[]` option; typed refs (`vault:`, `aws-sm:`,
    `gcp-sm:`, `k8s:`) route to the matching provider; `secret:` falls
    back to `defaultProviderType`. Every resolve emits a
    `secret_access` audit record (outcome: `resolved` / `denied` /
    `error`) with the ref + requester but NEVER the value.
  - **`secrets.yaml` config loader** with Zod validation, `${env:...}`
    expansion, and a rotation-monitor knob block.
  - **Rotation monitor** — periodic `metadata()` poll flags secrets past
    `warnAfterDays` / `errorAfterDays`. Never resolves values.
  - **Property test** — 500 random secrets across the resolve + denied
    paths, asserting no value appears in audit records or log lines.

- 4309000: Phase 6 slice 4: HMAC + webhook + dep-scan security hardening.

  - **Discord Ed25519 verification**. Replaces the stub-warn in
    `channel-discord` with real `crypto.subtle.verify('Ed25519', ...)`
    over `timestamp + body`. A new `transport.publicKey` config field
    carries the application's hex-encoded Ed25519 public key. Unsigned or
    tampered webhooks return a sanitized 401 `unauthorized`. Webhook mode
    REFUSES to process any request when `publicKey` isn't configured.
  - **Webhook endpoint hardening** (`createWebhookAdapter`):
    - `maxBodyBytes` cap enforced BEFORE auth (1 MiB default), returning
      413 both on pre-read Content-Length and post-read byte length.
    - HMAC auth grows `timestampHeader` + `replayWindowSec` (5-minute
      default) — requests outside the window are rejected even with a
      valid signature.
    - Sanitized 400/401 bodies — parse details land in the audit log, not
      the response.
  - **HMAC audit + property tests**. Line-by-line walk of every
    signature-comparison site in core + channel adapters confirms
    `timingSafeEqual` is the sole primitive. ~1500 assertions across
    `packages/core/src/events/sources/hmac-properties.test.ts` cover
    length mismatches, prefix / suffix attacks, symmetry, and avalanche.
    A static anti-pattern guard fails CI if any file regresses to
    `===` / `startsWith` HMAC comparisons.
  - **CI dep scanning**. New workflows:
    - `.github/workflows/deps-scan.yml` — `osv-scanner` against `bun.lock`
      on every PR + nightly. `.osv-ignore.yml` entries must carry
      `expires` + `reason`; CI rejects expired entries or missing fields.
    - `.github/workflows/npm-audit.yml` — `bun pm audit --audit-level=high`
      for double-coverage.

- 4309000: Phase 6 slice 5: audit sink unification + tamper-evidence.

  - **Unified record union**. `TenantAuditRecord` in
    `packages/core/src/audit/types.ts` folds in `tool_call` (Phase 1),
    `channel_event` / `channel_tool_call` / `channel_outbound` (Phase 5),
    `secret_access` (Phase 6 slice 3), plus new `tenant_boundary_violation`
    and `quota_exceeded` kinds. Each record carries a `tenantId` for the
    partitioned sink.
  - **Sqlite-backed sink** (`createSqliteAuditSink`). Single append-only
    table with monotonic `seq`, per-tenant + per-kind indexes, and a
    chained SHA-256 (`record_hash = SHA-256(prevHash \n canonicalize(record))`).
    Canonicalization deep-sorts keys so the chain is deterministic even
    after a round-trip through JSON.parse.
  - **Chain-verify**. `verifyEntries(...)` walks any iterable of
    `StoredAuditEntry` and detects `hash-mismatch` / `prev-hash-mismatch`
    violations at the seq that first broke. Consumable standalone (CLIs,
    JSON exports) as well as via `sink.verify(tenantId?)`.
  - **Right-to-erasure**. `erase()` replaces matching records with
    `{ kind: 'erased', ... }` tombstones while leaving the stored
    `recordHash` untouched — chain-verify stays green. Convenience
    helpers: `erasePlatformUser`, `eraseBySession`, `eraseByCorrelation`.
  - **Retention prune**. `sink.prune({ tenantId, retentionDays })`
    deletes rows older than the tenant's retention window.
  - **Tests**. Round-trip every record kind; two tamper vectors (flip a
    byte in `record_json`, overwrite `prev_hash`) — both surface the
    expected `seq`; erasure leaves a tombstone + keeps the chain
    verifiable; retention prune is tenant-scoped.

- 4309000: Phase 6 slice 6: multi-tenant runtime primitives.

  - **`tenants.yaml` loader** (`loadTenantsConfig`). Zod-validated config
    with `version` / `strategy.bus` (per-tenant or shared-with-filter) /
    `tenants[]` entries carrying `id`, `displayName`, `residency`,
    `auditRetentionDays`, `quotas`, `labels`, `extensions.allow/deny`,
    and `secretScopes`. Env expansion runs through the bootstrap
    secret resolver; duplicate ids + invalid id patterns are rejected.
  - **EventBus tenant scope**. `createEventBus` grows `tenantScope` +
    `filterSubscribersByTenant` options. Publishes with a mismatched
    `meta.tenantId` throw `TenantBoundaryError`; missing ids are
    stamped automatically. Shared-bus + per-tenant-bus strategies share
    the same test suite.
  - **Registry scoping** (`scopeRegistry`). Returns an
    `ExtensionRegistryView` that filters the global registry by a
    tenant's `{ allow, deny }` globs. Deny always wins. Uses the Phase-1
    permission-gate glob matcher.
  - **TenantRuntime assembler** (`createTenantRuntime` /
    `createDefaultTenantRuntime`). Binds `TenantContext` + `EventBus` +
    scoped registry view + quota tracker + optional audit sink. The
    default-tenant variant preserves Phase-1-through-5 behaviour
    bit-for-bit.
  - **Quota tracker** (`createQuotaTracker`). In-memory counters for
    `maxActiveSessions`, `maxConcurrentToolCalls`, `maxEventIngressPerSec`,
    and `dailyTokenUSD`. Breaches throw `QuotaExceededError` and (when
    an audit sink is wired) write a `quota_exceeded` record.
  - **Deferred to a follow-up**: session-key `(tenantId, sessionId)`
    migration, daemon's `startDaemon` per-tenant branch, `declaragent
tenants list / diff` CLI, and per-tenant metrics-label auto-stamping
    in the Prometheus exporter. None block slice 7 (chaos harness).

- 4309000: Phase 7 slice 0.2: daemon per-tenant branch + engine quota wiring.

  Second of the Phase-6 carry-over PRs. Multi-tenant runtime primitives
  from slice 6 are now reachable through the daemon's public surface.

  - **`startDaemon({ tenants })`**. Accepts an optional `readonly
LoadedTenant[]` — typically produced by `loadTenantsConfig` — and
    builds one `TenantRuntime` per entry via `createTenantRuntime`. Each
    tenant gets its own `EventBus` bound to its scope; the dispatcher
    attaches to every bus so events published by sources land in the
    dispatcher regardless of which tenant's bus they entered on.
  - **`daemon.tenants: ReadonlyMap<string, TenantRuntime>`**. Always
    populated — single-tenant deployments contain one entry for the
    implicit `__default__` tenant that shares the primary bus.
    `tenants.get(id).bus` / `.quotas` / `.registry` expose each tenant's
    isolated runtime to admin surfaces.
  - **`sendEvent` tenant routing**. In multi-tenant mode, an event
    carrying a `meta.tenantId` unknown to the daemon is rejected with
    `{ kind: 'rejected', reason: 'unauthorized', details: 'unknown
tenant "..."' }`. Events with no `meta.tenantId` remain dispatcher-
    routed (backward compatible).
  - **`tenantAudit` factory option**. An optional `(tenant) =>
TenantAuditSink` callback lets the daemon wire quota-breach and
    tenant-boundary audit records per tenant.
  - **Engine: `EngineConfig.quotas`**. When supplied, every tool call
    in the engine loop acquires a slot on `maxConcurrentToolCalls`
    before execution and releases it in `finally`. A `QuotaExceededError`
    produces an `[EQUOTA]` tool result (permission-deny semantics — the
    loop continues with other tool blocks, and `permissions.recordDenial`
    feeds the escalation counter).
  - **Graceful shutdown**. `doShutdown` now detaches the dispatcher from
    every tenant bus and calls `runtime.close()` on each tenant runtime.
  - **Tests**. New daemon suite `startDaemon — multi-tenant` covers the
    default-tenant fallback, two-tenant boot, `sendEvent` routing for
    known + unknown tenants, and the `tenantAudit` factory wiring
    through a `quota_exceeded` audit record. Engine suite `engine —
tenant quota wiring (slice 0.2)` covers the EQUOTA path and the
    high-limit happy path.

  Remaining slice 0 work:

  - 0.3 — `declaragent tenants / audit / secrets` CLI verbs.
  - 0.4 — per-tenant Prometheus `constLabels` auto-stamping.

- 4309000: Phase 7 slice 0.1: tenant-keyed session store.

  First of the four Phase-6 carry-over PRs that slice 0 needs to unblock
  GA. Session storage now keys on `(tenantId, sessionId)` instead of
  `sessionId` alone.

  - **Schema bump**. `sessions` grows a `tenant_id TEXT NOT NULL DEFAULT
'__default__'` column plus a `(tenant_id, id)` index. Pre-v1.0
    databases migrate in place via `ALTER TABLE ADD COLUMN` on first open
    — every legacy row lands on the implicit default tenant, preserving
    Phase-1-through-5 single-tenant behaviour exactly.
  - **API surface**. `SqliteSessionStore.create / open / list / delete`
    all accept an optional `{ tenantId }` scope. Omitting it falls back
    to `DEFAULT_TENANT_ID`, so existing callers (CLI `app.tsx`, skill
    runner, dispatcher) compile + run unchanged.
  - **Cross-tenant enforcement**. `open(id, { tenantId })` and
    `delete(id, { tenantId })` throw `TenantBoundaryError` when the row
    exists but belongs to a different tenant; `list` filters to the
    requested tenant. A session-scoped error code surfaces as
    `TENANT_BOUNDARY` with the offending `resource: 'session'`.
  - **`SessionMetadata.tenantId`** is exposed for CLI surfaces (slice
    0.3's forthcoming `declaragent tenants list` consumer).
  - **Tests**. New test suites cover the pre-v1.0 migration (fixture
    seeded through the old schema, reopened through the new store),
    idempotent re-open, tenant-isolated `list`/`open`, and cross-tenant
    `open`/`delete` boundary throws.

  Follow-ups in the rest of slice 0: daemon `startDaemon` per-tenant
  branch + `tenants.yaml` auto-load (0.2); `declaragent tenants / audit
/ secrets` CLI verbs (0.3); per-tenant metrics-label auto-stamping in
  the Prometheus exporter (0.4).

- 4309000: Phase 7 slice 0.4: per-tenant Prometheus metrics auto-stamping.

  Last of the Phase-6 carry-over PRs. `createPrometheusRegistry` already
  accepted `constLabels`; the daemon now wires one registry per tenant,
  pre-stamped with `constLabels: { tenant_id: tenant.id }`. Dashboards +
  alert rules in `packages/testkit/alerts/` that key on `tenant_id` light
  up automatically — the work is in the daemon, not the rules.

  - **`TenantRuntime.metrics`**. New optional field exposes a
    `PrometheusRegistry` per tenant. Adapters that write to the shared
    `deps.metrics` surface now emit samples that carry the tenant label
    with no additional work.
  - **`CreateTenantRuntimeOptions.metrics`**. Callers pass in the pre-
    built registry; the runtime stores it for downstream consumers.
  - **`StartDaemonOptions.tenantMetricsStrategy`**. Controls how the
    daemon provisions registries when `tenants` is supplied:
    - `'per-tenant'` (default when `tenants` is non-empty) — one
      registry per tenant, each with `constLabels: { tenant_id }`.
    - `'shared'` — one registry shared across every tenant. Useful for
      `shared-with-filter` bus deployments where the adapter stamps the
      tenant label itself.
    - `'none'` — opt out entirely.
  - **`StartDaemonOptions.createTenantMetricsRegistry`**. Factory hook
    for tests + custom deployments that want to pre-populate buckets or
    inject extra const labels beyond `tenant_id`.
  - **Tests** added to `daemon.test.ts`:
    - per-tenant registries are distinct, scrape output carries the
      correct `tenant_id` label, and write-time labels merge with the
      const label.
    - `strategy: 'none'` leaves `runtime.metrics` undefined.
    - `strategy: 'shared'` returns the same registry for every tenant,
      with caller-supplied `tenant_id` labels surviving the scrape.
    - single-tenant default runtime remains metrics-free unless
      explicitly opted into shared mode.

  **Slice 0 complete** — the multi-tenant primitives from Phase 6 now
  surface end-to-end through CLI, runtime, and metrics. Phase 7 moves
  on to slice 1 (release automation skeleton) next.

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

- 4309000: Phase 7 slice 5: five template packs under `templates/`.

  `declaragent init` (slice 4) will unpack one of these directories into
  the user's project root. Each template is a fully-specified starter
  that a new user can `declaragent run` in under 5 minutes.

  - **`concierge`** — minimal Slack Q&A bot via Socket Mode. One skill
    (`concierge.md`) uses the provider-default `Read` / `Glob` / `Grep`
    tools to answer questions about the local repo. No webhook — works
    on any laptop behind NAT.
  - **`oncall-escalator`** — Alertmanager webhook → Claude triage →
    Slack DM. Demonstrates the `webhook` source with HMAC verification,
    `X-Alertmanager-Fingerprint` as an idempotency key, and the
    `SendMessage` tool on an outbound-only channel. Ships with a
    `mock-alert.json` payload and the matching `curl` command in the
    README.
  - **`pr-review`** — GitHub `pull_request` webhook → Claude reviews the
    diff → inline review comments. References
    `@declaragent/plugin-github` via a `plugin-manifest.json`.
  - **`kafka-pipeline`** — Kafka source consuming `orders.created`,
    enrichment via Haiku, re-emit to `orders.enriched`, DLQ on
    `orders.dlq`. Declares `dailyTokenUSD: 5` to exercise Phase-6 cost
    enforcement. Bundles a Redpanda `docker-compose.yaml` for the local
    dev loop.
  - **`multi-tenant-starter`** — `tenants.yaml` with `acme-prod` (US
    residency, enterprise quotas) + `beta-tenant` (EU residency, trial
    quotas). Demonstrates `per-tenant` bus strategy, per-tenant
    `extensions.allow`/`deny`, scoped Vault secrets, and a smoke-test
    block in the README that walks the user through
    `declaragent tenants list / show` + `declaragent audit verify`.

  **Verifier.** `scripts/verify-templates.ts` walks every template and
  asserts that every YAML / JSON file parses, every declared skill file
  exists, and `.env.example` covers every `${env:FOO}` ref in the YAML.
  A matching CI job (`.github/workflows/templates-verify.yml`) runs the
  same script on `push` / `pull_request` / `workflow_dispatch` scoped to
  `templates/**`. The verifier doubles as a local check: `bun run
scripts/verify-templates.ts` is green in a clean checkout.

  **Top-level index.** `templates/README.md` catalogues the five
  templates + their demonstrated features, and links out to the parallel
  `declaragent init` unpacker in slice 4.

  **Locally validated.**

  - `bun run scripts/verify-templates.ts` — green on all five templates.
  - `bun run typecheck` — unchanged baseline.
  - `bun test` — unchanged baseline (templates aren't exercised in the
    test suite).
  - `bun run lint` — unchanged baseline; template markdown + YAML are
    already excluded via the root `biome.json` `files.ignore` block.

  **Template deferrals.**

  - `@declaragent/plugin-github` is referenced in `pr-review` but is not
    yet published. `declaragent run` on that template will fail plugin
    load until the Phase 2 ecosystem publishes the package. Called out
    in that template's README.
  - Slack / GitHub setup runbooks are linked as TODO-anchored paths
    under `docs/runbooks/`. The real pages land alongside slice 7 (docs
    site).
  - The `quotas` block on `kafka-pipeline/agent.yaml` and the `tenants`
    / `plugins` / `event-sources` references elsewhere use
    forward-compatible field names that `AgentSpec` in
    `packages/core/src/types/session.ts` will need to honor when the
    full `agent.yaml` schema is frozen in slice 8.

- 4309000: Phase 7 slice 6: `declaragent deploy gcp-cloud-run` artifact generator.

  New in `@declaragent/cli`:

  - `deployGcpCloudRun(args, deps?)` — parses the user's `agent.yaml` (plus
    an adjacent `tenants.yaml` when present) and emits four artifacts under
    `.declaragent/deploy/`: `Dockerfile`, `.dockerignore`, `service.yaml`,
    and a `README.md` with the three-command "docker build → docker push →
    gcloud run services replace" runbook.
  - `verifyGcpCloudRunDeploy(args, deps?)` — runs `gcloud run services
describe` + probes the deployed daemon's `/health` endpoint. On 200
    prints the shareable URL plus a webhook-configuration snippet derived
    from `channels.yaml` (or a generic fallback). Fails gracefully when
    `gcloud` is absent from `$PATH`.
  - Pure renderers in `deploy-dockerfile.ts` + `deploy-service-yaml.ts`
    that are easy to snapshot-test in isolation. `renderServiceYaml`
    stamps CPU / memory limits, `autoscaling.knative.dev/minScale` = 1 (so
    the daemon stays warm for webhooks), one env var per `${secret:...}`
    ref found anywhere in the parsed YAML, and one `volumes` +
    `volumeMounts` pair per tenant declared in `tenants.yaml`.

  **Deliberately out of scope:** we do not invoke `gcloud` on the user's
  behalf during generation — the three commands are printed for the user
  to run themselves, so GCP auth stays theirs to own. `--verify` is the
  one place we shell out, and even there we exit gracefully if the user
  doesn't have `gcloud` installed yet.

  **Cost note surfaced in the generated README:** $40–$60 / month (lower
  bound) at the default `cpu=1, memory=512MiB, minInstances=1` preset.
  Provider token costs are additive.

  **Locally validated.**

  - `bun run typecheck` — clean.
  - `bun test packages/cli/src/deploy-cli.test.ts` — 17/0.
  - `bun test packages/cli/src/deploy-service-yaml.test.ts` — 17/0.
  - `bun test` — baseline unchanged on all other suites.

  **Deferrals / TODOs.**

  - The `deploy` subcommand is not yet wired into `index.tsx` — the
    orchestrator will handle that after reconciling with slices 7 and 8.
  - A nightly Cloud Run soak that actually deploys to a scratch GCP
    project is TODO'd in `.github/workflows/cloud-run-soak.yml`; for slice
    6 the workflow asserts artifact generation only.

- 4309000: Phase 7 slice 7: Docusaurus docs site + auto-extraction pipeline.

  A new `docs-site/` directory at the repo root (sibling to `packages/`)
  hosts a Docusaurus 3.x site served from `https://declaragent.dev/docs/`.
  The project is intentionally **outside** the bun workspace — React +
  Docusaurus tooling must not pollute the core/cli TypeScript build.
  Maintainers install it with `cd docs-site && npm install`; `bun install`
  at the root is untouched.

  Four top-level sections, mirroring `PHASE_7_PLAN.md §8`:

  - **Quickstart** — the 10-minute path: curl / npm / brew install
    walkthrough with `<Tabs>` per path, first-agent wizard walkthrough.
  - **Reference** — `agent.yaml` schema (hand-curated subset pending the
    slice-8 Zod generator), CLI reference (auto-extracted), env vars table,
    provider matrix, extension registry.
  - **Cookbook** — one page per template (concierge, oncall-escalator,
    pr-review, kafka-pipeline, multi-tenant-starter) + four recipes
    (deploy-cloud-run, rotate-vault-secret, two-tenants-one-daemon,
    grafana-tracing).
  - **Troubleshooting** — error-code table (EEXTCONFLICT, TENANT_BOUNDARY,
    EQUOTA, EPERM, ENOTOOL, ENOSESSION, EINVAL, EABORT), deploy-403
    flowchart (mermaid), install-failed flowchart (mermaid), and one
    stub MDX page per `runbook_url` shipped under
    `packages/testkit/alerts/` — 23 runbooks surfaced.

  **Auto-extraction pipeline.** `scripts/docs-cli-extract.ts` reads the
  `printHelp()` + `printInitHelp()` template literals from
  `packages/cli/src/index.tsx` and writes them between BEGIN/END markers in
  `docs-site/docs/reference/cli.mdx`. Idempotent — running twice produces
  identical output. The CI workflow diffs the committed file against a
  fresh extraction and fails the PR if they differ, so help-string drifts
  get caught before merge.

  **Docusaurus config.** Pinned to `3.10.0` exact (per the §16
  risk-mitigation note on Docusaurus churn). `webpack` is pinned to
  `5.97.1` via `overrides` + `resolutions` — later webpack 5.x minors
  ship a stricter `ProgressPlugin` schema that `webpackbar` 6.x passes
  options against and fails. The docs site will re-pin once `webpackbar`
  publishes a compatible release. Local search via
  `@easyops-cn/docusaurus-search-local` (Algolia DocSearch application is
  a post-slice follow-up). `@docusaurus/theme-mermaid` plugin is wired in
  for the two flowcharts in Troubleshooting. `organizationName`,
  `projectName`, `url`, and `baseUrl` all match the spec
  (`declaragent`/`declaragent`/`https://declaragent.dev`/`/docs/`).

  **Versioning.** Docusaurus' per-version docs support is enabled via
  `includeCurrentVersion: true`. `versions.json` is unwritten until
  `npm run docusaurus docs:version 1.0` runs at release time.

  **Workflow.** `.github/workflows/docs-site.yml` runs two jobs:

  - `docs-build` on every PR — verifies the CLI reference is in sync,
    runs `npm ci && npm run build`, uploads the build as an artifact.
  - `deploy` on push to `main` — downloads the artifact and uses the
    official `cloudflare/pages-action` with
    `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (stubbed until the
    repo owner wires the secrets).

  **Touch points.** Disjoint from every other slice:

  - New files under `docs-site/` (entire project tree).
  - New script `scripts/docs-cli-extract.ts`.
  - New workflow `.github/workflows/docs-site.yml`.
  - This changeset.

  Nothing under `packages/`, `templates/`, other `scripts/`, or existing
  workflows was touched. Root `package.json` still lists
  `"workspaces": ["packages/*", "examples/*"]`; docs-site stays out of the
  bun workspace by design.

  **Locally validated.**

  - `bun run scripts/docs-cli-extract.ts` — writes + runs idempotent
    (second invocation prints `no changes`).
  - `bun run typecheck` — unchanged baseline, 0 errors.
  - `bun test` — 1594 pass / 19 skip / 0 fail across 152 files.
  - `bun run lint` — 489 files checked, 0 errors. Root `.gitignore`
    gains a `.docusaurus` entry so biome doesn't trip on the Docusaurus
    build-time cache directory (parallel to the existing `build/` entry).
  - `cd docs-site && bun run build` — generated static files in
    `docs-site/build`. The `npm ci && npm run build` equivalent runs in
    `.github/workflows/docs-site.yml` on every PR.

  **Deferred / placeholder content.** Every stub page carries a
  `[placeholder — landing 2026-Q2]` sentinel so grep can find them:

  - 23 runbook pages are stubs; slice 7.5 inlines the canonical markdown
    under `docs/runbooks/`.
  - Real screenshots land with slice 9 (Launch).
  - `agent.yaml` reference is a hand-curated subset; slice 8's Zod →
    MDX generator replaces it.
  - Nightly provider-matrix tests are aspirational; plumbing lands
    alongside the slice-8 generator.
  - `@declaragent/plugin-github` is referenced by the `pr-review`
    cookbook page but not yet published.

  **Post-slice follow-ups.**

  - Wire `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets + the
    Cloudflare Pages project.
  - Algolia DocSearch application.
  - Link-checker step in the workflow (Docusaurus' `onBrokenLinks` is
    set to `warn` for now so slice 6 + 8 merges don't fail the docs
    build in-flight).
  - `favicon.ico` + `declaragent-social-card.png` (placeholder SVG
    logo ships in this slice).
