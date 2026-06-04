# Phase 4 — Scale Event Sources: Implementation Plan

**Status:** Draft for review. Scoped to Phase 4 of `SPEC_AND_PLAN.md` (Scale Event Sources, target v0.7 scale beta).
**Last updated:** 2026-04-16.

Phase 3 made the agent **a service** — it runs in response to cron fires, HTTP webhooks, file changes, inter-agent mailbox messages, and survives `SIGHUP`. Those three built-in sources (cron / webhook / file-watch) are enough to prove the event spine, but they all speak the same host: localhost. Phase 4 makes the agent **a broker consumer** — Kafka, SQS, MQTT, AMQP, NATS — at scale. It formalizes the contract `EventSourceAdapter`, pushes production-grade plumbing (DLQ, replay, circuit breaker, rate limit, schema registry) into shared code, and ships each broker as its own loadable package.

The **acceptance bar** from `SPEC_AND_PLAN.md §Phase 4`:

> Load test sustains 1K msg/sec on Kafka adapter with <5s p99 end-to-end latency; zero message loss under broker restart.

This doc lays out the architecture, contracts, slice ordering, and known sharp edges. Phase 4 is the first slice of the system where a distributed-systems failure mode (broker restart, partition rebalance, schema evolution) can make the agent behave incorrectly — the plan is explicit about where we draw correctness guarantees and where we accept best-effort.

---

## 1. Goals and non-goals

**Goals.**
- Widen the Phase-3 `EventSourceAdapter` contract so it can describe brokers that existing sources don't model (offsets, ack strategies, consumer groups, QoS levels, visibility timeouts, replay).
- A `MessageNormalizer` that turns any transport's `RawMessage` into the canonical `AgentEvent` — one place for format decoding, JSON-path routing, filters, transforms, and schema-registry lookups.
- A `BaseSourceInstance` abstract class that every adapter subclasses — one place for retry + DLQ + concurrency + health + metrics.
- Five broker adapter packages shipped out of tree: `@declaragent/source-{kafka,sqs,mqtt,amqp,nats}`. Each is an optional `npm install`; core has **zero** broker-specific runtime deps.
- OpenTelemetry metrics + tracing (lazy-loaded per §3 of `SPEC_AND_PLAN.md`), per-source health endpoint, and Grafana dashboards for lag + throughput + errors.
- Delivery semantics: at-least-once (default), at-most-once (opt-in), DLQ on every adapter, cross-restart idempotency (from Phase 3 slice 8) extended with transport-natural keys.
- Declarative `event-sources.yaml` loader (alongside the Phase-3 JSON loader) with `${env:*}` + `${secret:*}` interpolation.

**Non-goals (Phase 4).**
- Communication channels — Slack, Discord, Telegram, WhatsApp land in Phase 5. Phase 4 adapters consume events *from* brokers; they don't bridge a chat UI.
- Multi-tenant isolation, RBAC beyond per-source permission scope, external secret vault integration — those land in Phase 6.
- Exactly-once semantics end-to-end. We give at-least-once + idempotent processing, which is what the rest of the industry means by "exactly-once." Downstream side-effects must be idempotent; the plan documents the key.
- Custom transport frameworks (gRPC stream, WebSocket subscriptions, SSE). These map cleanly onto the contract but are out-of-scope for v0.7; they'd ship as additional packages later.
- Cloud-adapter CI deploy (Cloud Run, Fargate, Fly) — that's Phase 7.
- Pulsar, Kinesis, Redis Streams — each is a streaming log family member and the Kafka adapter proves the family pattern. They're Phase-4.x stretch packages.
- Cross-adapter two-phase commit for "read from Kafka, write to SQS" transactions. The primitive isn't broker-wide; it belongs to per-session state.

---

## 2. Conceptual architecture

```
                                    ┌─────────────────────────────┐
                                    │        EventBus             │
                                    │     (Phase 3, unchanged)    │
                                    └─────────────┬───────────────┘
                                                  │
 ┌──────────┐                         normalize   │   subscribes
 │ Kafka    │─┐                                   ▼
 │ (kafkajs)│ │                      ┌─────────────────────┐
 └──────────┘ │       RawMessage     │    Dispatcher       │
              │                      │  (Phase 3 + slice  │
 ┌──────────┐ │    ┌──────────────┐  │   13: rate limit,  │
 │  SQS     │─┼───►│  Message-    │  │   circuit breaker) │
 │ (v3 sdk) │ │    │  Normalizer  │  └──────────┬──────────┘
 └──────────┘ │    │              │             │
              │    │ JSONPath     │             ▼
 ┌──────────┐ │    │ + filter     │        (engine, skills,
 │ MQTT     │─┼───►│ + transform  │         sessions — Phase 3)
 │ (mqttjs) │ │    │ + schema reg │
 └──────────┘ │    └──────┬───────┘
              │           │ AgentEvent
 ┌──────────┐ │           │
 │ AMQP     │─┤           ▼
 │(amqplib) │ │   ┌─────────────────┐
 └──────────┘ │   │ EventSource     │         ┌─────────────────┐
              │   │ Registry        │◄────────┤ EventStore      │
 ┌──────────┐ │   │ (widened Phase3)│         │ (Phase 3, ext.  │
 │  NATS    │─┘   └────────┬────────┘         │  for replay)    │
 │(nats.ws) │              │                  └─────────────────┘
 └──────────┘              │ reads
                           ▼
                     adapter discovery:
                     node_modules/@declaragent/source-*
```

**One contract, many transports.** Every adapter's `create()` returns an `EventSourceInstance` that conforms to the same interface. The daemon never hard-codes a broker. Adding support for a new broker = publishing an npm package; reconfiguring an existing broker = editing YAML.

**Phase 3 contracts widen; none break.** `EventSourceAdapter<C>`, `EventSourceInstance`, `SourceDependencies`, `SourceHealth`, `SourceMetrics` all grow optional fields. The three existing built-in sources (cron, webhook, file-watch) continue to compile with one-line changes.

