import type { HookRegistry } from '../hooks/types.js';
import type { TenantContext } from '../tenancy/types.js';
import type { Logger } from '../types/logger.js';
import type { AgentSpec } from '../types/session.js';

/** @since 1.0.0 */
export type EventKind =
  | 'user.input'
  | 'trigger.fire'
  | 'webhook.received'
  | 'file.changed'
  | 'mcp.notification'
  | 'mailbox.message'
  | 'self.wakeup'
  | 'self.retry'
  // ── Phase 5 channel kinds ──────────────────────────────────────────────
  | 'chat.message'
  | 'chat.mention'
  | 'chat.dm'
  | 'chat.voice'
  | 'chat.file'
  | 'channel.interaction'
  | 'channel.command'
  | 'channel.reaction'
  | 'channel.presence'
  | 'channel.send.request'
  | 'channel.send.delivered'
  | 'channel.send.failed'
  | 'assistant.message'
  | 'assistant.final'
  | 'turn.started';

export type EventSourceTag =
  | { type: 'user'; sessionId: string }
  | { type: 'cron'; triggerId: string; schedule: string }
  | { type: 'webhook'; triggerId: string; remoteAddr?: string }
  | { type: 'file-watch'; path: string; change: 'add' | 'modify' | 'delete' }
  | { type: 'mcp-notification'; server: string; method: string }
  | { type: 'mailbox'; fromAgent: string }
  | { type: 'self'; reason: 'wakeup' | 'retry' | 'loop' }
  | { type: 'sub-agent'; parentSessionId: string; childId: string }
  /** Phase 5: emitted by the engine loop itself (`assistant.*` events). */
  | { type: 'engine'; sessionId: string; turnId: string }
  // ── Phase 4 broker adapters ────────────────────────────────────────────
  | { type: 'kafka'; triggerId: string; topic: string; partition: number; offset: string }
  | { type: 'sqs'; triggerId: string; queueUrl: string; messageId: string; messageGroupId?: string }
  | { type: 'mqtt'; triggerId: string; topic: string; qos: 0 | 1 | 2 }
  | {
      type: 'amqp';
      triggerId: string;
      exchange: string;
      routingKey: string;
      queue: string;
      deliveryTag: number;
    }
  | {
      type: 'nats';
      triggerId: string;
      stream: string;
      subject: string;
      streamSequence: number;
    }
  // ── Phase 5 channel adapters ───────────────────────────────────────────
  | { type: 'telegram'; channelId: string; chatId: string; updateId: number }
  | {
      type: 'discord';
      channelId: string;
      guildId?: string;
      channelDiscordId: string;
      messageId: string;
    }
  | {
      type: 'slack';
      channelId: string;
      teamId: string;
      channelSlackId: string;
      ts: string;
      threadTs?: string;
    }
  | {
      type: 'whatsapp';
      channelId: string;
      phoneNumberId: string;
      waId: string;
      messageId: string;
    };

export type EventTarget =
  | { type: 'session'; sessionId: string; mode: 'inject' | 'replace' | 'queue' }
  | { type: 'new-session'; agentSpec?: Partial<AgentSpec>; initialPrompt: string }
  | { type: 'skill'; name: string; inputs: Readonly<Record<string, unknown>> }
  | { type: 'sub-agent'; parentSessionId: string; spec: Partial<AgentSpec> }
  | { type: 'broadcast' };

export type EventAuth =
  | { kind: 'local-user' }
  | { kind: 'trigger'; triggerId: string }
  | { kind: 'bearer'; tokenHash: string }
  | { kind: 'hmac'; signatureHash: string }
  | { kind: 'internal' };

/**
 * Generic principal carried on `AgentEventMeta.principal`. Phase-5 channel
 * adapters populate the full `ChannelPrincipal` shape from
 * `../channels/types.ts`; other event sources may supply a subset. Kept
 * narrow here to avoid a `channels → events → channels` import cycle.
 */
export interface EventPrincipal {
  /** Adapter instance id (e.g. "slack-prod"). Channel events only. */
  channelId?: string;
  /** Platform-specific user id. */
  platformUserId?: string;
  displayName?: string;
  /** Agent-user identity if resolved via an enroller; else undefined. */
  agentUserId?: string;
  /** Permission scopes granted to this principal. */
  scopes?: readonly string[];
  verified?: boolean;
  verifiedAt?: number;
}

