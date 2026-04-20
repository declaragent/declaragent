import type { DeliveryConfig, LimitsConfig, RoutingConfig } from '@declaragent/core';
import type { MqttProtocolVersion, MqttQoS } from './client.js';

/**
 * MQTT adapter configuration. Matches the YAML shape in the Phase-4 plan
 * (§Slice 9). Transport settings are deliberately minimal — LWT, retained
 * messages, and topic aliases can be layered on later without breaking
 * existing configs.
 */
export interface MqttTriggerConfig {
  id: string;
  transport: {
    /** e.g. `mqtt://broker:1883` or `mqtts://broker:8883`. */
    brokerUrl: string;
    clientId: string;
    username?: string;
    password?: string;
    /** MQTT clean-start flag. Defaults to `false` (durable session). */
    clean?: boolean;
    /** Default 5 (MQTT 5.0). Drop to 4 for older brokers. */
    protocolVersion?: MqttProtocolVersion;
    keepaliveSeconds?: number;
    ca?: string;
    cert?: string;
    key?: string;
    rejectUnauthorized?: boolean;
    /** At least one subscription is required. */
    subscriptions: readonly { topic: string; qos: MqttQoS }[];
  };
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
  /**
   * Where DLQ messages go. MQTT has no native DLQ — the adapter publishes
   * to this topic via the same client. Leave unset to log-and-drop on
   * retry exhaustion.
   */
  dlq?: { topic: string };
}

export function assertMqttConfig(config: unknown): asserts config is MqttTriggerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('mqtt trigger config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('mqtt config requires non-empty "id"');
  }

  // transport
  if (!c.transport || typeof c.transport !== 'object') {
    throw new Error('mqtt config requires "transport"');
  }
  const t = c.transport as Record<string, unknown>;
  if (typeof t.brokerUrl !== 'string' || t.brokerUrl.length === 0) {
    throw new Error('mqtt config requires non-empty "transport.brokerUrl"');
  }
  if (typeof t.clientId !== 'string' || t.clientId.length === 0) {
    throw new Error('mqtt config requires non-empty "transport.clientId"');
  }
  if (!Array.isArray(t.subscriptions) || t.subscriptions.length === 0) {
    throw new Error('mqtt config requires non-empty "transport.subscriptions"');
  }
  for (const sub of t.subscriptions) {
    if (!sub || typeof sub !== 'object') {
      throw new Error('mqtt subscriptions must be objects');
    }
    const s = sub as Record<string, unknown>;
    if (typeof s.topic !== 'string' || s.topic.length === 0) {
      throw new Error('mqtt subscription.topic must be a non-empty string');
    }
    if (s.qos !== 0 && s.qos !== 1 && s.qos !== 2) {
      throw new Error(`mqtt subscription.qos must be 0, 1, or 2 — got ${String(s.qos)}`);
    }
  }
  if (
    t.protocolVersion !== undefined &&
    t.protocolVersion !== 3 &&
    t.protocolVersion !== 4 &&
    t.protocolVersion !== 5
  ) {
    throw new Error(
      `mqtt transport.protocolVersion must be 3, 4, or 5 — got ${String(t.protocolVersion)}`,
    );
  }

  // routing / delivery / limits — the dispatcher + BaseSourceInstance
  // validate their own slice of these shapes. Here we just confirm they're
  // objects so we fail fast on wholly missing sections.
  if (!c.routing || typeof c.routing !== 'object') {
    throw new Error('mqtt config requires "routing"');
  }
  if (!c.delivery || typeof c.delivery !== 'object') {
    throw new Error('mqtt config requires "delivery"');
  }
  if (!c.limits || typeof c.limits !== 'object') {
    throw new Error('mqtt config requires "limits"');
  }

  if (c.dlq !== undefined) {
    const dlq = c.dlq as Record<string, unknown>;
    if (typeof dlq.topic !== 'string' || dlq.topic.length === 0) {
      throw new Error('mqtt config dlq.topic must be a non-empty string');
    }
  }
}

/**
 * MQTT topic-filter matching. Supports:
 * - `+` : single-level wildcard (matches exactly one level, no slashes)
 * - `#` : multi-level wildcard (must be last; matches zero or more levels)
 *
 * `#` at the root matches every topic (including single-level). `+` never
 * matches an empty level — `sensors/+/temp` doesn't match `sensors//temp`
 * per MQTT spec.
 *
 * Exported for callers that want to do their own topic routing outside of
 * the adapter (e.g. in a custom normalizer).
 */
export function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const filterLevels = filter.split('/');
  const topicLevels = topic.split('/');

  for (let i = 0; i < filterLevels.length; i++) {
    const f = filterLevels[i];
    if (f === '#') {
      // Multi-level wildcard — must be the last filter segment. Matches
      // zero or more remaining topic levels.
      return i === filterLevels.length - 1;
    }
    const t = topicLevels[i];
    if (t === undefined) return false;
    if (f === '+') {
      // Single-level wildcard — any non-empty level matches, but an empty
      // level does not per MQTT 5 §4.7.1.2.
      if (t.length === 0) return false;
      continue;
    }
    if (f !== t) return false;
  }
  // No `#` shortcut fired — the two must be the same length.
  return filterLevels.length === topicLevels.length;
}
