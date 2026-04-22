# Agent RPC — Implementation Plan

**Status:** Draft for review. Positioned as a post-GA v1.1 track (Phase 8 ergonomically, but slotted for "v1.1 Agent Graph" so the v1.0 config-freeze promise from `PHASE_7_PLAN.md` §10 isn't broken).
**Last updated:** 2026-04-19.

The current runtime ships transport (source adapters for Kafka/NATS/SQS/AMQP/MQTT) and an in-process agent-to-agent message primitive (`Mailbox`). What's missing is a **standardized request/response protocol** so agents in separate deployments can call each other like typed functions, maintain correlation back to the originating user, and surface a coherent trace across the hop.

This plan specifies the protocol (an envelope format + topic conventions), the runtime primitives (one tool, one source type, one `ToolContext` addition), and the slice breakdown to land it without reopening the v1.0 frozen surfaces.

The forcing function is the real scenario from `docs/PHASE_7_PLAN.md` §7 — a Slack concierge delegating to a PR-reviewer agent, both running in separate Cloud Run services, routing through a broker, and returning the result to the originating Slack thread with the trace intact.

---

## 1. Goals and non-goals

**Goals.**
- **Standardized envelope.** `AgentRpcEnvelope` v1 Zod schema frozen at v1.1. Every broker hop serializes + validates this shape. Versioned (`version: 1`); additive-only evolution within v1, breaking changes via `version: 2`.
- **Producer surface — one tool.** `RequestAgent({ to, capability, payload, timeoutMs?, mode? })` in `@declaragent/plugin-agent-rpc`. Three modes:
  - `sync` (default) — await a response with a timeout; returns `ok | error | timeout`.
  - `async` — return a `correlationId` immediately; the response later lands on the bus as an `agent.rpc.response` event.
  - `fire-and-forget` — publish an `event`-kind envelope; no replyTo, no correlation.
- **Consumer surface — one source type.** `agent-inbox` adapter that wraps any transport (Kafka/NATS/SQS/AMQP/MQTT), decodes envelopes, and auto-routes:
  - `kind: 'request'` → dispatch to skill named after `envelope.capability`.
  - `kind: 'response'` → wake the pending correlation in the local pending-RPC registry.
  - `kind: 'event'` → broadcast on the local bus.
- **Reply primitive.** New `ToolContext.respond(result)` method — skills publish a response envelope to the requestor's `replyTo`. Auto-populated from the current request context; calling it is optional (default `assistant.final` fallback ships).
- **Transport pluggability.** The envelope is broker-agnostic. Transport adapters are thin wrappers (≤ 200 LOC each) that speak the envelope over their wire format.
- **Capability discovery.** Optional `capabilities.yaml` per agent declaring what it can serve + on what transport + with what schemas. Registry aggregation is user-managed (a git-tracked file; no server).
- **Multi-tenant scope preservation.** Envelope carries `tenantId`; receiving adapter enforces match against its bus scope. Cross-tenant RPC throws `TenantBoundaryError` before dispatch.
- **Observability.** Per-hop traces via `correlationId`. Per-capability Prometheus counters + latency histograms. Every request + response an audit record.
- **Conformance test.** A compile-time + runtime suite every transport plugin MUST pass to claim the `agent-inbox` / `@declaragent/plugin-agent-rpc` compat tag.

**Non-goals.**
- **No new transport protocols.** Build on existing `source-*` adapters; HTTP-as-broker, gRPC, raw WebSockets are explicitly out of scope. If you want HTTP, use a webhook source.
- **No managed service registry.** `capabilities.yaml` is a local, git-tracked file. Central aggregation (a "declaragent registry list --org" sort of thing) is a v1.2 track.
- **No RPC streaming abstraction.** Async + multiple `ctx.respond()` calls per correlationId approximate streaming; a first-class streaming protocol is deferred.
- **No automatic retries.** Producer-side `timeoutMs` returns `{ status: 'timeout' }`. Retries are the caller's explicit choice — same contract as `fetch`.
- **No cross-tenant RPC in v1.** Envelope `tenantId` must match both sides' bus scope. Cross-tenant is a v1.2 feature (needs a trust-issuer authority).
- **No network-layer mTLS / managed auth.** Envelope carries a simple `auth: { kind: 'internal' | 'signed-hmac' }`. mTLS / JWT / SPIFFE is a transport-layer concern; adapters expose hooks but don't prescribe a choice.
- **No Windows-specific pathways.** Same constraint as Phase 7.
- **No auto-scaling of the pending-RPC registry.** Process-local, bounded. Producers that exceed capacity are shed with a typed error (§8 open question).

---

## 2. Conceptual architecture

```
  Producer daemon                                          Consumer daemon
  ─────────────────                                        ─────────────────
  bus.publish(evt)                                        (agent-inbox subscribes
        │                                                  to agents.<self>.requests)
        │ (engine loop)                                            │
        ▼                                                          │
  ┌──────────────┐                                                 │
  │ Tool:        │                                                 │
  │ RequestAgent │─┐                                               │
  │  (sync mode) │ │ 1. build envelope                             │
  └──────────────┘ │ 2. register pending correlation              │
                   │ 3. publish to replyTopic                      │
                   ▼                                               │
          ┌─────────────────────┐     broker transport            │
          │ Transport publisher │──────────────────────────────►  │
          │  (Kafka / NATS / …) │    agents.<to>.requests          ▼
          └─────────────────────┘                         ┌────────────────┐
                   ▲                                      │ agent-inbox    │
                   │  4. response envelope                │  source        │
                   │     (correlationId matches)          │  (decode +     │
                   │                                      │   validate)    │
                   │                                      └───────┬────────┘
          ┌─────────────────────┐                                 │
          │ agent-inbox source  │◄── agents.<self>.responses ──── │ ctx.respond()
          │  (decode, lookup    │     (replyTo topic)             │
          │   correlation)      │                                 ▼
          └─────────┬───────────┘                          ┌──────────────┐
                    │ 5. wake pending promise              │ Skill:       │
                    │                                      │  review-pr   │
                    ▼                                      └──────────────┘
          ┌──────────────┐                                         ▲
          │ Tool:        │                                         │ dispatcher
          │ RequestAgent │                                         │ routes by
          │  → returns   │                                         │ envelope
          │    to engine │                                         │ .capability
          └──────────────┘                                         │
```

**Invariant threading.** Every envelope flowing L→R and R→L carries the same
`correlationId`. `causedBy` is a linked list back to the originating event.
`tenantId` is the scope guard; mismatch fails closed at the consuming bus.

**Process-local pending-RPC registry.** The producer side holds a map `correlationId → { resolve, reject, timer, deadline }`. Capacity-bounded (default 10_000). Populated on `RequestAgent` invocation, consumed on matching `response` delivery, expired on `timeoutMs`. Process restart drops pending — the caller's `await` rejects with a typed error; the engine loop surfaces it as a `tool_result` with `code: 'EAGENTRPC_ABANDONED'`.

**Transport contract.** Every supported broker implements a tiny interface:

```ts
export interface RpcTransport {
  readonly kind: 'kafka' | 'nats' | 'sqs' | 'amqp' | 'mqtt';
  publish(topic: string, envelope: AgentRpcEnvelope): Promise<void>;
  subscribe(topic: string, handler: (envelope: AgentRpcEnvelope) => Promise<void>): () => void;
  close(): Promise<void>;
}
```

Each transport plugin produces an `RpcTransport` factory that the producer + consumer share. No transport-specific shape leaks into `RequestAgent` or `agent-inbox`.

---

## 3. The envelope and the topic convention

### 3.1 `AgentRpcEnvelope` v1

```ts
export interface AgentRpcEnvelope {
  /** Protocol version. v1.1 freezes this at 1. Breaking changes bump this. */
  version: 1;
  kind: 'request' | 'response' | 'event';
  /** UUID; per-message. */
  messageId: string;
  /**
   * Request.correlationId === response.correlationId. For `event` kind,
   * optional but recommended so downstream audit traces join.
   */
  correlationId: string;
  /** Prior messageId; feeds dispatcher loop-detection. */
  causedBy?: string;
  /** Source/destination addresses. `agent://<agent-id>`. */
  from: AgentAddress;
  to: AgentAddress;
  /** Logical function name; maps to a skill on the receiver. */
  capability: string;
  /**
   * Reply destination. Omit for `kind: 'event'`. For `kind: 'request'`,
   * transport + topic pair.
   */
  replyTo?: BrokerAddress;
  /** Absolute ms-epoch; receiver MAY reject when now > deadline. */
  deadline?: number;
  /**
   * Must match the bus scope on BOTH sides. Auto-stamped by the
   * producer tool from `ToolContext.tenant.id`. Mismatch = `TenantBoundaryError`.
   */
  tenantId?: string;
  /** Opaque transport annotations (routing hints, trace headers). */
  headers?: Record<string, string>;
  /** Capability-specific JSON payload. */
  payload: unknown;
  /** Authenticator; default `{ kind: 'internal' }` for intra-cluster calls. */
  auth?: RpcAuth;
}

