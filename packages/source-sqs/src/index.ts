export { createSqsAdapter, sqsAdapter, type SqsAdapterOptions } from './adapter.js';
export { SqsSourceInstance } from './instance.js';
export {
  assertSqsConfig,
  isFifoQueue,
  regionFromQueueUrl,
  type SqsTriggerConfig,
} from './config.js';
export {
  createAwsSqsClient,
  type ReceiveMessageRequest,
  type SendMessageRequest,
  type SqsClient,
  type SqsClientOptions,
  type SqsIncomingMessage,
} from './client.js';

export { sqsAdapter as default } from './adapter.js';
