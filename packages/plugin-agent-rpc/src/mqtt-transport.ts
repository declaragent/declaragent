/**
 * MQTT 3/5-backed `RpcTransport` (post-enterprise backlog item #24c,
 * Sprint 4). Fifth broker in the transport family alongside Kafka,
 * NATS / JetStream, SQS, and AMQP.
 *
 * ## When to pick MQTT over the others
 *
 *   - You're integrating with IoT fleets (cars, sensors, HMIs) whose
 *     native protocol is MQTT. No other transport we support runs on
 *     constrained edge devices.
 *   - You want pub/sub on a protocol whose brokers (Mosquitto, HiveMQ,
 *     EMQX) are ~10x lighter to operate than Kafka or RabbitMQ.
 *   - You need MQTT-native features like retained messages, last-will
 *     topics, or shared-subscription load balancing (`$share/<group>/`).
 *
 * Pick AMQP when you need native DLX + per-queue TTL; pick Kafka when
 * you need partitioned log replay; pick JetStream for NATS-operational
 * simplicity with persistence; pick SQS on AWS.
 *
 * ## Delivery semantics — read this carefully
 *
 * **QoS level is the load-bearing knob.** Defaults to **QoS 1** (at-
 * least-once) to match the other durable transports:
 *
 *   - **QoS 0** (at-most-once, "fire and forget"): broker does NOT
 *     retain the message if the subscriber is offline; no redelivery
 *     on handler failure. Use for high-frequency telemetry where
 *     losing a message is cheaper than delivering it twice.
 *   - **QoS 1** (at-least-once, default): broker retains messages for
 *     offline clients with a persistent session and redelivers on
 *     connection resumption. The publisher's `publish()` promise
 *     resolves on PUBACK from the broker.
 *   - **QoS 2** (exactly-once, four-way handshake): strongest
 *     guarantee, highest overhead. Rarely needed once you've designed
 *     idempotent handlers.
 *
 * ### ⚠️ MQTT does NOT expose per-message ack to the subscriber
 *
 * Unlike Kafka, JetStream, SQS, and AMQP, MQTT's wire protocol acks
 * PUBLISH packets at the **network layer** (PUBACK / PUBREC / PUBCOMP)
 * *on receipt* — the broker considers the message delivered as soon as
 * the client's TCP stack ACKs it, **before** any application handler
 * runs. There is no equivalent of `msg.ack()` / `channel.ack()` the
 * handler can call.
 *
 * This has two load-bearing consequences:
 *
 *   1. A handler that throws **cannot** cause a transport-layer
 *      redelivery. The broker already considers the message delivered.
 *      Redelivery only happens for QoS ≥ 1 messages whose PUBACK never
 *      reached the broker (because the client disconnected before
 *      ACKing) — i.e. at *session* resume time, not at handler throw
 *      time.
 *   2. Malformed-payload handling is a no-op from the broker's
 *      perspective: we log + continue. Putting the bad bytes on a
 *      side-channel is an application choice, implemented via the
 *      optional `dlqPublish: (topic, bytes) => void` hook rather than
 *      a transport-level DLX.
 *
 * This is a real semantics gap relative to the other transports. Call
 * sites that require at-least-once handler retry must either (a) layer
 * their own idempotency + inbox pattern on top, or (b) switch to Kafka,
 * AMQP, JetStream, or SQS for those specific capabilities. The builder
 * validator should flag MQTT for capabilities tagged `durable: true` if
 * we ever ship that capability metadata.
 *
 * ## Topic wildcards
 *
 * MQTT subject wildcards (`+` one level, `#` match-rest) are honored
 * transparently — the `topic` string you pass to `subscribe` goes
 * through to the broker unchanged. Publishers use concrete topics; any
 * subscriber pattern matching it receives the envelope.
 *
 * ## Shared subscriptions (MQTT 5)
 *
 * Set `sharedSubscriptionGroup: 'worker-group'` on construction and
 * every `subscribe(topic, ...)` is rewritten to `$share/worker-group/
 * <topic>`. This gives you competing-consumers semantics similar to
 * Kafka consumer groups or NATS queue groups — each message goes to
 * exactly one member of the group. Requires MQTT 5 + a broker that
 * implements the spec (Mosquitto 2.x ✅, EMQX ✅, HiveMQ ✅).
 *
 * @since 0.7.4 — post-enterprise backlog item #24c.
 */

