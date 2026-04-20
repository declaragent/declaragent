/**
 * In-memory RpcTransport. Useful for:
 *   - unit tests that exercise producer + consumer without a broker,
 *   - single-process multi-agent deployments,
 *   - the rpc-agents template's happy-path demo.
 *
 * Publishes are synchronous (same microtask). Subscribers are invoked
 * in registration order per topic; exceptions propagate to the publisher.
 *
 * @since 1.1.0
 */

import type { AgentRpcEnvelope, RpcSubscriptionHandler, RpcTransport } from '@declaragent/core';

export interface MemoryTransport extends RpcTransport {
  readonly kind: 'memory';
  /** Number of live subscribers on `topic`. Useful for test assertions. */
  subscriberCount(topic: string): number;
  /** Every topic with at least one subscriber. */
  topics(): readonly string[];
}

/**
 * A single in-memory bus shared across many `MemoryTransport` instances.
 * Allows two daemons in the same process (the template's happy-path demo)
 * to exchange envelopes as if over a broker.
 */
export interface MemoryBus {
  publish(topic: string, envelope: AgentRpcEnvelope): Promise<void>;
  subscribe(topic: string, handler: RpcSubscriptionHandler): () => void;
  topics(): readonly string[];
  subscriberCount(topic: string): number;
  close(): void;
}

export function createMemoryBus(): MemoryBus {
  const subs = new Map<string, Set<RpcSubscriptionHandler>>();

  return {
    async publish(topic, envelope) {
      const set = subs.get(topic);
      if (!set || set.size === 0) return;
      // Clone so handlers that mutate the set during dispatch don't
      // invalidate the iterator. Errors propagate so the producer's
      // publish() rejects on a bad handler — tests can assert on that.
      const snapshot = Array.from(set);
      for (const handler of snapshot) {
        await handler(envelope);
      }
    },
    subscribe(topic, handler) {
      let set = subs.get(topic);
      if (!set) {
        set = new Set();
        subs.set(topic, set);
      }
      set.add(handler);
      return () => {
        const s = subs.get(topic);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) subs.delete(topic);
      };
    },
    topics() {
      return [...subs.keys()];
    },
    subscriberCount(topic) {
      return subs.get(topic)?.size ?? 0;
    },
    close() {
      subs.clear();
    },
  };
}

export interface CreateMemoryTransportOptions {
  /** Shared bus; provides multi-daemon wiring in one process. */
  bus?: MemoryBus;
}

export function createMemoryTransport(opts: CreateMemoryTransportOptions = {}): MemoryTransport {
  const bus = opts.bus ?? createMemoryBus();

  return {
    kind: 'memory',
    async publish(topic, envelope) {
      await bus.publish(topic, envelope);
    },
    subscribe(topic, handler) {
      return bus.subscribe(topic, handler);
    },
    async close() {
      // Only close the bus if we created it. Shared buses outlive
      // any single transport — the caller owns lifecycle.
      if (!opts.bus) bus.close();
    },
    subscriberCount(topic) {
      return bus.subscriberCount(topic);
    },
    topics() {
      return bus.topics();
    },
  };
}
