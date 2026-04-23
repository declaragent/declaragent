/**
 * AMQP 0.9.1 (RabbitMQ)-backed `RpcTransport` — at-least-once RPC over a
 * broker with publisher confirms + native dead-letter routing
 * (post-enterprise backlog item #24b, Sprint 4).
 *
 * Fourth broker in the at-least-once family alongside Kafka (backlog #7
 * / Slice 7), JetStream (backlog #23), and SQS (backlog #24a).
 *
 * ## When to pick AMQP over Kafka / NATS / JetStream / SQS
 *
 *   - You already run RabbitMQ for non-agent workloads and want one less
 *     broker to operate. AMQP 0.9.1 has the richest built-in routing
 *     story (exchanges + bindings + headers) of any broker we support.
 *   - You need per-queue dead-letter exchanges (DLX) with configurable
 *     retry + TTL semantics without writing application-level DLQ code.
 *     The SQS transport's `decodeFail: 'send-dlq'` is a hand-rolled
 *     analogue; RabbitMQ's native DLX is better when it's available.
 *   - You want message-level TTL + priority queues + per-consumer
 *     prefetch — first-class AMQP features that the other transports
 *     simulate or don't support at all.
 *
 * Pick Kafka when you need partitioned log replay across consumer
 * groups; pick JetStream when you want NATS operational simplicity with
 * persistence; pick SQS when you're on AWS and don't want to operate a
 * broker at all.
 *
 * ## Delivery semantics
 *
 *   - `publish(topic, envelope)` resolves on broker confirm (publisher
 *     confirms enabled on every channel we open). Callers get the same
 *     "acked by broker" contract as Kafka + JetStream.
 *   - `subscribe(topic, handler)` asserts the queue (durable by default),
 *     binds it to the configured exchange + routing key, and consumes
 *     with `noAck: false`. Handler success → `ack(deliveryTag)`; handler
 *     throw → `nack(deliveryTag, requeue)`. `requeue` defaults to
 *     **false** so the broker's configured DLX picks up retry, matching
 *     the SQS transport's "let the broker DLQ it" posture. Flip to
 *     `requeueOnHandlerError: true` for transports where the same
 *     consumer should get another try (common for idempotent handlers
 *     without a DLX configured).
 *   - Envelope decode failure is terminal — the bytes won't parse
 *     better on retry. Default policy is `ack` (drop the malformed
 *     message) so handler-level failures don't share a fate with
 *     protocol-level ones. `requeue` and `nack-no-requeue` are also
 *     available if you want the DLX to capture decode failures.
 *   - `close()` cancels every consumer, closes the channel, and closes
 *     the connection.
 *
 * ## Topology
 *
 * AMQP separates "where you publish" (an exchange + routing key) from
 * "what you consume" (a queue bound to an exchange). The RPC transport
 * layer only sees `topic` strings, so we project both onto one side of
 * that split:
 *
 *   - The operator provides either a `topicMap: Record<topic, RouteSpec>`
 *     mapping each RPC topic to an explicit (exchange, routingKey,
 *     queue) triple, OR a single default `exchange` + a per-topic
 *     routing key convention (`topic → queue`, `routingKey = topic`).
 *   - A default `''` exchange + `routingKey = queueName` reproduces the
 *     "direct to queue" pattern most simple deployments use.
 *
 * Both exchange + queue are asserted with `durable: true` by default —
 * flip `durable: false` only for ephemeral / test queues. Queues can
 * carry an `arguments` map so the `x-dead-letter-exchange` + TTL knobs
 * are reachable without dropping to a custom topic spec.
 *
 * ## Dependency posture
 *
 * `amqplib` is loaded via dynamic import so `plugin-agent-rpc`'s hot
 * path stays dep-free. The caller can inject a pre-wired client for
 * tests or when the host already manages one. Version alignment matches
 * `@declaragent/source-amqp` (`amqplib@^0.10`).
 *
 * @since 0.7.4 — post-enterprise backlog item #24b.
 */

import type {
  AgentRpcEnvelope,
  Logger,
  RpcSubscriptionHandler,
  RpcTransport,
} from '@declaragent/core';
import { decodeEnvelope, encodeEnvelope } from '@declaragent/core';

// ── Minimal structural types for the `amqplib` surface we touch. Tests
//    pass in fakes; the real `amqplib` is loaded dynamically so this
//    package declares no hard dep on it.