export type AgentAddress = `agent://${string}`;
export type BrokerAddress =
  | `kafka://${string}`
  | `nats://${string}`
  | `sqs://${string}`
  | `amqp://${string}`
  | `mqtt://${string}`;

export type RpcAuth =
  | { kind: 'internal' }
  | { kind: 'hmac'; keyId: string; signature: string };

/** Response payload when status !== 'ok'. */
export interface RpcError {
  code: string;
  message: string;
  /** Optional stack / cause for debug builds. */
  details?: unknown;
}
```

Lives in `@declaragent/core/src/rpc/envelope.ts`. Tagged `@since 1.1.0`. Zod schema + type-level + runtime validation in the same file.

### 3.2 Topic topology

Defaults (overridable per-agent):

```
agents.<agent-id>.requests        # inbox — durable
agents.<agent-id>.responses       # replyTo target — ephemeral is fine
agents.<agent-id>.events          # pub/sub fan-out; optional
```

Multi-tenant extension:

```
agents.<agent-id>.<tenantId>.requests
agents.<agent-id>.<tenantId>.responses
```

Per-transport specifics:
- **Kafka:** topics with configurable partition count; keyed by `correlationId` for partition affinity during response routing.
- **NATS JetStream:** subjects; one durable consumer per process.
- **SQS:** queues; FIFO for requests (when capability declares `idempotent: false`), standard otherwise.
- **AMQP:** queues on a per-agent exchange with topic routing keys.
- **MQTT:** topic filters; QoS 1 for requests/responses.

### 3.3 Address scheme

- `agent://<agent-id>` — logical address. `<agent-id>` matches `agent.yaml.name` (plus an optional `@<version>` tag for blue-green).
- `broker://<transport>/<path>` — concrete topic. Resolved at publish time; overridable by the receiver's `capabilities.yaml`.
- A producer MAY specify either; if it passes `agent://…`, the transport is resolved via the local registry (`capabilities.yaml` or a flat `rpc-peers.yaml` config).

