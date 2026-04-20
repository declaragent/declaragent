import type {
  EventSourceAdapter,
  EventSourceInstance,
  SourceDependencies,
} from '@declaragent/core';
import { type KafkaClient, type KafkaClientOptions, createKafkajsClient } from './client.js';
import { type KafkaTriggerConfig, assertKafkaConfig } from './config.js';
import { KafkaSourceInstance } from './instance.js';

export interface KafkaAdapterOptions {
  /**
   * Test seam: supply a pre-built `KafkaClient` (stub) instead of letting
   * the adapter build one from `kafkajs`. When set, `transport.brokers`
   * and `security.*` are ignored — the injected client is used as-is.
   */
  client?: KafkaClient;
  /**
   * Test seam: override the factory used to build the default
   * `KafkaClient`. Production callers should leave this unset.
   */
  createClient?(options: KafkaClientOptions): KafkaClient;
}

/**
 * Kafka event-source adapter. Registered under `type: 'kafka'`. Creates a
 * `KafkaSourceInstance` per trigger, each with its own consumer (and
 * optional DLQ producer).
 *
 * The adapter itself is stateless — the client is built lazily per
 * `create()` call so two triggers pointing at different broker sets get
 * independent connections. Callers that need client reuse (connection
 * pooling across a fleet of triggers) can inject a shared client via
 * `opts.client`.
 */
export function createKafkaAdapter(
  opts: KafkaAdapterOptions = {},
): EventSourceAdapter<KafkaTriggerConfig> {
  const buildClient = opts.createClient ?? createKafkajsClient;

  return {
    type: 'kafka',
    agentCompat: '>=0.0.1',
    validateConfig(config: unknown): asserts config is KafkaTriggerConfig {
      assertKafkaConfig(config);
    },
    async create(
      config: KafkaTriggerConfig,
      deps: SourceDependencies,
    ): Promise<EventSourceInstance> {
      const client =
        opts.client ??
        buildClient({
          brokers: config.transport.brokers,
          ...(config.transport.clientId !== undefined && { clientId: config.transport.clientId }),
          ...(config.security?.sasl !== undefined && { sasl: config.security.sasl }),
          ...(config.security?.ssl !== undefined && { ssl: config.security.ssl }),
        });
      return new KafkaSourceInstance(config, deps, client);
    },
  };
}

/** Default adapter instance. Convenience for `adapterExtension(kafkaAdapter, …)`. */
export const kafkaAdapter = createKafkaAdapter();
