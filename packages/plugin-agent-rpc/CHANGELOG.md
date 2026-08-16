# @declaragent/plugin-agent-rpc

## 5.1.0

### Minor Changes

- 87ae87a: WS2 — outbound envelope signing wired into the fleet runtime (RELEASE_0_8_0_PLAN.md §B1, the hard blocker for the 0.8.0 zero-trust flip):

  - **`buildOutboundSigner`** (plugin-agent-rpc): sign-side counterpart of `buildAuthVerifyRegistry`. Builds one provider per peer with an `auth:` block and returns a `signOutbound`-compatible hook that dispatches on the envelope's destination — outbound to peer B is signed with the credentials shared with B (HMAC: the pair's secret + keyId). Destinations without an `auth:` block keep the legacy `internal` stamp, so mixed fleets sign exactly where a verifier expects a signature.
  - **Response-leg signing**: `createRespondHook` accepts `signOutbound`, replacing the hard-coded `auth:{kind:'internal'}` on replies.
  - **`fleet run` wires both legs**: signers are built at boot from the fleet-root and per-agent `rpc-peers.yaml` (same per-agent-wins selection as the verify registries) and threaded into every `RequestAgent` tool (request leg) and every worker's respond hook (response leg). A signer that cannot be built under `rpc.auth` (e.g. unresolvable `secretRef`) **aborts boot** with an actionable error instead of shipping a fleet whose delegations would all be rejected.
  - **`fleet audit-rpc` sign-side findings**: peers without an `auth:` block are reported (`no-auth-block`, fails `--strict` — at 0.8.0 outbound to them breaks) and `provider: oidc` peers are flagged as verify-only for the built-in signer.

  With this, the WS2 flagship scenario passes: strict verify ON + HMAC configured on both sides → built-in delegation succeeds end-to-end with both legs signed (previously rejected `wrong-kind`).

### Patch Changes

- Updated dependencies [8a36fd3]
  - @declaragent/core@0.6.1

## 5.0.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [0a15577]
- Updated dependencies [e67edc4]
  - @declaragent/core@0.6.0

## 4.0.3

### Patch Changes

- fe2a3c2: Add `createAmqpTransport` (RabbitMQ / AMQP 0.9.1) and `createMqttTransport` (MQTT 3/5) RPC transport factories — post-enterprise backlog items #24b + #24c.

  - **AMQP**: publisher confirms, per-topic (exchange, routingKey, queue) route specs, configurable prefetch, `requeueOnHandlerError` (default `false` so a broker-side DLX picks up handler failures), three decode-fail policies (`ack` / `requeue` / `nack-no-requeue`). Dynamic-import-loads `amqplib@^0.10` to align with `@declaragent/source-amqp`.
  - **MQTT**: QoS 0/1/2 per-topic with default QoS 1 (at-least-once), MQTT 5 shared subscriptions via `sharedSubscriptionGroup` rewriting to `$share/<group>/<topic>`, client-side topic-wildcard matching (`+` / `#`), optional `dlqPublish` hook for malformed payloads. Dynamic-import-loads `mqtt@^5` to align with `@declaragent/source-mqtt`.
  - MQTT semantics gap vs other transports documented in the top-of-file comment: MQTT 3 has no per-message handler ack, so handler throw cannot trigger transport-layer redelivery. Use Kafka/JetStream/SQS/AMQP for capabilities that require retry-on-handler-error.

  Both factories exported from `@declaragent/plugin-agent-rpc`; 39 new unit tests with mocked clients (no live-broker gated tests shipped this sprint).

- Updated dependencies [0649786]
- Updated dependencies [606f8c2]
  - @declaragent/core@0.5.3

## 4.0.2

### Patch Changes