**Composition at daemon startup** (additions over Phase 3 §2):
1. Scan `node_modules/@declaragent/source-*` → register adapter instances in the shared registry
2. Load `event-sources.yaml` (or `.json` for backward compat) → `SourceConfig[]`
3. For each source: `adapter.validateConfig(config)` → `adapter.create(config, deps)` → `registry.register(instance)`
4. Each instance subscribes to its broker; messages flow `RawMessage → normalizer → AgentEvent → bus → dispatcher → target`
5. Graceful shutdown (SIGTERM) → per-source `pause()` → drain in-flight → `stop()` → commit offsets / ack pending messages → exit

---

## 3. Core contract changes

All additions are backward-compatible. Live in `packages/core/src/events/types.ts` unless noted.

### 3.1 `SourceDependencies` widening

```ts
export interface SourceDependencies {
  // Existing (Phase 3):
  bus: EventBus;
  logger: Logger;
  configDir: string;

  // Phase 4 additions:
  /** Decodes + routes RawMessage → AgentEvent. */
  normalizer: MessageNormalizer;
  /** OTel-compatible metrics surface. Noop by default; ops wires in Prom/OTel. */
  metrics: MetricsRegistry;
  /** Resolves `${env:*}` and `${secret:*}` in configs. */
  secrets: SecretResolver;
  /** Testable clock. Production: `{ now: Date.now }`. */
  clock: Clock;
  /** Aborts when the daemon is shutting down. */
  shutdownSignal: AbortSignal;
}
```

Phase 3 built-ins keep working: the daemon already has a Phase-3 path, and each of `normalizer`, `metrics`, `secrets`, `clock`, `shutdownSignal` gets a noop default so adapters can ignore them. New adapters **must** wire them through `BaseSourceInstance`.

### 3.2 `EventSourceAdapter` widening

```ts
export interface EventSourceAdapter<C = unknown> {
  readonly type: string;
  /** NEW: semver range this adapter is compatible with. Registry rejects mismatches. */
  readonly agentCompat: string;
  validateConfig(config: unknown): asserts config is C;
  create(config: C, deps: SourceDependencies): Promise<EventSourceInstance>;
}
```

### 3.3 `EventSourceInstance` widening

```ts
export interface EventSourceInstance {
  // Existing: id, type, start, stop, pause, resume, health, metrics

  // Phase 4 additions (all optional — only adapters that can do them implement):
  /** Reposition consumer. Kafka: offset/timestamp. SQS: n/a. */
  seek?(position: SeekPosition): Promise<void>;
  /** Replay events from a window. Kafka: offset range. SQS: DLQ redrive. */
  replay?(params: ReplayParams): AsyncGenerator<AgentEvent>;
  /** Expose per-partition lag when the transport has partitions. */
  lag?(): Promise<Record<string, number>>;
}

export type SeekPosition =
  | { kind: 'offset'; offset: number; partition?: number; topic?: string }
  | { kind: 'timestamp'; timestampMs: number }
  | { kind: 'beginning' }
  | { kind: 'end' };

export interface ReplayParams {
  fromMs: number;
  toMs?: number;
  filter?: (event: AgentEvent) => boolean;
  /** Max events to replay. Hard cap to prevent accidental floods. */
  limit?: number;
}
```

### 3.4 Richer `SourceHealth` + `SourceMetrics`

```ts
export type SourceHealthStatus =
  | 'starting' | 'healthy' | 'degraded' | 'unhealthy' | 'stopped';

export interface SourceHealth {
  status: SourceHealthStatus;
  /** Phase 4 additions. */
  lastConnectedAt?: number;
  lastMessageAt?: number;
  connectionErrors: number;
  /** Adapter-specific — broker list, current partitions, consumer group lag, QoS levels, etc. */
  details?: Record<string, unknown>;
}

export interface SourceMetrics {
  // Phase 3: eventsPublished, lastEventAt
  // Phase 4 replaces with:
  messagesReceived: number;
  messagesProcessed: number;
  messagesFailed: number;
  messagesDLQ: number;
  inflightCount: number;
  /** Per-partition lag (streaming-log sources only). */
  lagByPartition?: Record<string, number>;
  avgProcessMs: number;
  p99ProcessMs: number;
}
```

Phase 3 sources will have their metrics retrofitted through `BaseSourceInstance` (slice 2) — cron's `eventsPublished` maps to `messagesProcessed`, etc.

### 3.5 `DeliveryConfig`

New. Every source config carries one; `BaseSourceInstance` enforces the contract.

```ts
export interface DeliveryConfig {
  mode: 'at-most-once' | 'at-least-once';
  /**
   * When to ack the transport:
   * - `before-publish`: ack on arrival. Fast, at-most-once.
   * - `after-publish`: ack after `bus.publish()` resolves. Safe default.
   * - `after-dispatch`: ack after the dispatcher's outcome. Strongest; slowest.
   */
  ackStrategy: 'before-publish' | 'after-publish' | 'after-dispatch';
  maxRetries: number;
  retryBackoff: { initialMs: number; maxMs: number; jitter: boolean };
  dlq?: DlqConfig;
  /** Queue adapters only — seconds before redelivery. */
  visibilityTimeoutMs?: number;
  idempotency: {
    strategy: 'transport-natural' | 'header' | 'content-hash';
    ttlMs: number;
    /** `sqlite` reuses the Phase-3 EventStore. Redis comes later. */
    store: 'memory' | 'sqlite';
  };
}

export interface DlqConfig {
  kind: 'transport-native' | 'agent-managed';
  /** SQS redrive policy target, Kafka retry topic, RabbitMQ DLX, etc. */
  destination?: string;
  onDlq?: 'alert' | 'retry-manual' | 'ignore';
}
```

### 3.6 `LimitsConfig`

New. Per-source backpressure + rate-limit knobs.

```ts
export interface LimitsConfig {
  concurrency: number;           // parallel message handlers
  maxInflight: number;           // depth before the source pauses itself
  ratePerSec?: number;           // token-bucket smoothing (optional)
  maxPayloadBytes?: number;      // reject before normalization
  maxEventsPerMinute?: number;   // hard cap (absolute)
}
```

---

## 4. `BaseSourceInstance` — shared lifecycle

New. The heart of Phase 4: every adapter subclasses this. Lives at `packages/core/src/events/base-source.ts` so adapter packages depend only on `@declaragent/core`.

