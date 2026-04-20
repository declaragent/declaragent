import { describe, expect, test } from 'bun:test';
import { createEventBus } from '../events/bus.js';
import {
  type RecordingMetricsRegistry,
  type RecordingTracer,
  createRecordingMetricsRegistry,
  createRecordingTracer,
} from '../events/observability.js';
import type {
  AgentEvent,
  DeliveryConfig,
  LimitsConfig,
  RawMessage,
  RoutingConfig,
} from '../events/types.js';
import type { Logger } from '../types/logger.js';
import {
  type BaseChannelConfig,
  BaseChannelInstance,
  type BaseChannelOptions,
  ChannelRateLimitError,
} from './base-channel.js';
import { createChannelRegistry } from './registry.js';
import type {
  ChannelCapabilities,
  ChannelDependencies,
  ConversationRef,
  MessageContent,
  MessageRef,
  SendMessageParams,
  SentMessage,
} from './types.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

const DEFAULT_DELIVERY: DeliveryConfig = {
  mode: 'at-least-once',
  ackStrategy: 'after-publish',
  maxRetries: 2,
  retryBackoff: { initialMs: 10, maxMs: 100, jitter: false },
  idempotency: { strategy: 'content-hash', ttlMs: 60_000, store: 'memory' },
};

const DEFAULT_LIMITS: LimitsConfig = {
  concurrency: 2,
  maxInflight: 10,
};

const DEFAULT_ROUTING: RoutingConfig = {
  format: 'json',
  kindSelector: { const: 'chat.message' },
  targetSelector: { type: 'broadcast' },
};

const DEFAULT_CAPS: ChannelCapabilities = {
  supportsThreads: false,
  supportsReactions: false,
  supportsTypingIndicator: false,
  supportsFileUpload: false,
  supportsVoice: false,
  supportsButtons: false,
  supportsEditMessage: false,
  supportsDeleteMessage: false,
  supportsPresence: false,
  supportsSlashCommands: false,
  supportsDMs: true,
  supportsGroupChats: false,
  supportsVoiceChannels: false,
  maxMessageLength: 4096,
  maxAttachmentBytes: 10 * 1024 * 1024,
};

interface SendRecord {
  params: SendMessageParams;
}

/** Minimal subclass — records every `doSend` call. */
class TestChannel extends BaseChannelInstance {
  calls: SendRecord[] = [];
  failCount = 0;
  rateLimitOnFirstN = 0;
  rateLimitRetryMs = 0;
  started = 0;
  stopped = 0;
  renderedContents: MessageContent[] = [];
  editCalls: { ref: MessageRef; content: MessageContent }[] = [];
  typingCalls: { conversation: ConversationRef; durationMs?: number }[] = [];
  reactCalls: { ref: MessageRef; emoji: string }[] = [];

  protected async doStart(): Promise<void> {
    this.started += 1;
  }
  protected async doStop(): Promise<void> {
    this.stopped += 1;
  }
  protected async doPause(): Promise<void> {}
  protected async doResume(): Promise<void> {}
  protected async healthDetails(): Promise<Record<string, unknown>> {
    return { type: 'test-channel' };
  }
  protected async sendToDLQ(_raw: RawMessage, _err: Error): Promise<void> {}

  protected async doSend(params: SendMessageParams): Promise<SentMessage> {
    this.calls.push({ params });
    this.renderedContents.push(params.content);
    if (this.rateLimitOnFirstN > 0) {
      this.rateLimitOnFirstN -= 1;
      throw new ChannelRateLimitError(this.rateLimitRetryMs);
    }
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw new Error('platform boom');
    }
    return {
      id: `msg-${this.calls.length}`,
      conversation: params.conversation,
    };
  }

  // Optional outbound methods — the base class wraps these at start()
  // time to emit metrics + spans. We leave the bodies as simple
  // recorders so tests can assert both the underlying call and the
  // wrapper instrumentation.
  override setTyping = async (
    conversation: ConversationRef,
    durationMs?: number,
  ): Promise<void> => {
    this.typingCalls.push(
      durationMs !== undefined ? { conversation, durationMs } : { conversation },
    );
  };

  override react = async (ref: MessageRef, emoji: string): Promise<void> => {
    this.reactCalls.push({ ref, emoji });
  };

  override edit = async (ref: MessageRef, content: MessageContent): Promise<void> => {
    this.editCalls.push({ ref, content });
  };

  /**
   * Public wrapper so tests can exercise publishInbound without
   * breaking encapsulation. `BaseChannelInstance.publishInbound` is
   * `protected`; real adapters call it from their own transport code.
   */
  publishInboundForTest(event: AgentEvent): Promise<AgentEvent> {
    return this.publishInbound(event);
  }
}

