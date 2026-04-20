import { stampTenantId } from '../tenancy/stamp.js';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { ConcurrencyLimiter } from './concurrency.js';
import type {
  AgentEvent,
  Counter,
  DeliveryConfig,
  EventSourceInstance,
  Gauge,
  Histogram,
  LimitsConfig,
  NormalizeContext,
  RawMessage,
  RoutingConfig,
  SourceDependencies,
  SourceHealth,
  SourceHealthStatus,
  SourceMetrics,
  Span,
} from './types.js';

export const DEFAULT_ACK_DISPATCH_TIMEOUT_MS = 60_000;
export const DEFAULT_LATENCY_RESERVOIR_SIZE = 1024;

/**
 * Per-message ack handle supplied by the subclass. `ack()` marks the
 * message as successfully processed (committed offset / deleted from
 * queue / settled publisher confirm); `nack()` signals the transport to
 * redeliver. Adapters that can't distinguish redelivery from loss should
 * treat nack as "let the normal retry/visibility semantics do the work."
 */
export interface AckContext {
  readonly messageId: string;
  ack(): Promise<void>;
  nack(): Promise<void>;
}

/**
 * Config slice that every `BaseSourceInstance` needs regardless of
 * transport. Adapter-specific settings (topic list, broker URLs, etc.)
 * live on the subclass's own config type alongside this.
 */
export interface BaseSourceConfig {
  id: string;
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
}

export interface BaseSourceOptions {
  type: string;
  config: BaseSourceConfig;
  deps: SourceDependencies;
  /**
   * How long to wait for the dispatcher's `event.after` hook to fire
   * before treating a message as undeliverable. Only used when
   * `delivery.ackStrategy === 'after-dispatch'`. Default 60s.
   */
  ackDispatchTimeoutMs?: number;
  /**
   * Slice 13 addition. When set, the base class runs every
   * handler through this circuit breaker; on `open`, the source
   * auto-pauses. When unset, no breaker is installed (every message
   * proceeds regardless of prior failures). Adapters that want the
   * default breaker can pass `{}`; the defaults match
   * `CircuitBreaker`'s constructor.
   */
  circuitBreaker?: CircuitBreakerOptions;
  /**
   * Slice 13 addition. When set, the source auto-pauses when the
   * bus's inflight-publish count crosses `highWatermark` and resumes
   * once it falls back to `<= lowWatermark`. Unset disables the
   * linkage.
   */
  busPressure?: {
    highWatermark: number;
    lowWatermark: number;
  };
}

/**
 * Shared lifecycle + metrics + retry + concurrency logic. Every Phase-4
 * adapter subclasses this and implements:
 *
 * - `doStart` / `doStop` / `doPause` / `doResume` — transport-specific
 *   connection management.
 * - `healthDetails` — extra fields merged into `SourceHealth.details`.
 * - `sendToDLQ` — push to transport-native DLQ or agent-managed store.
 *
 * Subclasses call `this.handleMessage(raw, ack)` from their message
 * handler. The base class takes over from there: concurrency limit,
 * normalize, publish, ack/retry/DLQ, latency + metric accounting.
 */
export abstract class BaseSourceInstance implements EventSourceInstance {
  readonly id: string;
  readonly type: string;

  protected state: SourceHealthStatus = 'starting';
  protected startedAt: number | null = null;
  protected lastConnectedAt: number | null = null;
  protected lastMessageAt: number | null = null;
  protected readonly counters = {
    received: 0,
    processed: 0,
    failed: 0,
    dlq: 0,
    connectionErrors: 0,
  };
  protected readonly latency = new LatencyHistogram(DEFAULT_LATENCY_RESERVOIR_SIZE);
  protected readonly limiter: ConcurrencyLimiter;

  protected readonly config: BaseSourceConfig;
  protected readonly deps: SourceDependencies;
  protected readonly ackDispatchTimeoutMs: number;

