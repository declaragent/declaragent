/**
 * Transport-agnostic RPC primitives. Transport plugins
 * (`@declaragent/plugin-agent-rpc-*`) supply an `RpcTransport`; the
 * producer (`RequestAgent`) + consumer (`agent-inbox`) never touch the
 * wire format.
 *
 * @since 1.1.0
 */

import type { AgentRpcEnvelope } from './envelope.js';

export type RpcTransportKind = 'kafka' | 'nats' | 'sqs' | 'amqp' | 'mqtt' | 'memory';

export type RpcSubscriptionHandler = (envelope: AgentRpcEnvelope) => Promise<void> | void;

export interface RpcTransport {
  readonly kind: RpcTransportKind;
  /**
   * Publish an envelope to `topic`. Resolves once the transport has
   * handed the message to the broker (at-least-once semantics for the
   * durable transports; best-effort for in-memory).
   */
  publish(topic: string, envelope: AgentRpcEnvelope): Promise<void>;
  /**
   * Subscribe to a topic. The returned function unsubscribes. Handlers
   * are invoked serially per subscription; concurrent delivery across
   * subscriptions is transport-specific.
   */
  subscribe(topic: string, handler: RpcSubscriptionHandler): () => void;
  close(): Promise<void>;
}
