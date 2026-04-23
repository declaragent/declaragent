/**
 * NATS-backed `RpcTransport` (Item #2 of the Enterprise Production Plan).
 *
 * Mirrors `kafka-transport.ts` one-for-one: the transport plumbing in
 * `packages/cli/src/fleet-run.ts` routes through `options.transportFactories`,
 * and this factory supplies the `nats` variant. NATS maps cleanly onto the
 * same `RpcTransport` contract — `publish(subject, envelope)` becomes a
 * core-NATS publish, `subscribe(subject, handler)` wires a per-subject
 * subscription.
 *
 * ## Why this lives here (not a separate `@declaragent/plugin-agent-rpc-nats`
 *   package)
 *
 * Same rationale as `kafka-transport.ts`: factory is ~200 LOC, extracting
 * it adds a new `package.json` + tsconfig + publish pipeline for one file.
 * If/when we split per-transport packages (v1.1 Agent Graph track), this
 * file moves wholesale.
 *
 * ## Subject naming
 *
 * NATS subjects are dot-delimited hierarchical tokens. We treat the
 * caller-supplied `topic` argument as an opaque NATS subject string — the
 * peer loader produces subjects that already follow the hierarchy
 * convention (`agents.<agent-id>.requests`). If a caller supplies a
 * Kafka-style topic with a slash or colon we do not rewrite it: NATS
 * silently accepts those characters in a subject but they can't be
 * subscribed to with wildcards. The `subjectPrefix` option is provided so
 * multi-tenant deployments can namespace without mutating agent config.
 *
 * ## Queue groups = consumer groups
 *
 * Kafka's `groupId` — "one message per group, partitioned across replicas"
 * — maps onto NATS's `queue` argument. When `queueGroup` is set, all
 * subscribers with the same queue name compete for each message; when it
 * is omitted, every subscriber receives every message. This matches
 * `kafka-transport.ts`'s behaviour: each subscription defaults to its own
 * group (unicast fan-out across replicas) unless the caller opts into
 * shared delivery.
 *
 * Dependency posture: `nats` is loaded via dynamic import so
 * `plugin-agent-rpc`'s hot path stays dep-free. The caller can inject the
 * module directly (tests) or let the transport resolve it from the host
 * `node_modules`.
 *
 * @since 0.6.x
 */

import type {
  AgentRpcEnvelope,
  Logger,
  RpcSubscriptionHandler,
  RpcTransport,
} from '@declaragent/core';
import { decodeEnvelope, encodeEnvelope } from '@declaragent/core';

// ── Minimal structural types for `nats` — same strategy as
//    `kafka-transport.ts`. We only model the surface we call, so a real
//    nats client or a test fake can implement these verbatim without
//    taking on the full nats.d.ts.

/**
 * Subset of nats `Msg`. The real `nats` library emits messages with
 * `subject: string`, `data: Uint8Array`. We only read those two fields.
 */
export interface NatsMessageLike {
  readonly subject: string;
  readonly data: Uint8Array;
}

/**
 * Subscription handle returned by `nc.subscribe`. The real `nats` lib
 * returns an async iterable AND exposes `.unsubscribe()` / `.drain()`;
 * we only need `unsubscribe` (sync teardown, best-effort) plus the
 * callback to be invoked on each message.
 */
export interface NatsSubscriptionLike {
  unsubscribe(): void;
}

/**
 * Subset of nats `NatsConnection`. Real connections expose a much
 * larger surface (JetStream, headers, services, etc.); the transport
 * only uses callback-style subscribe + byte-array publish + drain.
 */
export interface NatsConnectionLike {
  publish(subject: string, data: Uint8Array): void;
  subscribe(
    subject: string,
    opts: {
      callback: (err: Error | null, msg: NatsMessageLike) => void;
      queue?: string;
    },
  ): NatsSubscriptionLike;
  flush(): Promise<void>;
  drain(): Promise<void>;
  isClosed(): boolean;
}

/**
 * Subset of the top-level `nats` module. Only `connect` is needed.
 */
export interface NatsModule {
  connect(opts: {
    servers: readonly string[];
    name?: string;
    user?: string;
    pass?: string;
    token?: string;
    maxReconnectAttempts?: number;
    reconnectTimeWait?: number;
  }): Promise<NatsConnectionLike>;
}

