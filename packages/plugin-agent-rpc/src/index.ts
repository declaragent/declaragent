/**
 * @since 1.1.0
 *
 * Agent-to-agent RPC runtime. Pairs with `@declaragent/core/rpc` — the
 * core package owns the envelope + configuration loaders, this package
 * owns the runtime primitives (producer tool + consumer source +
 * in-memory transport + respond hook).
 */

export {
  DEFAULT_PENDING_CAPACITY,
  createPendingRegistry,
} from './pending-registry.js';
export type {
  CreatePendingRegistryOptions,
  PendingEntry,
  PendingRegistry,
  PendingSettleValue,
  RegisterOptions,
} from './pending-registry.js';
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  brokerAddressToTopic,
  createRequestAgentTool,
} from './request-agent.js';
export type {
  CreateRequestAgentToolOptions,
  RequestAgentInput,
  RequestAgentMode,
  RequestAgentOutput,
} from './request-agent.js';
export { createAgentInboxAdapter, decodeFromWire } from './agent-inbox.js';
export type {
  AgentInboxConfig,
  CreateAgentInboxAdapterOptions,
} from './agent-inbox.js';
export { createRespondHook } from './respond.js';
export type { CreateRespondHookOptions } from './respond.js';
export { createMemoryBus, createMemoryTransport } from './memory-transport.js';
export type {
  CreateMemoryTransportOptions,
  MemoryBus,
  MemoryTransport,
} from './memory-transport.js';
export { createKafkaTransport } from './kafka-transport.js';
export type {
  CreateKafkaTransportOptions,
  KafkaClientLike,
  KafkaConsumerLike,
  KafkaJSModule,
  KafkaProducerLike,
} from './kafka-transport.js';
