/**
 * Synthetic channel load harness (Phase 5 slice 15).
 *
 * Drives N simulated inbound events/sec against a `ChannelRegistry`
 * backed by mock channel instances and a `ChannelOutboundBridge`, and
 * measures the end-to-end latency from inbound publish → outbound send
 * via a `LatencyRecorder`.
 *
 * Unlike the Phase-4 Kafka acceptance harness, this one is deliberately
 * narrow: no adapter plumbing, no broker restart, no transport-level
 * acking. It exists to give the channel stack the same "how does it
 * hold up under a burst?" affordance the broker adapters enjoy.
 *
 * Event flow per inbound tick:
 *   1. Harness builds a `chat.message` `AgentEvent` and publishes it.
 *   2. A loopback subscriber on `chat.message` re-publishes the same
 *      conversation + content as a `channel.send.request`.
 *   3. `ChannelOutboundBridge` consumes `channel.send.request`, looks
 *      up the channel in the registry, and calls `ChannelInstance.send`.
 *   4. The mock channel records the call; the harness observes `send`
 *      as the terminal "outbound" event for latency accounting.
 *
 * Not a general-purpose load framework — just enough to validate that
 * the registry + bridge don't become the bottleneck for thousands of
 * concurrent conversations.
 */

import {
  type AgentEvent,
  type ChannelInstance,
  type ChannelRegistry,
  type ChannelSendRequestPayload,
  type ConversationRef,
  type EventBus,
  type Logger,
  type MessageContent,
  type SendMessageParams,
  type SentMessage,
  createChannelOutboundBridge,
  createChannelRegistry,
  createEventBus,
  createSessionChannelContextStore,
} from '@declaragent/core';
import { LatencyRecorder } from './latency.js';
import { runAtRate } from './pacer.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

/**
 * Payload carried on every `chat.message` the harness publishes. The
 * embedded `sentAt` + `seq` fields are how the harness closes the
 * inbound→outbound loop without relying on a back-channel.
 */
export interface ChannelLoadPayload {
  seq: number;
  sentAt: number;
  conversation: ConversationRef;
  content: MessageContent;
}

export interface ChannelLoadHarnessOptions {
  /**
   * Channels to drive. Pre-constructed (typically via
   * `createMockChannelInstance`). The harness registers each in a fresh
   * `ChannelRegistry` and drives traffic against all of them
   * round-robin.
   */
  channels: readonly ChannelInstance[];
  /**
   * Conversations per channel. Each synthetic inbound event is scoped
   * to `channel[i].id` + `conv-<j>` where j rotates 0..N-1.
   */
  conversationsPerChannel: number;
  /** Target events/sec across all channels. */
  eventsPerSec: number;
  /**
   * Run duration. When `totalEvents` is also set, the run stops at
   * whichever happens first.
   */
  durationMs?: number;
  /**
   * Optional cap on total events produced. Useful for deterministic
   * tests where pacing time is not important.
   */
  totalEvents?: number;
  /** Message content per inbound tick. Called with the 0-based seq. */
  payload: (seq: number) => MessageContent;
  /** Optional injected logger. Default noop. */
  logger?: Logger;
  /**
   * Injected monotonic clock (ms-epoch). Defaults to `Date.now`. Tests
   * that need deterministic latency values pass a fake clock; production
   * runs use the real wall clock.
   */
  now?: () => number;
  /**
   * Injected event bus. When omitted the harness creates a private bus —
   * preferred for isolation. Passing one in is only useful when a test
   * wants to observe `assistant.*` alongside channel traffic.
   */
  bus?: EventBus;
  /**
   * Injected channel registry. When omitted the harness builds a fresh
   * one and registers every channel. Callers that share a registry
   * elsewhere (e.g. daemon-level tests) can reuse it; the harness will
   * still register the supplied channels but skip IDs already present.
   */
  registry?: ChannelRegistry;
}

