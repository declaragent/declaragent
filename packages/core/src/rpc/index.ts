/**
 * @since 1.1.0
 * Agent RPC envelope + error types + transport contract.
 */

export {
  AgentRpcEnvelopeSchema,
  RpcEnvelopeValidationError,
  canonicalizeForSigning,
  decodeEnvelope,
  encodeEnvelope,
  parseEnvelope,
} from './envelope.js';
export type {
  AgentAddress,
  AgentRpcEnvelope,
  BrokerAddress,
  EnvelopeKind,
  RpcAuth,
  RpcError,
} from './envelope.js';
export {
  RPC_ERROR_CODES,
  RpcAbandonedError,
  RpcBusyError,
  RpcNoPeerError,
  RpcNoTransportError,
  RpcTimeoutError,
} from './errors.js';
export type { RpcErrorCode } from './errors.js';
export type { RpcSubscriptionHandler, RpcTransport, RpcTransportKind } from './types.js';
export {
  CapabilitiesConfigError,
  capabilitiesConfigSchema,
  loadCapabilitiesConfig,
  parseCapabilitiesConfig,
} from './capabilities-loader.js';
export type {
  CapabilityDefinition,
  CapabilitiesConfig,
  CapabilityTransport,
  LoadedCapabilities,
} from './capabilities-loader.js';
export {
  PeersConfigError,
  loadPeersConfig,
  parsePeersConfig,
  peerAuthSchema,
  peersConfigSchema,
  resolvePeerTransport,
} from './peers-loader.js';
export type {
  LoadedPeers,
  PeerAuthConfig,
  PeerEntry,
  PeerTransport,
  PeersConfig,
} from './peers-loader.js';
