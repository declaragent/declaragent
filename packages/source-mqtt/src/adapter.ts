import type {
  EventSourceAdapter,
  EventSourceInstance,
  SourceDependencies,
} from '@declaragent/core';
import { type MqttClient, type MqttClientOptions, createMqttjsClient } from './client.js';
import { type MqttTriggerConfig, assertMqttConfig } from './config.js';
import { MqttSourceInstance } from './instance.js';

export interface MqttAdapterOptions {
  /**
   * Test seam: supply a pre-built `MqttClient` (stub) instead of letting
   * the adapter build one from `mqtt`. When set, `transport.brokerUrl`
   * and the TLS / credentials fields are ignored — the injected client
   * is used as-is.
   */
  client?: MqttClient;
  /**
   * Test seam: override the factory used to build the default
   * `MqttClient`. Production callers should leave this unset.
   */
  createClient?(options: MqttClientOptions): MqttClient;
}

/**
 * MQTT event-source adapter. Registered under `type: 'mqtt'`. Creates a
 * `MqttSourceInstance` per trigger, each with its own MQTT.js client
 * (including its own durable session identity via `transport.clientId`).
 *
 * The adapter itself is stateless — the client is built lazily per
 * `create()` call so two triggers pointing at different brokers get
 * independent connections. Callers that want to share one client across
 * triggers can inject one via `opts.client`.
 */
export function createMqttAdapter(
  opts: MqttAdapterOptions = {},
): EventSourceAdapter<MqttTriggerConfig> {
  const buildClient = opts.createClient ?? createMqttjsClient;

  return {
    type: 'mqtt',
    agentCompat: '>=0.0.1',
    validateConfig(config: unknown): asserts config is MqttTriggerConfig {
      assertMqttConfig(config);
    },
    async create(
      config: MqttTriggerConfig,
      deps: SourceDependencies,
    ): Promise<EventSourceInstance> {
      const client =
        opts.client ??
        buildClient({
          brokerUrl: config.transport.brokerUrl,
          clientId: config.transport.clientId,
          ...(config.transport.username !== undefined && { username: config.transport.username }),
          ...(config.transport.password !== undefined && { password: config.transport.password }),
          ...(config.transport.clean !== undefined && { clean: config.transport.clean }),
          ...(config.transport.protocolVersion !== undefined && {
            protocolVersion: config.transport.protocolVersion,
          }),
          ...(config.transport.keepaliveSeconds !== undefined && {
            keepaliveSeconds: config.transport.keepaliveSeconds,
          }),
          ...(config.transport.ca !== undefined && { ca: config.transport.ca }),
          ...(config.transport.cert !== undefined && { cert: config.transport.cert }),
          ...(config.transport.key !== undefined && { key: config.transport.key }),
          ...(config.transport.rejectUnauthorized !== undefined && {
            rejectUnauthorized: config.transport.rejectUnauthorized,
          }),
        });
      return new MqttSourceInstance(config, deps, client);
    },
  };
}

/** Default adapter instance. Convenience for `adapterExtension(mqttAdapter, …)`. */
export const mqttAdapter = createMqttAdapter();