export interface ChannelLoadReport {
  /** Inbound events published successfully. */
  inboundCount: number;
  /** Outbound sends observed on the mock channels. */
  outboundCount: number;
  /** Outbound sends that threw. */
  failureCount: number;
  /** p50 (ms) for the inbound-publish → outbound-send path. */
  p50: number;
  /** p95 (ms) for the same. */
  p95: number;
  /** p99 (ms) for the same. */
  p99: number;
  /** Arithmetic mean (ms) over recorded latencies. */
  avgMs: number;
  /** Wall-clock elapsed for the full run. */
  elapsedMs: number;
  /** Achieved sustained rate (events/sec). */
  ratePerSec: number;
  /** Number of distinct conversations actually touched. */
  conversations: number;
}

export interface ChannelLoadHarness {
  run(): Promise<ChannelLoadReport>;
  /**
   * Abort the in-flight run. Resolves once the current tick finishes
   * and the pacer stops the loop. Safe to call even before `run()`.
   */
  stop(): Promise<void>;
}

/**
 * Build a harness. The harness is single-use: each call to `run()`
 * creates a private bus (unless one was injected), registers the
 * channels, wires a loopback `chat.message → channel.send.request`
 * subscriber, starts the outbound bridge, drives the pacer, and
 * resolves with the aggregated report.
 */