import type {
  AgentRpcEnvelope,
  Logger,
  RpcSubscriptionHandler,
  RpcTransport,
} from '@declaragent/core';
import { decodeEnvelope, encodeEnvelope } from '@declaragent/core';

// ── Minimal structural types for the `mqtt` (MQTT.js) surface we touch.
//    Tests inject fakes; the real `mqtt` package is dynamic-imported.

export type MqttQoS = 0 | 1 | 2;

/** Subset of MQTT.js `MqttClient` / `AsyncMqttClient`. */
export interface MqttClientLike {
  /**
   * Publish with the given QoS. Must resolve after the broker has ACKed
   * (PUBACK for QoS 1, PUBCOMP for QoS 2). QoS 0 resolves once the
   * bytes have left the client.
   */
  publish(
    topic: string,
    payload: Uint8Array | string,
    opts: { qos: MqttQoS; retain?: boolean },
  ): Promise<void>;
  /** Subscribe to one or more patterns at the given QoS. */
  subscribe(topic: string, opts: { qos: MqttQoS }): Promise<void>;
  /** Unsubscribe from a single pattern. */
  unsubscribe(topic: string): Promise<void>;
  /**
   * Register a message handler. Returns an unsubscribe function so
   * tests can verify cleanup. Handler receives every message the
   * broker delivers — topic-to-handler fan-out happens in this module.
   */
  on(
    event: 'message',
    handler: (topic: string, payload: Uint8Array, packet: { qos?: MqttQoS }) => void,
  ): void;
  off(
    event: 'message',
    handler: (topic: string, payload: Uint8Array, packet: { qos?: MqttQoS }) => void,
  ): void;
  end(force?: boolean): Promise<void>;
}

export interface MqttModule {
  /** Asynchronous connect — resolves once the CONNACK arrives. */
  connectAsync(brokerUrl: string, opts: MqttConnectOptionsLike): Promise<MqttClientLike>;
}

export interface MqttConnectOptionsLike {
  clientId?: string;
  username?: string;
  password?: string;
  clean?: boolean;
  keepalive?: number;
  protocolVersion?: 3 | 4 | 5;
  reconnectPeriod?: number;
}

export interface CreateMqttTransportOptions {
  /** Broker URL: `mqtt://host:1883`, `mqtts://…`, `ws://…`, `wss://…`. */
  brokerUrl: string;
  /** Client id; omit for a random uuid-derived id. */
  clientId?: string;
  username?: string;
  password?: string;
  /**
   * Per-topic QoS override. Default QoS applies to every topic not
   * listed here. When a topic is listed, the given QoS is used for
   * both publish and subscribe on that topic.
   */
  topicQoS?: Readonly<Record<string, MqttQoS>>;
  /**
   * Default QoS. Default: 1 (at-least-once) — matches JetStream, SQS,
   * AMQP, Kafka. Drop to 0 for telemetry, raise to 2 only when
   * duplicate delivery is catastrophic and you've verified the
   * handshake overhead is acceptable.
   */
  defaultQoS?: MqttQoS;
  /**
   * Persistent session flag. `false` (the default) means "clean session"
   * — simplest, but QoS 1/2 subscriptions are wiped on disconnect.
   * Set to `true` paired with a stable `clientId` when you need the
   * broker to retain messages for your subscriptions across restarts.
   */
  cleanSession?: boolean;
  /**
   * Protocol version. 5 unlocks user-properties + shared subscriptions
   * + request-response. Default: 5. Drop to 4 for older brokers.
   */
  protocolVersion?: 3 | 4 | 5;
  /** Keepalive seconds. MQTT.js default: 60. */
  keepaliveSeconds?: number;
  /**
   * Reconnect period (ms). MQTT.js default: 1000. Set to `0` to
   * disable auto-reconnect (rarely what you want).
   */
  reconnectPeriodMs?: number;
  /**
   * MQTT 5 shared-subscription group. When set, every `subscribe()`
   * call is rewritten to `$share/<group>/<topic>` so N replicas of the
   * same subscriber compete for delivery. Requires MQTT 5 + a
   * compliant broker. Ignored on MQTT 3.
   */
  sharedSubscriptionGroup?: string;
  /**
   * Side-channel for malformed payloads. Invoked with the raw topic +
   * bytes when envelope decoding fails. Lets operators forward bad
   * messages to an observation topic / warn log / database without
   * the transport layer owning that policy. No-op by default — bad
   * bytes are logged via `logger.warn` and dropped.
   */
  dlqPublish?: (topic: string, payload: Uint8Array) => void | Promise<void>;
  /** Injected module. Default: dynamic-import `mqtt`. */
  mqttModule?: MqttModule;
  /** Injected pre-connected client. Skips `connectAsync` entirely. */
  client?: MqttClientLike;
  logger?: Logger;
}

