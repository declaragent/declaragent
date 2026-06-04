# Phase 6 — Operations: Implementation Plan

**Status:** Draft for review. Scoped to Phase 6 of `SPEC_AND_PLAN.md` (Operations — production hardening, no milestone tag per the release train).
**Last updated:** 2026-04-17.

Phase 5 shipped the full bidirectional channel stack; the runtime is feature-complete for v1.0 functionality. Phase 6 takes that runtime from *works on a laptop* to *holds up to a third-party pen test, a chaos rig, and a multi-tenant deployment*. The scope is operational — no new product surface, no new adapters. Every slice hardens a seam that already exists.

The **acceptance bar** from `SPEC_AND_PLAN.md §Phase 6`:

> Pen test passes; chaos test (random pod kill every 60s for 1h) shows zero data loss; multi-tenant isolation test shows zero cross-tenant leakage.

This doc lays out the architecture, the contracts that need strengthening, and the sharp edges Phase 6 discovers that nothing before it did — because nothing before it tried to break the runtime on purpose.

---

## 1. Goals and non-goals

**Goals.**
- **Observability maturation.** Prometheus exposition endpoint (in addition to the existing OTel metrics bridge). Alert-rule files shipped alongside the Phase-4/5 Grafana dashboards. Correlation-id discipline verified across every cross-cutting seam.
- **Security hardening.** External threat model (STRIDE per component). Secret-vault integration (Vault, AWS Secrets Manager, GCP Secret Manager, Kubernetes Secrets) wired through the Phase-4 `secretHandler` hook. Secret-resolve audit log. HMAC + timing-safe-compare line-by-line review + a property-based test suite. Dependency vulnerability scanning in CI. Webhook endpoint hardening (TLS requirements, replay protection review).
- **Multi-tenant isolation.** A `TenantContext` that threads through the `EventBus`, `ExtensionRegistry`, `SessionManager`, `SecretResolver`, and audit log. Cross-tenant access is a compile-time + runtime error, not a convention.
- **Chaos testing harness.** A fault-injection driver (`@declaragent/testkit/chaos`) that kills replicas, partitions networks, exhausts watermarks, and expires caches. Assertions run against the live system + Phase-5 observability to prove the SLOs hold through disruption.
- **Compliance scaffolding.** GDPR/SOC2-friendly audit retention, right-to-erasure helper, data-residency labels on sessions + events — enough scaffolding that a Phase-7 GA deployment can land without a policy-retrofit sprint.
- **Release-gate CI**: new workflow that runs chaos + isolation + pen-test-assisted scans on every merge to main.

**Non-goals (Phase 6).**
- Performance tuning beyond what the chaos harness surfaces. p99 latency budgets are Phase-4's acceptance bar; Phase 6 asserts those budgets survive disruption, not that we lower them further.
- New channel adapters, new event sources, new tools. Frozen.
- Cloud-adapter deployments (GCP Cloud Run, AWS Fargate, etc.) — that's Phase 7.
- Managed control-plane authoring (per-tenant provisioning UI, team RBAC dashboards, billing). Control plane is private beta post-v1.0.
- End-user-identity federation (SSO, OIDC) — out of scope for v1.0; the enrollment hook point stays a stub.
- Rewriting any Phase-1 through -5 contract. Phase 6 is additive.
- A "compliance pack" branded as SOC2/HIPAA-ready — we ship the **scaffolding** those audits need, not the certification paperwork.

---

## 2. Conceptual architecture

```
                    ┌──────────────────────────────────────────┐
                    │           TenantContext                  │
                    │    ({ id, labels, secretScope, ... })    │
                    └──────────────────┬───────────────────────┘
                                       │ threaded through every request
                  ┌────────────────────┼────────────────────┐
                  │                    │                    │
                  ▼                    ▼                    ▼
       ┌───────────────────┐  ┌────────────────┐  ┌─────────────────┐
       │   EventBus        │  │  Extension     │  │  SecretResolver │
       │  (per-tenant or   │  │  Registry      │  │  (vault-backed, │
       │   filtered)       │  │  (scoped view) │  │   tenant-scoped)│
       └───────┬───────────┘  └───────┬────────┘  └────────┬────────┘
               │                      │                    │
               ▼                      ▼                    ▼
       ┌───────────────────┐  ┌────────────────┐  ┌─────────────────┐
       │ SessionManager    │  │  Tool dispatch │  │ Audit log       │
       │ (tenant-keyed)    │  │  (tenant gate) │  │ (append-only,   │
       │                   │  │                │  │  tenant-scoped) │
       └───────────────────┘  └────────────────┘  └─────────────────┘


                Observability
  ┌─────────────────────────────────────────────────────────────┐
  │  MetricsRegistry ──► OTel bridge  ──► OTLP collector (Phase 4)│
  │                 └──► Prometheus   ──► /metrics endpoint (new) │
  │  Tracer         ──► OTel spans    ──► trace backend           │
  │  ChannelAuditLogger + event audit ──► persistent sink (new)   │
  └─────────────────────────────────────────────────────────────┘


                Chaos Harness              Security Harness
  ┌───────────────────────────────┐  ┌─────────────────────────────┐
  │ • Kill replica every N sec    │  │ • Dep scan (osv-scanner)    │
  │ • Partition to broker/channel │  │ • Webhook replay detector   │
  │ • Exhaust bus watermarks      │  │ • Secret-leak regex scanner │
  │ • Expire dedup/idempotency    │  │ • Cross-tenant probe suite  │
  │ • Assert SLOs + zero-loss     │  │ • HMAC property tests       │
  └───────────────────────────────┘  └─────────────────────────────┘
```

**Every hardening vector routes through the same five seams.** `TenantContext` is the primary new primitive; the rest are existing contracts growing a "who's asking" parameter.

**Additive-only**: Phase 6 does not change the shape of a tool call, an event, a session, or a channel message. It adds a tenant-scoping context, a set of hardened defaults, and observability surfaces around them. Every Phase-1-through-5 test continues to pass by construction because default tenancy (`TenantContext.DEFAULT`) preserves the Phase-5 single-tenant behavior exactly.