```ts
export abstract class BaseSourceInstance implements EventSourceInstance {
  protected state: SourceHealthStatus = 'starting';
  protected startedAt?: number;
  protected lastMessageAt?: number;
  protected counters = {
    received: 0, processed: 0, failed: 0, dlq: 0, connectionErrors: 0,
  };
  protected latencyHist = new FixedSizeLatencyHistogram(1024);
  protected inflight = new Set<string>();
  protected limiter: ConcurrencyLimiter;

  constructor(
    public readonly id: string,
    public readonly type: string,
    protected config: SourceConfig,
    protected deps: SourceDependencies,
  ) {
    this.limiter = new ConcurrencyLimiter(config.limits.concurrency);
  }

  async start(): Promise<void> {
    this.state = 'starting';
    await this.doStart();
    this.state = 'healthy';
    this.startedAt = this.deps.clock.now();
  }
  async stop(reason?: string): Promise<void> { /* ... */ }
  async pause(): Promise<void> { /* ... */ }
  async resume(): Promise<void> { /* ... */ }

  /** Subclass calls this on every inbound message. */
  protected async handleMessage(raw: RawMessage, ack: AckContext): Promise<void> {
    const release = await this.limiter.acquire();
    const timer = this.latencyHist.start();
    this.counters.received++;
    this.lastMessageAt = this.deps.clock.now();
    this.inflight.add(ack.messageId);

    try {
      const event = await this.deps.normalizer.normalize(raw, this.config.routing);
      if (!event) { await ack.ack(); return; }

      const strategy = this.config.delivery.ackStrategy;
      if (strategy === 'before-publish') await ack.ack();
      await this.deps.bus.publish(event);
      this.counters.processed++;
      if (strategy === 'after-publish') await ack.ack();

      if (strategy === 'after-dispatch') {
        // Attach a one-shot event.after hook to this event id; ack once the
        // dispatcher outcome lands. Implementation details in slice 2.
        await this.ackWhenDispatched(event.id, ack);
      }
    } catch (err) {
      this.counters.failed++;
      await this.handleFailure(raw, ack, err as Error);
    } finally {
      timer.stop();
      release();
      this.inflight.delete(ack.messageId);
    }
  }

  protected async handleFailure(raw: RawMessage, ack: AckContext, err: Error): Promise<void> {
    const attempt = raw.meta?.deliveryCount ?? 0;
    if (attempt < this.config.delivery.maxRetries) {
      await ack.nack();  // requeue with adapter-supplied backoff
      return;
    }
    await this.sendToDLQ(raw, err);
    await ack.ack();
    this.counters.dlq++;
  }

  metrics(): SourceMetrics { /* ... */ }
  async health(): Promise<SourceHealth> { /* ... */ }

  // Subclass contract:
  protected abstract doStart(): Promise<void>;
  protected abstract doStop(reason?: string): Promise<void>;
  protected abstract doPause(): Promise<void>;
  protected abstract doResume(): Promise<void>;
  protected abstract healthDetails(): Promise<Record<string, unknown>>;
  protected abstract sendToDLQ(raw: RawMessage, err: Error): Promise<void>;
}
```

`AckContext` carries `ack()`, `nack()`, `messageId`, and whatever the underlying broker needs for redelivery (Kafka offset, SQS receipt handle, AMQP delivery tag).

---

## 5. `MessageNormalizer`

New. One place for decode → filter → transform → route. Lives at `packages/core/src/events/normalizer.ts`.

```ts
export interface RawMessage {
  value: string | Uint8Array;
  key?: string;
  topic?: string;
  partition?: number;
  offset?: string;
  routingKey?: string;
  headers?: Record<string, unknown>;
  timestamp?: number;
  meta?: Record<string, unknown>;
}

export interface RoutingConfig {
  format?: 'json' | 'avro' | 'protobuf' | 'msgpack' | 'plain';
  schemaRegistry?: { url: string; subject: string };
  filter?: { expr: string };         // JSONPath predicate
  transform?: { expr: string };      // JSONata-ish rewriter
  kindSelector: JsonPath | { const: EventKind };
  targetSelector: TargetSelector;
  /** Copied onto the emitted event's meta. Transport-natural keys are the default. */
  idempotencyKeyFrom?: JsonPath | 'transport-natural' | 'content-hash';
  correlationIdFrom?: JsonPath;
}

export type TargetSelector =
  | { type: 'broadcast' }
  | { type: 'session'; sessionIdFrom: JsonPath; action: 'inject' | 'replace' | 'queue' }
  | { type: 'new-session'; initialPromptFrom?: JsonPath; agentSpec?: Partial<AgentSpec> }
  | { type: 'skill'; name: string; inputs?: Record<string, JsonPath | string> }
  | { type: 'sub-agent'; parentSessionIdFrom: JsonPath };

export interface MessageNormalizer {
  normalize(raw: RawMessage, routing: RoutingConfig): Promise<AgentEvent | null>;
}
```

Format decoders:
- **JSON** — built-in, no deps.
- **plain** — stuffs `{ text: raw.value }`; no parsing.
- **Avro / Protobuf** — via `@confluentinc/schemaregistry` (optional peer dep). Adapter packages that need them declare the peer dep.
- **msgpack** — optional `msgpackr` peer dep.

The **filter** stage is critical at scale: an MQTT source with 50K devices each sending every 30s is 1,600 msg/sec; `$.temperature > 80` can drop 95% of that before an event ever hits the bus.

**Selector expression dialect.** JSONPath (RFC 9535 subset: `$.foo`, `$.foo.bar`, `$.foo[0]`, no script expressions). No JSONata / CEL in v0.7 — JSONPath covers 95% of selectors and is parseable in ~80 lines. If users ask for richer expressions later, pluggable compilers can land as a peer dep.

---

## 6. Adapter packages

Each adapter ships as its own npm package. Core has zero broker runtime deps.

### 6.1 Package shape

```
@declaragent/source-kafka/
├── package.json                         # peer deps: @declaragent/core
├── src/
│   ├── index.ts                         # default export: Adapter instance
│   ├── adapter.ts                       # class KafkaAdapter
│   ├── instance.ts                      # class KafkaSourceInstance extends BaseSourceInstance
│   ├── config.ts                        # Zod schema for KafkaConfig
│   └── offset-store.ts                  # pluggable (in-memory | sqlite | broker-managed)
└── test/
    ├── adapter.test.ts                  # contract conformance (uses Docker Compose fixture)
    └── integration.test.ts              # real broker; gated by env
```