const DEFAULT_QOS: MqttQoS = 1;
const DEFAULT_CLEAN_SESSION = false;
const DEFAULT_PROTOCOL_VERSION = 5 as const;

export async function createMqttTransport(opts: CreateMqttTransportOptions): Promise<RpcTransport> {
  const defaultQoS = opts.defaultQoS ?? DEFAULT_QOS;
  const client = opts.client ?? (await openClient(opts));

  // Multiplex broker messages across handlers. One `on('message', ...)`
  // listener forwards every packet to every matched topic handler set.
  const handlers = new Map<string, Set<RpcSubscriptionHandler>>();
  // Remember the concrete subscription we told the broker about (after
  // shared-group rewriting) so unsubscribe sends the right token.
  const subscribedPatterns = new Map<string, string>();
  let closed = false;

  const onMessage = (topic: string, payload: Uint8Array): void => {
    // Dispatch via `matchTopic` because MQTT wildcards (`+`, `#`) mean
    // the incoming concrete topic may match multiple subscribed
    // patterns. `handlers` is keyed by the *caller-supplied* topic
    // (shared-group wrapping is transparent to the caller).
    const matches: RpcSubscriptionHandler[] = [];
    for (const [subTopic, set] of handlers.entries()) {
      if (matchTopic(subTopic, topic)) {
        for (const h of set) matches.push(h);
      }
    }
    if (matches.length === 0) return;
    let envelope: AgentRpcEnvelope;
    try {
      envelope = decodeEnvelope(payload);
    } catch (err) {
      opts.logger?.warn('mqtt-transport.parse-failed', {
        topic,
        err: err instanceof Error ? err.message : String(err),
      });
      if (opts.dlqPublish) {
        // Fire-and-forget; surface exceptions via the logger but don't
        // block handler delivery on the DLQ path.
        void Promise.resolve(opts.dlqPublish(topic, payload)).catch((dlqErr) => {
          opts.logger?.warn('mqtt-transport.dlq-publish-failed', {
            topic,
            err: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
          });
        });
      }
      return;
    }
    for (const h of matches) {
      // MQTT 3 has no handler-level ack, so handler throw can't trigger
      // broker redelivery. Log + continue — same posture as the real
      // adapter `source-mqtt` uses.
      void Promise.resolve(h(envelope)).catch((handlerErr) => {
        opts.logger?.warn('mqtt-transport.handler-error', {
          topic,
          err: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
        });
      });
    }
  };
  client.on('message', onMessage);

  const transport: RpcTransport = {
    kind: 'mqtt',

    async publish(topic, envelope) {
      if (closed) throw new Error('createMqttTransport: transport closed');
      const qos = resolveQoS(topic, opts.topicQoS, defaultQoS);
      const payload = encodeEnvelope(envelope);
      await client.publish(topic, new TextEncoder().encode(payload), { qos });
    },

    subscribe(topic, handler): () => void {
      if (closed) {
        opts.logger?.warn('mqtt-transport.subscribe-after-close', { topic });
        return () => {};
      }
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
        const qos = resolveQoS(topic, opts.topicQoS, defaultQoS);
        const wirePattern = opts.sharedSubscriptionGroup
          ? `$share/${opts.sharedSubscriptionGroup}/${topic}`
          : topic;
        subscribedPatterns.set(topic, wirePattern);
        void client.subscribe(wirePattern, { qos }).catch((err) => {
          opts.logger?.error('mqtt-transport.subscribe-failed', {
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
          const wire = subscribedPatterns.get(topic);
          subscribedPatterns.delete(topic);
          if (wire !== undefined) {
            void client.unsubscribe(wire).catch(() => {
              // best-effort — broker-side unsubscribe races with
              // disconnect are benign.
            });
          }
        }
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      client.off('message', onMessage);
      const unsubs = Array.from(subscribedPatterns.values()).map((p) =>
        client.unsubscribe(p).catch(() => {
          // best-effort
        }),
      );
      handlers.clear();
      subscribedPatterns.clear();
      await Promise.allSettled(unsubs);
      if (opts.client === undefined) {
        try {
          await client.end();
        } catch {
          // best-effort
        }
      }
    },
  };

  return transport;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveQoS(
  topic: string,
  map: Readonly<Record<string, MqttQoS>> | undefined,
  fallback: MqttQoS,
): MqttQoS {
  if (map && Object.hasOwn(map, topic)) {
    const q = map[topic];
    if (q !== undefined) return q;
  }
  return fallback;
}

/**
 * MQTT-style topic matching. `+` = single level wildcard; `#` = rest
 * of the topic (must be terminal). Export so tests can round-trip
 * edge cases. Case-sensitive, per spec.
 */
export function matchTopic(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  const pp = pattern.split('/');
  const tp = topic.split('/');
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i];
    if (p === '#') {
      // `#` matches the rest (including zero segments when it's the
      // only remaining segment and topic has consumed the prefix).
      return i === pp.length - 1;
    }
    if (i >= tp.length) return false;
    if (p === '+') continue;
    if (p !== tp[i]) return false;
  }
  return pp.length === tp.length;
}

async function openClient(opts: CreateMqttTransportOptions): Promise<MqttClientLike> {
  const mod = opts.mqttModule ?? (await loadMqtt());
  const connectOpts: MqttConnectOptionsLike = {
    clean: opts.cleanSession ?? DEFAULT_CLEAN_SESSION,
    protocolVersion: opts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
  };
  if (opts.clientId !== undefined) connectOpts.clientId = opts.clientId;
  if (opts.username !== undefined) connectOpts.username = opts.username;
  if (opts.password !== undefined) connectOpts.password = opts.password;
  if (opts.keepaliveSeconds !== undefined) connectOpts.keepalive = opts.keepaliveSeconds;
  if (opts.reconnectPeriodMs !== undefined) connectOpts.reconnectPeriod = opts.reconnectPeriodMs;
  return mod.connectAsync(opts.brokerUrl, connectOpts);
}

async function loadMqtt(): Promise<MqttModule> {
  try {
    // Indirect specifier — same trick as every other transport.
    const specifier = 'mqtt';
    const raw = (await import(/* @vite-ignore */ specifier)) as unknown as Record<string, unknown>;
    const fromDefault = raw.default as MqttModule | undefined;
    const connectAsync =
      typeof (raw.connectAsync as unknown) === 'function'
        ? (raw.connectAsync as MqttModule['connectAsync'])
        : typeof (fromDefault?.connectAsync as unknown) === 'function'
          ? (fromDefault?.connectAsync as MqttModule['connectAsync'])
          : null;
    if (connectAsync) {
      return { connectAsync };
    }
    // Some MQTT.js versions only export `connect` (callback-style).
    // Wrap it to honour the `connectAsync` contract.
    const connect = raw.connect as
      | ((
          url: string,
          opts: MqttConnectOptionsLike,
        ) => {
          on(event: 'connect', cb: () => void): void;
          on(event: 'error', cb: (err: Error) => void): void;
          once(event: 'connect', cb: () => void): void;
          once(event: 'error', cb: (err: Error) => void): void;
        })
      | undefined;
    if (!connect) {
      throw new Error('mqtt has no `connect` / `connectAsync` export');
    }
    return {
      async connectAsync(brokerUrl, optsIn) {
        return new Promise<MqttClientLike>((resolve, reject) => {
          const c = connect(brokerUrl, optsIn);
          const onConnect = (): void => resolve(c as unknown as MqttClientLike);
          const onError = (err: Error): void => reject(err);
          c.once('connect', onConnect);
          c.once('error', onError);
        });
      },
    };
  } catch (err) {
    throw new Error(
      `createMqttTransport: unable to load "mqtt" (${err instanceof Error ? err.message : String(err)}). Install the peer dep with \`npm install mqtt\` or pass \`mqttModule\` / \`client\` explicitly.`,
    );
  }
}
