export { createMqttAdapter, mqttAdapter, type MqttAdapterOptions } from './adapter.js';
export { MqttSourceInstance } from './instance.js';
export { assertMqttConfig, topicMatches, type MqttTriggerConfig } from './config.js';
export {
  createMqttjsClient,
  type MqttClient,
  type MqttClientOptions,
  type MqttIncomingMessage,
  type MqttMessageHandler,
  type MqttProtocolVersion,
  type MqttPublishOptions,
  type MqttQoS,
  type MqttSubscription,
} from './client.js';

export { mqttAdapter as default } from './adapter.js';