/** @since 1.0.0 */
export interface AgentEventMeta {
  /** Trace id; preserved across child sessions and re-routed events. */
  correlationId?: string;
  /** The event that produced this one; enforced loop-breaker. */
  causedBy?: string;
  /** Application-supplied idempotency key (e.g. `X-GitHub-Delivery`). */
  idempotencyKey?: string;
  /** 0 = highest, no upper bound. Defaults to 100. */
  priority?: number;
  /**
   * Tenant ownership of this event. Phase 4 introduced the field as a
   * hint; Phase 6 promotes it to the canonical scoping key. When a
   * `TenantContext` is wired through the dep bag, every emit path
   * (normalizer, base source, engine, channel adapters) stamps this
   * automatically. Absent = the implicit default tenant.
   */
  tenantId?: string;
  /**
   * Phase-5 addition. Populated by channel adapters (and any other source
   * that knows its caller) so the permission gate's per-user override
   * resolution (slice 9) can apply scoped rules.
   */
  principal?: EventPrincipal;
}

/** @since 1.0.0 */
export interface AgentEvent<P = unknown> {
  /** UUID. Used for dedup + correlation. */
  id: string;
  source: EventSourceTag;
  target: EventTarget;
  kind: EventKind;
  timestamp: number;
  payload: P;
  auth: EventAuth;
  meta?: AgentEventMeta;
}

/**
 * Outcome of a dispatch decision. Defined here (not in the dispatcher
 * module) because `event.after` hooks need to reference it at type level.
 */
export type DispatchOutcome =
  | { kind: 'dispatched'; sessionId: string; turnId?: string }
  | { kind: 'broadcast' }
  | { kind: 'queued'; reason: 'session-busy' | 'session-not-active' }
  | { kind: 'duplicate'; firstSeenAt: number; eventId: string }
  | {
      kind: 'rejected';
      reason:
        | 'rate-limit'
        | 'unauthorized'
        | 'no-handler'
        | 'loop'
        | 'invalid'
        /**
         * Dispatch target's circuit breaker is `open`. Consecutive failures
         * tripped the breaker; new events for this target short-circuit
         * until the cool-down elapses and a probe succeeds.
         * @since 0.6.0-slice.3
         */
        | 'circuit-open';
      details?: string;
    };

export type EventHandler = (event: AgentEvent) => void | Promise<void>;

export type EventKindFilter = EventKind | '*';

/**
 * Phase-4 backpressure signal. The bus tracks in-flight publish count
 * against configured watermarks and fires `onHigh` when the count
 * crosses (and stays at or above) the high mark, and `onLow` when it
 * falls back at or below the low mark. Edge-triggered: one notification
 * per crossing, not a continuous stream.
 */
export interface BusPressureListener {
  /** Fired when in-flight count rises to `>= highWatermark`. */
  onHigh: (inflight: number) => void;
  /** Fired when in-flight count falls back to `<= lowWatermark`. */
  onLow: (inflight: number) => void;
  highWatermark: number;
  lowWatermark: number;
}

export interface EventBus {
  /**
   * Fan out to every matching subscriber. Resolves once all complete
   * via `Promise.allSettled` — one slow subscriber does not block others.
   */
  publish(event: AgentEvent): Promise<void>;
  /** Subscribe to a single `kind` or `'*'` for everything. Returns unsubscribe. */
  subscribe(kind: EventKindFilter, handler: EventHandler): () => void;
  /** In-memory ring buffer of the most recent events (for `/events` + dedup). */
  recent(filter?: (e: AgentEvent) => boolean): readonly AgentEvent[];
  /** Resolves once every in-flight publish has settled. Used by graceful shutdown. */
  drained(): Promise<void>;
  /**
   * Phase 4 slice 13. Subscribe to high/low watermark crossings on
   * in-flight publish count. Adapters (via `BaseSourceInstance`) use
   * this to auto-pause when downstream subscribers can't keep up, and
   * resume once they've drained.
   * Returns an unsubscribe function.
   */
  registerPressureListener(listener: BusPressureListener): () => void;
  /** Current in-flight publish count — useful for metrics + tests. */
  inflightCount(): number;
}

/**
 * The dispatcher is the single entry point that turns a bus event into
 * a concrete action (session turn, skill run, etc.). Slice 2 implements
 * it; later slices wire it into the daemon.
 */
export interface EventDispatcher {
  /**
   * Subscribe `handle()` to the bus (wildcard). Returns an unsubscribe
   * function. The dispatcher is responsible for one subscription per bus.
   */
  attach(bus: EventBus): () => void;
  /**
   * Resolve the event's `target` and execute. Idempotent for any event
   * whose id or `meta.idempotencyKey` has been seen within the TTL window.
   */
  handle(event: AgentEvent): Promise<DispatchOutcome>;
  /**
   * Resolves once every in-flight dispatch has settled. Used by graceful
   * shutdown to avoid dropping events mid-flight (§6 of PHASE_3_PLAN).
   */
  draining(): Promise<void>;
}

