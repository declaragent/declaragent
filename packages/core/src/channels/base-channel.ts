import {
  type BaseSourceConfig,
  BaseSourceInstance,
  type BaseSourceOptions,
} from '../events/base-source.js';
import type { AgentEvent, Counter, Histogram, Span } from '../events/types.js';
import { stampTenantId } from '../tenancy/stamp.js';
import { DEFAULT_OUTBOUND_MAX_WAIT_MS, OutboundRateLimiter } from './outbound-rate-limiter.js';
import { capabilitiesAwareRender as renderWithCapabilities } from './renderer/capabilities-degrade.js';
import {
  DEFAULT_SEND_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_SEND_IDEMPOTENCY_TTL_MS,
  type SendIdempotencyCache,
  createSendIdempotencyCache,
} from './send-idempotency.js';
import type { ChannelPermissionsConfig } from './types.js';
import type {
  ChannelAction,
  ChannelCapabilities,
  ChannelDependencies,
  ChannelInstance,
  ChannelMessageContent,
  ConversationRef,
  FileRef,
  FileUpload,
  MessageRef,
  SendMessageParams,
  SentMessage,
  WebhookRequest,
  WebhookResponse,
} from './types.js';

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Surfaces a platform rate-limit response. `BaseChannelInstance.send`
 * treats a throw of this type as "wait `retryAfterMs` then try exactly
 * once more"; persistent rate limits propagate to the caller. Adapters
 * map their SDK-specific 429 errors to this class.
 */
export class ChannelRateLimitError extends Error {
  constructor(
    readonly retryAfterMs: number,
    message?: string,
  ) {
    super(message ?? `Channel rate-limited; retry after ${retryAfterMs}ms`);
    this.name = 'ChannelRateLimitError';
  }
}