### 6.2 Package manifest convention

```jsonc
// @declaragent/source-kafka/package.json
{
  "name": "@declaragent/source-kafka",
  "version": "0.1.0",
  "main": "./dist/index.js",
  "peerDependencies": {
    "@declaragent/core": "^0.7.0"
  },
  "dependencies": {
    "kafkajs": "^2.2.4"
  },
  "declaragent": {
    "kind": "event-source-adapter",
    "type": "kafka",
    "agent_compat": ">=0.7.0 <2.0.0"
  }
}
```

### 6.3 Discovery

On daemon startup (slice 4):
1. Walk `configDir/node_modules/@declaragent/source-*` and `process.cwd()/node_modules/@declaragent/source-*`.
2. For each: read `package.json`, check the `declaragent` marker + `agent_compat`, dynamic-`import()` the default export.
3. Register with the event-source registry. Adapter-type collisions throw.

### 6.4 Per-adapter highlights

| Package | Transport family | Ship with |
|---|---|---|
| `@declaragent/source-kafka` | streaming log | SASL/PLAIN + SCRAM + OAUTHBEARER; consumer groups; manual offset commit; retry topic; `seek` by offset or timestamp; `replay` over a window; per-partition lag |
| `@declaragent/source-sqs` | queue | Long polling; FIFO + standard; IAM role or access keys; visibility timeout renewal; DLQ redrive via SQS native |
| `@declaragent/source-mqtt` | pub/sub | QoS 0/1/2; durable session (`cleanStart: false`); topic-filter wildcards; MQTT 5 user-properties → event meta |
| `@declaragent/source-amqp` | queue | Prefetch; publisher confirms; DLX via RabbitMQ-native; per-queue prefetch window |
| `@declaragent/source-nats` | pub/sub + streaming | JetStream streams/consumers + queue groups; `seek` by sequence |

Kafka is the acceptance-demo adapter — the others exist to validate that `BaseSourceInstance`'s abstractions hold across transport families.

---

## 7. Observability

Lazy-loaded OpenTelemetry per `SPEC_AND_PLAN.md §Part 3 — Observability`. The metrics surface is defined in core; exporters are wired at the daemon level from `@opentelemetry/*` peer deps (~400KB unshipped when not used).

### 7.1 `MetricsRegistry` contract

```ts
export interface MetricsRegistry {
  counter(name: string, help?: string): Counter;
  gauge(name: string, help?: string): Gauge;
  histogram(name: string, help?: string, buckets?: readonly number[]): Histogram;
}
```

Default: a noop `MetricsRegistry` so adapter code runs fine without OTel wired in. When OTel is present (`@opentelemetry/api` resolved), the daemon substitutes an adapter that bridges to OTel's `MeterProvider`.

### 7.2 Required metrics per source

Emitted from `BaseSourceInstance`:

```
source.messages.received{id=…,type=…}          counter
source.messages.processed{…}                   counter
source.messages.failed{…}                      counter
source.messages.dlq{…}                         counter
source.inflight{…}                             gauge
source.process.duration_ms{…}                  histogram (buckets ms)
source.connection.errors{…}                    counter
source.lag{…,partition=…}                      gauge       (streaming only)
source.circuit.state{…}                        gauge       (0=closed 1=half 2=open)
```

Dispatcher emits `dispatcher.outcome{kind=…}` and `dispatcher.target.rate_limited` (slice 14).

### 7.3 Tracing

One span per message:

```
span: source.message
  source.id, source.type, message.topic, message.partition, message.offset
    span: dispatcher.handle
      dispatch.outcome
        span: engine.runAgent (from Phase 3)
```

Stitching via `event.meta.correlationId` so multi-source correlation (§13.4 of `EVENT_SOURCE_REGISTRY.md`) works across adapters.

### 7.4 Lag dashboard

Grafana template (`dashboards/source-lag.json`) shipped in `packages/testkit/`. Panels: per-partition lag, p99 latency, inflight per source, DLQ rate, circuit-breaker state. Alert rules: sustained non-zero lag > 5min, DLQ rate > 1% of received, consecutive connection errors > 5.

---

## 8. Reliability machinery

### 8.1 `ConcurrencyLimiter`

Bounded worker pool used by `BaseSourceInstance`. `acquire(): Promise<release>`. Shared code; lives in core.

### 8.2 Circuit breaker

Per source. States: closed (normal), open (trip; refuse new work + pause consumer), half-open (probe). Config knobs: `failureThreshold`, `successThreshold`, `halfOpenAfterMs`. When the breaker opens, `BaseSourceInstance.pause()` is called; when it half-opens, a single probe fires; on success, `resume()`.

### 8.3 Backpressure watermarks on the bus

Extend `EventBus` with high/low watermark hooks (slice 13):

```ts
export interface EventBus {
  // ... existing
  /** High/low watermarks. When recent() / inflight exceeds high, sources pause(). */
  registerPressureListener(listener: {
    onHigh(): void;
    onLow(): void;
  }): () => void;
}
```

The daemon (slice 13) wires a pressure listener that calls `pause()` on every `EventSourceInstance` when the bus's in-flight publish count crosses the high watermark, then `resume()` when it drops below the low watermark.

### 8.4 Per-target rate limiting (dispatcher)

Slice 14 adds token-bucket rate limits keyed on `event.target` to the dispatcher. Caps runaway LLM spend when a chatty topic loops. Exceeded → `DispatchOutcome.kind = 'rejected', reason: 'rate-limit'` (already in Phase 3 types).

### 8.5 Idempotency at scale

Phase 3 slice 8 added `(idempotencyKey, source_type)` cross-restart dedup. Phase 4 extends:
- The normalizer computes a **transport-natural key** when `idempotencyKeyFrom: 'transport-natural'`: for Kafka, `kafka:<topic>:<partition>:<offset>`; for SQS, the MessageId; for AMQP, `<exchange>:<routingKey>:<deliveryTag>`.
- Header-based keys (`idempotencyKeyFrom: { path: '$.headers.x-event-id' }`) for publishers that embed their own keys.
- Content-hash fallback (SHA-256 of raw payload).