/**
 * Phase-3 values (`ok`, `degraded`, `failed`) are kept for backward
 * compatibility. Phase 4 prefers `starting` / `healthy` / `unhealthy` /
 * `stopped` for broker adapters that need richer lifecycle states.
 * `ok` remains accepted as an alias for `healthy`.
 */
export type SourceHealthStatus =
  | 'ok'
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'failed'
  | 'stopped';

export interface SourceHealth {
  status: SourceHealthStatus;
  details?: unknown;
  /** Phase 4 additions — populated by adapters that can track these. */
  lastConnectedAt?: number;
  lastMessageAt?: number;
  connectionErrors?: number;
}

/**
 * Metrics exposed by every source instance. Phase-3 fields
 * (`eventsPublished`, `lastEventAt`) are kept; Phase-4 adapters
 * additionally report processed/failed/DLQ counts, inflight depth,
 * per-partition lag, and latency percentiles via BaseSourceInstance
 * (slice 2).
 */
export interface SourceMetrics {
  eventsPublished: number;
  lastEventAt: number | null;
  /** Phase 4 additions — optional so Phase-3 sources don't need to change. */
  messagesReceived?: number;
  messagesProcessed?: number;
  messagesFailed?: number;
  messagesDLQ?: number;
  inflightCount?: number;
  lagByPartition?: Record<string, number>;
  avgProcessMs?: number;
  p99ProcessMs?: number;
}

/**
 * Live handle to a running event source. One instance per configured
 * trigger (cron schedule, webhook route, file watcher glob, etc.).
 * Carried as the `payload` of an `Extension<'event-source'>` so the
 * registry's lifecycle + `byKind` machinery applies uniformly.
 */
export interface EventSourceInstance {
  /** Caller-supplied id (e.g. `morning-summary`). Unique within a type. */
  readonly id: string;
  /** Adapter type (`cron`, `webhook`, `file-watch`, or plugin-supplied). */
  readonly type: string;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  health(): Promise<SourceHealth>;
  metrics(): SourceMetrics;
  /**
   * Phase 4 additions. All optional — adapters that can't seek/replay
   * simply omit them; the dispatcher + admin CLI check for presence.
   */
  seek?(position: SeekPosition): Promise<void>;
  replay?(params: ReplayParams): AsyncGenerator<AgentEvent>;
  lag?(): Promise<Record<string, number>>;
  /**
   * DLQ inspection (Phase 4 slice 12). Optional — adapters that can reach
   * into their DLQ (Kafka topic, SQS queue URL, RabbitMQ DLX queue,
   * jsonl file) implement these; transport-managed DLQs that hide the
   * queue from the consumer can omit them and the CLI reports
   * "not supported" cleanly.
   */
  listDLQ?(params?: DLQListParams): Promise<readonly DLQEntry[]>;
  showDLQ?(id: string): Promise<DLQEntry | undefined>;
  /**
   * Move a DLQ'd message back to the primary source. Adapter chooses the
   * mechanism: Kafka produces back to the source topic; SQS uses
   * `StartMessageMoveTask` (or a manual receive/send/delete); RabbitMQ
   * publishes to the source exchange with the original routing key.
   * The CLI calls `dlq redrive` which dispatches this method.
   */
  redriveDLQ?(id: string): Promise<void>;
}

/**
 * Dependencies handed to every source `create()` call. The bus is the
 * single spine every source publishes to; logger + configDir come from
 * the host (daemon in slice 9).
 *
 * @since 1.0.0
 */
export interface SourceDependencies {
  bus: EventBus;
  logger: Logger;
  /** Absolute path to the host config dir (e.g. `~/.declaragent`). */
  configDir: string;
  /**
   * Phase 4 additions. Optional during migration so Phase-3 adapters
   * don't need to be aware. The daemon supplies noop defaults; adapters
   * that need these (Kafka schema registry, MQTT/AMQP backpressure, OTel
   * wiring) check for presence.
   */
  normalizer?: MessageNormalizer;
  metrics?: MetricsRegistry;
  /**
   * Tracer for per-message spans. Default: noop. Adapters that wire an
   * OTel backend via `createOtelBridge` route spans through OpenTelemetry.
   */
  tracer?: Tracer;
  secrets?: SecretResolver;
  clock?: Clock;
  shutdownSignal?: AbortSignal;
  /**
   * Required only for adapters whose `delivery.ackStrategy` is
   * `'after-dispatch'` — `BaseSourceInstance` subscribes to `event.after`
   * here and acks pending messages when the dispatcher's outcome lands.
   */
  hookRegistry?: HookRegistry;
  /**
   * Phase 6 addition. Tenant the adapter is scoped to. When present,
   * `BaseSourceInstance` auto-stamps `event.meta.tenantId = tenant.id` on
   * every publish. Absent = default tenant — Phase-1-through-5 callers
   * are unaffected.
   */
  tenant?: TenantContext;
}

