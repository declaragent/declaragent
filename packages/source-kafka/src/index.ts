export { createKafkaAdapter, kafkaAdapter, type KafkaAdapterOptions } from './adapter.js';
export { KafkaSourceInstance } from './instance.js';
export { assertKafkaConfig, type KafkaTriggerConfig } from './config.js';
export {
  createKafkajsClient,
  type KafkaAdminHandle,
  type KafkaClient,
  type KafkaClientOptions,
  type KafkaConsumerHandle,
  type KafkaEachMessage,
  type KafkaIncomingMessage,
  type KafkaProducerHandle,
  type KafkaSaslConfig,
  type KafkaTlsConfig,
  type SaslMechanism,
} from './client.js';

// Default-export the adapter instance so the scope + discovery loaders
// in `@declaragent/cli` pick it up without needing to invoke a factory.
// `createKafkaAdapter` (the factory) remains available as a named
// export for callers who need to override adapter options.
export { kafkaAdapter as default } from './adapter.js';