No dispatcher changes — this is all in the normalizer. The dedup cache extension is slice 1.

---

## 9. Declarative configuration

`event-sources.yaml` is the v0.7 primary config surface. JSON stays working for back-compat with Phase 3.

### 9.1 Example

```yaml
version: 1
sources:
  - id: orders-kafka
    type: kafka
    enabled: true
    transport:
      brokers: ["kafka1:9092", "kafka2:9092"]
      consumerGroup: "my-agent-orders"
      topics: ["orders.placed", "orders.cancelled"]
    security:
      sasl:
        mechanism: SCRAM-SHA-512
        username: "${secret:kafka_username}"
        password: "${secret:kafka_password}"
      ssl: { ca: "/etc/ssl/kafka-ca.pem" }
    routing:
      format: avro
      schemaRegistry:
        url: "https://schema-registry.internal"
        subject: "orders-value"
      kindSelector: "$.event_type"
      targetSelector:
        type: skill
        name: "order-workflow"
        inputs:
          order_id: "$.order_id"
    delivery:
      mode: at-least-once
      ackStrategy: after-publish
      maxRetries: 5
      retryBackoff: { initialMs: 1000, maxMs: 60000, jitter: true }
      dlq: { kind: transport-native, destination: "orders.dlq" }
      idempotency: { strategy: transport-natural, ttlMs: 86400000, store: sqlite }
    limits:
      concurrency: 8
      maxInflight: 100
      ratePerSec: 50
    permissions:
      mode: auto
      allow: ["mcp__warehouse__*", "Read(**/*)"]
      deny: ["Bash(*)"]
```

### 9.2 Loader

Lives in `packages/core/src/events/config-loader.ts`. Uses `yaml` (already a dep). Zod schema per adapter type (adapters export their own Zod schema; the loader picks the right one based on `type`). Surfaces errors with file path + JSON pointer + human-readable diagnostic.

### 9.3 Secret resolution

`SecretResolver` contract:

```ts
export interface SecretResolver {
  resolve(ref: string): Promise<string>;  // "${env:VAR}" | "${secret:path}" | "${file:/path}"
}
```

Default resolver: `env:` and `file:` only. `secret:` is deferred to Phase 6 (vault integration). When a `secret:` ref is seen and no vault resolver is registered, the daemon fails fast with a pointer to Phase 6.

---

## 10. ExtensionRegistry integration

Phase 3 introduced `Extension<'event-source'>`. Phase 4 doesn't add a new extension kind; it widens the payload:
- `EventSourceInstance` gains the optional fields (`seek`, `replay`, `lag`).
- `BaseSourceInstance` is exported from `@declaragent/core`; adapter packages extend it.
- The discovery layer (slice 4) registers one `Extension<'event-source'>` per live adapter+config pair.

One wrinkle: Phase 3's `eventSourceExtension()` wrapper takes a single `{ config }` and resolves at daemon startup. Phase 4 discovery needs a two-step registration: first the **adapter** (type → `EventSourceAdapter<C>`), then per-source **instances** (each `SourceConfig` → `EventSourceInstance`). Slice 1 splits the wrapper accordingly:

```ts
// Old (Phase 3): one call creates both
await eventSourceExtension(adapter, { config, source, bus, ... });

// New (Phase 4): two phases
const adapterExt = adapterExtension(adapter, { source: 'plugin:@declaragent/source-kafka' });
await registry.register(adapterExt);

for (const cfg of loadedSourceConfigs) {
  const instanceExt = await sourceInstanceExtension(registry, cfg, deps);
  await registry.register(instanceExt);
}
```

Phase 3 built-ins (cron, webhook, file-watch) migrate to the two-step form. Their adapters register once; each configured trigger is its own instance.

---

## 11. Slice breakdown

Same approach as Phase 3: thin vertical slices, each independently mergeable.

### Slice 1 — Contract widening (~2 days)
- Extend `SourceDependencies`, `EventSourceAdapter`, `EventSourceInstance`, `SourceHealth`, `SourceMetrics` per §3
- Add `DeliveryConfig`, `LimitsConfig`, `SeekPosition`, `ReplayParams` types
- Migrate Phase 3 built-ins (cron/webhook/file-watch) to the wider interface — new fields defaulted via a `Phase3Compat` shim
- Extend `EventStore` + dispatcher idempotency cache to accept structured transport-natural keys
- Split `eventSourceExtension()` into `adapterExtension` + `sourceInstanceExtension`
- Tests: every Phase 3 test still passes; new fields exercised by fixture

### Slice 2 — `BaseSourceInstance` + `ConcurrencyLimiter` + ack strategies (~3 days)
- `packages/core/src/events/base-source.ts`
- `packages/core/src/events/concurrency.ts`
- `AckContext` contract
- Ack strategies: `before-publish`, `after-publish`, `after-dispatch`
  - `after-dispatch` wires a one-shot `event.after` hook per inflight message id
- Retry + DLQ flow in `handleFailure`
- Tests: in-memory fake adapter subclasses `BaseSourceInstance`; each ack strategy exercised; retry budget exhaustion → DLQ; concurrency limit enforced

### Slice 3 — `MessageNormalizer` + JSONPath + filter/transform (~3 days)
- `packages/core/src/events/normalizer.ts`
- Minimal JSONPath (`$.foo.bar`, `$.arr[0]`, `$.a.b.c`); explicit non-support of scripts/filters-in-path
- JSON + plain decoders
- Filter expressions (boolean JSONPath: `$.x > 5`, `$.y in ["a", "b"]`, `$.z and not $.w`) — a small predicate AST, hand-rolled (~200 lines) to avoid a parser dep
- Transform: copy-paths into target selectors (`inputs: { id: "$.order_id" }`)
- Tests: normalize a Kafka-shape RawMessage, an SQS-shape, an MQTT-shape; filter drops; transform picks the right fields; unknown JSONPath → reasonable error

### Slice 4 — Adapter package discovery (~2 days)
- Scan `node_modules/@declaragent/source-*` in `configDir` + cwd
- Read package.json, validate the `declaragent.kind == 'event-source-adapter'` marker + `agent_compat`
- Dynamic-import the default export; verify it's an `EventSourceAdapter`
- Register into the Phase-3 `ExtensionRegistry` via `adapterExtension()`
- CLI: `declaragent source-adapters list` — shows discovered adapters + their `agent_compat`
- Tests: fixture with a fake installed package in a tmpdir; mismatched `agent_compat` rejected with a clear message; two packages claiming the same `type` → conflict error