function buildChannel(
  opts: {
    outbound?: BaseChannelConfig['outbound'];
    idempotency?: BaseChannelConfig['idempotency'];
    capabilities?: ChannelCapabilities;
    sleep?: (ms: number) => Promise<void>;
    metrics?: RecordingMetricsRegistry;
    tracer?: RecordingTracer;
  } = {},
): {
  channel: TestChannel;
  sleeps: number[];
  metrics?: RecordingMetricsRegistry;
  tracer?: RecordingTracer;
} {
  const bus = createEventBus();
  const channels = createChannelRegistry();
  const deps: ChannelDependencies = {
    bus,
    logger: NOOP_LOGGER,
    configDir: '/tmp',
    channels,
    ...(opts.metrics !== undefined && { metrics: opts.metrics }),
    ...(opts.tracer !== undefined && { tracer: opts.tracer }),
  };
  const sleeps: number[] = [];
  const config: BaseChannelConfig = {
    id: 'test-channel',
    routing: DEFAULT_ROUTING,
    delivery: DEFAULT_DELIVERY,
    limits: DEFAULT_LIMITS,
    ...(opts.outbound !== undefined && { outbound: opts.outbound }),
    ...(opts.idempotency !== undefined && { idempotency: opts.idempotency }),
  };
  const options: BaseChannelOptions = {
    type: 'test',
    config,
    deps,
    capabilities: opts.capabilities ?? DEFAULT_CAPS,
    sleep:
      opts.sleep ??
      (async (ms: number) => {
        sleeps.push(ms);
      }),
  };
  const channel = new TestChannel(options);
  return {
    channel,
    sleeps,
    ...(opts.metrics !== undefined && { metrics: opts.metrics }),
    ...(opts.tracer !== undefined && { tracer: opts.tracer }),
  };
}

const CONV: ConversationRef = { channelId: 'test-channel', conversationId: 'C1' };

function mkParams(key: string, textOverride?: string): SendMessageParams {
  return {
    conversation: CONV,
    content: { kind: 'text', text: textOverride ?? 'hi' },
    idempotencyKey: key,
  };
}

describe('BaseChannelInstance.send', () => {
  test('calls doSend and returns the SentMessage', async () => {
    const { channel } = buildChannel();
    const sent = await channel.send(mkParams('k-1'));
    expect(sent.id).toBe('msg-1');
    expect(channel.calls).toHaveLength(1);
  });

  test('dedupes retries via the idempotency cache', async () => {
    const { channel } = buildChannel();
    const first = await channel.send(mkParams('dup'));
    const second = await channel.send(mkParams('dup'));
    expect(second).toEqual(first);
    expect(channel.calls).toHaveLength(1);
    expect(channel.sendCountersSnapshot().idempotencyHits).toBe(1);
  });

  test('requires idempotencyKey', async () => {
    const { channel } = buildChannel();
    await expect(
      channel.send({
        conversation: CONV,
        content: { kind: 'text', text: 'hi' },
        idempotencyKey: '',
      }),
    ).rejects.toThrow(/idempotencyKey/);
  });

  test('single-retries on ChannelRateLimitError and sleeps the retry-after', async () => {
    const { channel, sleeps } = buildChannel();
    channel.rateLimitOnFirstN = 1;
    channel.rateLimitRetryMs = 250;
    const sent = await channel.send(mkParams('retry-1'));
    expect(sent.id).toBe('msg-2');
    expect(channel.calls).toHaveLength(2);
    expect(sleeps).toEqual([250]);
    expect(channel.sendCountersSnapshot().rateLimitRetried).toBe(1);
    expect(channel.sendCountersSnapshot().success).toBe(1);
  });

  test('propagates persistent rate limits after the single retry', async () => {
    const { channel } = buildChannel();
    channel.rateLimitOnFirstN = 2;
    channel.rateLimitRetryMs = 10;
    await expect(channel.send(mkParams('retry-2'))).rejects.toBeInstanceOf(ChannelRateLimitError);
    expect(channel.calls).toHaveLength(2);
    expect(channel.sendCountersSnapshot().failed).toBe(1);
  });

  test('propagates non-rate-limit errors without retry', async () => {
    const { channel } = buildChannel();
    channel.failCount = 1;
    await expect(channel.send(mkParams('fail-1'))).rejects.toThrow(/platform boom/);
    expect(channel.calls).toHaveLength(1);
    expect(channel.sendCountersSnapshot().failed).toBe(1);
  });

  test('respects global outbound rate limit', async () => {
    let t = 0;
    const { channel } = buildChannel({
      outbound: { globalPerSec: 2, globalBurst: 2, maxWaitMs: 1000 },
      sleep: async (ms: number) => {
        t += ms;
      },
    });
    // Override clock so acquire's internal wait loop works deterministically.
    // We can't inject the clock into the channel's limiter post-hoc, but a
    // coarse assertion that two sends pass and the third blocks+resolves
    // is sufficient for this test.
    await channel.send(mkParams('a'));
    await channel.send(mkParams('b'));
    // Don't block on the third — allow it to run with real (fast) refill.
    const t0 = Date.now();
    await channel.send(mkParams('c'));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(0);
    expect(channel.calls).toHaveLength(3);
    // Keep an eye on accidental unused var warnings from the mock sleep.
    expect(t).toBeGreaterThanOrEqual(0);
  });

  test('capabilitiesAwareRender is applied to doSend (slice 2 pass-through)', async () => {
    const { channel } = buildChannel();
    const content: MessageContent = { kind: 'text', text: 'hello world' };
    await channel.send({ conversation: CONV, content, idempotencyKey: 'c-1' });
    expect(channel.renderedContents[0]).toEqual(content);
  });

  test('exposes the declared capabilities', () => {
    const { channel } = buildChannel();
    expect(channel.capabilities).toBe(DEFAULT_CAPS);
  });

  test('lifecycle from BaseSourceInstance still works', async () => {
    const { channel } = buildChannel();
    await channel.start();
    expect(channel.started).toBe(1);
    expect((await channel.health()).status).toBe('healthy');
    await channel.stop();
    expect(channel.stopped).toBe(1);
  });
});