/**
 * Adapter contract. Each source type (cron, webhook, file-watch, …)
 * ships one adapter. Plugins can contribute more (§9 of PHASE_3_PLAN).
 *
 * The two-step shape — `validateConfig` then `create` — lets the daemon
 * fail fast on a misconfigured trigger before touching the network or
 * filesystem.
 *
 * @since 1.0.0
 */
export interface EventSourceAdapter<C = unknown> {
  readonly type: string;
  /**
   * Phase 4 addition. Semver range the adapter is compatible with
   * (matched against the agent core version at discovery time, slice 4).
   * Optional for Phase-3 built-ins; slice 4's discovery treats an absent
   * value as "any compatible version".
   */
  readonly agentCompat?: string;
  /** Assertion: throws with a helpful message when `config` is invalid. */
  validateConfig(config: unknown): asserts config is C;
  /**
   * Produce an un-started instance. The wrapper calls `start()` from the
   * extension's `activate` hook so registration and liveness stay coupled.
   */
  create(config: C, deps: SourceDependencies): Promise<EventSourceInstance>;
}

// ─── Phase 4 additions ───────────────────────────────────────────────────
// All types below are new to Phase 4. Slice 1 declares them; later
// slices consume them (BaseSourceInstance in slice 2, MessageNormalizer
// in slice 3, metrics bridge in slice 6, etc.).

// ─── seek + replay ───

export type SeekPosition =
  | { kind: 'offset'; offset: number; partition?: number; topic?: string }
  | { kind: 'timestamp'; timestampMs: number }
  | { kind: 'beginning' }
  | { kind: 'end' };

export interface ReplayParams {
  fromMs: number;
  toMs?: number;
  /** Optional predicate applied after decode/normalize. */
  filter?: (event: AgentEvent) => boolean;
  /** Max events to yield. Hard cap to prevent accidental floods. */
  limit?: number;
}

// ─── DLQ inspection (slice 12) ───────────────────────────────────────────

export interface DLQListParams {
  /** Only return entries whose insertion time is at or after this ms-epoch. */
  sinceMs?: number;
  /** Max entries to return. Adapters cap at their own safe limits. */
  limit?: number;
}

/**
 * Normalized view of a DLQ'd message. The `id` is adapter-specific
 * (Kafka: `topic:partition:offset`; SQS: SQS message id; AMQP: message
 * id or `delivery-tag`; NATS: stream sequence). The CLI quotes it
 * verbatim when invoking `dlq show` / `dlq redrive`.
 */
export interface DLQEntry {
  id: string;
  /** Original message body (usually a string; binary payloads opt into base64). */
  body: string;
  /** Message headers including DLQ-annotation headers added by the adapter. */
  headers: Record<string, string>;
  /** Error message recorded at DLQ time (from `x-declaragent-dlq-reason`). */
  reason?: string;
  /** Optional DLQ insertion timestamp (ms-epoch). */
  insertedAtMs?: number;
  /** Adapter-specific metadata (origin topic/queue/subject, partition, …). */
  meta?: Record<string, unknown>;
}

// ─── DeliveryConfig ───

export interface IdempotencyConfig {
  /**
   * `transport-natural` — use a key derived from transport metadata
   * (Kafka `topic:partition:offset`, SQS MessageId, AMQP `exchange:rk:tag`).
   *
   * `header` — pull from a message header (path supplied via
   * `RoutingConfig.idempotencyKeyFrom`).
   *
   * `content-hash` — SHA-256 over the raw payload as a last resort.
   */
  strategy: 'transport-natural' | 'header' | 'content-hash';
  ttlMs: number;
  /** `sqlite` reuses the Phase-3 EventStore; `redis` lands in Phase 6. */
  store: 'memory' | 'sqlite';
}

export interface DlqConfig {
  /** `transport-native` = SQS redrive / RabbitMQ DLX / Kafka retry topic.
   *  `agent-managed` = written to a local jsonl or agent-side table. */
  kind: 'transport-native' | 'agent-managed';
  destination?: string;
  onDlq?: 'alert' | 'retry-manual' | 'ignore';
}

