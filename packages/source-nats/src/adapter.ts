import type {
  EventSourceAdapter,
  EventSourceInstance,
  SourceDependencies,
} from '@declaragent/core';
import { type NatsClient, type NatsClientOptions, createNatsJetStreamClient } from './client.js';
import { type NatsTriggerConfig, assertNatsConfig } from './config.js';
import { NatsSourceInstance } from './instance.js';

export interface NatsAdapterOptions {
  /**
   * Test seam: supply a pre-built `NatsClient` (stub) instead of letting
   * the adapter build one from `nats`. When set, `transport.servers` and
   * auth fields are ignored — the injected client is used as-is.
   */
  client?: NatsClient;
  /**
   * Test seam: override the factory used to build the default client.
   * Production callers should leave this unset.
   */
  createClient?(options: NatsClientOptions): NatsClient;
}

/**
 * NATS + JetStream event-source adapter. Registered under `type: 'nats'`.
 * Creates a `NatsSourceInstance` per trigger, each bound to one JetStream
 * consumer (durable or ephemeral).
 *
 * The adapter itself is stateless — the client is built lazily per
 * `create()` call so two triggers pointing at different server sets get
 * independent connections. Callers that need client reuse can inject a
 * shared client via `opts.client`.
 */
export function createNatsAdapter(
  opts: NatsAdapterOptions = {},
): EventSourceAdapter<NatsTriggerConfig> {
  const buildClient = opts.createClient ?? createNatsJetStreamClient;

  return {
    type: 'nats',
    agentCompat: '>=0.0.1',
    validateConfig(config: unknown): asserts config is NatsTriggerConfig {
      assertNatsConfig(config);
    },
    async create(
      config: NatsTriggerConfig,
      deps: SourceDependencies,
    ): Promise<EventSourceInstance> {
      const client =
        opts.client ??
        buildClient({
          servers: config.transport.servers,
          ...(config.id !== undefined && { name: config.id }),
          ...(config.transport.username !== undefined && { user: config.transport.username }),
          ...(config.transport.password !== undefined && {
            password: config.transport.password,
          }),
          ...(config.transport.token !== undefined && { token: config.transport.token }),
          ...(config.transport.nkeySeed !== undefined && {
            nkeySeed: config.transport.nkeySeed,
          }),
        });
      return new NatsSourceInstance(config, deps, client);
    },
  };
}

/** Default adapter instance. Convenience for `adapterExtension(natsAdapter, …)`. */
export const natsAdapter = createNatsAdapter();