/** Exchange kinds we accept — full AMQP 0.9.1 set. */
export type AmqpExchangeKind = 'direct' | 'topic' | 'headers' | 'fanout';

/** Subset of `amqplib` `ConfirmChannel` we actually use. */
export interface AmqpChannelLike {
  assertExchange(
    exchange: string,
    kind: AmqpExchangeKind,
    opts?: {
      durable?: boolean;
      autoDelete?: boolean;
      internal?: boolean;
      arguments?: Record<string, unknown>;
    },
  ): Promise<void>;
  assertQueue(
    queue: string,
    opts?: {
      durable?: boolean;
      autoDelete?: boolean;
      exclusive?: boolean;
      arguments?: Record<string, unknown>;
    },
  ): Promise<{ queue: string }>;
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<void>;
  prefetch(count: number, global?: boolean): Promise<void>;
  /**
   * Publish with publisher confirms. Must resolve on `basic.ack` from
   * the broker and reject on `basic.nack` / channel error.
   */
  publish(
    exchange: string,
    routingKey: string,
    content: Uint8Array,
    opts?: {
      persistent?: boolean;
      messageId?: string;
      correlationId?: string;
      headers?: Record<string, unknown>;
      contentType?: string;
    },
  ): Promise<void>;
  consume(
    queue: string,
    handler: (msg: AmqpIncomingMessageLike) => void,
  ): Promise<{
    consumerTag: string;
  }>;
  cancel(consumerTag: string): Promise<void>;
  ack(deliveryTag: number, allUpTo?: boolean): void;
  nack(deliveryTag: number, allUpTo?: boolean, requeue?: boolean): void;
  close(): Promise<void>;
}

/** Subset of `amqplib` `ChannelModel` / `Connection`. */
export interface AmqpConnectionLike {
  createConfirmChannel(): Promise<AmqpChannelLike>;
  close(): Promise<void>;
}

/** Message surface; mirrors `@declaragent/source-amqp`'s `AmqpIncomingMessage`. */
export interface AmqpIncomingMessageLike {
  readonly content: Uint8Array;
  readonly fields: {
    readonly deliveryTag: number;
    readonly redelivered: boolean;
    readonly exchange: string;
    readonly routingKey: string;
    readonly consumerTag: string;
  };
  readonly properties: {
    readonly headers?: Record<string, unknown>;
    readonly messageId?: string;
    readonly correlationId?: string;
    readonly contentType?: string;
  };
}

/** Top-level `amqplib` shape — only `connect` is needed. */
export interface AmqplibModule {
  connect(url: string | AmqpConnectUrl, opts?: unknown): Promise<AmqpConnectionLike>;
}

/** Structured-URL form of `amqplib.connect`. */
export interface AmqpConnectUrl {
  protocol?: string;
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  vhost?: string;
  heartbeat?: number;
}

/**
 * Per-topic route spec. Each RPC topic maps onto a publish target
 * (exchange + routing key) and a consume target (queue bound to the
 * same exchange with a matching pattern). Operators who don't need
 * granular control can use the top-level `exchange` option plus
 * `topic → queueName` defaulting.
 */
export interface AmqpTopicRoute {
  /** Exchange the publisher writes to. Defaults to top-level `exchange`. */
  exchange?: string;
  /** Routing key the publisher writes with. Defaults to `topic`. */
  routingKey?: string;
  /** Queue the consumer binds + reads. Defaults to `topic`. */
  queue?: string;
  /**
   * Binding pattern when binding the queue to the exchange. Defaults to
   * `routingKey` (exact match on direct exchanges; same-name match on
   * topic exchanges). Override for topic-exchange wildcards
   * (`"agents.beta.#"`) or headers-exchange empty strings.
   */
  bindingPattern?: string;
  /**
   * Per-queue `arguments` — reaches the `x-dead-letter-exchange`,
   * `x-message-ttl`, priority, and policy knobs without flowing through
   * the top-level `queueArguments`.
   */
  queueArguments?: Record<string, unknown>;
}

/**
 * Decode-failure policy. Mirror of `SqsDecodeFailPolicy`. Default is
 * `ack` — we drop the malformed message since its bytes will never
 * parse. Callers who want decode failures captured by a DLX use
 * `nack-no-requeue`; callers who don't trust the decoder use `requeue`
 * (rarely the right choice — decode is deterministic).
 */