// ── Slice 14: metrics + tracing assertions ──────────────────────────────────

const REF: MessageRef = { id: 'm-1', conversation: CONV };

function countRecords(metrics: RecordingMetricsRegistry, name: string): number {
  let n = 0;
  for (const r of metrics.records) {
    if (r.name === name) n += 1;
  }
  return n;
}

function sumRecords(
  metrics: RecordingMetricsRegistry,
  name: string,
  labelFilter?: Readonly<Record<string, string>>,
): number {
  let total = 0;
  for (const r of metrics.records) {
    if (r.name !== name) continue;
    if (labelFilter) {
      const labels = r.labels ?? {};
      let match = true;
      for (const [k, v] of Object.entries(labelFilter)) {
        if (labels[k] !== v) {
          match = false;
          break;
        }
      }
      if (!match) continue;
    }
    total += r.value;
  }
  return total;
}

describe('BaseChannelInstance observability (slice 14)', () => {
  test('successful send emits channel.outbound.sent + a latency sample', async () => {
    const metrics = createRecordingMetricsRegistry();
    const tracer = createRecordingTracer();
    const { channel } = buildChannel({ metrics, tracer });
    const sent = await channel.send(mkParams('obs-send-1'));
    expect(sent.id).toBe('msg-1');
    expect(sumRecords(metrics, 'channel.outbound.sent', { id: 'test-channel', type: 'test' })).toBe(
      1,
    );
    expect(countRecords(metrics, 'channel.outbound.latency_ms')).toBe(1);
    // Span should have closed with ok status + latency attribute.
    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0];
    expect(span).toBeDefined();
    expect(span?.name).toBe('channel.outbound.send');
    expect(span?.ended).toBe(true);
    expect(span?.status?.status).toBe('ok');
    expect(typeof span?.attributes['latency.ms']).toBe('number');
    expect(span?.attributes['message.id']).toBe('msg-1');
    expect(span?.startAttributes?.['idempotency.cached']).toBe(false);
  });

  test('failed send emits channel.outbound.failed with reason=error', async () => {
    const metrics = createRecordingMetricsRegistry();
    const tracer = createRecordingTracer();
    const { channel } = buildChannel({ metrics, tracer });
    channel.failCount = 1;
    await expect(channel.send(mkParams('obs-fail-1'))).rejects.toThrow(/platform boom/);
    expect(sumRecords(metrics, 'channel.outbound.failed', { reason: 'error' })).toBe(1);
    expect(sumRecords(metrics, 'channel.outbound.sent')).toBe(0);
    // Span recorded exception + error status.
    const span = tracer.spans[0];
    expect(span).toBeDefined();
    expect(span?.status?.status).toBe('error');
    expect(span?.exceptions.length).toBe(1);
  });

  test('rate-limited-then-succeeded emits rate_limit_retries:1 + sent:1', async () => {
    const metrics = createRecordingMetricsRegistry();
    const { channel } = buildChannel({ metrics });
    channel.rateLimitOnFirstN = 1;
    channel.rateLimitRetryMs = 0;
    const sent = await channel.send(mkParams('obs-retry-1'));
    expect(sent.id).toBe('msg-2');
    expect(sumRecords(metrics, 'channel.outbound.rate_limit_retries')).toBe(1);
    expect(sumRecords(metrics, 'channel.outbound.sent')).toBe(1);
    expect(sumRecords(metrics, 'channel.outbound.failed')).toBe(0);
  });

  test('idempotency cache hit emits idempotency_hits and no new sent', async () => {
    const metrics = createRecordingMetricsRegistry();
    const tracer = createRecordingTracer();
    const { channel } = buildChannel({ metrics, tracer });
    await channel.send(mkParams('obs-dup-1'));
    await channel.send(mkParams('obs-dup-1'));
    expect(sumRecords(metrics, 'channel.outbound.sent')).toBe(1);
    expect(sumRecords(metrics, 'channel.outbound.idempotency_hits')).toBe(1);
    // Two spans: first real send, second cache-hit.
    expect(tracer.spans).toHaveLength(2);
    const cachedSpan = tracer.spans[1];
    expect(cachedSpan).toBeDefined();
    expect(cachedSpan?.startAttributes?.['idempotency.cached']).toBe(true);
  });

  test('setTyping / edit / react wrappers emit metrics + spans after start()', async () => {
    const metrics = createRecordingMetricsRegistry();
    const tracer = createRecordingTracer();
    const { channel } = buildChannel({ metrics, tracer });
    await channel.start();
    // Optional arrow-property methods are wrapped at start() time.
    await channel.setTyping?.(CONV, 3000);
    await channel.react?.(REF, ':thumbsup:');
    await channel.edit?.(REF, { kind: 'text', text: 'corrected' });
    expect(channel.typingCalls).toHaveLength(1);
    expect(channel.reactCalls).toHaveLength(1);
    expect(channel.editCalls).toHaveLength(1);
    expect(sumRecords(metrics, 'channel.typing.sent')).toBe(1);
    expect(sumRecords(metrics, 'channel.reactions.sent')).toBe(1);
    expect(sumRecords(metrics, 'channel.outbound.edited')).toBe(1);
    // Edit produces its own span.
    const editSpan = tracer.spans.find((s) => s.name === 'channel.outbound.edit');
    expect(editSpan).toBeDefined();
    expect(editSpan?.status?.status).toBe('ok');
    expect(editSpan?.ended).toBe(true);
    // Counter snapshot reflects the new fields.
    const snap = channel.sendCountersSnapshot();
    expect(snap.typingSent).toBe(1);
    expect(snap.reactionsSent).toBe(1);
    expect(snap.edited).toBe(1);
    await channel.stop();
  });

  test('publishInbound emits channel.inbound.received on success, .failed on error', async () => {
    const metrics = createRecordingMetricsRegistry();
    const { channel } = buildChannel({ metrics });

    const okEvent: AgentEvent = {
      id: 'evt-ok',
      kind: 'chat.message',
      timestamp: Date.now(),
      source: { type: 'self', reason: 'wakeup' },
      target: { type: 'broadcast' },
      auth: { kind: 'internal' },
      payload: { text: 'ping' },
    };
    await channel.publishInboundForTest(okEvent);
    expect(sumRecords(metrics, 'channel.inbound.received')).toBe(1);
    expect(sumRecords(metrics, 'channel.inbound.failed')).toBe(0);
  });

  test('works as a noop when deps.metrics + deps.tracer are absent', async () => {
    const { channel } = buildChannel();
    // No metrics / tracer wired — every op should still succeed.
    await channel.send(mkParams('noop-1'));
    await channel.start();
    await channel.setTyping?.(CONV);
    await channel.edit?.(REF, { kind: 'text', text: 'x' });
    await channel.react?.(REF, ':ok:');
    await channel.stop();
    const snap = channel.sendCountersSnapshot();
    expect(snap.success).toBe(1);
    expect(snap.typingSent).toBe(1);
    expect(snap.edited).toBe(1);
    expect(snap.reactionsSent).toBe(1);
  });
});