### Slice 5 — Schema registry + Avro/Protobuf (~3 days)
- `packages/core/src/events/schema-registry.ts` — thin HTTP client for Confluent Schema Registry (`/subjects/<subject>/versions/latest` + decode by schema id in the magic-byte prefix)
- Avro decoder via optional peer dep `avsc`
- Protobuf decoder via optional peer dep `protobufjs`
- Small in-memory cache keyed on schema id
- Tests: mock registry server; happy path decode; cache hit; unknown schema id → typed error; missing peer dep → helpful "npm install avsc" message

### Slice 6 — Observability hook (OTel bridge + histograms) (~3 days)
- `MetricsRegistry` contract + noop default
- `@opentelemetry/api` bridge (peer dep, detected at runtime)
- Latency histogram with power-of-two buckets
- Wire metrics emission into `BaseSourceInstance`
- Tracing: one span per message, propagated via `correlationId`
- Tests: bus a fake metrics backend; assert emitted samples; verify span is attached to the event via meta

### Slice 7 — Kafka adapter (`@declaragent/source-kafka`) (~5 days) ★
- New workspace package
- `kafkajs` as the primary dep
- SASL/PLAIN + SCRAM-SHA-256/512 + OAUTHBEARER (stub) + mTLS
- Manual offset commits (sync with ack strategy)
- Consumer groups + rebalance handlers
- `seek(offset|timestamp)` + `replay` over an offset window
- Retry topic pattern for DLQ
- Per-partition `lag()`
- Tests:
  - Contract conformance (uses the in-memory test harness)
  - Docker Compose fixture with Redpanda (single-node Kafka) for integration tests
  - Broker-restart test: kill the broker mid-stream, verify consumer recovers + no duplicate publishes to the bus

### Slice 8 — SQS adapter (`@declaragent/source-sqs`) (~4 days)
- New package
- `@aws-sdk/client-sqs` v3 (modular) as the primary dep
- IAM role via default credential chain + access-key fallback
- Long-polling + visibility-timeout renewal
- FIFO queues: `MessageGroupId` honored for per-group serialization
- DLQ redrive via SQS native (no adapter code; point `delivery.dlq.destination` at the DLQ URL in the SQS policy)
- Tests: contract conformance; LocalStack integration for real SQS API

### Slice 9 — MQTT adapter (`@declaragent/source-mqtt`) (~3 days)
- New package
- `mqtt` npm (MQTT.js) as the primary dep
- QoS 0/1/2 per-topic
- Durable session (`clean: false`)
- Topic-filter wildcards (`sensors/+/temperature`)
- MQTT 5 user-properties copied to `event.headers`
- Tests: contract conformance; Mosquitto integration