export function createChannelLoadHarness(options: ChannelLoadHarnessOptions): ChannelLoadHarness {
  if (options.channels.length === 0) {
    throw new Error('channel load harness requires at least one channel');
  }
  if (options.conversationsPerChannel <= 0) {
    throw new Error('conversationsPerChannel must be >= 1');
  }
  if (options.eventsPerSec <= 0) {
    throw new Error('eventsPerSec must be > 0');
  }
  if (options.totalEvents === undefined && options.durationMs === undefined) {
    throw new Error('channel load harness requires durationMs or totalEvents');
  }

  const logger = options.logger ?? NOOP_LOGGER;
  const now = options.now ?? Date.now;

  const aborter = new AbortController();
  let active = false;

  async function run(): Promise<ChannelLoadReport> {
    if (active) throw new Error('harness run already in progress');
    active = true;

    const bus = options.bus ?? createEventBus({ logger });
    const registry = options.registry ?? createChannelRegistry();
    for (const ch of options.channels) {
      if (registry.get(ch.id) === undefined) registry.register(ch);
    }
    // The outbound bridge needs a session context store — for the
    // `channel.send.request` path it's only consulted as a passthrough
    // (never read), but it must be a valid store.
    const sessionChannelContext = createSessionChannelContextStore();
    const bridge = createChannelOutboundBridge({
      bus,
      channels: registry,
      sessionChannelContext,
      logger,
    });
    const detachBridge = bridge.start();

    const latency = new LatencyRecorder({ maxSamples: 1_000_000 });
    let inboundCount = 0;
    let outboundCount = 0;
    let failureCount = 0;
    const touchedConversations = new Set<string>();

    // Instrument each channel's `send` so we can observe outbound
    // events + record their latency without hooking into the bridge's
    // internals. `SentMessage` is returned straight through.
    const sendInstrumentations: (() => void)[] = [];
    for (const ch of options.channels) {
      const original = ch.send.bind(ch);
      const wrapped = async (params: SendMessageParams): Promise<SentMessage> => {
        try {
          const sent = await original(params);
          outboundCount += 1;
          const sentAtRaw =
            params.content.kind === 'text' ? extractSentAt(params.content.text) : undefined;
          if (sentAtRaw !== undefined) {
            const delta = now() - sentAtRaw;
            if (delta >= 0) latency.record(delta);
          }
          touchedConversations.add(
            `${params.conversation.channelId}:${params.conversation.conversationId}`,
          );
          return sent;
        } catch (err) {
          failureCount += 1;
          throw err;
        }
      };
      ch.send = wrapped as ChannelInstance['send'];
      sendInstrumentations.push(() => {
        ch.send = original;
      });
    }

    // Loopback: `chat.message` → `channel.send.request` with the same
    // conversation + content. The outbound bridge picks it up from
    // there. We stamp `sentAt` into the outbound text so the send
    // instrumentation can compute latency without mutating the
    // content's public shape.
    const detachLoopback = bus.subscribe('chat.message', async (event) => {
      try {
        const payload = event.payload as ChannelLoadPayload;
        const stampedContent = stampSentAt(payload.content, payload.sentAt);
        const req: ChannelSendRequestPayload = {
          conversation: payload.conversation,
          content: stampedContent,
          idempotencyKey: `load:${payload.conversation.channelId}:${payload.seq}`,
        };
        await bus.publish({
          id: `load-req-${payload.seq}`,
          kind: 'channel.send.request',
          source: { type: 'self', reason: 'loop' },
          target: { type: 'broadcast' },
          timestamp: now(),
          payload: req,
          auth: { kind: 'internal' },
        });
      } catch (err) {
        logger.warn('channel.load.loopback.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    const start = now();
    try {
      const pacerOptions: Parameters<typeof runAtRate>[0] = {
        ratePerSec: options.eventsPerSec,
        signal: aborter.signal,
        now,
        onTick: async (seq: number) => {
          const chIdx = seq % options.channels.length;
          const channel = options.channels[chIdx];
          if (!channel) return;
          const convIdx =
            Math.floor(seq / options.channels.length) % options.conversationsPerChannel;
          const conversation: ConversationRef = {
            channelId: channel.id,
            conversationId: `conv-${convIdx}`,
          };
          const content = options.payload(seq);
          const payload: ChannelLoadPayload = {
            seq,
            sentAt: now(),
            conversation,
            content,
          };
          const event: AgentEvent<ChannelLoadPayload> = {
            id: `load-inbound-${seq}`,
            kind: 'chat.message',
            source: { type: 'self', reason: 'loop' },
            target: { type: 'broadcast' },
            timestamp: payload.sentAt,
            payload,
            auth: { kind: 'internal' },
          };
          await bus.publish(event);
          inboundCount += 1;
        },
      };
      if (options.totalEvents !== undefined) {
        pacerOptions.totalMessages = options.totalEvents;
      }

      // Enforce the duration cap by wiring a timer to the abort signal.
      let durationTimer: ReturnType<typeof setTimeout> | null = null;
      if (options.durationMs !== undefined) {
        durationTimer = setTimeout(() => aborter.abort(), options.durationMs);
      }

      await runAtRate(pacerOptions);
      if (durationTimer) clearTimeout(durationTimer);

      // Drain any in-flight subscribers so outbound sends are observed
      // before we snapshot the metrics.
      await bus.drained();

      const elapsedMs = now() - start;
      const summary = latency.summary();
      return {
        inboundCount,
        outboundCount,
        failureCount,
        p50: summary.p50,
        p95: summary.p95,
        p99: summary.p99,
        avgMs: summary.avg,
        elapsedMs,
        ratePerSec: elapsedMs > 0 ? (inboundCount / elapsedMs) * 1000 : 0,
        conversations: touchedConversations.size,
      };
    } finally {
      detachLoopback();
      detachBridge();
      for (const restore of sendInstrumentations) restore();
      active = false;
    }
  }

  async function stop(): Promise<void> {
    aborter.abort();
  }

  return { run, stop };
}

// ── `sentAt` shuttle ───────────────────────────────────────────────────────
//
// The outbound bridge only forwards the assistant/content pair verbatim —
// there's no per-event metadata channel the harness can piggy-back on. We
// encode the inbound `sentAt` into the text body as a one-line prefix,
// then strip it in the send instrumentation. The prefix is stable + easy
// to parse; callers that pass non-text payloads get best-effort tracking
// and any mismatched contents simply don't contribute to the latency
// histogram (they still count towards `outboundCount`).

const SENT_AT_PREFIX = '__declaragent.load.sentAt=';
const SENT_AT_SUFFIX = '__';
const SENT_AT_RE = /__declaragent\.load\.sentAt=(\d+)__\n?/;

function stampSentAt(content: MessageContent, sentAt: number): MessageContent {
  if (content.kind !== 'text') return content;
  const stamp = `${SENT_AT_PREFIX}${sentAt}${SENT_AT_SUFFIX}\n`;
  return { ...content, text: `${stamp}${content.text}` };
}

function extractSentAt(text: string): number | undefined {
  const match = SENT_AT_RE.exec(text);
  if (!match) return undefined;
  const raw = match[1];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

/**
 * Exposed for tests that want to inspect/strip the harness stamp from a
 * captured outbound message.
 */
export function stripSentAtStamp(text: string): string {
  return text.replace(SENT_AT_RE, '');
}