export interface CreateNatsTransportOptions {
  /** NATS server URLs. e.g. `['nats://localhost:4222']`. */
  servers: readonly string[];
  /** NATS client name — surfaces in monitoring + auth logs. */
  clientName?: string;
  /**
   * Optional subject prefix. Every publish/subscribe has this string
   * prepended (with a `.` separator). Useful for multi-tenant deployments
   * that want one NATS cluster per environment but a single declaragent
   * config. When omitted, subjects pass through unchanged.
   */
  subjectPrefix?: string;
  /**
   * Queue group name. When set, every subscription joins this queue
   * group — so N replicas of the same agent each receive a subset of
   * messages (load-balanced). When omitted, each subscription is
   * independent (every replica receives every message). This is the
   * NATS-native equivalent of Kafka's `groupId`.
   *
   * Kept for backward compatibility with 0.7.0 callers. New code should
   * prefer {@link queueGroups}, which supports per-topic groups. When
   * both are set, {@link queueGroups} takes precedence (with this
   * serving as the fallback for unlisted topics).
   *
   * @deprecated since 0.7.1 — prefer {@link queueGroups}.
   */
  queueGroup?: string;
  /**
   * Per-topic queue-group mapping. Two shapes accepted:
   *
   *   - `string` — same semantics as the legacy {@link queueGroup}:
   *     every subscription joins this group regardless of topic.
   *   - `Record<topic, group>` — each topic gets its own queue group.
   *     Topics absent from the map fall through to {@link queueGroup}
   *     (if set) or no group at all (every replica receives every
   *     message).
   *
   * Motivation: real fleets mix load-balanced + fan-out topologies on
   * one NATS cluster. For example, `agents.beta.requests` needs a
   * shared queue so replicas load-balance, while `agents.broadcast.
   * health` needs no queue so every replica sees the heartbeat. A
   * single construction-time queue group can't express both.
   *
   * When a subscription is taken against a topic listed in the map,
   * the mapped group name is applied to the NATS `subscribe` call.
   *
   * @since 0.7.1 — Transport breadth backlog item #25.
   */
  queueGroups?: string | Record<string, string>;
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
  natsModule?: NatsModule;
  logger?: Logger;
}