---

## 4. Runtime primitives

### 4.1 Producer — `RequestAgent` tool

Lives in `@declaragent/plugin-agent-rpc`. Registered via the usual plugin
manifest; adds to `ToolContext.tools` per-agent.

```ts
export interface RequestAgentInput {
  to: AgentAddress;                // "agent://pr-reviewer"
  capability: string;
  payload: unknown;
  timeoutMs?: number;              // default 30_000
  mode?: 'sync' | 'async' | 'fire-and-forget'; // default 'sync'
  /** Caller-supplied idempotency key. Defaults to content-hash. */
  idempotencyKey?: string;
  /** Override the resolved transport; rare, for A/B migrations. */
  transport?: BrokerAddress;
}

export interface RequestAgentOutput {
  status: 'ok' | 'error' | 'timeout' | 'abandoned';
  correlationId: string;
  latencyMs: number;
  response?: unknown;
  error?: RpcError;
}
```

**Permission key:** `RequestAgent:${input.to}/${input.capability}`.
Allows glob-matched ACLs like `allow: "RequestAgent:agent://pr-reviewer/*"`.

**Flow (sync mode):**
1. Build envelope; stamp `from`, `to`, `capability`, `correlationId` (reuse
   `ctx.correlationId` when set — threading the cause), fresh `messageId`,
   `tenantId` from `ctx.tenant.id`.
2. Resolve transport via the local `rpc-peers.yaml` / `capabilities.yaml` /
   explicit `input.transport`.
3. Register in the pending-RPC registry: `{ correlationId: { resolve, reject,
   timer, deadline } }`.
4. Publish to `agents.<to>.requests`.
5. `await` — settled by either:
   - a matching `response` envelope delivered through the local `agent-inbox`,
   - `timeoutMs` elapsing,
   - daemon shutdown (rejects with `{ status: 'abandoned' }`).
