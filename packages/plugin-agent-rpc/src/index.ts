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
  CapabilitySchemaViolationEmitter,
  CreateRequestAgentToolOptions,
  RequestAgentInput,
  RequestAgentMode,
  RequestAgentOutput,
} from './request-agent.js';
export { createAgentInboxAdapter, decodeFromWire } from './agent-inbox.js';
export type {
  AgentInboxConfig,
  AuthRejectSink,
  AuthVerifyRegistry,
  CreateAgentInboxAdapterOptions,
} from './agent-inbox.js';
export { createOidcAuthProvider } from './auth/oidc.js';
export type {
  CreateOidcAuthProviderOptions,
  OidcPeerConfig,
} from './auth/oidc.js';
export { createOAuth2ClientAuthProvider } from './auth/oauth2-client.js';
export type {
  CreateOAuth2ClientAuthProviderOptions,
  OAuth2ClientPeerConfig,
} from './auth/oauth2-client.js';
export { buildAuthVerifyRegistry } from './auth/registry-factory.js';
export type {
  BuildAuthVerifyRegistryOptions,
  ResolveSecret,
} from './auth/registry-factory.js';
export type {
  RpcAuthPeerConfigBase,
  RpcAuthPrincipal,
  RpcAuthProvider,
  RpcAuthRejectReason,
  RpcAuthVerifyResult,
} from './auth/types.js';
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
export { createNatsTransport } from './nats-transport.js';
export type {
  CreateNatsTransportOptions,
  NatsConnectionLike,
  NatsMessageLike,
  NatsModule,
  NatsSubscriptionLike,
} from './nats-transport.js';