  // Slice 13: optional breaker + bus-pressure wiring.
  protected readonly breaker: CircuitBreaker | null;
  private readonly busPressureSpec: BaseSourceOptions['busPressure'];
  private detachBreakerListener: (() => void) | null = null;
  private detachBusPressureListener: (() => void) | null = null;
  /**
   * Set of reasons the source is currently paused. Empty → running.
   * `'manual'` is added on public `pause()` and removed on `resume()`.
   * `'breaker'` / `'bus-pressure'` are added/removed by the listeners.
   * The actual `doPause()` / `doResume()` only fire on the empty ↔
   * non-empty transition so a pair of overlapping signals doesn't
   * pause/resume twice.
   */
  private readonly pauseReasons = new Set<'manual' | 'breaker' | 'bus-pressure'>();

  // Emission targets. Lazily resolved on first use so construction is
  // free when no metrics/tracer is wired.
  private instruments?: {
    received: Counter;
    processed: Counter;
    failed: Counter;
    dlq: Counter;
    connectionErrors: Counter;
    inflight: Gauge;
    duration: Histogram;
  };
  private readonly labels: Readonly<Record<string, string>>;

  private readonly pendingAcks = new Map<
    string,
    { ctx: AckContext; timer: ReturnType<typeof setTimeout> }
  >();
  private detachAfterHook: (() => void) | null = null;

  constructor(opts: BaseSourceOptions) {
    this.type = opts.type;
    this.id = opts.config.id;
    this.config = opts.config;
    this.deps = opts.deps;
    this.ackDispatchTimeoutMs = opts.ackDispatchTimeoutMs ?? DEFAULT_ACK_DISPATCH_TIMEOUT_MS;
    this.limiter = new ConcurrencyLimiter(opts.config.limits.concurrency);
    this.labels = { id: this.id, type: this.type };
    this.breaker = opts.circuitBreaker ? new CircuitBreaker(opts.circuitBreaker) : null;
    this.busPressureSpec = opts.busPressure;
  }

  private getInstruments(): typeof this.instruments {
    if (this.instruments) return this.instruments;
    const m = this.deps.metrics;
    if (!m) return undefined;
    this.instruments = {
      received: m.counter('source.messages.received', 'Messages received from the transport'),
      processed: m.counter('source.messages.processed', 'Messages published to the bus'),
      failed: m.counter('source.messages.failed', 'Messages that threw during processing'),
      dlq: m.counter('source.messages.dlq', 'Messages that exhausted retries and hit the DLQ'),
      connectionErrors: m.counter('source.connection.errors', 'Transport connection errors'),
      inflight: m.gauge('source.inflight', 'In-flight message handlers'),
      duration: m.histogram('source.process.duration_ms', 'End-to-end processing latency in ms'),
    };
    return this.instruments;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.state = 'starting';
    await this.doStart();
    this.state = 'healthy';
    const t = this.now();
    this.startedAt = t;
    this.lastConnectedAt = t;
    this.wireAfterDispatchListener();
    this.wireBreakerListener();
    this.wireBusPressureListener();
  }

  async stop(reason?: string): Promise<void> {
    this.state = 'stopped';
    this.detachAfterHook?.();
    this.detachAfterHook = null;
    this.detachBreakerListener?.();
    this.detachBreakerListener = null;
    this.detachBusPressureListener?.();
    this.detachBusPressureListener = null;
    this.pauseReasons.clear();
    this.breaker?.reset();
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingAcks.clear();
    await this.doStop(reason);
  }

  async pause(): Promise<void> {
    await this.pauseFor('manual');
  }

  async resume(): Promise<void> {
    await this.resumeFrom('manual');
  }

  /**
   * Add a reason to the pause set. If this was the first reason, call
   * `doPause()`. Otherwise the transport is already paused — just record
   * the reason so only the *last* reason to be removed triggers resume.
   */
  private async pauseFor(reason: 'manual' | 'breaker' | 'bus-pressure'): Promise<void> {
    const wasRunning = this.pauseReasons.size === 0;
    this.pauseReasons.add(reason);
    if (wasRunning) {
      this.state = 'degraded';
      await this.doPause();
    }
  }

  /**
   * Remove a pause reason. If no reasons remain, resume the transport.
   */
  private async resumeFrom(reason: 'manual' | 'breaker' | 'bus-pressure'): Promise<void> {
    if (!this.pauseReasons.delete(reason)) return; // wasn't pausing for this reason
    if (this.pauseReasons.size === 0) {
      this.state = 'healthy';
      await this.doResume();
    }
  }

