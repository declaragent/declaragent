/**
 * JetStream-backed `RpcTransport` — at-least-once RPC with replay
 * (post-enterprise backlog item #23).
 *
 * The existing `createNatsTransport` (core-NATS pub/sub) gives us
 * low-latency best-effort delivery — appropriate for "telemetry" /
 * "event" semantics but **not** for transactional command delivery.
 * JetStream adds persistence + explicit ack + redelivery + replay, which
 * is what operators actually want when a request envelope represents a
 * side-effectful action ("charge this card", "open this ticket").
 *
 * This factory mirrors `kafka-transport.ts`'s at-least-once contract
 * one-for-one:
 *
 *   - `publish(topic, envelope)` uses the JetStream client's `publish`
 *     (server-acked) rather than core-NATS fire-and-forget.
 *   - `subscribe(topic, handler)` creates / binds a durable consumer and
 *     explicitly `ack()`s after the handler returns without throwing.
 *     Handler errors leave the message un-acked so JetStream redelivers
 *     after `ackWaitMs`.
 *   - `close()` drains in-flight consumers + disconnects cleanly.
 *
 * Reuse: the wire envelope + `pending-registry` contract are unchanged —
 * callers use `createRequestAgentTool` + `createAgentInboxAdapter`
 * exactly as they do for Kafka or core-NATS, just with this transport
 * plugged in via `transportFactories` in `fleet-run`.
 *
 * ## Why `kind: 'nats'` (not `'jetstream'`)
 *
 * JetStream is an overlay on the same NATS wire protocol; the peer
 * loader (`capabilities-loader.ts`, `peers-loader.ts`) already accepts
 * `kind: 'nats'` and resolves its `subjectPrefix` / server URL options
 * the same way. Introducing a fourth transport kind (`'jetstream'`)
 * would ripple through `RpcTransportKind` + every loader + the builder
 * type enum for no operational benefit — operators pick the JetStream
 * factory by wiring it into `transportFactories.nats` explicitly. If a
 * future customer needs per-agent differentiation between core-NATS and
 * JetStream within one `fleet.yaml`, we'll split the kind then.
 *
 * @since 0.7.x — post-enterprise backlog item #23.
 */

import type {
  AgentRpcEnvelope,
  Logger,
  RpcSubscriptionHandler,
  RpcTransport,
} from '@declaragent/core';
import { decodeEnvelope, encodeEnvelope } from '@declaragent/core';

// ── Minimal structural types for the JetStream surface we touch. Same
//    strategy as `kafka-transport.ts` / `nats-transport.ts`: we only
//    declare what we call so a real `nats` client or a test fake can
//    implement these verbatim without pulling the full JetStream
//    type surface into this package.

/** Structural view of `PubAck` returned by `JetStreamClient.publish`. */
export interface JetStreamPublishAck {
  readonly stream: string;
  readonly seq: number;
  readonly duplicate?: boolean;
}

/**
 * Subset of the JetStream `JsMsg` surface we touch. The real lib emits
 * many more fields (`redelivered`, `info`, `reply`); we only need the
 * bytes + ack controls.
 */
export interface JetStreamMessageLike {
  readonly subject: string;
  readonly data: Uint8Array;
  /** Redelivery count — 1 on first delivery. */
  readonly redeliveryCount?: number;
  ack(): void;
  nak(delayMs?: number): void;
  term(reason?: string): void;
  working(): void;
}

/**
 * Handle returned by `consumer.consume()` — an async iterator of
 * messages plus a `stop()` hook. Matches the real lib's
 * `ConsumerMessages` shape.
 */
export interface JetStreamConsumerMessages extends AsyncIterable<JetStreamMessageLike> {
  stop(): void;
}

export interface JetStreamConsumer {
  consume(): Promise<JetStreamConsumerMessages>;
}

/** Config accepted when creating / upserting a JetStream consumer. */
export interface JetStreamConsumerConfig {
  durable_name?: string;
  ack_policy: 'explicit';
  filter_subject?: string;
  filter_subjects?: readonly string[];
  ack_wait?: number; // nanoseconds
  max_deliver?: number;
  deliver_policy?: 'all' | 'last' | 'new' | 'by_start_sequence' | 'by_start_time';
  opt_start_seq?: number;
  opt_start_time?: string;
  replay_policy?: 'instant' | 'original';
}

/** JetStream-manager consumer surface we use. */
export interface JetStreamConsumersManager {
  add(stream: string, cfg: JetStreamConsumerConfig): Promise<{ name: string }>;
}

export interface JetStreamManager {
  consumers: JetStreamConsumersManager;
}

