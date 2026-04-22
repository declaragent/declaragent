/**
 * Kafka-backed `RpcTransport` (Slice 7 of 0.6.0 production hardening).
 *
 * The transport plumbing in `packages/cli/src/fleet-run.ts` has honored
 * `options.transportFactories` since 0.5.x — but no broker-specific
 * factory shipped. This module is the first one: it constructs an
 * `RpcTransport` whose `publish` sends through a Kafka producer and
 * whose `subscribe` spins a per-topic Kafka consumer.
 *
 * Why here (not a new package): the factory is ~200 LOC; extracting it
 * adds a new `package.json` + tsconfig + publish pipeline for one file.
 * When we publish a separate `@declaragent/plugin-agent-rpc-kafka`
 * package (v1.1 Agent Graph track), this module is the seed.
 *
 * Dependency posture: `kafkajs` is loaded via dynamic import so
 * `plugin-agent-rpc`'s hot path stays dep-free. The caller can inject
 * the module directly (tests) or let the transport resolve it from
 * the host `node_modules`.
 *
 * @since 0.6.0-slice.7
 */

import type {
  AgentRpcEnvelope,
  Logger,
  RpcSubscriptionHandler,
  RpcTransport,
} from '@declaragent/core';
import { decodeEnvelope, encodeEnvelope } from '@declaragent/core';

// ── Minimal structural types for kafkajs — lets us avoid declaring
//    `kafkajs` as a hard dep of this package. When a real kafkajs is
//    loaded at runtime its types are structurally compatible with
//    these. Tests pass in fakes that implement exactly these shapes.

export interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: { topic: string; messages: readonly { value: string }[] }): Promise<unknown>;
}

export interface KafkaConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(opts: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(opts: {
    eachMessage: (payload: { topic: string; message: { value: Buffer | null } }) => Promise<void>;
  }): Promise<void>;
}

export interface KafkaClientLike {
  producer(): KafkaProducerLike;
  consumer(config: { groupId: string }): KafkaConsumerLike;
}

export interface KafkaJSModule {
  Kafka: new (config: { clientId: string; brokers: readonly string[] }) => KafkaClientLike;
}

export interface CreateKafkaTransportOptions {
  /** Bootstrap brokers. e.g. `['localhost:9092']`. */
  brokers: readonly string[];
  /** Kafka client id — surfaces in broker logs. */
  clientId?: string;
  /**
   * Consumer group id. Each up-process joins its own group so multiple
   * replicas don't miss deliveries; setting this lets callers share a
   * group across replicas when they want partitioned fan-out.
   */
  groupId?: string;
  /**
   * Injected kafkajs module. When omitted, we dynamically import
   * `kafkajs` from the host's node_modules. Supply this directly in
   * tests or when embedding declaragent inside a host that already
   * has kafkajs loaded.
   */
  kafkajsModule?: KafkaJSModule;
  logger?: Logger;
}

export async function createKafkaTransport(
  opts: CreateKafkaTransportOptions,
): Promise<RpcTransport> {
  if (opts.brokers.length === 0) {
    throw new Error('createKafkaTransport: brokers[] must not be empty');
  }
  const mod = opts.kafkajsModule ?? (await loadKafkaJS());
  const kafka = new mod.Kafka({
    clientId: opts.clientId ?? 'declaragent-rpc',
    brokers: opts.brokers,
  });
  const producer = kafka.producer();
  await producer.connect();

  const groupId = opts.groupId ?? `declaragent-rpc-${randomSuffix()}`;
  const handlers = new Map<string, Set<RpcSubscriptionHandler>>();
  // One consumer per topic keeps the subscription semantics identical
  // to `MemoryTransport`. Kafka technically supports multi-topic
  // consumers, but per-topic makes lifecycle + dedup-per-subscription
  // straightforward and avoids coordinated rebalances when one topic
  // comes/goes.
  const consumers = new Map<string, KafkaConsumerLike>();
  let closed = false;

  const transport: RpcTransport = {
    kind: 'kafka',

    async publish(topic, envelope) {
      if (closed) throw new Error('createKafkaTransport: transport closed');
      const payload = encodeEnvelope(envelope);
      await producer.send({ topic, messages: [{ value: payload }] });
    },

    subscribe(topic, handler): () => void {
      if (closed) {
        opts.logger?.warn('kafka-transport.subscribe-after-close', { topic });
        return () => {};
      }
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
        // Kick off the consumer asynchronously. `subscribe` returns
        // synchronously per the contract; first messages arrive once
        // the consumer has joined its group (seconds). Tests awaiting
        // specific messages should ensure sub is attached before
        // publishing.
        void startConsumer(kafka, groupId, topic, handlers, consumers, opts.logger).catch((err) => {
          opts.logger?.error('kafka-transport.consumer-start-failed', {
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
          const c = consumers.get(topic);
          if (c) {
            consumers.delete(topic);
            // Fire-and-forget disconnect; don't block the unsub path
            // on broker ack.
            void c.disconnect().catch(() => {
              // best-effort
            });
          }
        }
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([
        producer.disconnect(),
        ...Array.from(consumers.values()).map((c) => c.disconnect()),
      ]);
      consumers.clear();
      handlers.clear();
    },
  };

  return transport;
}

// ── Consumer startup ──────────────────────────────────────────────────────

async function startConsumer(
  kafka: KafkaClientLike,
  groupId: string,
  topic: string,
  handlers: Map<string, Set<RpcSubscriptionHandler>>,
  consumers: Map<string, KafkaConsumerLike>,
  logger: Logger | undefined,
): Promise<void> {
  // Narrow groupId per topic so parallel subscriptions across topics
  // don't share rebalance coordination — one lagging topic shouldn't
  // delay another.
  const consumer = kafka.consumer({ groupId: `${groupId}:${topic}` });
  consumers.set(topic, consumer);
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (message.value === null) return;
      let envelope: AgentRpcEnvelope;
      try {
        envelope = decodeEnvelope(message.value);
      } catch (err) {
        logger?.warn('kafka-transport.parse-failed', {
          topic,
          err: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const set = handlers.get(topic);
      if (!set) return;
      // Snapshot so handlers removing themselves mid-iteration don't
      // corrupt the loop.
      const snapshot = Array.from(set);
      for (const handler of snapshot) {
        try {
          await handler(envelope);
        } catch (err) {
          logger?.warn('kafka-transport.handler-error', {
            topic,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function loadKafkaJS(): Promise<KafkaJSModule> {
  try {
    // Bun + Node both honor dynamic import resolution from the host's
    // node_modules. If kafkajs isn't installed, this throws a clear
    // MODULE_NOT_FOUND error that the caller can surface. The indirect
    // import (via a computed specifier) keeps TypeScript's static
    // resolver from demanding a `kafkajs` dep on this package.
    const specifier = 'kafkajs';
    const mod = (await import(/* @vite-ignore */ specifier)) as unknown as {
      default?: KafkaJSModule;
    } & KafkaJSModule;
    // Some bundlers wrap CJS in `.default`; accept either shape.
    if (mod.default?.Kafka) return mod.default;
    if (mod.Kafka) return mod;
    throw new Error('kafkajs module has no `Kafka` export');
  } catch (err) {
    throw new Error(
      `createKafkaTransport: unable to load "kafkajs" (${err instanceof Error ? err.message : String(err)}). Install the peer dep with \`npm install kafkajs\` or pass \`kafkajsModule\` explicitly.`,
    );
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
