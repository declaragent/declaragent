# @declaragent/testkit

## 5.0.0

### Patch Changes

- 0a15577: Docs-truth pass — code fixes (the four places the docs wrote a check the code should cash):

  - **`DECLARAGENT_CONFIG_DIR` is now honored** by `configDir()` (the deploy-generated Dockerfile always set it to `/etc/declaragent`, but the runtime never read it — the container config mount was dead weight). An explicit `root` argument (the test seam) still wins over the env var. The generated Dockerfile's `ENTRYPOINT` also fixed from the non-existent `run` verb to `up`.
  - **`fleet run`'s provider is now rate-limited** with the same token bucket as `up` — the shared wrap lives in `packages/cli/src/provider-rate-limit.ts` (same per-provider defaults, same `DECLARAGENT_PROVIDER_RATE_LIMIT_{RPS,DISABLE}` escape hatches). Previously `fleet run` built a bare provider, so "token bucket wraps every provider" held for `up` only.
  - **MCP stdio kill-on-close**: closing the adapter now sends `SIGTERM` immediately and falls back to `SIGKILL` after a 5-second grace (`STDIO_KILL_GRACE_MS`), so a hung server can no longer stall shutdown forever — making THREAT_MODEL's kill-on-shutdown mitigation true. Tested against a TERM-ignoring child.
  - **Peer dependencies declared**: `@declaragent/core` declares `@opentelemetry/api` / `@opentelemetry/sdk-node` / `@opentelemetry/exporter-trace-otlp-http` as optional peerDependencies (the documented OTel setup previously relied on undeclared packages), and `@declaragent/plugin-agent-rpc` declares `kafkajs` / `@aws-sdk/client-sqs` / `amqplib` / `mqtt` as optional peers mirroring its existing `nats` entry.
  - **Generated deploy README** now includes the binary/config staging steps the Dockerfile requires and the webhook-port note (`EXPOSE 8787` vs the source default 7777).
  - Testkit dashboards + alert rules corrected to query metric names the exporter actually emits (no `_total` suffixing on counters); rules contracted on not-yet-emitted metrics are annotated in-file.