/** The JetStream client exposed by `nc.jetstream()`. */
export interface JetStreamClient {
  publish(subject: string, data: Uint8Array): Promise<JetStreamPublishAck>;
  consumers: { get(stream: string, consumer: string): Promise<JetStreamConsumer> };
}

/**
 * Subset of `NatsConnection` that the JetStream transport uses. The
 * real `nats` client exposes a much larger surface; we only need the
 * JetStream + JetStream-manager factories + `drain()`.
 */
export interface JetStreamConnectionLike {
  jetstream(): JetStreamClient;
  jetstreamManager(): Promise<JetStreamManager>;
  drain(): Promise<void>;
  isClosed(): boolean;
}

/**
 * Subset of the top-level `nats` module surface we use. `connect`
 * must return a connection that exposes `jetstream()` +
 * `jetstreamManager()`.
 */
export interface JetStreamNatsModule {
  connect(opts: {
    servers: readonly string[];
    name?: string;
    user?: string;
    pass?: string;
    token?: string;
    maxReconnectAttempts?: number;
    reconnectTimeWait?: number;
  }): Promise<JetStreamConnectionLike>;
}

/**
 * Replay semantics. Maps directly onto JetStream's `replay_policy`:
 *
 *   - `'instant'` (default) — JetStream delivers messages as fast as
 *     the consumer drains them. Correct for replaying a backlog
 *     quickly.
 *   - `'original'` — JetStream honors the original publish inter-arrival
 *     spacing. Rarely what RPC callers want but useful for traffic-shape
 *     replay in staging.
 */
export type JetStreamReplayPolicy = 'instant' | 'original';

/**
 * Deliver-policy shorthand. Maps onto JetStream's `deliver_policy` —
 * `'new'` (only new messages after consumer start) is safer for
 * redeploys that shouldn't re-drive an old backlog; `'all'` replays the
 * entire stream on first binding (subsequent binds resume from the
 * durable cursor).
 */
export type JetStreamDeliverPolicy = 'all' | 'last' | 'new';

export interface CreateJetStreamTransportOptions {
  /** NATS server URLs. e.g. `['nats://localhost:4222']`. */
  servers: readonly string[];
  /**
   * JetStream stream name that already holds (or will hold, per the
   * operator's provisioning) the RPC subjects this transport uses. We
   * do **not** create the stream — stream provisioning is a deploy-time
   * concern (typically a terraform/k8s manifest). We upsert consumers
   * only.
   */
  stream: string;
  /**
   * Durable consumer name prefix. One durable consumer is created per
   * `subscribe(topic)` call; its name is `${durableName}-${topic}` with
   * subject-unsafe chars replaced. Picking a stable prefix is what lets
   * multiple replicas share the same consumer (load-balanced
   * at-least-once delivery — the JetStream equivalent of a Kafka
   * consumer group).
   */
  durableName: string;
  /** NATS client name — surfaces in monitoring + auth logs. */
  clientName?: string;
  /**
   * Optional subject prefix. Every publish/subscribe has this string
   * prepended (with a `.` separator). Matches `createNatsTransport`'s
   * semantics so the same `subjectPrefix` config carries over.
   */
  subjectPrefix?: string;
  /**
   * Ack wait (ms). How long JetStream waits for `ack()` before
   * redelivering the message. Default: 30_000ms — matches the real
   * `nats` client default. Tune up when downstream handlers regularly
   * take longer; tune down to tighten redelivery latency.
   */
  ackWaitMs?: number;
  /**
   * Max deliveries before JetStream stops redelivering and the message
   * is abandoned / sent to the stream's DLQ (if configured). Default: 5.
   * Mirrors a conservative default — tune per deployment.
   */
  maxDeliver?: number;
  /**
   * Replay policy. Default `'instant'` — replay the backlog as fast as
   * the consumer drains. `'original'` preserves original timing and is
   * useful for shape-replay in staging. Maps onto JetStream's
   * `replay_policy`.
   */
  replay?: JetStreamReplayPolicy;
  /**
   * Initial deliver policy. Default `'new'` — safer for respawn /
   * redeploy (don't re-drive an old backlog). `'all'` drives the full
   * stream on first consumer binding; subsequent binds resume from the
   * durable cursor regardless.
   */
  deliverPolicy?: JetStreamDeliverPolicy;
  /** Simple password auth. Paired with `password`. */
  user?: string;
  password?: string;
  /** Token auth. Supersedes user/password when both are set. */
  token?: string;
  /** Max reconnect attempts. Default: nats lib default (forever). */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay (ms). */
  reconnectTimeWaitMs?: number;
  /**
   * Injected `nats` module. When omitted, we dynamically import `nats`
   * from the host's node_modules. Supply this directly in tests or
   * when embedding declaragent inside a host that already has nats
   * loaded.
   */
  natsModule?: JetStreamNatsModule;
  logger?: Logger;
}

