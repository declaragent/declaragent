export { createNatsAdapter, natsAdapter, type NatsAdapterOptions } from './adapter.js';
export { NatsSourceInstance } from './instance.js';
export { assertNatsConfig, type NatsTriggerConfig } from './config.js';
export {
  createNatsJetStreamClient,
  type ConsumeOptions,
  type NatsAckHandle,
  type NatsClient,
  type NatsClientOptions,
  type NatsConsumerHandle,
  type NatsIncomingMessage,
  type NatsTlsConfig,
} from './client.js';

export { createNatsAdapter as default } from './adapter.js';
