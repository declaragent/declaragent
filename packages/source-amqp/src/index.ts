export { createAmqpAdapter, amqpAdapter, type AmqpAdapterOptions } from './adapter.js';
export { AmqpSourceInstance } from './instance.js';
export { assertAmqpConfig, type AmqpTriggerConfig } from './config.js';
export {
  createAmqplibClient,
  type AmqpChannel,
  type AmqpClient,
  type AmqpClientOptions,
  type AmqpExchangeOptions,
  type AmqpIncomingMessage,
  type AmqpMessageHandler,
  type AmqpPublishOptions,
  type AmqpQueueOptions,
} from './client.js';

export { createAmqpAdapter as default } from './adapter.js';