**Composition at daemon startup** (additions over Phase 5):
1. Daemon reads `tenants.yaml` (or falls back to single-tenant default).
2. For each tenant: builds a `TenantContext`, instantiates (or scopes) a `TenantRuntime` containing `{ bus, registry, sessions, secrets, audit, metrics }`.
3. Extensions discovered from `node_modules/@declaragent/*` register once but get a **tenant-scoped view** at invocation.
4. Every inbound event, tool call, and outbound send carries the resolved `tenantId` on `AgentEventMeta` (field already exists from Phase 4) and the `TenantContext` in the `ToolContext` / `SourceDependencies` / `ChannelDependencies` bags.
5. Prometheus `/metrics` endpoint comes up on port 9464 (OTel-convention) alongside the existing daemon HTTP server on 8787; scrape output is labeled by `tenant_id` + the existing `{ id, type }` labels.
6. Chaos harness (when enabled via `DECLARAGENT_CHAOS=1`) injects faults on a configurable schedule; teardown emits a chaos report.

---

## 3. Core contract additions

All additions are backward-compatible. New types live in `packages/core/src/tenancy/types.ts` unless noted.

### 3.1 `TenantContext`

```ts
export interface TenantContext {
  /** Stable identifier, e.g. "acme-prod". Matches `${tenant}` in secret refs. */
  readonly id: string;
  /** Human-readable display name. */
  readonly displayName?: string;
  /** Opaque labels usable for routing + audit retention policy. */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Residency hint for session/event storage. The daemon picks a
   * storage backend per residency; mis-residency is a fail-fast error.
   */
  readonly residency?: 'us' | 'eu' | 'apac' | 'custom';
  /**
   * Audit retention in days. Defaults to `spec.observability.auditRetentionDays`
   * when omitted; tenant-level override wins when set.
   */
  readonly auditRetentionDays?: number;
  /**
   * Per-tenant quota knobs. The runtime enforces these; quota-exceeded
   * events land in the audit log with `reason: 'quota-exceeded'`.
   */
  readonly quotas?: TenantQuotas;
}

export interface TenantQuotas {
  maxActiveSessions?: number;
  dailyTokenUSD?: number;           // mirrors spec.deployment.budget
  maxConcurrentToolCalls?: number;
  maxEventIngressPerSec?: number;
}
```

`TenantContext` is immutable per runtime; a config reload constructs a fresh context + swaps the live runtime atomically (slice 4 details).

### 3.2 `TenantRuntime`

```ts
export interface TenantRuntime {
  readonly tenant: TenantContext;
  readonly bus: EventBus;             // filtered / scoped view
  readonly registry: ExtensionRegistry;
  readonly sessions: SessionManager;
  readonly secrets: SecretResolver;   // tenant-scoped handle
  readonly audit: TenantAuditSink;    // unified + scoped
  readonly metrics: MetricsRegistry;  // labeled with tenant_id
}
```

Every dependency bag (`SourceDependencies`, `ChannelDependencies`, `ToolContext`) grows an optional `tenant?: TenantContext` field. A `TenantRuntime` resolves the full dep bag per-operation.

### 3.3 `TenantAuditSink`

Unifies the Phase-1 audit log, the Phase-5 `ChannelAuditLogger`, and new Phase-6 record kinds (`secret_access`, `tenant_boundary_violation`, `quota_exceeded`). The sink is append-only and optionally tamper-evident (slice 5 options).

```ts
export type TenantAuditRecord =
  | ToolCallAuditRecord          // Phase 1
  | ChannelEventAuditRecord      // Phase 5
  | ChannelToolCallAuditRecord
  | ChannelOutboundAuditRecord
  | SecretAccessAuditRecord      // NEW
  | TenantBoundaryAuditRecord    // NEW
  | QuotaExceededAuditRecord;    // NEW

export interface SecretAccessAuditRecord {
  kind: 'secret_access';
  ts: number;
  tenantId: string;
  ref: string;              // e.g. "secret:acme-prod/kafka_password"
  requester: string;        // session id, skill name, adapter id
  outcome: 'resolved' | 'denied' | 'error';
  error?: { message: string; code?: string };
  /** Value is NEVER stored — only the ref + outcome. */
}

export interface TenantBoundaryAuditRecord {
  kind: 'tenant_boundary_violation';
  ts: number;
  sourceTenantId: string;
  targetTenantId: string;
  resource: 'event' | 'session' | 'secret' | 'tool' | 'audit';
  resourceId: string;
  blocked: boolean;          // always true in v1.0; logged for triage
}

export interface QuotaExceededAuditRecord {
  kind: 'quota_exceeded';
  ts: number;
  tenantId: string;
  quota: keyof TenantQuotas;
  limit: number;
  observed: number;
}
```

### 3.4 `SecretProvider` — vault-backed resolver

Phase-4's `SecretResolver` exposed a `secretHandler?: (path: string) => Promise<string>` hook. Phase 6 ships four concrete implementations under `packages/core/src/secrets/providers/`:

```ts
export interface SecretProvider {
  /** Stable label for audit + diagnostics. */
  readonly type: 'vault' | 'aws-sm' | 'gcp-sm' | 'k8s' | 'env';
  /**
   * Resolve a reference. `path` is the portion after `secret:` in the
   * ref — tenant-scoped per `TenantContext.id`. Providers may reject
   * paths that don't match their scoping rules.
   */
  resolve(path: string, ctx: SecretResolveContext): Promise<string>;
  /**
   * Report per-secret metadata without resolving the value. Used by
   * the rotation audit to detect stale secrets.
   */
  metadata?(path: string, ctx: SecretResolveContext): Promise<SecretMetadata>;
  /** Graceful shutdown for any cached sessions (Vault token renewal, etc.). */
  close?(): Promise<void>;
}

export interface SecretResolveContext {
  readonly tenant: TenantContext;
  /** The actor resolving the secret — session id, skill name, adapter id. */
  readonly requester: string;
}

export interface SecretMetadata {
  lastRotatedAt?: number;    // ms-epoch
  version?: string;
  ttlMs?: number;
}
```

The Phase-4 `createDefaultSecretResolver` grows a `providers: SecretProvider[]` option; first-match-wins based on a `type:` prefix in the ref (`vault:path`, `aws-sm:path`, etc.). Back-compat: refs without a type prefix route to the configured default provider.

### 3.5 `ChaosPolicy`

New, lives in `@declaragent/testkit/chaos`:

```ts
export interface ChaosPolicy {
  /** How often to fire a fault. Deterministic clock for tests. */
  readonly intervalMs: number;
  /** Probability 0-1 of firing a fault on each tick. */
  readonly probability: number;
  /** Which fault kinds are eligible; chosen uniformly. */
  readonly faults: readonly ChaosFault[];
  /** Stop after this many faults. Undefined = run forever. */
  readonly budget?: number;
}

export type ChaosFault =
  | { kind: 'kill-replica'; replicaId: string }
  | { kind: 'partition-broker'; broker: string; durationMs: number }
  | { kind: 'partition-channel'; channelId: string; durationMs: number }
  | { kind: 'bus-high-watermark'; excessFactor: number; durationMs: number }
  | { kind: 'expire-idempotency-cache' }
  | { kind: 'clock-skew'; offsetMs: number; durationMs: number }
  | { kind: 'network-latency'; target: string; extraMs: number; durationMs: number };
```