### Slice 10 — AMQP adapter (`@declaragent/source-amqp`) (~3 days)
- New package
- `amqplib` as the primary dep
- Prefetch (`basic.qos`) honoring `limits.maxInflight`
- Publisher confirms
- DLX via native RabbitMQ DLX declaration (adapter writes it on startup if the target queue doesn't exist)
- Tests: contract conformance; RabbitMQ integration via Docker

### Slice 11 — NATS adapter (`@declaragent/source-nats`) (~3 days)
- New package
- `nats` v2 as the primary dep
- Plain subject subscription (at-most-once)
- JetStream streams + durable consumers (at-least-once)
- Queue groups for competing-consumers
- `seek` by JetStream sequence number
- Tests: contract conformance; nats-server integration

### Slice 12 — DLQ + replay tooling (~3 days)
- `declaragent events replay --from <time> --source <id> [--filter <expr>]` reads events from the store (Phase 3) or calls `instance.replay()` when the source supports it; routes through the dispatcher with fresh event ids
- DLQ inspection: `declaragent dlq list --source <id>`, `declaragent dlq show <id>`, `declaragent dlq redrive <id>`
- Transport-native DLQs (SQS redrive, RabbitMQ DLX) vs. agent-managed (Kafka retry topic, file-watch jsonl) — the CLI adapts
- Tests: integration with the Kafka + SQS adapters; assert replay respects `filter`; assert redrive clears from DLQ

### Slice 13 — Bus backpressure watermarks + circuit breaker (~2 days)
- `EventBus.registerPressureListener({ onHigh, onLow })`
- `CircuitBreaker` class (shared)
- Wire both into `BaseSourceInstance` — open breaker + pause on sustained failure; bus-high → pause all sources; bus-low → resume
- Tests: simulate dispatcher stall, verify sources pause; simulate consumer-facing 100% error rate, verify breaker opens

### Slice 14 — Per-target rate limiting (dispatcher) (~1 day)
- Token-bucket in the dispatcher keyed on `event.target`
- Config: `spec.deployment.rateLimits.byTarget[]` (new)
- Exceeded → `{ kind: 'rejected', reason: 'rate-limit' }`
- Tests: hammer a target, assert overflow is rejected; assert the bucket refills

### Slice 15 — YAML config loader + secret resolver (~2 days)
- `event-sources.yaml` support alongside `.json`
- `SecretResolver` contract + `env:` + `file:` resolvers
- Zod per-adapter-type schemas (each adapter exports its schema; the loader composes them)
- `declaragent events-config validate [path]` — dry-run the config without starting sources
- Tests: malformed YAML → clear error; `${env:UNSET}` → clear error; round-trip with a real multi-source config

### Slice 16 — Load test harness + acceptance demo (~3 days)
- `packages/testkit/src/load/kafka.ts` — produces N msg/sec against a Redpanda instance
- Agent config: a skill that does nothing but return, so we measure transport overhead
- Measurement: p50, p99 end-to-end latency; dropped count; offset-commit correctness
- Broker restart test: kill the Redpanda pod at T+30s, restart at T+45s; assert the agent reconnects and processes the full message set exactly once per the idempotency config
- Acceptance target: 1K msg/sec sustained for 10 minutes with p99 < 5s and zero messages unaccounted for

### Slice 17 — Grafana dashboards + OTel exporter docs (~1 day)
- `packages/testkit/dashboards/` — Grafana JSON for source lag + throughput + DLQ + circuit-breaker
- `docs/OTEL_SETUP.md` — wiring the OTel exporter (OTLP HTTP + Prom scrape) with concrete recipes
- No code in core; docs + dashboards only

**Critical path:** 1 → 2 → 3 → {5 ∥ 6} → 7 → 12 → 16. Slices 4, 13, 14, 15 can land any time after slice 1. Slices 8/9/10/11 can run in parallel with slice 12 and 13 once 2+3+6 are in.

**Total estimate:** ~40 days of focused work, ~5–6 weeks for one engineer; ~4 weeks with two engineers parallelizing adapters. Matches the spec's 4–6 week guidance for Phase 4.

---

## 12. File layout

```
packages/core/src/
├── events/
│   ├── base-source.ts                 # slice 2
│   ├── base-source.test.ts
│   ├── concurrency.ts                 # slice 2
│   ├── concurrency.test.ts
│   ├── circuit-breaker.ts             # slice 13
│   ├── normalizer.ts                  # slice 3
│   ├── normalizer.test.ts
│   ├── jsonpath.ts                    # slice 3 (minimal impl)
│   ├── jsonpath.test.ts
│   ├── filter-expr.ts                 # slice 3
│   ├── schema-registry.ts             # slice 5
│   ├── schema-registry.test.ts
│   ├── metrics-registry.ts            # slice 6
│   ├── secret-resolver.ts             # slice 15
│   ├── config-loader.ts               # slice 15
│   └── adapter-discovery.ts           # slice 4

packages/source-kafka/                 # slice 7
├── package.json
├── src/{index,adapter,instance,config,offset-store}.ts
├── src/instance.test.ts
└── test/integration.test.ts

packages/source-sqs/                   # slice 8
packages/source-mqtt/                  # slice 9
packages/source-amqp/                  # slice 10
packages/source-nats/                  # slice 11

packages/cli/src/
├── dlq-cli.ts                         # slice 12
├── dlq-cli.test.ts
├── events-config-cli.ts               # slice 15 (validate)
└── source-adapters-cli.ts             # slice 4 (list)

packages/testkit/
├── dashboards/                        # slice 17
│   ├── source-lag.json
│   └── throughput.json
└── src/load/kafka.ts                  # slice 16
```

---

## 13. Touch points into existing code

Phase 4 is **more intrusive than Phase 3** because the contract widening touches every existing source + the dispatcher.

- `packages/core/src/events/types.ts` — widened interfaces (slice 1)
- `packages/core/src/events/sources/{cron,webhook,file-watch}.ts` — migrated to `BaseSourceInstance` (slice 2). Cron's existing hand-rolled retry timer moves to `BaseSourceInstance`'s concurrency limiter + retry.
- `packages/core/src/events/dispatcher.ts` — per-target rate limit hook (slice 14); transport-natural idempotency keys respected (slice 1).
- `packages/core/src/events/bus.ts` — pressure listeners (slice 13).
- `packages/core/src/events/store.ts` — `findDuplicate` extended to scope on natural key shape (slice 1).
- `packages/core/src/events/daemon.ts` — calls adapter discovery (slice 4); wires `SecretResolver`, `MetricsRegistry`, `normalizer` into the per-source `SourceDependencies` (slices 3, 5, 6, 15).
- `packages/cli/src/daemon-cli.ts` — `sourcesProvider` reads YAML (slice 15).
- `packages/cli/src/events-cli.ts` — `replay --from` uses `instance.replay()` when available (slice 12).
- `packages/core/package.json` — stays lean; the optional peer deps (`avsc`, `protobufjs`, `msgpackr`, `@opentelemetry/api`) are **peer** deps so core's install footprint doesn't balloon.

Same rationale as Phase 2/3: keep the Phase-1 contract change rate at zero. Engine, tool system, permission gate, session manager — all untouched.

---

## 14. Testing strategy

Four tiers (one more than Phase 3 — the new tier is the integration fixture).

1. **Pure unit tests** for `BaseSourceInstance`, `MessageNormalizer`, `jsonpath`, `filter-expr`, `ConcurrencyLimiter`, `CircuitBreaker`, `SchemaRegistry` client, config loader.

2. **In-process integration tests** for the contract: a tiny fake adapter subclasses `BaseSourceInstance`, exercises every ack strategy + DLQ path + retry budget + pause/resume. Same test module runs against every shipped adapter via a parameterized "adapter contract" suite in `packages/testkit/src/contract.ts`. Every adapter package imports the suite and runs it with its own factory. Non-negotiable.

3. **Docker Compose integration tests** for each adapter, gated by `DECLARAGENT_INTEGRATION=1`. Compose files live in `packages/source-*/test/fixtures/`. Tests: Redpanda (Kafka), LocalStack (SQS), Mosquitto (MQTT), RabbitMQ (AMQP), nats-server (NATS). CI has a nightly job that runs these; PR CI doesn't (compose is too slow for PR feedback).

4. **End-to-end load test** (slice 16) with the acceptance-demo target. Gated by env. Runs nightly against the Kafka + SQS adapters; generates a report that the daemon shipped zero message loss, p99 latency < 5s, at 1K/sec.

**No tests against a real paid-for service** (no AWS account creds in CI; LocalStack for SQS). Any adapter that needs a real service to test (none in Phase 4) would be gated separately.

---

## 15. Open questions

1. **Schema registry vendor lock-in.** Confluent's Schema Registry is de-facto standard for Kafka Avro. AWS Glue Schema Registry exists; Apicurio exists. Pick one, or ship multiple?
   - **My lean:** ship Confluent's protocol first (the spec names it explicitly). Pluggable interface; Apicurio is largely compatible, AWS Glue is not. If a user needs Glue, they write a decoder.

2. **Filter expression dialect.** JSONPath predicates (hand-rolled) vs. CEL (via a dep) vs. JSONata (via a dep).
   - **My lean:** hand-rolled JSONPath with a small boolean predicate layer. ~200 lines, zero deps. CEL is tempting but ~30KB and a parser we'd own. If users ask for richer expressions, pluggable compilers are a peer-dep Phase-4.x add.

3. **Config format.** YAML-first for v0.7; JSON stays working.
   - **My lean:** ship both. YAML for humans, JSON for tools. Same loader; format detected by extension.

4. **Adapter discovery cwd vs. configDir.** Scan only `configDir`, only cwd, or both?
   - **My lean:** both. Dev-time `npm install` lands in cwd; production `~/.declaragent/node_modules` is installed via `declaragent source install`. Conflicts logged.

5. **Offset-store persistence.** Kafka broker-managed offsets vs. agent-managed (sqlite) vs. hybrid (commit to broker + mirror to sqlite for cross-restart startup consistency).
   - **My lean:** broker-managed default. Agent-managed for adapters where the broker can't (`@declaragent/source-imap` for example, if that ever lands). Sqlite mirror is a Phase-4.x polish if broker failures turn out to leak.

6. **`after-dispatch` ack strategy timeout.** The current sketch waits for the dispatcher's outcome. If the dispatcher hangs, the broker eventually redelivers via visibility-timeout (queues) or a partition-rebalance (streaming). What's the adapter-side timeout?
   - **My lean:** config-supplied `ackDispatchTimeoutMs` (default: 2× `visibilityTimeoutMs` when queues; 5min for streaming). Exceeded → treat as failure, flow into retry.

7. **Broker-restart zero-loss proof.** The acceptance bar is "zero message loss under broker restart." For Kafka this means: committed offset must always ≤ processed message. That's true iff `ackStrategy: after-publish` + committed-offset store in-sync. Still, a partial partition-commit can leave gaps. How strict is "zero loss"?
   - **My lean:** define it as "every message whose offset was committed was delivered to the bus at least once." If the user needs exactly-once, they opt into `after-dispatch` + idempotent downstream. Document explicitly.

8. **Transport-natural key per-family policy.** For Kafka: `topic:partition:offset`. For SQS: MessageId. For AMQP: delivery tag isn't stable across redelivery; better to use the publisher's message-id if present. For MQTT: no natural id (message-id is per-session). Content-hash fallback?
   - **My lean:** each adapter is responsible for picking the best natural key; normalizer treats it as opaque. Document the choice per adapter.

9. **Multi-tenant routing.** `event.meta.tenantId` is mentioned in `EVENT_SOURCE_REGISTRY.md §13.5` but not formalized. Phase 6 handles multi-tenant isolation; Phase 4 should at least carry the field.
   - **My lean:** add `AgentEventMeta.tenantId?: string` in slice 1. Adapters that surface it populate it; dispatcher is unaware (Phase 6's job).

10. **Peer-dep strategy for OTel.** `@opentelemetry/api` is a peer; but adapters can also emit OTel directly without core's bridge.
    - **My lean:** adapters never import OTel directly — they use `deps.metrics`. Keeps adapters portable across OTel versions.

---

## 16. Risks

- **`kafkajs` maintenance velocity.** The primary maintainer has been slow; alternatives (`node-rdkafka` native, Confluent's JS client) exist but have their own tradeoffs (native binding vs. pure-JS). Mitigation: adapter depends on kafkajs via semver; slice 7 has a 2-day budget for swapping to `node-rdkafka` if kafkajs proves untenable; the `KafkaSourceInstance` class isolates the broker API.
- **Schema-registry availability in tests.** Confluent's registry isn't trivially dockerizable. Mitigation: slice 5 tests use a mock HTTP server with canned responses; integration tests in slice 7 use Redpanda's built-in schema registry (API-compatible).
- **Cross-adapter drift.** Five packages means five places to forget to apply a fix. Mitigation: the contract-conformance suite in `packages/testkit/src/contract.ts` is the source of truth; any fix that affects every adapter lands there first.
- **Peer-dep hell.** `@declaragent/source-kafka` peer-depends on `@declaragent/core@^0.7.0`. When core publishes 0.8.0, adapters lag. Mitigation: agent_compat check is strict (fails fast on mismatch); we ship adapters in lockstep with core until v1.0.
- **`after-dispatch` ack complexity.** Wiring a one-shot event.after hook per inflight message adds memory per inflight. Mitigation: bound by `limits.maxInflight`; timeout per §15.6 so hung dispatches don't leak.
- **Load test flakiness.** 1K msg/sec tests are sensitive to CI hardware. Mitigation: load tests run nightly on a dedicated runner; PR CI only runs contract tests. Acceptance is measured on a known-good dev machine profile.
- **YAML parsing surprise.** `yaml` library's tag-handling can surprise users (e.g. `yes` → `true`). Mitigation: schema-validate post-parse; reject unexpected types with a clear error pointing at the offending line.
- **Docker Compose in CI.** Some CI runners don't have Docker. Mitigation: integration tests gated by env; PR CI runs only unit + in-process contract tests; nightly runner has Docker.

---

## 17. Acceptance check

Following the Phase 1 / 2 / 3 pattern: declare Phase 4 done when the spec's exit bar is met:

> Load test sustains 1K msg/sec on Kafka adapter with <5s p99 end-to-end latency; zero message loss under broker restart.

Practically (slice 16):
1. Redpanda running locally; `orders.placed` topic with 12 partitions, replication 1.
2. Daemon running `@declaragent/source-kafka` wired to a skill that increments a counter.
3. Producer: 1,000 msg/sec sustained for 10 minutes.
4. Measurements: p50, p95, p99 end-to-end latency via correlation span; total received vs. total committed-and-dispatched.
5. Mid-run (T+5min): `docker compose restart redpanda`. Observe reconnect within 10s; no duplicate publish to the bus (verified via idempotency-cache dedup count).
6. End-state: received count == dispatched count == 600,000. p99 ≤ 5s.

Plus: the adapter-contract suite runs green on all five adapters (Kafka, SQS, MQTT, AMQP, NATS) against their Docker fixtures.

If both pass, Phase 4 ships.

---

## 18. Next step

Slice 1 (contract widening) is the unblocker — ~2 days, touches every Phase-3 source but each is a surgical edit. Once slice 1 lands:
- Slice 2 (BaseSourceInstance) sets up the subclass pattern
- Slice 3 (normalizer) unblocks adapter routing
- Slices 7–11 can run in parallel on independent adapter packages

Kafka is the critical path to the acceptance bar. Slice 7 starts as soon as slice 3 + 5 + 6 are in — expect ~2 weeks to the first green load test.