export type AmqpDecodeFailPolicy = 'ack' | 'requeue' | 'nack-no-requeue';

export interface CreateAmqpTransportOptions {
  /** AMQP URL, e.g. `amqp://guest:guest@localhost:5672`. */
  url: string;
  /**
   * Default exchange used when a per-topic spec doesn't set one.
   * Empty string (`''`) is the AMQP default exchange — routes directly
   * to the queue whose name equals the routing key.
   */
  exchange?: string;
  /** Default exchange kind when we assert the exchange. Default: `'direct'`. */
  exchangeKind?: AmqpExchangeKind;
  /**
   * Per-topic routing specs. Either this or `exchange` (with default
   * per-topic `topic → queue` / `routingKey = topic`) must be enough to
   * resolve every topic the caller publishes or subscribes to.
   */
  topicRoutes?: Readonly<Record<string, AmqpTopicRoute>>;
  /**
   * Queue durability default. Durable survives broker restart; keep
   * this `true` in production. Default: `true`.
   */
  queueDurable?: boolean;
  /** Exchange durability default. Default: `true`. */
  exchangeDurable?: boolean;
  /**
   * Global prefetch. Sets `basic.qos` on the channel. Default: `10` —
   * moderate back-pressure so a slow handler doesn't starve the
   * channel. Bump up for high-throughput workloads with fast handlers.
   */
  prefetch?: number;
  /**
   * Whether to mark published messages `persistent`. Requires the queue
   * to be durable for actual disk persistence. Default: `true`.
   */
  persistent?: boolean;
  /**
   * Requeue policy when the handler throws. Default: `false` — let the
   * broker's dead-letter exchange route the failure. Flip to `true`
   * when there's no DLX configured and the handler is idempotent.
   */
  requeueOnHandlerError?: boolean;
  /**
   * Decode-failure policy. Default: `'ack'` — drop malformed bytes so
   * healthy traffic flows. See `AmqpDecodeFailPolicy`.
   */
  decodeFail?: AmqpDecodeFailPolicy;
  /**
   * Heartbeat seconds; pass through to `amqplib.connect`. Default:
   * library default (0 — disabled).
   */
  heartbeatSeconds?: number;
  /**
   * Injected `amqplib` module. When omitted, loaded via dynamic import.
   * Supply directly in tests.
   */
  amqpModule?: AmqplibModule;
  /**
   * Injected connection — bypasses `amqpModule` entirely. Supply in
   * tests or when embedding declaragent inside a host that already
   * owns an `amqplib` connection.
   */
  connection?: AmqpConnectionLike;
  logger?: Logger;
}

const DEFAULT_EXCHANGE_KIND: AmqpExchangeKind = 'direct';
const DEFAULT_QUEUE_DURABLE = true;
const DEFAULT_EXCHANGE_DURABLE = true;
const DEFAULT_PREFETCH = 10;
const DEFAULT_PERSISTENT = true;
const DEFAULT_REQUEUE_ON_HANDLER_ERROR = false;
const DEFAULT_DECODE_FAIL: AmqpDecodeFailPolicy = 'ack';