---

## 4. Observability maturation

### 4.1 Prometheus exposition

A new `PrometheusExporter` bridges the existing `MetricsRegistry` to Prometheus text-format scrapes.

```ts
export interface PrometheusExporterOptions {
  /** MetricsRegistry to read. Typically `deps.metrics`. */
  registry: MetricsRegistry;
  /** HTTP listen port. Default: 9464 (OTel convention). */
  port?: number;
  /** Path for scrapes. Default: '/metrics'. */
  path?: string;
  /** Inject tenant label on every sample. Default: true when in multi-tenant mode. */
  includeTenantLabel?: boolean;
}

export function startPrometheusExporter(opts: PrometheusExporterOptions): PrometheusHandle;
```

Implementation details:
- No peer dep. We emit OpenMetrics text directly (~200 lines).
- Labels inherit from the MetricsRegistry's existing `{ id, type, ... }` set; when `includeTenantLabel` is on we add `tenant_id` automatically by walking the `RecordingMetricsRegistry`-style samples and stamping the active tenant context.
- Histograms export `_bucket` + `_count` + `_sum` per OpenMetrics convention.
- The `/metrics` endpoint is authenticated by default: it rejects non-localhost connections unless `allowRemote: true`. Matches the Phase-3 daemon control-socket model.

### 4.2 Alert rules

Ship `packages/testkit/alerts/` with Prometheus-format YAML:

```
alerts/
├── channels.rules.yaml         # outbound failure rate > 1%, rate-limit sustained
├── event-sources.rules.yaml    # sustained lag, DLQ growth, connection-error storm
├── whatsapp-windows.rules.yaml # template-reject spike, tier health drop
├── security.rules.yaml         # secret_access.denied burst, tenant_boundary_violation any
├── chaos-assertions.rules.yaml # chaos-run-only rules
└── daemon.rules.yaml           # bus inflight stuck, session spawn stall, heartbeat timeout
```

Every alert references a metric already emitted (Phase 4/5). Alert severity levels: `warning` (degraded) and `critical` (SLO-breaking). Each rule includes a `runbook_url` annotation pointing at `docs/runbooks/<alert-name>.md`.

### 4.3 Correlation-id discipline

An audit pass verifies that `event.meta.correlationId` flows through every cross-cutting seam:

- `AgentEvent.meta.correlationId` → `ToolContext.correlationId` → tool-emitted events.
- Channel outbound events inherit from inbound via the `ChannelOutboundBridge`.
- Sub-agent spawns inherit from parent via `runAgent(input, { causedBy })`.
- Prometheus + OTel spans include it as an exemplar label where applicable.

The audit is a one-time grep+fix pass in slice 1; no code changes expected unless drift is found.

### 4.4 Runbooks

`docs/runbooks/<alert-name>.md` — one per alert rule. Each runbook follows:

1. **Symptom.** What the operator sees on the dashboard.
2. **Likely cause.** Top 3 with decision tree.
3. **Immediate mitigation.** Rate-limit, circuit-break, fail-open, whatever the rule can't decide.
4. **Root-cause investigation.** Specific commands to run (`declaragent events replay`, `declaragent dlq list`, etc.).
5. **Post-incident.** What to capture, when to close, when to post-mortem.

Slice 2 writes these for the alerts shipped; follow-up hardening can grow them.

---

## 5. Security hardening

### 5.1 Threat model document

A single `docs/THREAT_MODEL.md` walked through with the STRIDE methodology, per component:

- **Core engine + permission gate.** Tool-call escape paths, privilege elevation via plugin, session-id spoofing.
- **Event bus + sources.** Webhook replay, HMAC bypass, broker spoofing, schema injection.
- **Channels.** Token theft, platform-side account takeover, privileged-intent escalation, template abuse.
- **Tools.** Bash sandboxing, file-system traversal, subprocess credential inheritance.
- **MCP client.** Server-spoofing, stdio injection, long-running-server resource drain.
- **Secret resolver.** Ref-substitution injection, log exfiltration, rotation-window divergence.
- **Daemon + control plane.** Socket-auth bypass, reload-race, hot-reload with config drift.

Each component → threat table → mitigations → residual risk. External reviewer sign-off required before the phase ships.

### 5.2 Secret-vault integration

Four providers in `packages/core/src/secrets/providers/`:

| Provider        | Ref example                           | Auth            |
|-----------------|---------------------------------------|-----------------|
| HashiCorp Vault | `vault:secret/data/acme/kafka`        | AppRole / token |
| AWS SM          | `aws-sm:us-east-1/acme-prod/kafka`    | IRSA / SDK chain |
| GCP SM          | `gcp-sm:projects/acme/secrets/kafka`  | WIF / ADC        |
| K8s Secrets     | `k8s:acme-prod/kafka-secret/password` | in-cluster SA    |

All providers:
- Zero peer dep by default — fetch-based against the provider's public API. Callers that want SDKs install them optionally.
- Cache resolved values in memory with a caller-configurable TTL (`ttlMs`). Defaults: Vault uses lease duration; AWS SM uses `rotationEnabled`-aware TTL; GCP SM and K8s use 5-minute default.
- Emit `secret_access` audit records on every resolve (success + failure).
- Support rotation: providers expose `metadata.lastRotatedAt`; a periodic reconciler (opt-in) warns when a live secret hasn't rotated in > `rotationExpectedDays`.

### 5.3 Secret-resolve audit

Every `${secret:...}` resolution produces an audit record:

```
secret_access | ts | tenantId=acme-prod | ref="secret:acme-prod/kafka_password"
              | requester="channel:slack-prod" | outcome=resolved
```

The value is **never** persisted, logged, or forwarded to stdout. A property-based test in slice 3 exercises 10,000 random secret values + verifies none appear in any audit record or log line.

### 5.4 HMAC + timing-safe-compare audit

Line-by-line review of every callsite:

