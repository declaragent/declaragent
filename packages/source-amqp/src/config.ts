import type { DeliveryConfig, LimitsConfig, RoutingConfig } from '@declaragent/core';

/**
 * AMQP (RabbitMQ) adapter configuration. Matches the YAML shape in
 * `docs/EVENT_SOURCE_REGISTRY.md §13.2` + the Phase-4 plan.
 *
 * DLX pattern: publish to an exchange + routing key (not a queue URL).
 * The consumer-side DLX binding is a native RabbitMQ concern — operators
 * declare it on the target exchange or via `x-dead-letter-exchange`
 * argument on the consumer queue. The adapter asserts the DLX exchange
 * at startup so DLQ sends from retry exhaustion never hit an unrouted
 * publish.
 */
export interface AmqpTriggerConfig {
  id: string;
  transport: {
    /** AMQP URL, e.g. `amqp://guest:guest@localhost:5672`. */
    url: string;
    /** Consumer queue name. Declared on startup with the options below. */
    queue: string;
    /**
     * `basic.qos` prefetch. Defaults to `limits.maxInflight` when unset;
     * the adapter also caps it at `maxInflight` so the broker never hands
     * us more than our concurrency limit.
     */
    prefetch?: number;
    /**
     * Optional source exchange to bind the queue to on startup. If set,
     * `bindingPatterns` must be non-empty.
     */
    exchange?: string;
    /** Routing keys to bind with. Each pattern triggers one `queue.bind`. */
    bindingPatterns?: readonly string[];
    /** Queue durability. Default `true`. */
    durable?: boolean;
    /** Auto-delete the queue once the last consumer disconnects. Default `false`. */
    autoDelete?: boolean;
    /** Heartbeat (seconds). Defaults to the `amqplib` default (0 = disabled). */
    heartbeatSeconds?: number;
  };
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
  /**
   * Where DLQ messages go. The adapter publishes to `exchange` with the
   * given `routingKey` (fallback: the original message's routing key).
   * Leave unset to nack-without-requeue + log on retry exhaustion.
   */
  dlq?: {
    exchange: string;
    routingKey?: string;
    /**
     * Optional assertion: declare the DLX exchange on startup. Default
     * `true` so a typo in the exchange name surfaces immediately instead
     * of silently losing DLQ publishes.
     */
    declare?: boolean;
    /** DLX exchange type. Default `topic`. */
    exchangeType?: 'direct' | 'topic' | 'headers' | 'fanout';
  };
}

export function assertAmqpConfig(config: unknown): asserts config is AmqpTriggerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('amqp trigger config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('amqp config requires non-empty "id"');
  }

  // transport
  if (!c.transport || typeof c.transport !== 'object') {
    throw new Error('amqp config requires "transport"');
  }
  const t = c.transport as Record<string, unknown>;
  if (typeof t.url !== 'string' || t.url.length === 0) {
    throw new Error('amqp config requires "transport.url"');
  }
  if (typeof t.queue !== 'string' || t.queue.length === 0) {
    throw new Error('amqp config requires "transport.queue"');
  }
  if (t.prefetch !== undefined) {
    const v = Number(t.prefetch);
    if (!Number.isInteger(v) || v < 1 || v > 65_535) {
      throw new Error('amqp transport.prefetch must be an integer between 1 and 65535');
    }
  }
  if (t.exchange !== undefined) {
    if (typeof t.exchange !== 'string' || t.exchange.length === 0) {
      throw new Error('amqp transport.exchange must be a non-empty string');
    }
  }
  if (t.bindingPatterns !== undefined) {
    if (!Array.isArray(t.bindingPatterns)) {
      throw new Error('amqp transport.bindingPatterns must be an array of strings');
    }
    for (const p of t.bindingPatterns) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new Error('amqp transport.bindingPatterns entries must be non-empty strings');
      }
    }
  }
  if (t.exchange !== undefined) {
    // Binding without patterns is almost never what the user wants — catch
    // the oversight early. (Fanout exchanges *do* work without a routing
    // key, but `bindingPatterns: ['']` expresses that explicitly.)
    if (!Array.isArray(t.bindingPatterns) || t.bindingPatterns.length === 0) {
      throw new Error('amqp transport.exchange requires non-empty "transport.bindingPatterns"');
    }
  }

  // routing / delivery / limits — downstream validators handle their own
  // fields; just fail fast on wholly-missing sections.
  if (!c.routing || typeof c.routing !== 'object') {
    throw new Error('amqp config requires "routing"');
  }
  if (!c.delivery || typeof c.delivery !== 'object') {
    throw new Error('amqp config requires "delivery"');
  }
  if (!c.limits || typeof c.limits !== 'object') {
    throw new Error('amqp config requires "limits"');
  }

  if (c.dlq !== undefined) {
    if (!c.dlq || typeof c.dlq !== 'object') {
      throw new Error('amqp dlq must be an object');
    }
    const dlq = c.dlq as Record<string, unknown>;
    if (typeof dlq.exchange !== 'string' || dlq.exchange.length === 0) {
      throw new Error('amqp dlq.exchange must be a non-empty string');
    }
    if (dlq.routingKey !== undefined && typeof dlq.routingKey !== 'string') {
      throw new Error('amqp dlq.routingKey must be a string');
    }
    if (dlq.exchangeType !== undefined) {
      const valid = ['direct', 'topic', 'headers', 'fanout'];
      if (typeof dlq.exchangeType !== 'string' || !valid.includes(dlq.exchangeType)) {
        throw new Error(`amqp dlq.exchangeType must be one of ${valid.join(', ')}`);
      }
    }
  }
}
