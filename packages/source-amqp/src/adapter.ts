import type {
  EventSourceAdapter,
  EventSourceInstance,
  SourceDependencies,
} from '@declaragent/core';
import { type AmqpClient, type AmqpClientOptions, createAmqplibClient } from './client.js';
import { type AmqpTriggerConfig, assertAmqpConfig } from './config.js';
import { AmqpSourceInstance } from './instance.js';

export interface AmqpAdapterOptions {
  /**
   * Test seam: supply a pre-built `AmqpClient` (stub) instead of letting
   * the adapter build one from `amqplib`. When set, `transport.url` +
   * `transport.heartbeatSeconds` are ignored — the injected client is
   * used as-is.
   */
  client?: AmqpClient;
  /** Test seam: override the factory used to build the default client. */
  createClient?(options: AmqpClientOptions): AmqpClient;
}

export function createAmqpAdapter(
  opts: AmqpAdapterOptions = {},
): EventSourceAdapter<AmqpTriggerConfig> {
  const buildClient = opts.createClient ?? createAmqplibClient;

  return {
    type: 'amqp',
    agentCompat: '>=0.0.1',
    validateConfig(config: unknown): asserts config is AmqpTriggerConfig {
      assertAmqpConfig(config);
    },
    async create(
      config: AmqpTriggerConfig,
      deps: SourceDependencies,
    ): Promise<EventSourceInstance> {
      const client =
        opts.client ??
        buildClient({
          url: config.transport.url,
          ...(config.transport.heartbeatSeconds !== undefined && {
            heartbeatSeconds: config.transport.heartbeatSeconds,
          }),
        });
      return new AmqpSourceInstance(config, deps, client);
    },
  };
}

/** Default adapter instance. */
export const amqpAdapter = createAmqpAdapter();