- `packages/core/src/events/sources/webhook.ts` — HMAC + bearer auth.
- `packages/channel-slack/src/instance.ts` — Slack request-signature verification.
- `packages/channel-whatsapp/src/instance.ts` — `X-Hub-Signature-256` verification + verify-token handshake.
- `packages/channel-discord/src/instance.ts` — Ed25519 signature (currently a stub warn; slice 4 lands actual verification via Node's `crypto.verify`).

Property-based tests in slice 4:
- Fuzz every HMAC comparison with length-mismatched strings — expect timing-safe rejection in all cases.
- Replay-window tests: verify every webhook path rejects messages older than its configured window.
- Prefix-attack tests: confirm no `startsWith` / `===` / `!==` path for HMAC comparison anywhere.

### 5.5 Dependency scanning

New GitHub Actions job `deps-scan.yml`:

- Runs `osv-scanner` against `bun.lock` + every package's `package.json`.
- Fails the build on any CRITICAL vulnerability; reports HIGH as warnings (review-required).
- Separate workflow `npm-audit.yml` runs `bun pm audit` for double-coverage.
- Cadence: every PR + nightly scheduled run against `main`.
- Exception allow-list lives in `.osv-ignore.yml` with required expiry date + justification comment; CI enforces expiry.

### 5.6 Webhook endpoint hardening

A pen-test-oriented audit of every HTTP entry-point:

- **TLS required**: the daemon refuses to register webhook paths on non-HTTPS base URLs outside of localhost. Overridable for dev via explicit `insecureDev: true`.
- **Body-size limits**: default 1 MiB per request; configurable per source.
- **Rate limits**: per-source token bucket on webhook ingress. Exceeded → 429 with `Retry-After`.
- **Replay protection**: HMAC-signed webhook paths enforce a 5-minute timestamp window by default (Slack already does; extend to GitHub, custom).
- **Error-response sanitization**: 401 / 403 / 400 bodies contain no server-side detail. Internal errors surface only in audit + server logs.

---

## 6. Multi-tenant isolation

### 6.1 Default tenant + multi-tenant modes

- **Default tenant mode (backward-compat).** If no `tenants.yaml` is present and no `TenantContext` is wired explicitly, the daemon runs with `TenantContext.DEFAULT = { id: '__default__', ... }`. Every Phase-1-through-5 behavior is preserved bit-for-bit.
- **Multi-tenant mode.** `tenants.yaml` enumerates tenants; the daemon spawns a `TenantRuntime` per entry. Resources are keyed on `tenant.id`; cross-tenant reads fail with `TenantBoundaryError` + emit an audit record.

Cross-tenant is always a fatal error — per the resolved-gap §7 decision in `SPEC_AND_PLAN.md`, tenants stay isolated at the registry layer.

### 6.2 EventBus namespacing

Two implementation strategies, chosen by `spec.multiTenant.busStrategy`:

- **Per-tenant buses** (default). Each `TenantRuntime` has its own `EventBus` instance. Cross-tenant subscription isn't possible because the ref doesn't exist. Simplest to reason about; highest memory overhead per tenant.
- **Shared bus with tag filtering**. One bus; every event carries `meta.tenantId`; every subscriber auto-filters. Lower memory; attack surface is a forgotten filter (one-line bug leaks events). Used only when memory pressure demands it.

Either way, the public API is identical — `deps.bus` in a `ChannelDependencies` / `SourceDependencies` is already tenant-scoped by the time the adapter sees it. Registry-layer enforcement throws `TenantBoundaryError` on any attempt to publish an event whose `meta.tenantId` doesn't match the bus's scope.

### 6.3 ExtensionRegistry scoping

Extensions (tools, plugins, skills, MCP servers, event-source adapters, channel adapters, hooks) register once at process startup. Each registration carries an optional `scope: { tenants: readonly string[] }` — omitted means "available to every tenant" (default), listed means "only these tenants".

Lookup goes through a scoped view:

```ts
const tenantView = registry.forTenant(tenant);
const tool = tenantView.get('tool:Bash');  // null if Bash isn't scoped to this tenant
```

Every tool-call dispatch routes through the scoped view — cross-tenant tools are invisible, not just forbidden.

### 6.4 Session scoping

`SessionManager.key(tenantId, sessionId)` replaces `SessionManager.key(sessionId)`. Existing sessions are migrated by prefixing their keys with `__default__:`. API-level, sessions are keyed by `(tenant, id)` everywhere. A lookup with the wrong tenant throws `TenantBoundaryError`.

### 6.5 Audit log scoping

Records go to a per-tenant partition of the audit log. Query APIs (`TenantAuditSink.snapshot({ tenantId, ... })`) refuse to return cross-tenant records. The single-tenant default continues to partition at `__default__`.

### 6.6 Secret scoping

Every `${secret:...}` ref resolves through the tenant's `SecretProvider`. Path prefixes are enforced: `vault:secret/data/acme/kafka` is only resolvable when the active tenant is `acme`. Cross-tenant access attempts fail with `TenantBoundaryError` + emit `secret_access { outcome: 'denied' }`.

### 6.7 Tenant-aware metrics labels

Every metric emitted from `BaseChannelInstance` / `BaseSourceInstance` / the engine gets a `tenant_id` label automatically (when multi-tenant mode is on). Prometheus dashboards + Grafana queries pick this up without template changes — Phase 5's dashboards already parameterize on `id` and `type`; the new axis is orthogonal.

### 6.8 `tenants.yaml` declarative config

```yaml
version: 1
strategy:
  bus: per-tenant         # or: shared-with-filter
  secretProvider: vault   # default provider for refs without a type prefix
tenants:
  - id: acme-prod
    displayName: "ACME Production"
    residency: us
    auditRetentionDays: 90
    quotas:
      maxActiveSessions: 500
      dailyTokenUSD: 200
      maxConcurrentToolCalls: 20
    secretScopes:
      - "vault:secret/data/acme/**"
      - "aws-sm:us-east-1/acme/**"
    labels:
      env: production
      team: platform
    extensions:
      allow:
        - "channel-telegram"
        - "source-kafka"
        - "tool:Bash"
      deny:
        - "plugin-experimental-*"
  - id: beta-tenant
    displayName: "Beta Partner"
    residency: eu
    auditRetentionDays: 30
    quotas:
      maxActiveSessions: 100
      dailyTokenUSD: 50
```

---

## 7. Chaos testing harness

Lives in `packages/testkit/src/chaos/`. Design intent: **prove the SLOs hold under controlled failure** — not discover faults organically. The harness fires known faults; the runtime + observability stack must absorb them without data loss.

### 7.1 Driver

```ts
export interface ChaosDriver {
  /** Start firing faults per the policy. */
  start(): Promise<void>;
  /** Stop + emit a summary report. */
  stop(): Promise<ChaosReport>;
  /** Force a specific fault immediately (test-only). */
  inject(fault: ChaosFault): Promise<void>;
  /** Subscribe to fault + recovery events. */
  onEvent(handler: (evt: ChaosEvent) => void): () => void;
}

export function createChaosDriver(options: {
  policy: ChaosPolicy;
  runtime: ChaosTargetRuntime;   // deps the driver can poke: replicas, brokers, clock, bus
  clock?: () => number;
  logger?: Logger;
}): ChaosDriver;
```

`ChaosTargetRuntime` is the façade over the real runtime the driver exercises. In tests it's a stub; in production it's backed by a Kubernetes pod-kill API + broker-restart hooks.

### 7.2 Fault implementations

Each fault in `ChaosFault` has an implementation under `chaos/faults/`:

- `kill-replica.ts` — simulates an orderly or ungraceful process exit.
- `partition-broker.ts` — blocks network to a broker; drains inflight messages.
- `partition-channel.ts` — drops outbound traffic to a channel adapter for a window.
- `bus-high-watermark.ts` — publishes dummy events to exhaust backpressure thresholds.
- `expire-idempotency-cache.ts` — force-clears the dedup cache so a replay looks new.
- `clock-skew.ts` — skews `deps.clock` forward/back; tests rotation + idempotency TTL sensitivity.
- `network-latency.ts` — injects fetch-layer latency into outbound HTTP.

### 7.3 Assertions framework

After each fault + recovery cycle, the harness runs an assertion pass:

```ts
export interface ChaosAssertion {
  name: string;
  /** Runs after a fault cycle completes. Return { ok, details }. */
  check(snapshot: ChaosSnapshot): Promise<ChaosAssertionResult>;
}

export interface ChaosSnapshot {
  tenantId?: string;
  metrics: Record<string, MetricSample[]>;
  auditRecords: readonly TenantAuditRecord[];
  busDepth: number;
  dlqDepths: Record<string, number>;
}
```

Stock assertions shipped in `chaos/assertions/`:

- `no-event-loss.ts` — ingress count == (processed + dlq + inflight) count.
- `no-cross-tenant-leak.ts` — every audit record's `tenantId` matches the scope it was queried in.
- `no-secret-in-logs.ts` — grep every captured log line for values returned by the secret providers.
- `slos-held.ts` — p99 outbound latency < configured budget; DLQ rate < 1%.
- `dedup-never-drops.ts` — every event with a correlation id appears in the audit log exactly once despite clock-skew + expire-cache injections.

### 7.4 Chaos run report

Every harness run emits a JSON + markdown report:

```
chaos-report.<timestamp>.json
chaos-report.<timestamp>.md
```

Includes: policy, fault timeline, assertion results, metric snapshots at each window, full audit trail. The markdown is human-scan-friendly; the JSON is diff-able across runs.

### 7.5 CI integration

Three entry points:

- `bun run chaos:quick` — 60-second scenario with 5-second fault intervals; runs on every PR.
- `bun run chaos:soak` — 1-hour scenario with 60-second fault intervals; matches the spec's acceptance bar. Runs nightly.
- `bun run chaos:scenario <name>` — targeted fault (broker partition, say) for development.

The PR-triggered quick run is a smoke test; any assertion failure blocks merge. The nightly soak is tracked against the Phase-6 exit criteria.

---

## 8. Declarative configuration

Two new top-level configs:

```
<configDir>/
├── tenants.yaml             # multi-tenant registry (optional)
├── secrets.yaml             # secret providers (one per type)
├── alerts/                  # Prometheus alert rule YAML (slice 2)
│   └── ...
└── runbooks/                # per-alert operator playbooks
    └── ...
```

`secrets.yaml` example:

```yaml
version: 1
default: vault-prod          # provider used when a ref omits the type prefix
providers:
  vault-prod:
    type: vault
    address: "https://vault.acme.internal"
    auth:
      method: approle
      roleId: "${env:VAULT_ROLE_ID}"
      secretId: "${env:VAULT_SECRET_ID}"
    defaultTtlMs: 300000
  aws-sm-prod:
    type: aws-sm
    region: us-east-1
    # IRSA — no explicit creds needed.
  gcp-sm-prod:
    type: gcp-sm
    project: acme-prod
    # WIF via ambient ADC.
rotationMonitor:
  enabled: true
  checkIntervalMs: 3_600_000
  warnAfterDays: 90
  errorAfterDays: 180
```

The secret-provider loader (slice 3) lives in `packages/core/src/secrets/config-loader.ts` and reuses the Phase-5 `channels/config-loader.ts` patterns: YAML + env expansion + sentinel-preservation. No `${secret:...}` refs in this file — providers are the bootstrap; they can't depend on themselves.

---

## 9. Slice breakdown

Same approach as Phase 3/4/5: thin vertical slices, each independently mergeable.

### Slice 1 — Tenancy primitives + default-tenant compat (~3 days)
- `packages/core/src/tenancy/types.ts` — `TenantContext`, `TenantRuntime`, `TenantBoundaryError`, `TenantQuotas`.
- `TenantContext.DEFAULT` constant + helpers.
- Widen `SourceDependencies` / `ChannelDependencies` / `ToolContext` with optional `tenant?: TenantContext`.
- Auto-stamp `event.meta.tenantId` from dep `tenant` in normalizer + channel adapters + engine emit paths.
- Tests: every Phase-1-through-5 test passes with `TenantContext.DEFAULT` wired through.

### Slice 2 — Observability maturation (~3 days)
- `packages/core/src/observability/prometheus.ts` — text-format exporter.
- `startPrometheusExporter` + HTTP handler in the daemon alongside port 8787 + control socket.
- `packages/testkit/alerts/` — six rule files keyed on existing metrics.
- `docs/runbooks/<alert>.md` — one runbook per alert, following the §4.4 template.
- Correlation-id grep-and-fix pass across every cross-cutting seam.
- Tests: scrape endpoint returns valid OpenMetrics text; alert rules parse cleanly via `promtool check rules`.

### Slice 3 — Secret provider + rotation audit (~4 days)
- `packages/core/src/secrets/providers/{vault,aws-sm,gcp-sm,k8s}.ts` — four fetch-based providers.
- `packages/core/src/secrets/config-loader.ts` — `secrets.yaml` loader.
- `SecretAccessAuditRecord` emission inside `createDefaultSecretResolver`'s resolve path.
- `packages/core/src/secrets/rotation-monitor.ts` — periodic metadata poll + stale-secret alerts.
- CLI: `declaragent secrets list --provider <name>`, `declaragent secrets rotate <ref>`.
- Tests: each provider's happy path, denied path, metadata path, TTL cache semantics. Property test: no resolved value appears in any audit record or log line.

### Slice 4 — HMAC + webhook + dep-scan security hardening (~3 days)
- HMAC audit pass across webhook.ts + channel adapters; line-by-line walk.
- Replace Discord's Ed25519 stub with `crypto.verify('ed25519', ...)`.
- Property tests in `packages/core/src/events/sources/webhook.test.ts` — fuzz HMAC comparisons with length mismatches, replay windows, prefix attacks.
- `deps-scan.yml` + `npm-audit.yml` GitHub Actions workflows.
- `.osv-ignore.yml` format + CI expiry enforcement.
- Webhook endpoint hardening: TLS requirement, body-size limits, error-response sanitization.
- Tests: every HMAC touchpoint passes a fuzz-length regression; dep scan runs clean.

### Slice 5 — Audit unification + tamper-evidence (~3 days)
- `packages/core/src/audit/sink.ts` — `TenantAuditSink` unifies Phase-1 tool-call audit + Phase-5 `ChannelAuditLogger` + new `secret_access` / `tenant_boundary_violation` / `quota_exceeded` records.
- Sqlite-backed persistent implementation (reusing the Phase-1 session DB pattern).
- Optional tamper-evidence: append-only log with a chained SHA-256 of prior record. Verifiable via `declaragent audit verify` CLI.
- Per-tenant retention: scheduled job prunes records past `auditRetentionDays`.
- `declaragent audit query --tenant <id> --kind <kind> --since <ts>` CLI.
- Right-to-erasure helper: `declaragent audit erase --user <platformUserId>` wipes PII-carrying records while preserving the chain (hash replaced with tombstone).
- Tests: unified sink round-trips every Phase-1/5 record type; chain-verify detects tamper.

### Slice 6 — Multi-tenant runtime (~5 days)
- `packages/core/src/tenancy/runtime.ts` — `TenantRuntime` assembler.
- `packages/core/src/tenancy/config-loader.ts` — `tenants.yaml` loader + Zod schema.
- Daemon's `startDaemon` grows a `tenants` branch: either default-tenant or per-tenant mode.
- Registry scoping: `ExtensionRegistry.forTenant(tenant)` returns a view with tenant-allow-list + deny-list applied.
- Session scoping: `SessionManager` keys become `(tenantId, sessionId)`; existing sessions migrate to `__default__:` prefix on daemon start.
- EventBus strategies: per-tenant default + shared-with-filter opt-in.
- Per-tenant metrics labels auto-stamped.
- Quota enforcement: exceeded → typed error + `quota_exceeded` audit record.
- `declaragent tenants list` + `declaragent tenants diff` CLI.
- Tests: two tenants in one daemon; cross-tenant session lookup throws; cross-tenant event publish throws; bus strategies both pass the same test suite; registry scope deny works; quota breach surfaces cleanly.

### Slice 7 — Chaos harness + assertions (~4 days)
- `packages/testkit/src/chaos/driver.ts` — `ChaosDriver` with policy-driven fault firing.
- Fault implementations under `packages/testkit/src/chaos/faults/`.
- Assertion library under `packages/testkit/src/chaos/assertions/`.
- `chaos-report` markdown + JSON writers.
- Integration with the Phase-5 channel demo + the Phase-4 load harness — a single `bun run chaos:quick` exercise runs both.
- `ChaosTargetRuntime` bridges to real runtimes (K8s pod-kill via `kubectl`, broker restart via Docker Compose).
- Tests: each fault implementation has a unit test + an integration that asserts the correct observable state transitions. Quick-scenario end-to-end passes locally.

### Slice 8 — Release-gate CI + threat-model signoff (~2 days)
- `.github/workflows/release-gate.yml` — runs chaos:quick, isolation tests, dep scan, secret-leak scan; blocks merge on failure.
- `docs/THREAT_MODEL.md` — STRIDE walkthrough per component (core, events, channels, tools, MCP, secrets, daemon).
- Third-party reviewer signoff: external security firm review of the threat model. Document the review + remediation tickets + sign-off attribution.
- Exit-criteria runbook: what to capture + publish at the end of each Phase-6 soak run.

**Critical path:** 1 → {2 ∥ 3 ∥ 4} → 5 → 6 → 7 → 8. Slices 2 / 3 / 4 are independent and can land in parallel on three engineers.

**Total estimate:** ~27 days of focused work, ~4 weeks for two engineers parallelizing slices 2–4. Matches the spec's 3–4 week guidance for Phase 6.

---

## 10. File layout

```
packages/core/src/
├── tenancy/
│   ├── types.ts                  # slice 1
│   ├── types.test.ts
│   ├── runtime.ts                # slice 6
│   ├── runtime.test.ts
│   ├── config-loader.ts          # slice 6
│   └── boundary-error.ts         # slice 1
├── observability/
│   ├── prometheus.ts             # slice 2
│   └── prometheus.test.ts
├── secrets/
│   ├── index.ts
│   ├── types.ts                  # slice 3
│   ├── config-loader.ts          # slice 3
│   ├── rotation-monitor.ts       # slice 3
│   └── providers/
│       ├── vault.ts
│       ├── vault.test.ts
│       ├── aws-sm.ts
│       ├── aws-sm.test.ts
│       ├── gcp-sm.ts
│       ├── gcp-sm.test.ts
│       └── k8s.ts
├── audit/
│   ├── sink.ts                   # slice 5
│   ├── sink.test.ts
│   ├── sqlite-sink.ts            # slice 5
│   ├── chain-verify.ts           # slice 5
│   └── erase.ts                  # slice 5
└── events/
    └── types.ts                  # slice 1 adds tenant-scoped flavors

packages/testkit/src/
├── chaos/                        # slice 7
│   ├── index.ts
│   ├── driver.ts
│   ├── policy.ts
│   ├── report.ts
│   ├── faults/
│   │   ├── kill-replica.ts
│   │   ├── partition-broker.ts
│   │   ├── partition-channel.ts
│   │   ├── bus-high-watermark.ts
│   │   ├── expire-idempotency-cache.ts
│   │   ├── clock-skew.ts
│   │   └── network-latency.ts
│   └── assertions/
│       ├── no-event-loss.ts
│       ├── no-cross-tenant-leak.ts
│       ├── no-secret-in-logs.ts
│       ├── slos-held.ts
│       └── dedup-never-drops.ts
└── alerts/                       # slice 2
    ├── channels.rules.yaml
    ├── event-sources.rules.yaml
    ├── whatsapp-windows.rules.yaml
    ├── security.rules.yaml
    ├── chaos-assertions.rules.yaml
    └── daemon.rules.yaml

packages/cli/src/
├── audit-cli.ts                  # slice 5
├── secrets-cli.ts                # slice 3
└── tenants-cli.ts                # slice 6

docs/
├── THREAT_MODEL.md               # slice 8
└── runbooks/                     # slice 2
    ├── channels-outbound-failure-rate.md
    ├── event-sources-sustained-lag.md
    ├── secret-access-denied-spike.md
    ├── tenant-boundary-violation.md
    └── ...

.github/workflows/
├── deps-scan.yml                 # slice 4
├── npm-audit.yml                 # slice 4
└── release-gate.yml              # slice 8
```

---

## 11. Touch points into existing code

Phase 6 is **more invasive than Phase 5** because tenancy threads through every dep bag. Every change is additive (new optional field); none break a caller.

- `packages/core/src/events/types.ts` — `AgentEventMeta.tenantId` widened from optional to a scoped canonical form; `SourceDependencies.tenant?: TenantContext` added (slice 1).
- `packages/core/src/channels/types.ts` — `ChannelDependencies.tenant?: TenantContext` added (slice 1).
- `packages/core/src/types/tool.ts` — `ToolContext.tenant?: TenantContext` added (slice 1). Tool authors read when they need it; default tenant works unchanged.
- `packages/core/src/engine/engine.ts` — emits `event.meta.tenantId` on `turn.started` / `assistant.message` / `assistant.final` when the config supplies a tenant (slice 1).
- `packages/core/src/events/secret-resolver.ts` — resolver grows `providers` + `tenant` awareness; audit hook lands in `resolveRef` (slice 3).
- `packages/core/src/events/bus.ts` — optional `tenantScope?: string` constructor arg; throws `TenantBoundaryError` on cross-tenant publish when set (slice 6).
- `packages/core/src/extension/registry.ts` — `forTenant(tenant)` view method (slice 6).
- `packages/core/src/session/sqlite.ts` — session keys become `(tenantId, sessionId)` tuples with a migration for pre-existing rows (slice 6).
- `packages/core/src/events/daemon.ts` — calls tenant-config loader + instantiates per-tenant runtimes; Prometheus exporter lifecycle; chaos target hooks (slices 2, 6, 7).
- `packages/core/package.json` — stays lean; no new runtime deps unless `node:crypto`'s Ed25519 support requires a Bun polyfill (slice 4).
- Adapter packages — no changes required. The tenant field threads through the deps bag transparently; adapters that want to label their own metrics call `deps.tenant?.id` and get the tenant id automatically.

Same rationale as Phase 2-5: keep the Phase-1 contract change rate at zero. The engine loop, tool contract, permission gate, MCP loader, plugin loader, channel runtime, sources — all untouched API-level. The only new dep bag field is `tenant?`, which defaults to `TenantContext.DEFAULT`.

---

## 12. Testing strategy

Six tiers (one more than Phase 5 — the chaos tier is genuinely new):

1. **Pure unit tests** for every Phase 6 primitive: `TenantContext`, `TenantRuntime`, `SecretProvider` implementations, `PrometheusExporter`, audit sink chain-verify, chaos assertions.

2. **In-process integration tests** for the tenant-runtime composition: two tenants in one daemon, extension-scope enforcement, session-key migration, cross-tenant publishes correctly throwing.

3. **Chaos-driver unit tests** for each fault implementation against a stub runtime, plus the assertion library against synthetic snapshots.

4. **End-to-end chaos-quick run** against the full daemon + Phase-5 channel demo. Gated by env (`DECLARAGENT_CHAOS=1`), runs on every PR. 60-second scenario with each fault kind exercised at least once. All shipped assertions pass.

5. **Nightly chaos soak** — 1-hour scenario matching the spec's acceptance bar. Kills random replicas every 60 seconds. Produces a dated report; dashboards track report-to-report diffs.

6. **External pen test + security review.** Third-party security firm reviews the threat model, scans the deployment, attempts the attacks documented in STRIDE. Any CRITICAL finding blocks Phase-6 signoff; HIGH findings are remediated before Phase 7.

**No tests against a real paid-for service.** Vault / AWS SM / GCP SM providers are tested against mock HTTP servers with canned responses. Real-provider integration tests are gated separately (`DECLARAGENT_SECRETS_IT=1`), run against a dedicated test account, and are not a release gate.

---

## 13. Open questions

1. **Default tenant mode forever, or sunset?** The `__default__` tenant keeps Phase-1-through-5 callers working. Long-term, do we sunset it + require explicit tenant contexts?
   - **My lean:** keep it indefinitely. Single-tenant is a valid deployment mode; forcing a tenant context on every caller adds ergonomic cost with no isolation win.

2. **Audit sink storage backend.** Sqlite today. Does Phase 6 ship a Postgres option? Kafka sink? S3 archive?
   - **My lean:** sqlite-in-process for slice 5. Postgres + S3 archive land with the managed control plane (post-v1.0). The audit sink's interface is backend-agnostic so swap is a config change.

3. **Tenant bus strategy default.** Per-tenant vs. shared-with-filter.
   - **My lean:** per-tenant by default — simplest invariant. Shared mode is opt-in for memory-constrained deployments; it carries a "read the documentation twice" footgun warning.

4. **Ed25519 signature verification.** Discord needs it for webhook interactions. Node's `crypto.verify` supports it; Bun supports it via the same API. Peer dep on `tweetnacl` as a fallback?
   - **My lean:** use Node's built-in `crypto.verify('ed25519', ...)`. Bun implements it too. No peer dep.

5. **Secret-rotation reconciliation cadence.** Every hour? Every 6 hours? Adaptive to the observed TTL?
   - **My lean:** every 1 hour by default, configurable. Per-provider opt-in to adaptive TTL where the provider exposes it (Vault leases).

6. **Chaos-harness KBs and runners.** Quick runs on PR CI (30-60s) are fine. Soaks (1 hour) need dedicated runners — self-hosted Docker fleet or cloud.
   - **My lean:** self-hosted runner with Docker Compose for the soak. CI skips the soak by default; merge-to-main triggers a nightly schedule.

7. **Right-to-erasure hash chain.** When an audit record is erased (PII removal), the hash chain changes. Do we replace with a tombstone + hash of original for verification continuity?
   - **My lean:** yes — erase leaves a tombstone with `{ kind: 'erased', previousHash }`. Verification walks the chain using tombstones in place of original records. Any external auditor can confirm the chain is intact; the original content is gone.

8. **Secret-provider peer deps.** Vault, AWS SM, GCP SM, K8s — each could use its official SDK. SDK sizes: Vault Node SDK ~200KB; AWS SM SDK v3 modular ~800KB; GCP SM ~1.5MB; K8s ~2MB.
   - **My lean:** fetch-based by default for all four. Official SDKs are optional peer deps users can swap in if they want Ansible-level production wrangling (credential chain, retry, paging). Zero-dep default keeps core lean.

9. **Chaos harness on Windows.** The Phase-3 hot-reload-on-Windows limitation is already documented. Chaos harness's pod-kill semantic is Linux/macOS only.
   - **My lean:** document Windows limitation; CI runs chaos on Linux only. Windows support is a post-v1.0 stretch if demand materializes.

10. **Quota enforcement on cross-tenant shared resources.** If one tenant exhausts the daily token budget, does it affect other tenants' budgets?
    - **My lean:** no — tenant budgets are orthogonal. Shared resources (the LLM provider's own rate limits) affect every tenant equally and are policed at the provider layer (outside this plan).

---

## 14. Risks

- **External reviewer scheduling.** The threat-model signoff in slice 8 depends on a third-party firm. Booking leads of 4+ weeks are common. Mitigation: book the reviewer at Phase 5 slice 15 start; target review window overlaps with slices 6–7 development.
- **Chaos harness brittleness.** Fault injection is inherently flaky — a chaos run that fails an assertion is either "a real bug" or "chaos harness timing got unlucky." Mitigation: every assertion includes an `allowJitterMs` budget; repeat the full run 3x before flagging an assertion as a real failure.
- **Sqlite audit write throughput.** At soak-scale (tool calls/sec + events/sec), the audit sink's single-writer sqlite may bottleneck. Mitigation: batched writes + a background flush thread; if throughput is still insufficient, the control-plane-only path can opt into Postgres via the interface (slice 5 ships the swap-readiness).
- **Cross-tenant regression.** Any code that reads `.sessions.get(sessionId)` without the tenant prefix after migration is a silent bug. Mitigation: slice 6 ships a "ban undecorated lookups" lint rule; CI grep fails on `sessions.get(` / `bus.publish(` without a tenant-scoped context where multi-tenant mode is on.
- **Secret-provider SDK drift.** AWS/GCP credentials flows evolve. Fetch-based providers need to track IAM role / WIF conventions. Mitigation: each provider ships a "how this integrates" doc with links to the specific auth flow used, plus a quarterly-review schedule in slice 8.
- **Ed25519 verification cost.** Per-request signature verification on Discord interactions adds ~1-3ms per request. At slice-4 acceptance scale this is absorbed by the rest of the pipeline; larger scales may need to pool verifier instances. Mitigation: microbenchmark in slice 4; profile-guided optimization if > 2% of interaction latency.
- **Pen-test scope creep.** Ambiguously-scoped pen tests find issues outside Phase 6's acceptance bar (e.g., DOM XSS in a not-yet-built dashboard). Mitigation: scope statement signed before the engagement; out-of-scope findings go to Phase 7 backlog, not Phase-6 signoff.
- **Alert rule drift.** Metric names change over time; alert rules rot. Mitigation: slice 2 ships a `promtool check rules` CI job; slice 8 adds a linter for missing runbooks; quarterly review of fired + unfired alerts in ops retrospectives.

---

## 15. Acceptance check

The spec's acceptance bar:

> Pen test passes; chaos test (random pod kill every 60s for 1h) shows zero data loss; multi-tenant isolation test shows zero cross-tenant leakage.

Practical (slices 6–8):

1. **Isolation test.**
   - Configure `tenants.yaml` with 3 tenants: A, B, C.
   - Each tenant has its own channel config, skill set, secret scope.
   - Drive 1,000 inbound events per tenant in parallel.
   - Assert: every outbound event's `tenantId` matches its inbound; no audit record surfaces across tenant boundaries on cross-tenant queries; cross-tenant secret access throws `TenantBoundaryError` 100% of the time.

2. **Chaos soak.**
   - `bun run chaos:soak` — 1-hour run, 60-second fault intervals.
   - Policy: `kill-replica` (every 60s), `partition-broker` (every 5m for 30s), `bus-high-watermark` (random, 2m window), `expire-idempotency-cache` (every 10m), `clock-skew` (every 15m, ±5s).
   - Run against a Redpanda + full Phase-5 channel mock stack.
   - Assert: `no-event-loss` passes — every input event is accounted for in `(processed ∪ dlq ∪ inflight)`. `no-cross-tenant-leak` passes. `dedup-never-drops` passes despite the `expire-idempotency-cache` fault firing twice.

3. **External pen test.**
   - Engagement scope: core runtime, every webhook endpoint, every channel adapter's auth flow, the Prometheus exporter, the audit sink, secret-resolver paths.
   - Reviewer output: threat table + findings list + sign-off on residual risk.
   - No CRITICAL findings; HIGH findings remediated before phase close.
   - Bonus: publish the threat model doc + sign-off page as `docs/THREAT_MODEL.md` + `docs/PEN_TEST_SIGNOFF.md`.

If all three pass, Phase 6 ships.

---

## 16. Next step

Slice 1 (tenancy primitives) is the unblocker. Once the `TenantContext` is widened into dep bags + `AgentEventMeta.tenantId` is stamped everywhere, slices 2 / 3 / 4 can run in parallel on separate engineers:

- Slice 2 (observability) is smallest: the exporter + alert rules.
- Slice 3 (secrets) lands providers + rotation + audit record emission.
- Slice 4 (security) is cross-cutting but self-contained: HMAC audit + dep scan + webhook hardening.

Slice 5 (audit unification) depends on slice 3's audit record shapes + slice 1's tenant context. Slice 6 (multi-tenant runtime) depends on slices 1 + 5.

Slice 7 (chaos) can start any time after slice 6 lands the tenant runtime. Slice 8 (release-gate) closes Phase 6.

First concrete PR: `packages/core/src/tenancy/types.ts` + dep-bag widening + `TenantContext.DEFAULT` wiring through the daemon. Expect ~2 days to land; every Phase-1-through-5 test stays green by construction.
