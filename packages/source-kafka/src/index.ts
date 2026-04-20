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

export { createKafkaAdapter as default } from './adapter.js';