6. Return typed output.

**Flow (async mode):**
Steps 1–4 identical. Returns immediately with `{ status: 'ok', correlationId }`.
The response arrives later as an `agent.rpc.response` event on the bus; the
caller's LLM can observe it via a `WaitFor({ correlationId })` tool or via
a follow-up turn triggered by the event.

**Flow (fire-and-forget mode):**
Envelope `kind: 'event'`, no `replyTo`, no pending registration. Returns
immediately.

### 4.2 Consumer — `agent-inbox` source

Lives in `@declaragent/plugin-agent-rpc`. Registered as a standard
`EventSourceAdapter` so it plugs into `startDaemon({ sources })` unchanged.

```yaml
# event-sources.yaml
- type: agent-inbox
  config:
    id: inbox
    agentId: pr-reviewer
    transport:
      kind: kafka
      brokers: ${env:KAFKA_BROKERS}
    # Optional overrides; sensible defaults below match §3.2:
    requestsTopic: agents.pr-reviewer.requests
    responsesTopic: agents.pr-reviewer.responses
    eventsTopic: agents.pr-reviewer.events       # optional
    # Shared delivery knobs:
    delivery:
      mode: at-least-once
      ackStrategy: after-dispatch
      idempotency: { strategy: transport-natural, store: sqlite, ttlMs: 900000 }
      dlq: { kind: transport-native, destination: agents.pr-reviewer.requests.dlq }
  # NO explicit `routing` — the adapter owns this, keyed on envelope.kind:
  #   'request'  → skill: envelope.capability
  #   'response' → local pending-RPC registry correlation lookup
  #   'event'    → broadcast on the local bus
```

Internally, the adapter:
1. Decodes + Zod-validates the envelope. Failure → DLQ.
2. Verifies `envelope.tenantId` matches the local bus scope (multi-tenant).
   Mismatch → audit + DLQ.
3. Verifies `envelope.auth` when the agent's config requires it.
4. Builds an `AgentEvent`:
   - `kind` = `agent.rpc.request` | `agent.rpc.response` | `agent.rpc.event`
   - `meta.correlationId`, `meta.causedBy`, `meta.tenantId` all carried.
   - `target` derived per §4.2 rules above.

### 4.3 Reply — `ToolContext.respond()`

Core change. Added to `packages/core/src/types/tool.ts` with `@since 1.1.0`:

```ts
export interface ToolContext {
  // … existing fields …
  /**
   * When the current turn was triggered by an agent-rpc request, publishes
   * a response envelope to the requestor's replyTo topic. Auto-populated
   * from the request context — skills don't see the envelope, only the
   * payload + the respond hook. Idempotent per correlationId; multiple
   * calls produce successive response-kind messages (useful for streaming
   * or progress updates).
   */
  respond?(
    result: { ok: true; data: unknown } | { ok: false; error: RpcError },
  ): Promise<void>;
}
```

Also a default hook in `@declaragent/plugin-agent-rpc` that, when `respond`
hasn't been called by turn-end and the turn was RPC-triggered, publishes
`{ ok: true, data: assistantFinal.content }` automatically. So skills
written for the REPL "just work" over RPC.

---

## 5. Discovery — `capabilities.yaml`

Optional but gold for multi-agent teams.

```yaml
# capabilities.yaml (alongside agent.yaml)
version: 1
agent: agent://pr-reviewer
# Transports the agent is listening on.
transports:
  - kind: kafka
    brokers: ["kafka.internal:9092"]
    topics:
      requests: agents.pr-reviewer.requests
      responses: agents.pr-reviewer.responses
  - kind: nats
    servers: ["nats://nats.internal:4222"]
    subjects:
      requests: agents.pr-reviewer.requests
# Capabilities the agent serves. One entry per skill that's RPC-exposed.
capabilities:
  - name: review-pr
    description: "Review a GitHub pull request and emit structured findings."
    inputSchema: { $ref: "./schemas/review-pr.input.json" }
    outputSchema: { $ref: "./schemas/review-pr.output.json" }
    timeoutMs: 60000
    idempotent: true
    since: "1.1.0"
    # Optional — which skill answers this. Default: `name`.
    skill: review-pr
```

**Loader.** `loadCapabilitiesConfig({ path })` in `@declaragent/core` returns
a `LoadedCapabilities`. Zod-validated.