  async health(): Promise<SourceHealth> {
    const details = await this.healthDetails();
    const out: SourceHealth = {
      status: this.state,
      connectionErrors: this.counters.connectionErrors,
      details,
    };
    if (this.lastConnectedAt !== null) out.lastConnectedAt = this.lastConnectedAt;
    if (this.lastMessageAt !== null) out.lastMessageAt = this.lastMessageAt;
    return out;
  }

  metrics(): SourceMetrics {
    return {
      // Phase-3 fields kept for back-compat.
      eventsPublished: this.counters.processed,
      lastEventAt: this.lastMessageAt,
      // Phase-4 fields.
      messagesReceived: this.counters.received,
      messagesProcessed: this.counters.processed,
      messagesFailed: this.counters.failed,
      messagesDLQ: this.counters.dlq,
      inflightCount: this.limiter.currentInflight,
      avgProcessMs: this.latency.avg(),
      p99ProcessMs: this.latency.p99(),
    };
  }

  // ── Message flow ───────────────────────────────────────────────────────

  /**
   * Subclass calls this on each inbound RawMessage. Flow:
   * 1. acquire a concurrency slot
   * 2. normalize (filter may drop → ack + no publish)
   * 3. ack strategy dispatch
   * 4. on error, nack up to `maxRetries`, then DLQ + ack
   */
  protected async handleMessage(raw: RawMessage, ack: AckContext): Promise<void> {
    const release = await this.limiter.acquire();
    const timerStop = this.latency.start();
    const t0 = performance.now();
    this.counters.received += 1;
    this.lastMessageAt = this.now();

    const instruments = this.getInstruments();
    instruments?.received.inc(1, this.labels);
    instruments?.inflight.set(this.limiter.currentInflight, this.labels);

    // Start a span covering the entire message lifecycle. Attributes
    // that depend on the normalized event (correlation id, kind) are
    // attached after normalization succeeds.
    const span: Span | undefined = this.deps.tracer?.startSpan('source.message', {
      ...this.labels,
      'message.id': ack.messageId,
      ...(raw.topic !== undefined && { 'message.topic': raw.topic }),
      ...(raw.partition !== undefined && { 'message.partition': raw.partition }),
      ...(raw.offset !== undefined && { 'message.offset': raw.offset }),
    });

    try {
      const normalizer = this.deps.normalizer;
      if (!normalizer) {
        // Adapter is wired without a normalizer. Two plausible reasons:
        // (a) test fixture, (b) misconfiguration. Either way, acking is
        // the safe default; the message doesn't get dropped on the
        // floor (transport still thinks we processed it) but nothing
        // reaches the bus. Log noisily so the miswire is observable.
        this.deps.logger.warn('base-source.no-normalizer', {
          id: this.id,
          messageId: ack.messageId,
        });
        span?.setAttribute('outcome', 'no-normalizer');
        await ack.ack();
        return;
      }

      const normalized = await normalizer.normalize(
        raw,
        this.config.routing,
        this.buildNormalizeContext(raw),
      );
      if (!normalized) {
        // Filter dropped the message. Success: ack and move on.
        span?.setAttribute('outcome', 'filtered');
        await ack.ack();
        return;
      }

      // Phase 6: auto-stamp tenant id when the adapter is tenant-scoped
      // and the normalizer didn't already set one.
      const event = stampTenantId(normalized, this.deps.tenant);

      // Enrich the span with post-normalize attributes.
      span?.setAttribute('event.id', event.id);
      span?.setAttribute('event.kind', event.kind);
      if (event.meta?.correlationId) {
        span?.setAttribute('correlation.id', event.meta.correlationId);
      }

      const strategy = this.config.delivery.ackStrategy;

      if (strategy === 'before-publish') {
        await ack.ack();
      }

      await this.deps.bus.publish(event);
      this.counters.processed += 1;
      instruments?.processed.inc(1, this.labels);
      span?.setAttribute('outcome', 'published');

      if (strategy === 'after-publish') {
        await ack.ack();
      } else if (strategy === 'after-dispatch') {
        this.registerPendingAck(event.id, ack);
      }
      span?.setStatus('ok');
      this.breaker?.record(true);
    } catch (err) {
      this.counters.failed += 1;
      instruments?.failed.inc(1, this.labels);
      this.breaker?.record(false);
      if (err instanceof Error) {
        span?.recordException(err);
        span?.setStatus('error', err.message);
      } else {
        span?.setStatus('error', String(err));
      }
      await this.handleFailure(raw, ack, err as Error);
    } finally {
      timerStop();
      const durationMs = performance.now() - t0;
      instruments?.duration.observe(durationMs, this.labels);
      release();
      instruments?.inflight.set(this.limiter.currentInflight, this.labels);
      span?.end();
    }
  }

