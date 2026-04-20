import type { DeliveryConfig, LimitsConfig, RoutingConfig } from '@declaragent/core';
import type { KafkaSaslConfig, KafkaTlsConfig } from './client.js';

/**
 * Kafka adapter configuration. Matches the YAML shape in
 * `docs/EVENT_SOURCE_REGISTRY.md §13.1` + the Phase-4 plan.
 */
export interface KafkaTriggerConfig {
  id: string;
  transport: {
    brokers: readonly string[];
    clientId?: string;
    consumerGroup: string;
    topics: readonly string[];
    sessionTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    fromBeginning?: boolean;
  };
  security?: {
    sasl?: KafkaSaslConfig;
    ssl?: KafkaTlsConfig | boolean;
  };
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
  /**
   * Where DLQ messages go. Kafka doesn't have a native DLQ — the
   * adapter produces to this topic via a dedicated producer. Leave
   * unset to log-and-drop on retry exhaustion.
   */
  dlq?: { topic: string };
}

export function assertKafkaConfig(config: unknown): asserts config is KafkaTriggerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('kafka trigger config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('kafka config requires non-empty "id"');
  }

  // transport
  if (!c.transport || typeof c.transport !== 'object') {
    throw new Error('kafka config requires "transport"');
  }
  const t = c.transport as Record<string, unknown>;
  if (!Array.isArray(t.brokers) || t.brokers.length === 0) {
    throw new Error('kafka config requires non-empty "transport.brokers"');
  }
  for (const b of t.brokers) {
    if (typeof b !== 'string') throw new Error('kafka brokers must be strings');
  }
  if (typeof t.consumerGroup !== 'string' || t.consumerGroup.length === 0) {
    throw new Error('kafka config requires "transport.consumerGroup"');
  }
  if (!Array.isArray(t.topics) || t.topics.length === 0) {
    throw new Error('kafka config requires non-empty "transport.topics"');
  }
  for (const topic of t.topics) {
    if (typeof topic !== 'string') throw new Error('kafka topics must be strings');
  }

  // security (optional)
  if (c.security !== undefined) {
    if (!c.security || typeof c.security !== 'object') {
      throw new Error('kafka config "security" must be an object');
    }
    const sec = c.security as Record<string, unknown>;
    if (sec.sasl !== undefined) {
      if (!sec.sasl || typeof sec.sasl !== 'object') {
        throw new Error('kafka security.sasl must be an object');
      }
      const sasl = sec.sasl as Record<string, unknown>;
      const validMechanisms = ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512', 'OAUTHBEARER'];
      if (typeof sasl.mechanism !== 'string' || !validMechanisms.includes(sasl.mechanism)) {
        throw new Error(
          `kafka sasl.mechanism must be one of ${validMechanisms.join(', ')} — got ${String(sasl.mechanism)}`,
        );
      }
    }
  }

  // routing / delivery / limits — the dispatcher + BaseSourceInstance
  // validate their own slice of these shapes. Here we just confirm
  // they're objects so we fail fast on wholly missing sections.
  if (!c.routing || typeof c.routing !== 'object') {
    throw new Error('kafka config requires "routing"');
  }
  if (!c.delivery || typeof c.delivery !== 'object') {
    throw new Error('kafka config requires "delivery"');
  }
  if (!c.limits || typeof c.limits !== 'object') {
    throw new Error('kafka config requires "limits"');
  }

  if (c.dlq !== undefined) {
    const dlq = c.dlq as Record<string, unknown>;
    if (typeof dlq.topic !== 'string' || dlq.topic.length === 0) {
      throw new Error('kafka config dlq.topic must be a non-empty string');
    }
  }
}