**Registry.** Producer-side resolution of `agent://<id>` to a transport +
topic looks up an `rpc-peers.yaml` (or reads a merged registry dir):

```yaml
# rpc-peers.yaml
version: 1
peers:
  - agent: agent://pr-reviewer
    transports:
      - kind: kafka
        brokers: ["kafka.internal:9092"]
        topics:
          requests: agents.pr-reviewer.requests
  - agent: agent://translator
    transports:
      - kind: nats
        servers: ["nats://nats.internal:4222"]
        subjects:
          requests: agents.translator.requests
```

No server required; `rpc-peers.yaml` is a normal git-tracked config. A
`declaragent rpc peers` CLI verb prints the effective peer table.

A future v1.2 can add a `--registry http://registry.internal/peers.yaml`
flag that pulls the same shape from a central endpoint on daemon start.

---

## 6. Slice breakdown

Same approach as the Phase plans: thin vertical slices, each independently
mergeable, critical path serialized with parallel legs.

### Slice 0 — Envelope + `ToolContext.respond()` core changes (~1.5 days)
- `packages/core/src/rpc/envelope.ts` — Zod schema + TS types + `@since 1.1.0`.
- `packages/core/src/rpc/errors.ts` — `RpcError`, `RpcEnvelopeValidationError`.
- `packages/core/src/types/tool.ts` — add `respond?` to `ToolContext`.
- Re-export from `packages/core/src/index.ts`.
- Tests: envelope round-trip, Zod rejects malformed, every field's happy + error path.

### Slice 1 — Pending-RPC registry + `RequestAgent` (no transport yet) (~2 days)
- New package `packages/plugin-agent-rpc/`.
  - `src/pending-registry.ts` — `createPendingRegistry({ capacity, now })`:
    `register(correlationId, { resolve, reject, deadline })`, `settle(correlationId, result)`, `abandon()`, LRU eviction on overflow.
  - `src/request-agent.ts` — the `RequestAgent` tool. Transport dependency
    injected; tests use an in-memory `RpcTransport` stub.
  - `src/types.ts` — `RpcTransport` interface.
- Tests: sync/async/fire-and-forget paths; timeout; overflow (registry full);
  abandonment on shutdown; permission-key format.

### Slice 2 — `agent-inbox` source adapter (transport-stub) (~2 days)
- `packages/plugin-agent-rpc/src/agent-inbox.ts` — implements `EventSourceAdapter<AgentInboxConfig>`.
- Decode + validate envelope. Tenant scope verify. Dispatch rules per §4.2.
- Internal default hook that binds request-originated turns so `ctx.respond()` is wired.
- Tests: request routing to skill; response → pending registry; event → bus;
  malformed envelope → DLQ; tenant-mismatch → audit + DLQ.

### Slice 3 — Kafka transport + templates (~2 days)
- `packages/plugin-agent-rpc-kafka/` — thin wrapper. `createKafkaRpcTransport({ brokers, saslOpts, … })` returns an `RpcTransport`.
- Reuses the existing `@declaragent/source-kafka` internals (KafkaJS client, consumer group management).
- End-to-end integration test via Redpanda in Docker, running from `packages/testkit/kafka`.
- `templates/rpc-agent-a/` + `templates/rpc-agent-b/` — two paired starters that exercise request/response.

### Slice 4 — NATS + AMQP + MQTT + SQS transports (~3 days; parallelizable)
- `packages/plugin-agent-rpc-nats/`, `-amqp/`, `-mqtt/`, `-sqs/`. Same contract.
- Each transport re-uses its existing `source-*` peer for connection management
  so we don't re-implement auth + reconnect logic.
- Conformance test suite (slice 6) validates each.

### Slice 5 — `capabilities.yaml` + peer registry (~1.5 days)
- `packages/core/src/rpc/capabilities-loader.ts` — Zod-validated loader.
- `packages/core/src/rpc/peers-loader.ts` — same shape for `rpc-peers.yaml`.
- `packages/cli/src/rpc-cli.ts` — `declaragent rpc peers` + `declaragent rpc capabilities` verbs; `--json` flag standard.
- Tests: loader happy + error paths; merging multi-source peer tables.