export function isChannelRateLimitError(err: unknown): err is ChannelRateLimitError {
  return err instanceof ChannelRateLimitError;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface BaseChannelOutboundConfig {
  perConversationPerSec?: number;
  perConversationBurst?: number;
  globalPerSec?: number;
  globalBurst?: number;
  maxWaitMs?: number;
}

export interface BaseChannelIdempotencyConfig {
  ttlMs?: number;
  maxEntries?: number;
}

export interface BaseChannelConfig extends BaseSourceConfig {
  /** Outbound rate-limit tuning. Omit for unlimited. */
  outbound?: BaseChannelOutboundConfig;
  /** Send-idempotency cache tuning. */
  idempotency?: BaseChannelIdempotencyConfig;
  /**
   * Slice 9. Per-channel permission rules + per-user overrides. Resolved
   * via `resolveForChannel(principal, permissions)` at session-spawn
   * time and wired into the session's scoped `PermissionGate`.
   */
  permissions?: ChannelPermissionsConfig;
}

export interface BaseChannelOptions extends BaseSourceOptions {
  config: BaseChannelConfig;
  deps: ChannelDependencies;
  capabilities: ChannelCapabilities;
  /** Injected sleep for the 429 single-retry path. Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

// ── Counters ────────────────────────────────────────────────────────────────
//
// Slice 14 extends the original in-process counters with per-op totals so
// tests (and ad-hoc operators without a metrics backend wired) can read a
// snapshot without a MetricsRegistry. The metric names emitted through
// `deps.metrics` remain the source of truth for production dashboards.

interface SendCounters {
  // Original counters (kept for back-compat with slice 2 tests + adapters).
  success: number;
  failed: number;
  rateLimitRetried: number;
  idempotencyHits: number;
  // Slice 14 additions.
  edited: number;
  typingSent: number;
  reactionsSent: number;
  deleted: number;
  inboundReceived: number;
  inboundFailed: number;
}

// ── Base class ──────────────────────────────────────────────────────────────

/**
 * Shared lifecycle + outbound plumbing for every channel adapter.
 * Inherits Phase-4 reliability (retry, DLQ, circuit breaker, concurrency,
 * metrics) from `BaseSourceInstance`; adds:
 *
 * - Two-tier outbound rate limiting.
 * - Send-idempotency dedup.
 * - One-shot retry on a platform rate-limit response.
 * - Capabilities-aware render pass (slice 2 pass-through; slice 4 wires
 *   the unified `RichBlock` renderer).
 * - Slice 14: channel-specific metrics + tracing, emitted via
 *   `deps.metrics` / `deps.tracer` when present (noop otherwise).
 *
 * Subclasses supply the transport-specific `doSend` alongside the
 * `BaseSourceInstance` abstract contract.
 */
export abstract class BaseChannelInstance extends BaseSourceInstance implements ChannelInstance {
  readonly capabilities: ChannelCapabilities;
  protected readonly channelDeps: ChannelDependencies;
  protected readonly outboundLimiter: OutboundRateLimiter;
  protected readonly sendIdempotency: SendIdempotencyCache;
  protected readonly sendCounters: SendCounters = {
    success: 0,
    failed: 0,
    rateLimitRetried: 0,
    idempotencyHits: 0,
    edited: 0,
    typingSent: 0,
    reactionsSent: 0,
    deleted: 0,
    inboundReceived: 0,
    inboundFailed: 0,
  };
  private readonly sleep: (ms: number) => Promise<void>;

  // Slice 14: lazily-resolved channel-specific instruments. Mirrors the
  // `getInstruments()` pattern on `BaseSourceInstance` so we pay nothing
  // at construction when no metrics backend is wired.
  private channelInstruments?: {
    sent: Counter;
    edited: Counter;
    failed: Counter;
    idempotencyHits: Counter;
    rateLimitRetries: Counter;
    typingSent: Counter;
    reactionsSent: Counter;
    deleted: Counter;
    inboundReceived: Counter;
    inboundFailed: Counter;
    latency: Histogram;
  };
  private readonly channelLabels: Readonly<Record<string, string>>;
  private optionalMethodsWrapped = false;

  constructor(opts: BaseChannelOptions) {
    super(opts);
    this.capabilities = opts.capabilities;
    this.channelDeps = opts.deps;
    this.sleep = opts.sleep ?? defaultSleep;
    this.channelLabels = { id: this.id, type: this.type };

    const outboundOpts: Parameters<typeof buildLimiter>[0] = opts.config.outbound ?? {};
    this.outboundLimiter = buildLimiter(outboundOpts);

    const idemOpts = opts.config.idempotency ?? {};
    this.sendIdempotency = createSendIdempotencyCache({
      ttlMs: idemOpts.ttlMs ?? DEFAULT_SEND_IDEMPOTENCY_TTL_MS,
      maxEntries: idemOpts.maxEntries ?? DEFAULT_SEND_IDEMPOTENCY_MAX_ENTRIES,
    });
  }

  // ── Instruments ────────────────────────────────────────────────────────

  private getChannelInstruments(): typeof this.channelInstruments {
    if (this.channelInstruments) return this.channelInstruments;
    const m = this.channelDeps.metrics;
    if (!m) return undefined;
    this.channelInstruments = {
      sent: m.counter('channel.outbound.sent', 'Outbound messages successfully sent'),
      edited: m.counter('channel.outbound.edited', 'Outbound messages successfully edited'),
      failed: m.counter('channel.outbound.failed', 'Outbound sends that failed after retries'),
      idempotencyHits: m.counter(
        'channel.outbound.idempotency_hits',
        'Outbound sends short-circuited by the idempotency cache',
      ),
      rateLimitRetries: m.counter(
        'channel.outbound.rate_limit_retries',
        'Outbound sends that hit a platform 429 and were one-shot retried',
      ),
      typingSent: m.counter('channel.typing.sent', 'Typing indicators issued'),
      reactionsSent: m.counter('channel.reactions.sent', 'Reactions issued'),
      deleted: m.counter('channel.outbound.deleted', 'Outbound messages deleted'),
      inboundReceived: m.counter('channel.inbound.received', 'Inbound events published to the bus'),
      inboundFailed: m.counter('channel.inbound.failed', 'Inbound events that failed to publish'),
      latency: m.histogram('channel.outbound.latency_ms', 'End-to-end outbound send latency in ms'),
    };
    return this.channelInstruments;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  override async start(): Promise<void> {
    await super.start();
    // Arrow-property optional methods (`setTyping`, `react`, `edit`,
    // `delete`) are assigned by the subclass body, which runs after our
    // constructor finishes. By `start()` time every subclass field has
    // been installed — wrap them now with metric-emitting proxies so
    // adapters don't need to sprinkle emission calls themselves.
    this.wrapOptionalMethods();
  }

  // ── Outbound ─────────────────────────────────────────────────────────────

  async send(params: SendMessageParams): Promise<SentMessage> {
    if (!params.idempotencyKey) {
      throw new Error('BaseChannelInstance.send: idempotencyKey is required');
    }

    const instruments = this.getChannelInstruments();
    const tracer = this.channelDeps.tracer;

    const cached = this.sendIdempotency.get(params.idempotencyKey);
    if (cached) {
      this.sendCounters.idempotencyHits += 1;
      instruments?.idempotencyHits.inc(1, this.channelLabels);
      const span: Span | undefined = tracer?.startSpan('channel.outbound.send', {
        ...this.channelLabels,
        'conversation.id': params.conversation.conversationId,
        'content.kind': params.content.kind,
        'idempotency.cached': true,
      });
      span?.setStatus('ok');
      span?.end();
      return cached;
    }

    await this.outboundLimiter.acquire(params.conversation.conversationId);

    const rendered: SendMessageParams = {
      ...params,
      content: this.capabilitiesAwareRender(params.content),
    };

    const span: Span | undefined = tracer?.startSpan('channel.outbound.send', {
      ...this.channelLabels,
      'conversation.id': params.conversation.conversationId,
      'content.kind': params.content.kind,
      'idempotency.cached': false,
    });
    const t0 = performance.now();

    try {
      const sent = await this.doSend(rendered);
      const elapsed = performance.now() - t0;
      this.sendIdempotency.put(params.idempotencyKey, sent);
      this.sendCounters.success += 1;
      instruments?.sent.inc(1, this.channelLabels);
      instruments?.latency.observe(elapsed, this.channelLabels);
      span?.setAttribute('latency.ms', elapsed);
      span?.setAttribute('message.id', sent.id);
      span?.setStatus('ok');
      return sent;
    } catch (err) {
      if (isChannelRateLimitError(err)) {
        this.sendCounters.rateLimitRetried += 1;
        instruments?.rateLimitRetries.inc(1, this.channelLabels);
        const retryMs = Math.max(0, err.retryAfterMs);
        if (retryMs > 0) await this.sleep(retryMs);
        try {
          const sent = await this.doSend(rendered);
          const elapsed = performance.now() - t0;
          this.sendIdempotency.put(params.idempotencyKey, sent);
          this.sendCounters.success += 1;
          instruments?.sent.inc(1, this.channelLabels);
          instruments?.latency.observe(elapsed, this.channelLabels);
          span?.setAttribute('latency.ms', elapsed);
          span?.setAttribute('message.id', sent.id);
          span?.setStatus('ok');
          return sent;
        } catch (retryErr) {
          this.sendCounters.failed += 1;
          instruments?.failed.inc(1, {
            ...this.channelLabels,
            reason: isChannelRateLimitError(retryErr) ? 'rate-limit' : 'error',
          });
          if (retryErr instanceof Error) {
            span?.recordException(retryErr);
            span?.setStatus('error', retryErr.message);
          } else {
            span?.setStatus('error', String(retryErr));
          }
          throw retryErr;
        }
      }
      this.sendCounters.failed += 1;
      instruments?.failed.inc(1, { ...this.channelLabels, reason: 'error' });
      if (err instanceof Error) {
        span?.recordException(err);
        span?.setStatus('error', err.message);
      } else {
        span?.setStatus('error', String(err));
      }
      throw err;
    } finally {
      span?.end();
    }
  }

  /** Snapshot of outbound counters for tests + metrics. */
  sendCountersSnapshot(): Readonly<SendCounters> {
    return { ...this.sendCounters };
  }

  // ── Inbound ─────────────────────────────────────────────────────────────

  /**
   * Channel-native inbound publish. Chat platforms don't need the
   * transport-level ack/retry choreography `BaseSourceInstance.handleMessage`
   * provides (Telegram resumes from its `update_id` offset, webhooks
   * retry on HTTP failure, etc.) — the adapter builds a fully-formed
   * `AgentEvent` and hands it here. Concurrency limiting + received /
   * processed / failed counters are preserved.
   *
   * Returns the published event so callers can chain correlation-id
   * bookkeeping.
   */
  protected async publishInbound(event: AgentEvent): Promise<AgentEvent> {
    const release = await this.limiter.acquire();
    this.counters.received += 1;
    this.lastMessageAt = Date.now();
    // Phase 6: auto-stamp tenant id when the channel adapter is
    // tenant-scoped and the adapter didn't already set one. Return the
    // stamped event so callers (and channel tests) see the final shape.
    const stamped = stampTenantId(event, this.channelDeps.tenant);
    try {
      await this.channelDeps.bus.publish(stamped);
      this.counters.processed += 1;
      this.sendCounters.inboundReceived += 1;
      this.getChannelInstruments()?.inboundReceived.inc(1, this.channelLabels);
      return stamped;
    } catch (err) {
      this.counters.failed += 1;
      this.sendCounters.inboundFailed += 1;
      this.getChannelInstruments()?.inboundFailed.inc(1, this.channelLabels);
      throw err;
    } finally {
      release();
    }
  }

  // ── Optional outbound surface ───────────────────────────────────────────
  //
  // Every method below is optional at the `ChannelInstance` level. The
  // base class proxies to a protected `doXxx` if a subclass implements it;
  // otherwise throws a clear "not supported" error keyed on capability.

  setTyping?(conversation: ConversationRef, durationMs?: number): Promise<void>;
  react?(ref: MessageRef, emoji: string): Promise<void>;
  edit?(ref: MessageRef, content: ChannelMessageContent): Promise<void>;
  delete?(ref: MessageRef): Promise<void>;
  uploadFile?(file: FileUpload, conversation: ConversationRef): Promise<FileRef>;
  performAction?(action: ChannelAction): Promise<void>;
  handleWebhook?(req: WebhookRequest): Promise<WebhookResponse>;

  // ── Optional-method wrapping ─────────────────────────────────────────────

  /**
   * Wrap the subclass-provided arrow-property implementations of
   * `setTyping` / `react` / `edit` / `delete` so metrics + spans fire
   * around each call. Safe to invoke multiple times: subsequent calls
   * short-circuit. Invoked from `start()` once the subclass body has
   * finished assigning its own overrides.
   */
  private wrapOptionalMethods(): void {
    if (this.optionalMethodsWrapped) return;
    this.optionalMethodsWrapped = true;

    if (typeof this.setTyping === 'function') {
      const original = this.setTyping.bind(this);
      this.setTyping = async (
        conversation: ConversationRef,
        durationMs?: number,
      ): Promise<void> => {
        await original(conversation, durationMs);
        this.sendCounters.typingSent += 1;
        this.getChannelInstruments()?.typingSent.inc(1, this.channelLabels);
      };
    }

    if (typeof this.react === 'function') {
      const original = this.react.bind(this);
      this.react = async (ref: MessageRef, emoji: string): Promise<void> => {
        await original(ref, emoji);
        this.sendCounters.reactionsSent += 1;
        this.getChannelInstruments()?.reactionsSent.inc(1, this.channelLabels);
      };
    }

    if (typeof this.edit === 'function') {
      const original = this.edit.bind(this);
      this.edit = async (ref: MessageRef, content: ChannelMessageContent): Promise<void> => {
        const tracer = this.channelDeps.tracer;
        const span: Span | undefined = tracer?.startSpan('channel.outbound.edit', {
          ...this.channelLabels,
          'conversation.id': ref.conversation.conversationId,
          'message.id': ref.id,
          'content.kind': content.kind,
        });
        const t0 = performance.now();
        try {
          await original(ref, content);
          const elapsed = performance.now() - t0;
          this.sendCounters.edited += 1;
          this.getChannelInstruments()?.edited.inc(1, this.channelLabels);
          span?.setAttribute('latency.ms', elapsed);
          span?.setStatus('ok');
        } catch (err) {
          if (err instanceof Error) {
            span?.recordException(err);
            span?.setStatus('error', err.message);
          } else {
            span?.setStatus('error', String(err));
          }
          throw err;
        } finally {
          span?.end();
        }
      };
    }

    if (typeof this.delete === 'function') {
      const original = this.delete.bind(this);
      this.delete = async (ref: MessageRef): Promise<void> => {
        await original(ref);
        this.sendCounters.deleted += 1;
        this.getChannelInstruments()?.deleted.inc(1, this.channelLabels);
      };
    }
  }

  // ── Abstract surface ────────────────────────────────────────────────────

  /**
   * Transport-specific outbound. Subclass POSTs to Slack / calls
   * telegraf / writes to Discord.js and returns the `SentMessage`. May
   * throw `ChannelRateLimitError` on 429 — the base class's single-retry
   * handles that.
   */
  protected abstract doSend(params: SendMessageParams): Promise<SentMessage>;

  /**
   * Capability-driven degradation pass (slice 4). Drops blocks the
   * channel can't render into a fallback text tail so the transport-
   * specific renderer (e.g. `renderTelegram`) sees only supported
   * blocks. Platform-specific serialization happens inside the adapter's
   * `doSend` via the matching renderer.
   */
  protected capabilitiesAwareRender(content: ChannelMessageContent): ChannelMessageContent {
    return renderWithCapabilities(content, this.capabilities);
  }
}

function buildLimiter(cfg: BaseChannelOutboundConfig): OutboundRateLimiter {
  const options: Record<string, number> = {
    maxWaitMs: cfg.maxWaitMs ?? DEFAULT_OUTBOUND_MAX_WAIT_MS,
  };
  if (cfg.perConversationPerSec !== undefined) {
    options.perConversationPerSec = cfg.perConversationPerSec;
  }
  if (cfg.perConversationBurst !== undefined) {
    options.perConversationBurst = cfg.perConversationBurst;
  }
  if (cfg.globalPerSec !== undefined) {
    options.globalPerSec = cfg.globalPerSec;
  }
  if (cfg.globalBurst !== undefined) {
    options.globalBurst = cfg.globalBurst;
  }
  return new OutboundRateLimiter(options as ConstructorParameters<typeof OutboundRateLimiter>[0]);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