export interface DeliveryConfig {
  mode: 'at-most-once' | 'at-least-once';
  /**
   * When to ack the transport:
   * - `before-publish` — fast, at-most-once.
   * - `after-publish` — ack after `bus.publish()` resolves. Safe default.
   * - `after-dispatch` — ack only after the dispatcher's outcome. Strongest.
   */
  ackStrategy: 'before-publish' | 'after-publish' | 'after-dispatch';
  maxRetries: number;
  retryBackoff: { initialMs: number; maxMs: number; jitter: boolean };
  dlq?: DlqConfig;
  /** Queue adapters only — ms before redelivery. */
  visibilityTimeoutMs?: number;
  idempotency: IdempotencyConfig;
}

// ─── LimitsConfig ───

export interface LimitsConfig {
  concurrency: number;
  maxInflight: number;
  ratePerSec?: number;
  maxPayloadBytes?: number;
  maxEventsPerMinute?: number;
}

// ─── MessageNormalizer (forward-declared; slice 3 implements) ───

export type JsonPath = string;

export interface RawMessage {
  value: string | Uint8Array;
  key?: string;
  topic?: string;
  partition?: number;
  offset?: string;
  /** AMQP routing key / MQTT topic / NATS subject. */
  routingKey?: string;
  headers?: Record<string, unknown>;
  timestamp?: number;
  meta?: Record<string, unknown>;
}

export type TargetSelector =
  | { type: 'broadcast' }
  | {
      type: 'session';
      sessionIdFrom: JsonPath;
      action: 'inject' | 'replace' | 'queue';
    }
  | {
      type: 'new-session';
      initialPromptFrom?: JsonPath;
      agentSpec?: Partial<AgentSpec>;
    }
  | { type: 'skill'; name: string; inputs?: Record<string, JsonPath | string> }
  | { type: 'sub-agent'; parentSessionIdFrom: JsonPath };

export interface RoutingConfig {
  format?: 'json' | 'avro' | 'protobuf' | 'msgpack' | 'plain';
  schemaRegistry?: { url: string; subject: string };
  /** Boolean JSONPath predicate; messages that evaluate falsy are dropped. */
  filter?: { expr: string };
  /** Pick a subset of the decoded body to carry forward as payload. */
  transform?: { expr: string };
  kindSelector: JsonPath | { const: EventKind };
  targetSelector: TargetSelector;
  /** Where the idempotency key comes from. Default: `transport-natural`. */
  idempotencyKeyFrom?: JsonPath | 'transport-natural' | 'content-hash';
  correlationIdFrom?: JsonPath;
}

/**
 * Adapter-supplied context the normalizer needs to finish constructing
 * an `AgentEvent`. `source` is transport-specific (Kafka topic/partition,
 * SQS queue url, etc.) and the adapter is the authority. `auth` is an
 * optional event-auth stamp; defaults to `{ kind: 'internal' }` when
 * omitted.
 */
export interface NormalizeContext {
  source: EventSourceTag;
  auth?: EventAuth;
}

export interface MessageNormalizer {
  normalize(
    raw: RawMessage,
    routing: RoutingConfig,
    ctx: NormalizeContext,
  ): Promise<AgentEvent | null>;
}

// ─── MetricsRegistry (forward-declared; slice 6 implements) ───

export interface Counter {
  inc(value?: number, labels?: Readonly<Record<string, string>>): void;
}

export interface Gauge {
  set(value: number, labels?: Readonly<Record<string, string>>): void;
  inc(value?: number, labels?: Readonly<Record<string, string>>): void;
  dec(value?: number, labels?: Readonly<Record<string, string>>): void;
}

export interface Histogram {
  observe(value: number, labels?: Readonly<Record<string, string>>): void;
}

export interface MetricsRegistry {
  counter(name: string, help?: string): Counter;
  gauge(name: string, help?: string): Gauge;
  histogram(name: string, help?: string, buckets?: readonly number[]): Histogram;
}

// ─── Tracing ─────────────────────────────────────────────────────────────

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;
export type SpanStatus = 'ok' | 'error';

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: SpanAttributeValue): this;
  setAttributes(attributes: SpanAttributes): this;
  recordException(err: Error): this;
  setStatus(status: SpanStatus, message?: string): this;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attributes?: SpanAttributes): Span;
}

// ─── Secrets + Clock ───

/**
 * Resolves `${env:VAR}` / `${secret:path}` / `${file:/path}` placeholders
 * in source configs. Default host-supplied resolver handles `env:` and
 * `file:`; Phase 6 wires `secret:` to a vault backend.
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export interface Clock {
  now(): number;
}