### Slice 6 — Conformance test suite (~2 days)
- `packages/testkit/src/rpc-conformance.ts` — a test function every transport plugin imports:
  `conformsToRpcTransport(transport: RpcTransport)`. Asserts:
  - Publish + subscribe round-trip preserves the envelope byte-for-byte.
  - Idempotent delivery under `at-least-once`.
  - Backpressure signal at the `BusPressureListener` high-watermark.
  - Orderly close.
  - Auth verification hook fires.
- Kafka/NATS/AMQP/MQTT/SQS plugins each wire a test file that calls this.
- Failures block the transport's publish.

### Slice 7 — Observability (~1.5 days)
- Prometheus counters + histograms:
  - `agent_rpc_requests_total{from,to,capability,transport,outcome}`
  - `agent_rpc_latency_seconds{capability,transport}` (producer + consumer sides)
  - `agent_rpc_pending_gauge{agent}` — pending-registry depth.
- Audit record kinds: `agent_rpc_request`, `agent_rpc_response`. Extend `TenantAuditRecord` union. Every hop writes one record; GDPR erase by `correlationId` already tombstones the chain.
- OTel spans: `agent.rpc.request` + `agent.rpc.response` with `from` / `to` / `capability` as span attributes. Trace id === `correlationId`.
- Tests: metric emission; audit-record shape; OTel attribute set.

### Slice 8 — Templates + cookbook + CLI help (~2 days)
- `templates/rpc-client/` + `templates/rpc-server/`: two paired starters.
- `templates/rpc-multi-transport/`: agent A (Kafka) → agent B (NATS) → back to agent A.
- `docs-site/docs/cookbook/agent-rpc.mdx`: walkthrough + sequence diagrams.
- `docs-site/docs/reference/rpc.mdx`: envelope schema, topic conventions, permission key format.
- `declaragent rpc peers --verify` — live-ping every peer's inbox, report unreachable.

### Slice 9 — Soak + release candidate (~1 day)
- Nightly test: three-daemon chain (Slack-concierge → pr-reviewer over Kafka → translator over NATS → back). Run 1k cycles; assert zero drops.
- 7-day soak the RC against the Phase-6 chaos suite.
- `v1.1.0-rc.1` → `v1.1.0` promotion.

**Critical path:** 0 → 1 → 2 → 3 → {4 ∥ 5} → 6 → 7 → 8 → 9. Slices 4 + 5 parallelize. Slice 8's templates depend on slice 3's Kafka transport shipping.

**Total estimate:** ~16 days of focused work.

---

## 7. File layout

```
packages/core/src/rpc/                   # slice 0 + 5
├── envelope.ts
├── errors.ts
├── capabilities-loader.ts
├── peers-loader.ts
├── types.ts
└── index.ts

packages/core/src/types/tool.ts          # slice 0 — add `respond?`

packages/plugin-agent-rpc/                # slices 1 + 2
├── src/
│   ├── request-agent.ts
│   ├── agent-inbox.ts
│   ├── pending-registry.ts
│   ├── types.ts
│   └── index.ts
├── package.json
└── README.md

packages/plugin-agent-rpc-kafka/          # slice 3
├── src/index.ts
└── package.json

packages/plugin-agent-rpc-nats/           # slice 4
packages/plugin-agent-rpc-amqp/           # slice 4
packages/plugin-agent-rpc-mqtt/           # slice 4
packages/plugin-agent-rpc-sqs/            # slice 4

packages/testkit/src/rpc-conformance.ts   # slice 6

packages/cli/src/rpc-cli.ts               # slice 5
packages/cli/src/rpc-cli.test.ts

templates/rpc-client/                     # slice 8
templates/rpc-server/                     # slice 8
templates/rpc-multi-transport/            # slice 8

docs-site/docs/cookbook/agent-rpc.mdx     # slice 8
docs-site/docs/reference/rpc.mdx          # slice 8

.github/workflows/rpc-soak.yml            # slice 9 (nightly)
```

---

## 8. Touch points into existing code

Agent RPC is deliberately a plugin layer on top of v1.0 primitives. The only
core touches:

- `packages/core/src/types/tool.ts` — add optional `respond` to `ToolContext`
  (additive; every existing Tool stays backward-compatible).
- `packages/core/src/rpc/**` — net-new.
- `packages/core/src/audit/types.ts` — extend `TenantAuditRecord` union with
  `AgentRpcRequestRecord` + `AgentRpcResponseRecord`. Additive.