  /**
   * Retry budget, then DLQ, then ack. Adapters' `nack()` is expected to
   * propagate the retry via transport semantics (SQS visibility timeout,
   * Kafka retry topic, AMQP nack/requeue, etc.).
   */
  protected async handleFailure(raw: RawMessage, ack: AckContext, err: Error): Promise<void> {
    const attempt = Number(raw.meta?.deliveryCount ?? 0);
    if (attempt < this.config.delivery.maxRetries) {
      this.deps.logger.warn('base-source.retry', {
        id: this.id,
        messageId: ack.messageId,
        attempt,
        err: err.message,
      });
      try {
        await ack.nack();
      } catch (nackErr) {
        this.deps.logger.error('base-source.nack.error', {
          id: this.id,
          err: nackErr instanceof Error ? nackErr.message : String(nackErr),
        });
      }
      return;
    }
    try {
      await this.sendToDLQ(raw, err);
      this.counters.dlq += 1;
      this.getInstruments()?.dlq.inc(1, this.labels);
    } catch (dlqErr) {
      this.deps.logger.error('base-source.dlq.error', {
        id: this.id,
        err: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
      });
    }
    await ack.ack();
  }

  // ── after-dispatch wiring ──────────────────────────────────────────────

  /**
   * Subscribe to breaker transitions. When the breaker opens, pause the
   * source with the `'breaker'` reason; when it closes, remove that
   * reason (which resumes the source if no other pause reasons remain).
   */
  private wireBreakerListener(): void {
    if (!this.breaker) return;
    this.detachBreakerListener = this.breaker.onTransition((event) => {
      if (event.to === 'open') {
        this.deps.logger.warn('base-source.breaker.open', {
          id: this.id,
          type: this.type,
        });
        void this.pauseFor('breaker').catch((err: unknown) => {
          this.deps.logger.error('base-source.breaker.pause-error', {
            id: this.id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      } else if (event.to === 'closed') {
        this.deps.logger.info?.('base-source.breaker.closed', {
          id: this.id,
          type: this.type,
        });
        void this.resumeFrom('breaker').catch((err: unknown) => {
          this.deps.logger.error('base-source.breaker.resume-error', {
            id: this.id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });
  }

  /**
   * Subscribe to bus pressure watermarks. When the bus is overloaded,
   * pause the source with the `'bus-pressure'` reason; when pressure
   * clears, drop the reason (and resume if nothing else is holding the
   * source paused).
   */
  private wireBusPressureListener(): void {
    if (!this.busPressureSpec) return;
    this.detachBusPressureListener = this.deps.bus.registerPressureListener({
      highWatermark: this.busPressureSpec.highWatermark,
      lowWatermark: this.busPressureSpec.lowWatermark,
      onHigh: (n) => {
        this.deps.logger.warn('base-source.bus-pressure.high', { id: this.id, inflight: n });
        void this.pauseFor('bus-pressure').catch((err: unknown) => {
          this.deps.logger.error('base-source.bus-pressure.pause-error', {
            id: this.id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      },
      onLow: (n) => {
        this.deps.logger.info?.('base-source.bus-pressure.low', { id: this.id, inflight: n });
        void this.resumeFrom('bus-pressure').catch((err: unknown) => {
          this.deps.logger.error('base-source.bus-pressure.resume-error', {
            id: this.id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      },
    });
  }

  private wireAfterDispatchListener(): void {
    if (this.config.delivery.ackStrategy !== 'after-dispatch') return;
    if (!this.deps.hookRegistry) return;
    this.detachAfterHook = this.deps.hookRegistry.on('event.after', ({ event, outcome }) => {
      const pending = this.pendingAcks.get(event.id);
      if (!pending) return;
      this.pendingAcks.delete(event.id);
      clearTimeout(pending.timer);
      // Every dispatcher outcome (dispatched/broadcast/queued/duplicate/
      // rejected) is an authoritative "done." Ack in all cases — the
      // transport has no signal here beyond "we processed it."
      void pending.ctx.ack().catch((err: unknown) => {
        this.deps.logger.warn('base-source.ack.error', {
          id: this.id,
          eventId: event.id,
          err: err instanceof Error ? err.message : String(err),
          outcome: outcome.kind,
        });
      });
    });
  }

  private registerPendingAck(eventId: string, ack: AckContext): void {
    if (!this.deps.hookRegistry) {
      // Without a hook registry we can't observe outcomes. Rather than
      // hanging the message, degrade to `after-publish` semantics and
      // warn — this is always a misconfiguration (the daemon should
      // wire a hook registry when adapters use after-dispatch).
      this.deps.logger.warn('base-source.after-dispatch.no-hook-registry', { id: this.id });
      void ack.ack().catch(() => {});
      return;
    }
    const timer = setTimeout(() => {
      this.pendingAcks.delete(eventId);
      this.deps.logger.warn('base-source.after-dispatch.timeout', {
        id: this.id,
        eventId,
        timeoutMs: this.ackDispatchTimeoutMs,
      });
      void ack.nack().catch((err: unknown) => {
        this.deps.logger.error('base-source.nack.error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.ackDispatchTimeoutMs);
    this.pendingAcks.set(eventId, { ctx: ack, timer });
  }

  // ── Helpers for subclasses ─────────────────────────────────────────────

  protected now(): number {
    return this.deps.clock?.now() ?? Date.now();
  }

  /**
   * Supply the adapter-specific `NormalizeContext` for each inbound
   * message. Default: a neutral `self.wakeup` source tag so test
   * adapters don't have to override. Broker adapters return their own
   * transport-specific tag — Kafka returns `{ type: 'kafka', topic, ... }`,
   * SQS returns `{ type: 'sqs', queueUrl, ... }`, etc.
   */
  protected buildNormalizeContext(_raw: RawMessage): NormalizeContext {
    return {
      source: { type: 'self', reason: 'wakeup' },
      auth: { kind: 'internal' },
    };
  }

  protected recordConnectionError(): void {
    this.counters.connectionErrors += 1;
    this.state = 'unhealthy';
    this.getInstruments()?.connectionErrors.inc(1, this.labels);
  }

  protected markConnected(): void {
    this.lastConnectedAt = this.now();
    this.state = 'healthy';
  }

  /** Expose inflight ids (for diagnostics). */
  protected get pendingAckIds(): readonly string[] {
    return [...this.pendingAcks.keys()];
  }

  // ── Subclass contract ──────────────────────────────────────────────────

  protected abstract doStart(): Promise<void>;
  protected abstract doStop(reason?: string): Promise<void>;
  protected abstract doPause(): Promise<void>;
  protected abstract doResume(): Promise<void>;
  protected abstract healthDetails(): Promise<Record<string, unknown>>;
  protected abstract sendToDLQ(raw: RawMessage, err: Error): Promise<void>;
}

/**
 * Fixed-size reservoir for average + p99 latency. Precise enough for
 * dashboards + alert rules; replaced by OTel histograms in slice 6 for
 * adapters that opt into full percentile telemetry.
 */
export class LatencyHistogram {
  private samples: number[] = [];

  constructor(private readonly max: number) {}

  /** Returns a stop function that records the elapsed ms. */
  start(): () => void {
    const t0 = performance.now();
    return () => this.observe(performance.now() - t0);
  }

  observe(ms: number): void {
    if (this.samples.length >= this.max) this.samples.shift();
    this.samples.push(ms);
  }

  avg(): number {
    if (this.samples.length === 0) return 0;
    let sum = 0;
    for (const v of this.samples) sum += v;
    return sum / this.samples.length;
  }

  p99(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1);
    return sorted[idx] ?? 0;
  }

  /** For tests. */
  get count(): number {
    return this.samples.length;
  }
}

// Unused import guard — silences TS when `AgentEvent` is only referenced
// via JSDoc in this file.
export type { AgentEvent };