- e67edc4: Production-readiness pass (WS1–WS11 + quick wins):

  **Live sandbox verification (docker + minikube).** With a local broker/cluster/collector provisioned, the previously-"unverified" workstreams were exercised against real systems — and the live runs caught **three real bugs that unit tests could not**:

  - **WS4/WS11 (live brokers):** the fleet RPC round-trip + cross-host respond now verified against **Redpanda** (`kafka-rpc`), **NATS** (`nats-rpc`), and **NATS JetStream** (`jetstream-rpc`) — consumers join groups, request→response completes over each real transport. **SASL/SCRAM handshake verified live too:** `createKafkaTransport` with `sasl: {mechanism: scram-sha-256, …}` authenticated against a SASL-enabled Redpanda + round-tripped a message (not just config-mapping — the real handshake).
  - **WS3 (live control-plane auth):** an agent with `controlPlane.auth` (OIDC → mock-oauth2-server, `allowLoopback: false`) was run with a non-loopback bind; `/events` returned **401 without a bearer token and 200 with a valid JWKS-verified token**, while `/healthz` stayed **200** (auth-exempt). The Host-header/fail-closed hardening is now confirmed end-to-end against a real IdP, not just unit-tested.
  - **WS9 (live soak):** a bounded 45s / ~225-cycle soak ran green against Redpanda. **Bug fixed:** the soak harness generated dotted capability names (`alpha.ping`) that violate the URL-safe rule → switched to `alpha-ping` (`multi-process.ts`, `kafka-soak.test.ts`).
  - **WS7 (live OTLP):** a span emitted via `startOtelSdk` was confirmed **received by a real OTLP collector** (debug exporter logged it). **Bug fixed:** `startOtelSdk` passed `traceExporter:{url}` — not a valid `SpanExporter`, so the BatchSpanProcessor's `_exporter.export` was undefined and export silently failed; now constructs a real `OTLPTraceExporter` (peer-dep-loaded) at the resolved `/v1/traces` URL (`otel-sdk.ts` + `otlpTracesUrl`).
  - **WS2 (live OIDC/OAuth2 rpc-auth):** the two-agent envelope-auth round-trip is now verified end-to-end against a real IdP — a valid client_credentials token is accepted (JWKS verify + audience), a wrong-audience token rejected. **Two more fixture/test bugs fixed:** (1) the Dex fixture never booted (missing `connectors`) AND Dex v2.39 doesn't implement the client_credentials grant — migrated the fixture to `navikt/mock-oauth2-server` (which does); (2) the test paired an `oauth2-client` signer with an `oidc` verifier (kind mismatch → `wrong-kind`) — corrected to the matching `oauth2-client` verifier on both sides, with IdP-specifics env-overridable. (`rpc-auth.test.ts`, `rpc-auth-idp.yml`.)
  - **WS6 (live k8s):** a rendered single-agent manifest was deployed to **minikube** and the pod reached **Ready (1/1, 0 restarts)**. Getting there required, and verified, several fixes: (a) the ConfigMap now embeds the full top-level agent dir (`event-sources.yaml`, `rpc-peers.yaml`, `capabilities.yaml`, `.mcp.json`) — without it no source bound and `/readyz` never went 200; (b) the readiness probe now targets `/readyz` (source-gated) while liveness keeps `/healthz` (new `readyProbePath`, default `/readyz`); (c) **bug fixed:** a non-loopback bind without `controlPlane.auth` previously skipped the whole listener (so k8s probes 403'd / got no listener) — it now binds in a **safe-subset mode** serving only `/metrics`+`/healthz`+`/readyz` with `allowRemote`, so kubelet probes work without forcing an OIDC IdP, while `/events`,`/audit`,`/dlq` are simply not registered (the WS3 fail-closed guarantee holds); (d) a real `Dockerfile` + `.dockerignore` (the "no image" gap). NOTE: the in-container monorepo _tsc_ build hits a bun-workspace-resolution quirk in `oven/bun`, so the image ships pre-built `dist/` + installs runtime deps; reconciling the in-container build is a follow-up.

  All three render formats are now at parity: **helm** embeds the full agent-dir config in its ConfigMap + uses `/readyz` for readiness too, and a `helm install` of the rendered chart to minikube reached **pod Ready (1/1, 0 restarts)** — verified end-to-end, matching k8s + kustomize. Full unit suite remains green (3202 pass / 0 fail) alongside the live runs.

  ***

  - **WS11 — Slack Socket Mode reconnect + truthful health.** The Socket Mode transport now reconnects with exponential backoff when Slack recycles the WSS or the network blips (it was a documented no-op, so the "2-minute" Slack path silently went dead after ~1h), exposes `connected()`, and the channel's `health()` reports `socketActive` from the live connection instead of always-true-while-the-object-exists. Tested with a fake WebSocket. (Kafka SASL/TLS has since been live-verified — see above; reconnect parity for the other channels/brokers remains.)
  - **WS6 — bootable container render + health probes.** The control-plane server now serves auth-exempt `/healthz` (liveness) + `/readyz` (readiness; 503 until a source binds) routes — kubelet probes send no token, so they're exempt while every other route stays authed. The k8s/helm/kustomize renderers now run **foreground** `up` (was `up -d`, whose detached child left PID 1 to exit 0 → CrashLoopBackOff), inject `DECLARAGENT_METRICS_PORT` so the listener serves the probes, and set `DECLARAGENT_BIND_ADDRESS=0.0.0.0` so the kubelet reaches `/healthz`+`/readyz` via the pod IP (the default 127.0.0.1 bind made probes unreachable). This is also a correctness coupling with WS3: a non-loopback bind is fail-closed without `controlPlane.auth`, and the health routes are auth-exempt, so the rendered pod boots iff auth is configured — secure by default. (Superseded by the live-verification section above: the full agent-dir ConfigMap, a real Dockerfile, and a minikube pod-Ready run all landed. Still open: rendered auth-secret wiring, a `fleet deploy` adapter, and a CI cluster smoke gate.)
  - **WS4 — cross-host delegation wiring.** (1) `fleet run` hard-pinned the response transport to the in-process memory bus, so a request arriving over Kafka/NATS was answered on a bus the caller couldn't observe — every cross-host sync round-trip timed out. The responder now selects the transport from the inbound envelope's `replyTo` scheme (`brokerAddressKind`). (2) `fleet run` now supplies `transportFactories` (`buildTransportFactories`) so declared kafka/nats transports actually instantiate from their `capabilities.yaml` config instead of warn-skipping — the config→constructor mapping is unit-tested with injected constructors. Both verified hermetically (fake/injected transports). (3) **Transport SASL/TLS (WS11):** the kafka transport + `capabilities.yaml` schema now accept `ssl` + a `sasl` block (`mechanism`/`username`/`passwordRef`); `buildTransportFactories` resolves the `passwordRef` through the secrets resolver and hands kafkajs the credentials — a fleet can now authenticate to a production broker, and a declared `sasl` without a resolver fails loud rather than connecting unauthenticated. Verified by asserting the kafkajs client receives `ssl`/`sasl` and the ref is resolved — and the live SASL/SCRAM handshake has since been verified against a SASL-enabled Redpanda (see the live-verification section above). `RequestAgent` in `up` remains.
  - **WS8 — dollar spend brake + `tenants.yaml` loading.** (1) `agent.yaml#quotas` (strict-validated) is parsed and `up` builds a `QuotaTracker`: the engine records each LLM call's estimated cost and halts the turn fail-closed (`stopReason: 'quota_exceeded'`, `spend_capped_total` metric, `quota_exceeded` audit) once `dailyTokenUSD` is reached — the first dollar-denominated runaway-spend brake. (2) `tenants.yaml` is no longer dead config: an agent declares `tenant: <id>`, and `up` loads `tenants.yaml` (searching the agent dir up to the fleet root via `findTenantsConfig`), resolves it (`resolveTenantContext`), and uses the TENANT's quotas + context — so a fleet shares one tenant budget. A declared-but-unresolvable tenant warns instead of silently mis-scoping. (3) GDPR erasure: `EventStore.eraseByPlatformUser(id)` hard-deletes a subject's event rows (+ DLQ rows) via `meta.principal.platformUserId`, and a new `eraseSubject(platformUserId, { auditSink, eventStores })` composer runs the subject's erasure across the audit sink (tombstone, chain stays verifiable) + every event store, reporting per-store counts — so "right to be forgotten" now covers audit AND events (the audit flagged events had no deletion path). A new `declaragent erase --user <platformUserId> [--reason R] [--json]` verb wires this over the daemon's real handles (audit.db + sessions.db), reporting per-store counts and idempotent on re-run — so GDPR right-to-erasure is now a real command, not just a library call. (4) Per-tenant memory isolation: long-term memory (`memory_*` tools) now scopes its namespace by the executing `ctx.tenant` (`tenantScopedNamespace`) — the default tenant keeps the bare namespace (no migration, bit-for-bit backward-compatible), while each non-default tenant gets an isolated `<ns>::t::<id>` partition another tenant's turns can't read or overwrite, closing the "shared memory commingles tenant PII" gap. (5) Per-end-user isolation: a `subject` (the channel principal's `platformUserId`) is now threaded from the inbound event through the dispatcher → `RunAgentInput` → engine → `ToolContext.subject`, and memory scopes further to `…::sub::<id>` — so two end-users of the SAME agent+tenant get isolated memory, no cross-user PII leakage. (6) Retention that doesn't break tamper-evidence: `audit prune` now TOMBSTONES expired rows (scrubs the PII payload, keeps the seq/prevHash/recordHash) instead of hard-deleting them — fixing the audit's "prune breaks verify" finding (the chain is global, so deletes orphaned the next row's prev-hash). `verify()` passes after retention pruning, prune is idempotent, and other tenants are untouched. **WS8 is now substantively complete.**
  - **WS7 — LLM golden signals + honest tracing banner.** The engine now instruments every `provider.complete` call with a latency histogram, `requests_total`, `errors_total`, `input/output_tokens_total`, and `cost_usd_total` (plus `unpriced_calls_total`), labelled by agent + model — operators can alert on provider latency, errors, and spend. Separately, the `up` startup banner no longer falsely claims "tracing enabled": it now states accurately that spans export only when an OTel SDK is registered in the process (declaragent bridges `@opentelemetry/api` but does not start an SDK). **The NodeSDK now actually starts (WS7):** a new `startOtelSdk` loads `@opentelemetry/sdk-node` (peer dep, injectable loader) and calls `sdk.start()` so the bridge's spans EXPORT to `OTEL_EXPORTER_OTLP_ENDPOINT`; `up` starts it when the endpoint is set, flushes it on shutdown, and the banner now says "spans exporting" vs the honest no-SDK fallback. The bootstrap (construct + start + idempotent stop, peer-dep-absent → loud non-fatal warning) is unit-tested with a stub SDK, and span receipt has since been confirmed at a live OTLP collector (see the live-verification section above — which also caught and fixed the exporter-shape bug). A **daemon heartbeat gauge** (`declaragent.daemon.heartbeat_timestamp_seconds`) is now refreshed by the up-loop and stopped on shutdown, so the `DaemonHeartbeatTimeout` alert (alert on staleness) can finally fire — the "agent stopped responding at 2am" pager works.

  - **WS3 — control-plane hardening (security risk).** (1) Host-header auth bypass fixed: the loopback decision now uses the real connection peer IP (plumbed via `server.requestIP`), not a spoofable `Host: 127.0.0.1`. (2) Consumed `bindAddress` knob (`DECLARAGENT_BIND_ADDRESS`, default `127.0.0.1`): the listener no longer hard-binds loopback, enabling multi-host operation — but a non-loopback bind without a `controlPlane.auth` block is refused fail-closed (the listener is skipped with a loud error rather than exposing `/events`,`/audit`,`/dlq` to the network).
  - **WS2 — RPC auth fails closed + HMAC signer (security risk).** (1) The inbound verify path (agent-inbox + the fleet-run worker) previously ACCEPTED any envelope whose `from` had no entry in the `AuthVerifyRegistry` — an attacker could set `from: agent://not-in-registry` to bypass verification. A new `strictAuth` mode rejects unregistered senders (`unknown-peer`), enabled whenever `rpc.auth.enabled: true`. (2) New `createHmacAuthProvider` (HMAC-SHA256 over the canonical envelope, constant-time compare, `keyId` rotation) — the zero-infra default that closes the gap where `RequestAgent` could only stamp `auth:{kind:'internal'}` (so enabling auth rejected all built-in delegation). It's wired into the `rpc-peers.yaml` schema (`provider: hmac` + `secretRef`), the verify registry factory, and a `RequestAgent` `signOutbound` hook; a sign→verify round-trip (with tamper + wrong-key rejection) is tested end-to-end. Default-off preserves the legacy path until the 0.8.0 zero-trust cutover.

  - **WS5 — DLQ requeue no-op fixed + boot-time crash recovery (reliability blocker).** (1) `dlq requeue` / the `/dlq/requeue` route previously re-published the _same_ event id, which the dispatcher's idempotency check rejected as a duplicate before routing — a 0-execution no-op that reported success and deleted the DLQ row. Requeue now mints a fresh event id (dropping the application idempotency key, stamping `meta.causedBy` for lineage) so the re-dispatch actually executes; the result carries `newEventId`, and an optional `dispatch` hook returns the real outcome. (2) Events left pending (`outcome=NULL`) by a crash/SIGKILL mid-turn were silently lost forever. `up` now recovers them at boot via `recoverPendingEvents` — re-dispatching fresh-id clones and marking originals `rejected/interrupted` (idempotent across restarts). A new `'interrupted'` rejected reason makes this auditable. (3) Graceful drain — `up`/`down` now stop sources first, then await in-flight engine turns (`dispatcher.draining()`) bounded by `DECLARAGENT_DRAIN_DEADLINE_MS` (default 15s; `0` disables), and `down`'s SIGKILL grace is aligned to the drain deadline so a routine deploy no longer aborts live turns. (4) Outbound channel sends now retry with bounded backoff (idempotency-key-safe, so no double-post) and log `channels.outbound.exhausted` at ERROR on failure instead of silently dropping the reply. All four reliability-loss seams are now closed.

  - **WS1 — tool-permission enforcement (security blocker).** Headless runtimes (`up`, `fleet run`) now enforce `agent.yaml#tools.defaults`: the engine is handed only the declared tools, an unknown tool name fails boot, and a real `default`-mode permission gate denies anything undeclared (was `mode:'bypass'` with the full builtin set). Capability tools (SendMessage/RequestAgent/memory\_\*) and plugin tools are auto-exempt. New optional `permissions.rules` block adds per-key allow/deny scoping. `DECLARAGENT_TOOLS_LEGACY=on` restores prior behavior during rollout.
  - **WS1(d) — Bash secret-env scrub.** The Bash tool now passes an explicitly scrubbed environment to subprocesses: secret-looking keys (`*_API_KEY`/`*_SECRET`/`*_TOKEN`/…) are removed, a safe keep-set is retained, and `DECLARAGENT_BASH_ENV_ALLOW`/`DECLARAGENT_BASH_ENV_DENY` override the policy. Closes a real provider-key exfiltration path; `THREAT_MODEL.md` corrected to match.
  - **WS10 — config integrity + claims reconciliation.** New `declaragent agent validate [dir] [--json]` verb (schema + unknown-key lint + tool resolution); `fleet validate` now validates every member's agent body; unknown top-level `agent.yaml` keys (e.g. a `rcp:` typo of `rpc:`) are flagged instead of silently swallowed. The claims docs are reconciled to code: `AGENTS.md` gains an evidence-backed "production-readiness pass" ledger (§0) and `CLAUDE.md`'s "5-of-5 ✅" scoreboard carries an accuracy note pointing at the real (partial) state — directly addressing the audit's top finding that status claims had drifted from the code.
  - **WS9 — Kafka soak harness + hermetic flagship E2E.** (1) The testkit fleet-run subprocess now resolves `kafkajs` from testkit's own dependency tree (`createRequire(import.meta.url)`) instead of relying on plugin-agent-rpc's bare import, which failed in CI/subprocess contexts. (2) A hermetic end-to-end test now composes the flagship path as a unit — inbound (webhook) event → bus → dispatcher → engine (scripted provider) → `assistant.final` → outbound bridge → mock channel send, with the event store recording a `dispatched` outcome. Fully in-memory (no broker/LLM/network), closing the audit's "no test composes the flagship webhook→skill→LLM→channel path" gap. (Branch protection, the release sentinel, and the real soak streak still need GitHub admin + calendar time.)
  - **Quick wins.** Price table now includes the default `up`/`fleet run` model (`claude-sonnet-4-5`) so the default path isn't silently $0, plus an `onUnknownModel` hook and `hasPriceFor`; `up -d` detach now works when the CLI runs under an interpreter (`bun dist/index.js`) by prepending the entry script; Kafka source `lag()` now reports end − committed (consumer lag) instead of the raw end offset.

- Updated dependencies [0a15577]
- Updated dependencies [e67edc4]
  - @declaragent/core@0.6.0
  - @declaragent/plugin-agent-rpc@5.0.0
  - @declaragent/source-kafka@5.0.0

## 4.0.5

### Patch Changes

- Updated dependencies [5fca34b]
- Updated dependencies [56c7f8d]
- Updated dependencies [c8df2a7]
- Updated dependencies [e17abfc]
  - @declaragent/core@0.5.5

## 4.0.4

### Patch Changes

- Updated dependencies [0bfc5a7]
- Updated dependencies [7858f66]
  - @declaragent/core@0.5.4

## 4.0.3

### Patch Changes

- Updated dependencies [0649786]
- Updated dependencies [606f8c2]
- Updated dependencies [fe2a3c2]
  - @declaragent/core@0.5.3
  - @declaragent/plugin-agent-rpc@4.0.3

## 4.0.2

### Patch Changes

- Updated dependencies [cfb5dbe]
- Updated dependencies [eda26e5]
  - @declaragent/plugin-agent-rpc@4.0.2
  - @declaragent/core@0.5.2

## 4.0.1

### Patch Changes

- Updated dependencies [11c494d]
- Updated dependencies [c8e87e6]
- Updated dependencies [e9abb80]
  - @declaragent/plugin-agent-rpc@4.0.1
  - @declaragent/core@0.5.1

## 4.0.0

### Patch Changes

- Updated dependencies [1bc842d]
- Updated dependencies [8651c54]
- Updated dependencies [b69d717]
- Updated dependencies [2e60de4]
  - @declaragent/core@0.5.0
  - @declaragent/plugin-agent-rpc@4.0.0
  - @declaragent/source-kafka@4.0.0

## 3.0.0

### Patch Changes

- 8bddcc1: **Slice 7 of 0.6.0 production hardening — fleet RPC over Kafka.**

  ### @declaragent/plugin-agent-rpc

  New `createKafkaTransport({ brokers, clientId?, groupId?, kafkajsModule?, logger? })` at `packages/plugin-agent-rpc/src/kafka-transport.ts`. Constructs an `RpcTransport` whose `publish()` routes through a Kafka producer and whose `subscribe()` spins a per-topic consumer.

  Key design points:

  - **`kafkajs` is loaded dynamically** via a computed-specifier `import()`, so `plugin-agent-rpc` doesn't declare `kafkajs` as a dep. Hosts that want Kafka install `kafkajs` themselves; hosts that use the memory transport pay no weight.
  - **Per-topic consumers** mirror `MemoryTransport`'s subscription semantics — one topic's lifecycle never blocks another's rebalance.
  - **Envelope wire format** reuses core's `encodeEnvelope` / `decodeEnvelope` so Kafka payloads round-trip the same validation as memory-bus messages.

  Unit coverage (`kafka-transport.test.ts`): 7 tests against a mocked `KafkaJSModule` covering publish wire format, subscribe delivery, multi-subscriber unsub, close lifecycle, post-close reject, empty-brokers guard, and malformed-payload swallow.

  ### @declaragent/testkit

  New `packages/testkit/src/fleet-integration/kafka-rpc.test.ts`. Gated behind `FLEET_INTEGRATION=1` + `KAFKA_BROKERS` so the default `bun test` run stays broker-free. When enabled: spins two transports against a live Redpanda, sends a request, asserts the round-trip completes within 2s.

  Also adds `@declaragent/plugin-agent-rpc` to testkit's peer deps (needed for the new harness).

  ### .github/workflows/nightly-integration.yml

  Runs the integration test nightly at 08:00 UTC against a Redpanda service spun up via the existing `packages/source-kafka/test/fixtures/docker-compose.yml`. Failures open a `nightly-flake`-labeled issue rather than blocking unrelated PRs. Configurable retry count (default 3) absorbs transient broker flakes without hiding real regressions.

  ### Intentional deferrals

  - **Full `declaragent fleet run` boot over Kafka** — the current integration test proves the transport layer. End-to-end `RequestAgent` dispatch through live LLM handlers needs a provider-mock scaffold that grew out of scope. Tracked for Slice 7.5 / post-0.6.0.
  - **Chaos scenarios** — broker crash, partition rebalance, consumer-lag recovery. Same post-0.6 track.
  - **Soak proof** — the plan asked for 7 consecutive green nightlies before beta → rc. Can't verify that from a single PR; first nightly run gates the promotion. AGENTS.md reflects the gap honestly: infrastructure ✅, soak 🟡.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 7.

- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
  - @declaragent/core@0.4.0
  - @declaragent/plugin-agent-rpc@3.0.0
  - @declaragent/source-kafka@3.0.0

## 2.0.0

### Patch Changes

- Updated dependencies [da8f330]
- Updated dependencies [579362c]
- Updated dependencies [778f505]
- Updated dependencies [a4ba7a4]
- Updated dependencies [9a6c64f]
  - @declaragent/core@0.3.0
  - @declaragent/source-kafka@2.0.0

## 1.0.0

### Minor Changes

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

- 4309000: Phase 6 slice 7: chaos harness + assertions.

  - **`ChaosDriver`** (`packages/testkit/src/chaos/driver.ts`). Deterministic
    policy-driven fault firing with injectable clock / RNG / scheduler.
    `policy.probability`, `policy.budget`, and `inject(fault)` all covered.
    `onEvent` streams a `started` / `fault.fire` / `fault.complete` /
    `fault.error` / `budget-exhausted` / `stopped` timeline. `stop()`
    returns the full `ChaosReport`.
  - **Seven fault implementations** under
    `packages/testkit/src/chaos/faults/`:
    - In-memory: `bus-high-watermark`, `expire-idempotency-cache`,
      `clock-skew` (with a companion `createMutableClock`),
      `network-latency` (wraps a caller-supplied `fetch`).
    - Infrastructure-shaped: `kill-replica`, `partition-broker`,
      `partition-channel` — each ships an `InMemory…` implementation for
      unit tests and an interface (`ReplicaKiller`, `BrokerPartitioner`,
      `ChannelPartitioner`) callers plug K8s/Docker shell hooks into.
    - `composeRuntimes(logger, ...fragments)` helper stitches the
      per-fault fragments into the single `ChaosTargetRuntime` the driver
      dispatches to.
  - **Five assertions** under `assertions/`:
    - `no-event-loss` — per-source `received == processed + dlq + inflight`.
    - `no-cross-tenant-leak` — audit records all match the scoped tenant
      and zero `tenant_boundary_violation` records surface.
    - `no-secret-in-logs` — watched values never appear in logs or audit.
    - `slos-held` — p99 channel-outbound latency + DLQ rate stay within
      configurable thresholds (10 s / 1 % defaults).
    - `dedup-never-drops` — every correlation id appears in the audit
      log exactly once.
  - **Report writers** — `renderChaosReportJson` + `renderChaosReportMarkdown`
    produce diff-friendly JSON + human-scan markdown tables (assertions +
    fault timeline).
  - **Tests** — 28 unit tests covering every fault, every assertion, the
    driver's scheduler + budget + inject + error-propagation paths, and
    both report renderers.

- 4309000: Phase 6 slice 8: release gate + threat-model signoff. Phase-closer.

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

### Patch Changes

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
  - @declaragent/source-kafka@1.0.0