- `packages/core/src/index.ts` — re-export new types.
- `packages/cli/src/index.tsx` — add `rpc` subcommand router.

The engine loop, dispatcher, event bus, session store, permission gate, quota
tracker, audit sink, channel adapters, source adapter SDK — **unchanged**.

---

## 9. Testing strategy

Seven tiers.

1. **Unit.** Every new file's `*.test.ts`. Envelope round-trip, Zod rejects,
   pending-registry LRU, permission-key format, transport stubs.
2. **Integration.** In-memory transport: two processes on the same bus
   exchanging envelopes. Covers producer + consumer + respond hook without
   a real broker.
3. **Transport smoke.** One Docker-composed broker per transport
   (Redpanda for Kafka, nats-server for NATS, rabbitmq for AMQP, mosquitto
   for MQTT, localstack for SQS). Two `agent-rpc` daemons connect + exchange.
4. **Conformance.** Every transport plugin imports the slice-6 conformance
   suite. Failures block publish.
5. **Multi-tenant isolation.** Two tenants, same capability name, different
   topics. Verifies `tenantId` mismatches throw at the boundary.
6. **Chaos.** RPC under broker loss, slow consumers, broker partition,
   pending-registry overflow. Leans on the Phase-6 chaos rig already in
   `packages/testkit/chaos`.
7. **Nightly soak.** 1k-cycle three-daemon chain; zero drops; p99 latency
   bound.

Baseline test count: **1594 pass** at the start of Phase 8. Every slice must
add tests, not regress existing ones.

---

## 10. Security

Envelope `auth` options:
- `{ kind: 'internal' }` — default for intra-cluster deployments. Trusts
  the bus scope + broker ACLs. Same posture as the current source adapters.
- `{ kind: 'hmac', keyId, signature }` — HMAC-SHA-256 over the canonical
  envelope form (minus the `auth` field itself). Keys managed through
  `secrets.yaml` (Vault / AWS-SM / etc.). `keyId` maps to a per-agent key.

Receivers that require signed envelopes declare it in `agent.yaml`:

```yaml
rpc:
  auth:
    required: hmac
    keysRef: ${secret:vault:kv/acme/rpc-keys}
```

Unsigned / bad-signature envelopes land in the DLQ with an audit record
(`kind: 'tenant_boundary_violation'`, `resource: 'event'`, `blocked: true`).

mTLS / JWT / SPIFFE are transport-layer concerns. The plugin exposes a
`validateAuth(envelope, raw, transportCtx)` hook each transport can override
to run the network's chosen auth check before handoff to the dispatcher.

---

## 11. Open questions

1. **Transport resolution strategy.** Producer resolves `agent://<id>` via
   (a) local `rpc-peers.yaml`, (b) the receiver's published `capabilities.yaml`
   fetched out-of-band, or (c) a central registry. Slice 5 ships (a). (b) +
   (c) are v1.2.
2. **Pending registry overflow behavior.** When the producer is mid-burst
   and the registry hits capacity, do we (a) reject the new `RequestAgent`
   call with `{ status: 'error', code: 'EAGENTRPC_BUSY' }`, (b) evict the
   oldest pending and `reject` its Promise, or (c) block the engine loop?
   **Lean:** (a). Consistent with the `permissions.recordDenial` +
   `EQUOTA` path — the LLM gets a typed error, can retry or back off.
3. **Response topic partitioning.** On Kafka, `agents.<self>.responses` is
   keyed by `correlationId` — but N producer daemons consume the same
   topic, causing double-delivery. Fix: each daemon uses a distinct
   consumer group per daemon id. Add a `daemonId` override to the
   adapter config.
4. **`tenantId` trust.** The receiving adapter trusts the envelope's
   `tenantId` for routing. A bad actor who can publish to `agents.<x>.requests`
   could spoof a tenant. Mitigation: require `auth: hmac` in multi-tenant
   deployments. Alternative: encode `tenantId` in the topic name
   (`agents.<x>.<tenantId>.requests`) and derive from topic at decode time.
   **Lean:** topic-encoded for multi-tenant; envelope field is an assertion
   the receiver verifies matches.
5. **Response-topic scoping per session.** A producer could subscribe to
   `agents.<self>.responses.<sessionId>` instead of the shared topic,
   eliminating the correlationId-based lookup. Tradeoff: thousands of
   ephemeral topics vs one shared topic with filtering. **Lean:** shared
   topic + correlation registry. Simpler; doesn't pressure the broker's
   topic metadata.