export async function createNatsTransport(opts: CreateNatsTransportOptions): Promise<RpcTransport> {
  if (opts.servers.length === 0) {
    throw new Error('createNatsTransport: servers[] must not be empty');
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

  // One subscription per (topic, handler) — NATS doesn't fan out within a
  // single subscription, so we register each handler as its own
  // subscription. This mirrors the Kafka transport's semantics (many
  // handlers can attach to the same topic and each receives the message)
  // while keeping unsubscribe a simple `.unsubscribe()` call.
  //
  // When `queueGroup` is set, every subscription joins that queue — so
  // replicas load-balance the same way Kafka consumer groups do.
  const subscriptions = new Map<RpcSubscriptionHandler, NatsSubscriptionLike>();
  const handlersByTopic = new Map<string, Set<RpcSubscriptionHandler>>();
  const encoder = new TextEncoder();
  let closed = false;

  const transport: RpcTransport = {
    kind: 'nats',

    async publish(topic, envelope) {
      if (closed) throw new Error('createNatsTransport: transport closed');
      const subject = prefixSubject(opts.subjectPrefix, topic);
      const payload = encodeEnvelope(envelope);
      connection.publish(subject, encoder.encode(payload));
      // Flush so callers awaiting the promise get broker-ack semantics
      // comparable to Kafka's `producer.send()`. NATS core-publish is
      // fire-and-forget without this — flush guarantees the bytes left
      // the client.
      await connection.flush();
    },

    subscribe(topic, handler): () => void {
      if (closed) {
        opts.logger?.warn('nats-transport.subscribe-after-close', { topic });
        return () => {};
      }
      const subject = prefixSubject(opts.subjectPrefix, topic);
      const queue = resolveQueueForTopic(topic, opts.queueGroups, opts.queueGroup);
      const sub = connection.subscribe(subject, {
        ...(queue !== undefined && { queue }),
        callback: (err, msg) => {
          if (err) {
            opts.logger?.warn('nats-transport.callback-error', {
              topic,
              err: err.message,
            });
            return;
          }
          let envelope: AgentRpcEnvelope;
          try {
            envelope = decodeEnvelope(msg.data);
          } catch (decodeErr) {
            opts.logger?.warn('nats-transport.parse-failed', {
              topic,
              err: decodeErr instanceof Error ? decodeErr.message : String(decodeErr),
            });
            return;
          }
          // We invoke the handler asynchronously so a slow handler
          // doesn't starve the NATS callback loop. Errors are logged
          // rather than thrown back into the nats client (matches Kafka
          // transport's `handler-error` behaviour).
          void Promise.resolve(handler(envelope)).catch((handlerErr) => {
            opts.logger?.warn('nats-transport.handler-error', {
              topic,
              err: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
            });
          });
        },
      });
      subscriptions.set(handler, sub);
      let perTopic = handlersByTopic.get(topic);
      if (!perTopic) {
        perTopic = new Set();
        handlersByTopic.set(topic, perTopic);
      }
      perTopic.add(handler);

      return () => {
        const s = subscriptions.get(handler);
        if (!s) return;
        subscriptions.delete(handler);
        try {
          s.unsubscribe();
        } catch {
          // best-effort
        }
        const pt = handlersByTopic.get(topic);
        if (pt) {
          pt.delete(handler);
          if (pt.size === 0) handlersByTopic.delete(topic);
        }
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const sub of subscriptions.values()) {
        try {
          sub.unsubscribe();
        } catch {
          // best-effort
        }
      }
      subscriptions.clear();
      handlersByTopic.clear();
      try {
        await connection.drain();
      } catch {
        // drain rejects if the connection already closed — safe to
        // swallow on our close path.
      }
    },
  };

  return transport;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolves which queue group (if any) a subscription on `topic` should
 * join. Precedence:
 *   1. `queueGroups` string — blanket group for every topic (new-style
 *      equivalent of the legacy `queueGroup`).
 *   2. `queueGroups[topic]` — per-topic override. If the topic is
 *      listed here, the mapped value wins over the legacy fallback.
 *   3. `queueGroups` record without the topic → legacy `queueGroup`
 *      fallback. Callers who want "no queue at all" for an unlisted
 *      topic simply omit `queueGroup`.
 *   4. Legacy `queueGroup` string — same semantics as pre-0.7.1.
 *   5. No queue — `undefined`, so every subscriber gets every message.
 *
 * Note: a record entry with an empty-string value means "no queue" for
 * that topic — it explicitly opts out of the legacy fallback. This
 * matters when the fleet wants 99% of topics load-balanced but 1%
 * broadcast-only on the same transport instance.
 */
export function resolveQueueForTopic(
  topic: string,
  queueGroups: string | Record<string, string> | undefined,
  legacyQueueGroup: string | undefined,
): string | undefined {
  if (typeof queueGroups === 'string') {
    // Blanket group; legacy option is superseded.
    return queueGroups.length > 0 ? queueGroups : undefined;
  }
  if (queueGroups !== undefined && Object.hasOwn(queueGroups, topic)) {
    const mapped = queueGroups[topic];
    return mapped !== undefined && mapped.length > 0 ? mapped : undefined;
  }
  return legacyQueueGroup !== undefined && legacyQueueGroup.length > 0
    ? legacyQueueGroup
    : undefined;
}

function prefixSubject(prefix: string | undefined, topic: string): string {
  if (prefix === undefined || prefix === '') return topic;
  // A trailing dot in the prefix would produce `..topic` — strip it so
  // operators can be loose about the separator.
  const trimmed = prefix.endsWith('.') ? prefix.slice(0, -1) : prefix;
  return `${trimmed}.${topic}`;
}

async function loadNats(): Promise<NatsModule> {
  try {
    // Indirect specifier keeps TypeScript's static resolver from
    // demanding `nats` as a declared dep of this package. Same trick as
    // `kafka-transport.ts` uses for `kafkajs`.
    const specifier = 'nats';
    const raw = (await import(/* @vite-ignore */ specifier)) as unknown as Record<string, unknown>;
    // Some bundlers wrap CJS in `.default`; accept either shape.
    const candidate =
      raw.default && typeof (raw.default as NatsModule).connect === 'function'
        ? (raw.default as NatsModule)
        : typeof (raw as unknown as NatsModule).connect === 'function'
          ? (raw as unknown as NatsModule)
          : null;
    if (candidate) return candidate;
    throw new Error('nats module has no `connect` export');
  } catch (err) {
    throw new Error(
      `createNatsTransport: unable to load "nats" (${err instanceof Error ? err.message : String(err)}). Install the peer dep with \`npm install nats\` or pass \`natsModule\` explicitly.`,
    );
  }
}