- cfb5dbe: feat(transport): `createSqsTransport` for at-least-once RPC over Amazon SQS (#24a)

  Third broker in the at-least-once family alongside `createKafkaTransport` (#7 / Slice 7) and `createJetStreamTransport` (#23). Partial delivery on backlog item #24 — SQS ships in 0.7.3; AMQP + MQTT are sequenced for Sprint 4 (0.7.4).

  Shape mirrors the Kafka + JetStream factories: the envelope contract and `pending-registry` are unchanged, so `createRequestAgentTool` + `createAgentInboxAdapter` plug in via `transportFactories.sqs` exactly like the existing factories.

  Delivery semantics:

  - `publish(topic, envelope)` → `SendMessage` against the mapped `queueUrl`. FIFO queues (URL suffix `.fifo`) are auto-detected; `messageGroupId` defaults to `envelope.to` (serializes requests per target-agent) and `messageDeduplicationId` accepts a resolver for queues without content-based dedup.
  - `subscribe(topic, handler)` → per-topic long-poll loop (defaults: 20 s wait, 10 messages per batch, 10 in-flight). Handler success → `DeleteMessage`. Handler throw → leave the message undeleted so SQS's visibility-timeout + `maxReceiveCount` → native DLQ redrive fires.
  - Decode failures are terminal; three operator-selectable policies: `'delete'` (default — log + remove; matches JetStream's `term`), `'leave'` (let SQS redrive until queue-native DLQ kicks in), `'send-dlq'` (forward to an operator-owned `dlqQueueUrl` + delete from main).
  - `close()` stops every poll loop, drains in-flight handlers, and disconnects the SDK client.

  Config accepts a static `queueUrls` map, a dynamic `queueUrlFor` resolver, or both (resolver wins). Credentials default to the AWS SDK chain (IAM role / env / shared config); static creds + custom `endpoint` are supported for LocalStack. The AWS SDK is loaded via dynamic import so this package stays dep-free until used.

  Unit tests (22 cases) cover: kind, publish to standard + FIFO with auto-/explicit `messageGroupId` + dedup-id resolvers, subscribe success-delete + handler-throw-leave, three decode-fail policies, DLQ-without-url rejection, missing-queue rejection, close idempotency, unsubscribe teardown, transient receive-failure retry, and factory-vs-injected-client wiring. The live-broker round-trip reuses `@declaragent/source-sqs`'s LocalStack fixtures behind `SQS_INTEGRATION=1`.

- Updated dependencies [eda26e5]
  - @declaragent/core@0.5.2

## 4.0.1

### Patch Changes

- 11c494d: feat(transport): `createJetStreamTransport` for at-least-once RPC with replay (#23)

  Adds a new transport factory alongside `createNatsTransport` + `createKafkaTransport` that uses NATS JetStream for persistent, at-least-once request/response delivery — the right default when RPC envelopes represent side-effectful actions ("charge this card") rather than telemetry.

  Shape mirrors the Kafka transport: per-topic durable consumers, explicit ack on handler success, nak on handler throw (JetStream redelivers after `ackWaitMs`), and `term` on malformed payloads. Publish is server-acked via `js.publish()`. The envelope + pending-registry contract is unchanged — callers plug this into `transportFactories` exactly like the existing factories.

  Options cover the common production knobs: `stream` + `durableName` (operator-provisioned), `ackWaitMs` (default 30s), `maxDeliver` (default 5), `replay: 'instant' | 'original'`, `deliverPolicy: 'all' | 'last' | 'new'` (default `'new'`), plus the usual `subjectPrefix` / auth fields. `kind: 'nats'` is preserved — JetStream is an overlay on the same wire protocol, and introducing a fourth `RpcTransportKind` would ripple through every loader + builder type enum for no operational gain.

  Unit tests cover publish/subscribe/ack/nak/term, unsubscribe tearing down the consume loop, subject prefixing, replay-policy passthrough, and bind-to-existing consumer semantics. A live-broker test lives at `packages/testkit/src/fleet-integration/jetstream-rpc.test.ts` behind `FLEET_INTEGRATION=1 NATS_INTEGRATION=1`; it asserts round-trip latency + handler-throws-then-redelivery.

- Updated dependencies [c8e87e6]
- Updated dependencies [e9abb80]
  - @declaragent/core@0.5.1

## 4.0.0

### Patch Changes

- 8651c54: `createNatsTransport` now accepts `queueGroups` as either a blanket string (same semantics as the legacy `queueGroup`) or a per-topic `Record<topic, group>` map. Real fleets routinely mix load-balanced and fan-out topologies on one NATS cluster — `agents.beta.requests` needs a shared queue so replicas load-balance, while `agents.broadcast.health` needs no queue so every replica sees the heartbeat. A single construction-time queue group can't express both; the new shape does.

  Backward compatible: the pre-existing `queueGroup` option keeps working and now acts as the fallback for topics unlisted in `queueGroups`. An explicit empty-string entry opts that topic out of any queue group. Addresses post-enterprise backlog item #25.

- 2e60de4: **Security sprint follow-ups from `POST_ENTERPRISE_BACKLOG.md` — items #8 + #9.**

  - **#8 — `AUTH_REJECTED` promoted to `RPC_ERROR_CODES`.** Previously the envelope auth-reject path in `packages/cli/src/fleet-run.ts` stamped a bare `'AUTH_REJECTED'` string on the response envelope. The constant now lives on `@declaragent/core`'s canonical `RPC_ERROR_CODES` map alongside `AUTH_FAILED`, `VERSION_SKEW`, etc. The wire value is intentionally preserved (unprefixed `'AUTH_REJECTED'`) for back-compat with 3.0.0 receivers that pattern-match the literal — callers migrating should import `RPC_ERROR_CODES.AUTH_REJECTED` from `@declaragent/core`. Covered by `packages/core/src/rpc/errors.test.ts`.

  - **#9 — Capability schema-violation audit cardinality pinned per-envelope.** The emit contract on `CapabilitySchemaViolationEmitter` (in `@declaragent/plugin-agent-rpc`) + the `capability_schema_violation` audit record (in `@declaragent/core`) was already batched per envelope, but the decision was only implicit. Added explicit `POST_ENTERPRISE_BACKLOG.md #9` JSDoc + a regression test in `request-agent.test.ts` that trips 3 violations in one payload and asserts the emitter fires exactly once with all violations in the array. This caps SIEM volume under bad-actor / mass-rejection traffic — a single misconfigured envelope can trip every field in a large schema, and a per-violation emit would multiply audit rows by the schema's field count.

  No breaking changes. `@declaragent/cli` patch bump picks up the `RPC_ERROR_CODES.AUTH_REJECTED` wire swap in `fleet-run.ts`.

- Updated dependencies [1bc842d]
- Updated dependencies [b69d717]
- Updated dependencies [2e60de4]
  - @declaragent/core@0.5.0

## 3.0.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
  - @declaragent/core@0.4.0

## 2.0.0

### Patch Changes

- Updated dependencies [da8f330]
- Updated dependencies [579362c]
- Updated dependencies [778f505]
- Updated dependencies [a4ba7a4]
- Updated dependencies [9a6c64f]
  - @declaragent/core@0.3.0

## 1.0.0

### Minor Changes

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
