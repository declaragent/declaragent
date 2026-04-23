/**
 * Agent RPC error taxonomy. Every error that surfaces on a
 * `RequestAgent` tool result or in the receiver's DLQ carries a stable
 * code callers can pattern-match on.
 *
 * @since 1.1.0
 */

export const RPC_ERROR_CODES = {
  TIMEOUT: 'EAGENTRPC_TIMEOUT',
  ABANDONED: 'EAGENTRPC_ABANDONED',
  BUSY: 'EAGENTRPC_BUSY',
  NO_TRANSPORT: 'EAGENTRPC_NO_TRANSPORT',
  NO_PEER: 'EAGENTRPC_NO_PEER',
  NO_CAPABILITY: 'EAGENTRPC_NO_CAPABILITY',
  INVALID_ENVELOPE: 'EAGENTRPC_INVALID_ENVELOPE',
  AUTH_FAILED: 'EAGENTRPC_AUTH_FAILED',
  DEADLINE_EXCEEDED: 'EAGENTRPC_DEADLINE_EXCEEDED',
  TENANT_MISMATCH: 'EAGENTRPC_TENANT_MISMATCH',
  /** Caller's `x-fleet-version` is older than the receiver's `minFleetVersion`. @since 1.2.0 */
  VERSION_SKEW: 'EVERSION_SKEW',
  /**
   * Emitted on the response path when an inbound envelope's {@link RpcAuth}
   * block fails verification against the registered {@link RpcAuthProvider}.
   * Distinct from {@link AUTH_FAILED}: this one is raised by the envelope
   * auth middleware (OIDC / OAuth2 / HMAC providers) before the capability
   * handler runs, whereas `AUTH_FAILED` is the generic transport-layer auth
   * error. The wire value is the historical unprefixed `AUTH_REJECTED`
   * literal — we preserve that for back-compat with 3.0.0 receivers that
   * pattern-match on the string. See POST_ENTERPRISE_BACKLOG.md #8.
   * @since 1.2.1 — promoted from string literal in fleet-run.ts
   */
  AUTH_REJECTED: 'AUTH_REJECTED',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export class RpcTimeoutError extends Error {
  readonly code = RPC_ERROR_CODES.TIMEOUT;
  constructor(
    readonly correlationId: string,
    readonly timeoutMs: number,
  ) {
    super(`agent-rpc timed out after ${timeoutMs}ms (correlationId=${correlationId})`);
    this.name = 'RpcTimeoutError';
  }
}

export class RpcAbandonedError extends Error {
  readonly code = RPC_ERROR_CODES.ABANDONED;
  constructor(readonly correlationId: string) {
    super(`agent-rpc abandoned (correlationId=${correlationId})`);
    this.name = 'RpcAbandonedError';
  }
}

export class RpcBusyError extends Error {
  readonly code = RPC_ERROR_CODES.BUSY;
  constructor(readonly capacity: number) {
    super(`agent-rpc pending-registry at capacity (${capacity})`);
    this.name = 'RpcBusyError';
  }
}

export class RpcNoTransportError extends Error {
  readonly code = RPC_ERROR_CODES.NO_TRANSPORT;
  constructor(message: string) {
    super(message);
    this.name = 'RpcNoTransportError';
  }
}

export class RpcNoPeerError extends Error {
  readonly code = RPC_ERROR_CODES.NO_PEER;
  constructor(readonly target: string) {
    super(`no peer registered for "${target}"`);
    this.name = 'RpcNoPeerError';
  }
}