export async function createAmqpTransport(opts: CreateAmqpTransportOptions): Promise<RpcTransport> {
  const exchangeKind = opts.exchangeKind ?? DEFAULT_EXCHANGE_KIND;
  const queueDurable = opts.queueDurable ?? DEFAULT_QUEUE_DURABLE;
  const exchangeDurable = opts.exchangeDurable ?? DEFAULT_EXCHANGE_DURABLE;
  const prefetch = Math.max(0, opts.prefetch ?? DEFAULT_PREFETCH);
  const persistent = opts.persistent ?? DEFAULT_PERSISTENT;
  const requeueOnHandlerError = opts.requeueOnHandlerError ?? DEFAULT_REQUEUE_ON_HANDLER_ERROR;
  const decodeFail = opts.decodeFail ?? DEFAULT_DECODE_FAIL;

  const connection = opts.connection ?? (await openConnection(opts));
  const channel = await connection.createConfirmChannel();
  if (prefetch > 0) {
    await channel.prefetch(prefetch);
  }

  // Track which exchanges + queues we've already asserted in this
  // channel's lifetime so subscribe/publish on the same topic don't
  // re-issue redundant `assertExchange` / `assertQueue` calls.
  const assertedExchanges = new Set<string>();
  const assertedQueues = new Set<string>();
  const handlers = new Map<string, Set<RpcSubscriptionHandler>>();
  const consumers = new Map<string, { consumerTag: string; queue: string }>();
  let closed = false;

  async function ensureExchange(exchange: string): Promise<void> {
    if (exchange === '') return; // AMQP default exchange — no declaration.
    if (assertedExchanges.has(exchange)) return;
    await channel.assertExchange(exchange, exchangeKind, { durable: exchangeDurable });
    assertedExchanges.add(exchange);
  }

  async function ensureQueue(
    queue: string,
    queueArguments: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (assertedQueues.has(queue)) return;
    const queueOpts: { durable: boolean; arguments?: Record<string, unknown> } = {
      durable: queueDurable,
    };
    if (queueArguments !== undefined) queueOpts.arguments = queueArguments;
    await channel.assertQueue(queue, queueOpts);
    assertedQueues.add(queue);
  }

  function resolveRoute(topic: string): Required<
    Pick<AmqpTopicRoute, 'exchange' | 'routingKey' | 'queue' | 'bindingPattern'>
  > & {
    queueArguments: Record<string, unknown> | undefined;
  } {
    const spec = opts.topicRoutes?.[topic];
    const exchange = spec?.exchange ?? opts.exchange ?? '';
    const routingKey = spec?.routingKey ?? topic;
    const queue = spec?.queue ?? topic;
    const bindingPattern = spec?.bindingPattern ?? routingKey;
    return {
      exchange,
      routingKey,
      queue,
      bindingPattern,
      queueArguments: spec?.queueArguments,
    };
  }

  const transport: RpcTransport = {
    kind: 'amqp',

    async publish(topic, envelope) {
      if (closed) throw new Error('createAmqpTransport: transport closed');
      const route = resolveRoute(topic);
      // We assert the exchange (if named) so a pristine broker doesn't
      // 404 the first publish. We deliberately do NOT assert the
      // destination queue here — publish-side assertion would create
      // phantom queues for topics the fleet hasn't subscribed to.
      await ensureExchange(route.exchange);
      const payload = encodeEnvelope(envelope);
      const bytes = new TextEncoder().encode(payload);
      const publishOpts: {
        persistent: boolean;
        contentType: string;
        messageId?: string;
        correlationId?: string;
      } = {
        persistent,
        contentType: 'application/json',
      };
      if (envelope.messageId) publishOpts.messageId = envelope.messageId;
      if (envelope.correlationId) publishOpts.correlationId = envelope.correlationId;
      await channel.publish(route.exchange, route.routingKey, bytes, publishOpts);
    },

    subscribe(topic, handler): () => void {
      if (closed) {
        opts.logger?.warn('amqp-transport.subscribe-after-close', { topic });
        return () => {};
      }
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
        // Wire the consumer on first subscribe per topic. Subsequent
        // subscribers share the consumer + multiplex via the handler set.
        void startConsumer(topic).catch((err) => {
          opts.logger?.error('amqp-transport.consumer-start-failed', {
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
          const consumer = consumers.get(topic);
          if (consumer) {
            consumers.delete(topic);
            void channel.cancel(consumer.consumerTag).catch(() => {
              // best-effort — channel may have closed already.
            });
          }
        }
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      const cancelPromises = Array.from(consumers.values(), (c) =>
        channel.cancel(c.consumerTag).catch(() => {
          // best-effort
        }),
      );
      consumers.clear();
      handlers.clear();
      await Promise.allSettled(cancelPromises);
      try {
        await channel.close();
      } catch {
        // best-effort
      }
      if (opts.connection === undefined) {
        try {
          await connection.close();
        } catch {
          // best-effort — don't leak a rejection if the broker already
          // hung up on us.
        }
      }
    },
  };

  return transport;

  // ── Consumer wiring ────────────────────────────────────────────────

  async function startConsumer(topic: string): Promise<void> {
    const route = resolveRoute(topic);
    await ensureExchange(route.exchange);
    await ensureQueue(route.queue, route.queueArguments);
    if (route.exchange !== '') {
      // Default exchange (`''`) routes by queue-name match — no bind
      // required (and amqplib rejects binds to the default exchange).
      await channel.bindQueue(route.queue, route.exchange, route.bindingPattern);
    }
    const reply = await channel.consume(route.queue, (msg) => {
      // msg === null shape (broker-initiated cancel) never surfaces via
      // our structural type — amqplib fakes omit the branch, and the
      // real adapter's client.ts maps it to "do nothing". We keep the
      // same posture here.
      void dispatchMessage(topic, msg).catch((err) => {
        opts.logger?.warn('amqp-transport.dispatch-fatal', {
          topic,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    });
    consumers.set(topic, { consumerTag: reply.consumerTag, queue: route.queue });
  }

  async function dispatchMessage(topic: string, msg: AmqpIncomingMessageLike): Promise<void> {
    let envelope: AgentRpcEnvelope;
    try {
      envelope = decodeEnvelope(msg.content);
    } catch (err) {
      opts.logger?.warn('amqp-transport.parse-failed', {
        topic,
        deliveryTag: msg.fields.deliveryTag,
        err: err instanceof Error ? err.message : String(err),
      });
      applyDecodeFailPolicy(msg.fields.deliveryTag);
      return;
    }
    const set = handlers.get(topic);
    if (!set || set.size === 0) {
      // Subscription removed mid-flight. Re-queue the message so
      // another replica can own it — matches the SQS "visibility
      // timeout lets someone else try" posture.
      channel.nack(msg.fields.deliveryTag, false, true);
      return;
    }
    const snapshot = Array.from(set);
    let handlerThrew = false;
    for (const h of snapshot) {
      try {
        await h(envelope);
      } catch (err) {
        handlerThrew = true;
        opts.logger?.warn('amqp-transport.handler-error', {
          topic,
          deliveryTag: msg.fields.deliveryTag,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (handlerThrew) {
      channel.nack(msg.fields.deliveryTag, false, requeueOnHandlerError);
      return;
    }
    channel.ack(msg.fields.deliveryTag);
  }

  function applyDecodeFailPolicy(deliveryTag: number): void {
    switch (decodeFail) {
      case 'requeue':
        channel.nack(deliveryTag, false, true);
        return;
      case 'nack-no-requeue':
        channel.nack(deliveryTag, false, false);
        return;
      default:
        // 'ack'
        channel.ack(deliveryTag);
    }
  }
}

// ── Connection bootstrap ─────────────────────────────────────────────────

async function openConnection(opts: CreateAmqpTransportOptions): Promise<AmqpConnectionLike> {
  const mod = opts.amqpModule ?? (await loadAmqplib());
  const connectArg: string | AmqpConnectUrl =
    opts.heartbeatSeconds !== undefined
      ? parseUrlWithHeartbeat(opts.url, opts.heartbeatSeconds)
      : opts.url;
  return mod.connect(connectArg);
}

function parseUrlWithHeartbeat(url: string, heartbeat: number): AmqpConnectUrl {
  const parsed = new URL(url);
  const out: AmqpConnectUrl = {
    protocol: parsed.protocol.replace(':', ''),
    hostname: parsed.hostname || 'localhost',
    heartbeat,
  };
  if (parsed.port) out.port = Number(parsed.port);
  if (parsed.username) out.username = decodeURIComponent(parsed.username);
  if (parsed.password) out.password = decodeURIComponent(parsed.password);
  if (parsed.pathname && parsed.pathname !== '/') {
    out.vhost = decodeURIComponent(parsed.pathname.slice(1));
  }
  return out;
}

async function loadAmqplib(): Promise<AmqplibModule> {
  try {
    // Indirect specifier — same dynamic-import trick as the Kafka,
    // NATS, and SQS transports. Keeps `amqplib` out of this package's
    // declared deps; the host provides it.
    const specifier = 'amqplib';
    const raw = (await import(/* @vite-ignore */ specifier)) as unknown as Record<string, unknown>;
    const candidate =
      raw.default && typeof (raw.default as AmqplibModule).connect === 'function'
        ? (raw.default as AmqplibModule)
        : typeof (raw as unknown as AmqplibModule).connect === 'function'
          ? (raw as unknown as AmqplibModule)
          : null;
    if (candidate) return candidate;
    throw new Error('amqplib has no `connect` export');
  } catch (err) {
    throw new Error(
      `createAmqpTransport: unable to load "amqplib" (${err instanceof Error ? err.message : String(err)}). Install the peer dep with \`npm install amqplib\` or pass \`connection\` / \`amqpModule\` explicitly.`,
    );
  }
}
