import type { DeliveryConfig, LimitsConfig, RoutingConfig } from '@declaragent/core';

/**
 * NATS + JetStream adapter configuration. JetStream is the primary
 * target: every trigger binds (or creates) a JetStream consumer against
 * a named stream. Core-NATS `queueGroup` is accepted as a passthrough
 * hint for a future pure-core fallback; the JetStream path uses the
 * durable consumer name itself for group semantics.
 */
export interface NatsTriggerConfig {
  id: string;
  transport: {
    /** Server URLs, e.g. `['nats://localhost:4222']`. At least one required. */
    servers: readonly string[];
    /** JetStream stream name to bind against. Required. */
    stream: string;
    /**
     * Durable consumer name. When set, JetStream persists consumer state
     * across disconnects and multiple workers sharing this name split
     * delivery (JetStream's equivalent of a queue group).
     */
    durableConsumer?: string;
    /**
     * Subject filters the consumer cares about. Defaults to all subjects
     * configured on the stream.
     */
    subjectFilters?: readonly string[];
    /**
     * Core-NATS queue group hint. Only meaningful for a future non-JetStream
     * fallback; JetStream uses the durable consumer name for group semantics.
     */
    queueGroup?: string;
    /** Start sequence for a fresh consumer. Ignored if bound to an existing one. */
    startSequence?: number;
    /** ISO timestamp start. Alternative to startSequence. */
    startTime?: string;
    /** Ack wait in seconds. Server default is 30s. */
    ackWaitSeconds?: number;
    /** Max deliveries JetStream attempts before quarantining. */
    maxDeliver?: number;
    /** Username/password auth. */
    username?: string;
    password?: string;
    /** Token auth (mutually exclusive with user/pass). */
    token?: string;
    /** NKey seed (string). For advanced NKey/JWT auth. */
    nkeySeed?: string;
  };
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
  /**
   * Agent-managed DLQ. When set, DLQ messages are published to
   * `dlq.subject`. Unset → log-and-drop on retry exhaustion (JetStream
   * `max_deliver` covers the server-side-quarantine case independently).
   */
  dlq?: { subject: string };
}

export function assertNatsConfig(config: unknown): asserts config is NatsTriggerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('nats trigger config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('nats config requires non-empty "id"');
  }

  // transport
  if (!c.transport || typeof c.transport !== 'object') {
    throw new Error('nats config requires "transport"');
  }
  const t = c.transport as Record<string, unknown>;
  if (!Array.isArray(t.servers) || t.servers.length === 0) {
    throw new Error('nats config requires non-empty "transport.servers"');
  }
  for (const s of t.servers) {
    if (typeof s !== 'string') throw new Error('nats transport.servers must be strings');
  }
  if (typeof t.stream !== 'string' || t.stream.length === 0) {
    throw new Error('nats config requires non-empty "transport.stream"');
  }

  if (t.subjectFilters !== undefined) {
    if (!Array.isArray(t.subjectFilters)) {
      throw new Error('nats transport.subjectFilters must be an array of strings');
    }
    for (const s of t.subjectFilters) {
      if (typeof s !== 'string') throw new Error('nats subjectFilters must be strings');
    }
  }

  if (t.startSequence !== undefined) {
    const v = Number(t.startSequence);
    if (!Number.isInteger(v) || v < 1) {
      throw new Error('nats transport.startSequence must be a positive integer');
    }
  }
  if (t.ackWaitSeconds !== undefined) {
    const v = Number(t.ackWaitSeconds);
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error('nats transport.ackWaitSeconds must be a positive number');
    }
  }
  if (t.maxDeliver !== undefined) {
    const v = Number(t.maxDeliver);
    if (!Number.isInteger(v) || v < 1) {
      throw new Error('nats transport.maxDeliver must be a positive integer');
    }
  }

  if ((t.username !== undefined) !== (t.password !== undefined)) {
    throw new Error('nats transport.username and password must be set together');
  }

  // routing / delivery / limits — the dispatcher + BaseSourceInstance
  // validate their own slice. Here we just confirm they're objects.
  if (!c.routing || typeof c.routing !== 'object') {
    throw new Error('nats config requires "routing"');
  }
  if (!c.delivery || typeof c.delivery !== 'object') {
    throw new Error('nats config requires "delivery"');
  }
  if (!c.limits || typeof c.limits !== 'object') {
    throw new Error('nats config requires "limits"');
  }

  if (c.dlq !== undefined) {
    const dlq = c.dlq as Record<string, unknown>;
    if (typeof dlq.subject !== 'string' || dlq.subject.length === 0) {
      throw new Error('nats config dlq.subject must be a non-empty string');
    }
  }
}