const DEFAULT_ACK_WAIT_MS = 30_000;
const DEFAULT_MAX_DELIVER = 5;
const DEFAULT_REPLAY: JetStreamReplayPolicy = 'instant';
const DEFAULT_DELIVER_POLICY: JetStreamDeliverPolicy = 'new';

export async function createJetStreamTransport(
  opts: CreateJetStreamTransportOptions,
): Promise<RpcTransport> {
  if (opts.servers.length === 0) {
    throw new Error('createJetStreamTransport: servers[] must not be empty');
  }
  if (opts.stream.length === 0) {
    throw new Error('createJetStreamTransport: stream must be a non-empty string');
  }
  if (opts.durableName.length === 0) {
    throw new Error('createJetStreamTransport: durableName must be a non-empty string');
  }

  const mod = opts.natsModule ?? (await loadNats());
  const connection = await mod.connect({
    servers: [...opts.servers],
    ...(opts.clientName !== undefined && { name: opts.clientName }),
    ...(opts.user !== undefined && { user: opts.user }),
    ...(opts.password !== undefined && { pass: opts.password }),
    ...(opts.token !== undefined && { token: opts.token }),
    ...(opts.maxReconnectAttempts !== undefined && {
      maxReconnectAttempts: opts.maxReconnectAttempts,
    }),
    ...(opts.reconnectTimeWaitMs !== undefined && {
      reconnectTimeWait: opts.reconnectTimeWaitMs,
    }),
  });

  const js = connection.jetstream();
  const jsm = await connection.jetstreamManager();

  const ackWaitMs = opts.ackWaitMs ?? DEFAULT_ACK_WAIT_MS;
  const maxDeliver = opts.maxDeliver ?? DEFAULT_MAX_DELIVER;
  const replay = opts.replay ?? DEFAULT_REPLAY;
  const deliverPolicy = opts.deliverPolicy ?? DEFAULT_DELIVER_POLICY;

  // Per-topic consume loops — mirrors the Kafka transport's one-consumer-
  // per-topic model. Each subscription is independent so one slow topic
  // doesn't head-of-line block another.
  const handlers = new Map<string, Set<RpcSubscriptionHandler>>();
  const consumerLoops = new Map<string, JetStreamConsumerMessages>();
  const encoder = new TextEncoder();
  let closed = false;

  const transport: RpcTransport = {
    // JetStream is NATS at the wire level. See module-level comment for
    // why we deliberately don't introduce a fourth `RpcTransportKind`.
    kind: 'nats',

    async publish(topic, envelope) {
      if (closed) throw new Error('createJetStreamTransport: transport closed');
      const subject = prefixSubject(opts.subjectPrefix, topic);
      const payload = encodeEnvelope(envelope);
      // JetStream publish is server-acked — we wait on the PubAck so
      // callers get at-least-once semantics identical to Kafka's
      // `producer.send()`.
      await js.publish(subject, encoder.encode(payload));
    },

    subscribe(topic, handler): () => void {
      if (closed) {
        opts.logger?.warn('jetstream-transport.subscribe-after-close', { topic });
        return () => {};
      }
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
        // Boot the consume loop lazily. `subscribe` returns synchronously
        // per the contract; first messages arrive once the JetStream
        // consumer has been upserted + `consume()` has hydrated. Tests
        // awaiting messages should ensure the subscription is attached
        // before publishing (same as Kafka).
        void startConsumeLoop(
          jsm,
          js,
          opts.stream,
          opts.durableName,
          prefixSubject(opts.subjectPrefix, topic),
          topic,
          {
            ackWaitMs,
            maxDeliver,
            replay,
            deliverPolicy,
          },
          handlers,
          consumerLoops,
          opts.logger,
        ).catch((err) => {
          opts.logger?.error('jetstream-transport.consumer-start-failed', {
            topic,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      set.add(handler);

      return () => {
        const s = handlers.get(topic);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) {
          handlers.delete(topic);
          const loop = consumerLoops.get(topic);
          if (loop) {
            consumerLoops.delete(topic);
            try {
              loop.stop();
            } catch {
              // best-effort
            }
          }
        }
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const loop of consumerLoops.values()) {
        try {
          loop.stop();
        } catch {
          // best-effort
        }
      }
      consumerLoops.clear();
      handlers.clear();
      try {
        await connection.drain();
      } catch {
        // drain rejects if the connection is already closed — safe to
        // swallow on our close path.
      }
    },
  };

  return transport;
}

// ── Consume loop ─────────────────────────────────────────────────────────

interface ConsumeTunables {
  ackWaitMs: number;
  maxDeliver: number;
  replay: JetStreamReplayPolicy;
  deliverPolicy: JetStreamDeliverPolicy;
}

async function startConsumeLoop(
  jsm: JetStreamManager,
  js: JetStreamClient,
  stream: string,
  durablePrefix: string,
  subject: string,
  topic: string,
  tunables: ConsumeTunables,
  handlers: Map<string, Set<RpcSubscriptionHandler>>,
  consumerLoops: Map<string, JetStreamConsumerMessages>,
  logger: Logger | undefined,
): Promise<void> {
  const durableName = buildDurableName(durablePrefix, topic);
  const consumerConfig: JetStreamConsumerConfig = {
    durable_name: durableName,
    ack_policy: 'explicit',
    filter_subject: subject,
    ack_wait: tunables.ackWaitMs * 1_000_000, // ms → ns
    max_deliver: tunables.maxDeliver,
    replay_policy: tunables.replay,
    deliver_policy: tunables.deliverPolicy,
  };

  // Upsert: `add` returns the existing consumer if the config matches
  // and throws if it diverges. We treat "already in use" as success
  // (the operator has pinned a different config on purpose — the
  // transport binds rather than mutate).
  let resolvedName = durableName;
  try {
    const info = await jsm.consumers.add(stream, consumerConfig);
    resolvedName = info.name ?? durableName;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already in use|consumer name already in use/i.test(msg)) {
      throw err;
    }
    logger?.debug?.('jetstream-transport.consumer-already-exists', {
      topic,
      durableName,
    });
  }

  const consumer = await js.consumers.get(stream, resolvedName);
  const iter = await consumer.consume();
  consumerLoops.set(topic, iter);

  void (async () => {
    try {
      for await (const m of iter) {
        if (!consumerLoops.has(topic)) break; // closed / unsubscribed
        let envelope: AgentRpcEnvelope;
        try {
          envelope = decodeEnvelope(m.data);
        } catch (err) {
          logger?.warn('jetstream-transport.parse-failed', {
            topic,
            err: err instanceof Error ? err.message : String(err),
          });
          // Malformed payloads are terminal — redelivering the same
          // bytes won't help. `term` tells JetStream to drop it.
          try {
            m.term('parse-failed');
          } catch {
            // best-effort
          }
          continue;
        }
        const set = handlers.get(topic);
        if (!set) {
          // Subscription removed mid-flight; nak with a short delay so
          // the next replica picks it up.
          try {
            m.nak(100);
          } catch {
            // best-effort
          }
          continue;
        }
        const snapshot = Array.from(set);
        let handlerThrew = false;
        for (const handler of snapshot) {
          try {
            await handler(envelope);
          } catch (err) {
            handlerThrew = true;
            logger?.warn('jetstream-transport.handler-error', {
              topic,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        try {
          if (handlerThrew) {
            // Leave to JetStream's ackWait + max_deliver machinery.
            m.nak();
          } else {
            m.ack();
          }
        } catch {
          // best-effort — the connection may be draining
        }
      }
    } catch (err) {
      logger?.warn('jetstream-transport.consume-loop-error', {
        topic,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

// ── Helpers ─────────────────────────────────────────────────────────────

function prefixSubject(prefix: string | undefined, topic: string): string {
  if (prefix === undefined || prefix === '') return topic;
  const trimmed = prefix.endsWith('.') ? prefix.slice(0, -1) : prefix;
  return `${trimmed}.${topic}`;
}

/**
 * Durable consumer names must match `[A-Za-z0-9_-]+` — JetStream rejects
 * dots and other subject-legal chars. We replace anything outside the
 * allowed class with `_` so a caller can freely pass dot-delimited
 * topics (which is the common convention).
 */
export function buildDurableName(prefix: string, topic: string): string {
  const safeTopic = topic.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${prefix}-${safeTopic}`;
}

async function loadNats(): Promise<JetStreamNatsModule> {
  try {
    // Indirect specifier keeps TS's static resolver from demanding `nats`
    // as a declared dep. Same trick as `nats-transport.ts`.
    const specifier = 'nats';
    const raw = (await import(/* @vite-ignore */ specifier)) as unknown as Record<string, unknown>;
    const candidate =
      raw.default && typeof (raw.default as JetStreamNatsModule).connect === 'function'
        ? (raw.default as JetStreamNatsModule)
        : typeof (raw as unknown as JetStreamNatsModule).connect === 'function'
          ? (raw as unknown as JetStreamNatsModule)
          : null;
    if (candidate) return candidate;
    throw new Error('nats module has no `connect` export');
  } catch (err) {
    throw new Error(
      `createJetStreamTransport: unable to load "nats" (${err instanceof Error ? err.message : String(err)}). Install the peer dep with \`npm install nats\` or pass \`natsModule\` explicitly.`,
    );
  }
}