6. **Sync vs async as the default.** `RequestAgent` defaults to sync for
   ergonomics — LLMs treat it like a function call. But `timeoutMs = 30s`
   default pins the engine loop open. Consider `async` default with an
   explicit `--sync` mode. **Lean:** sync default; we already hold the
   tool-call slot + quota during the await, which is the honest cost.
7. **Streaming progress updates.** `ctx.respond()` idempotent-per-correlationId
   allows multiple responses. But the producer's sync-mode `await` returns
   after the first. Do we add a fourth mode `stream` that yields to the
   caller? **Lean:** defer to v1.2. Async mode + follow-up `WaitFor` is
   enough for v1.1.
8. **Cross-tenant RPC.** Currently forbidden. Real federated scenarios
   (tenant A in one org calls a capability published by tenant B in another
   org) need a trust issuer (JWT with claims, OIDC federation). **Lean:**
   v1.2 track. v1.1 hard-rejects cross-tenant at the bus boundary.

---

## 12. Risks

- **Pending-registry memory leak.** If `timeoutMs` is unset and the response
  never arrives, the registry grows unbounded. Mitigation: unconditional
  default timeout (30 s), LRU eviction at capacity, gauge metric.
- **Topic name collisions.** Two teams both claim `agent://summarizer`.
  Mitigation: `rpc-peers.yaml` is git-managed; CI runs `declaragent rpc
  peers --verify` and flags duplicates.
- **Envelope v1 foot-guns.** Fields added in v1.1 that we want to remove in
  v2. Mitigation: Zod `.strict()` rejects unknown fields on the consumer;
  proposing a new field requires a changeset + a soak week on `main`.
- **Transport-specific quirks.** SQS's 256 KiB message cap, NATS's subject
  wildcards, Kafka's compaction. Mitigation: the conformance suite + per-
  transport README documenting gotchas.
- **Double-ack on crash during `respond`.** Consumer acks the request
  before the response publish lands. Mitigation: `ackStrategy: after-dispatch`
  is the default, which waits for `respond()` to settle before acking.
- **Loop explosions.** Agent A calls B calls A. The `causedBy` chain
  catches it at `causedByDepthLimit` (default 5). Mitigation: dashboards
  for `loop-rejected` outcome counts; alert on spikes.

---

## 13. Acceptance check

Practical bar for v1.1:

1. **Three-daemon chain** (Slack → concierge → pr-reviewer over Kafka →
   translator over NATS → back to Slack) completes end-to-end with correct
   correlationId threading. `declaragent events list --correlation <id>`
   on any of the three daemons surfaces all hops.
2. **p99 latency** intra-cluster ≤ 150 ms for a trivial capability on a
   warm broker. Measured; budgeted.
3. **Conformance suite** green for all five shipped transports.
4. **Soak:** 1k-cycle three-daemon chain, 7 days, zero drops, zero loop
   rejections on the happy path.
5. **Multi-tenant isolation:** two tenants, same capability name; a packet
   inspector confirms topic names are scoped + no cross-leakage in logs.
6. **GDPR erase:** `declaragent audit erase --user U123` on agent-A
   tombstones the inbound chat; cascaded erase-by-correlation on
   agent-B + agent-C removes the downstream `tool_call` records.
7. **Every slice ships a changeset.** `release-gate.yml` stays green on
   every merge.

---

## 14. Next step

**First concrete PR:** `packages/core/src/rpc/envelope.ts` + its Zod schema
+ `ToolContext.respond?` addition + `@since 1.1.0` tags. Small, reviewable,
unblocks every subsequent slice.

Expect ~1.5 days to land; 20-30 new tests; every Phase-1-through-7 test
stays green (the core changes are additive).

Once slice 0 lands:
- Slice 1 (pending registry + `RequestAgent`) is 100% test-driven; no
  real broker needed.
- Slice 2 (`agent-inbox` source) likewise, with an in-memory transport.
- Slice 3 (Kafka transport) gates on slice 1 + 2; once it lands, every
  subsequent transport plugin is a shallow copy + rename.

The launch moment is slice 9's three-daemon soak. v1.1 ships when the
green chain holds for 7 days.
