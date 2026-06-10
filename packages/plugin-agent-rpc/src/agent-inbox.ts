/**
 * `agent-inbox` EventSourceAdapter. Subscribes to the local agent's
 * `agents.<self>.requests` + `agents.<self>.responses` topics over a
 * plugged-in `RpcTransport`. On receipt:
 *
 *   - `kind: 'request'`  → publish an `AgentEvent` with
 *     `target: { type: 'skill', name: capability }`.
 *   - `kind: 'response'` → wake the producer-side pending-RPC registry.
 *   - `kind: 'event'`    → publish to the local bus as a broadcast.
 *
 * Tenant scope is enforced at decode: `envelope.tenantId` (when present)
 * must match the adapter's bound `tenant.id`. Mismatch drops the message
 * onto a local DLQ buffer + emits an audit record.
 *
 * @since 1.1.0
 */

import {
  type AgentEvent,
  type AgentRpcEnvelope,
  type AuthCheckAuditRecord,
  type BrokerAddress,
  type EventSourceAdapter,
  type EventSourceInstance,
  type PeerAuthConfig,
  type RpcSubscriptionHandler,
  type RpcTransport,
  type SourceDependencies,
  type SourceHealth,
  type SourceMetrics,
  type TenantAuditSink,
  decodeEnvelope,
} from '@declaragent/core';
import type { RpcAuthProvider, RpcAuthRejectReason } from './auth/types.js';
import type { PendingRegistry } from './pending-registry.js';

/**
 * Callback invoked when an envelope fails auth verify. Receivers wire
 * this to the event-store's `upsertRejection` so the envelope lands on
 * the `rejected_events` table under `kind=auth-rejected`.
 */
export type AuthRejectSink = (entry: {
  envelope: AgentRpcEnvelope;
  reason: RpcAuthRejectReason;
  message: string;
}) => Promise<void> | void;

/**
 * Map from `agent://` peer id to its verify config + the provider that
 * knows how to verify it. Receivers look up by `envelope.from`.
 */
export interface AuthVerifyRegistry {
  /** Return verify config for this peer, or `undefined` when auth is not required. */
  resolve(peerId: string): { config: PeerAuthConfig; provider: RpcAuthProvider } | undefined;
}

export interface AgentInboxConfig {
  id: string;
  /** Logical agent id. */
  agentId: string;
  /** Requests topic. Default: `agents.<agentId>.requests`. */
  requestsTopic?: string;
  /** Responses topic. Default: `agents.<agentId>.responses`. */
  responsesTopic?: string;
  /** Optional broadcast events topic. */
  eventsTopic?: string;
  /**
   * Broker scheme used for outbound `replyTo` values. Producer-side only;
   * the receiver stamps this when constructing its own response envelopes.
   */
  replyToAddress?: BrokerAddress;
}

export interface CreateAgentInboxAdapterOptions {
  transport: RpcTransport;
  /** Producer-side pending-RPC registry (for response routing). */
  pending?: PendingRegistry;
  /**
   * Optional handler invoked for every decoded request envelope. Wires
   * `ctx.respond` into the receiver's engine turn. The default hook
   * publishes the envelope as an `AgentEvent` with target
   * `{ type: 'skill', name: envelope.capability }`.
   */
  onRequest?(envelope: AgentRpcEnvelope, event: AgentEvent): Promise<void> | void;
  /**
   * Optional handler invoked for every decoded event envelope. The
   * default hook publishes an `AgentEvent` with `target: { type: 'broadcast' }`.
   */
  onEvent?(envelope: AgentRpcEnvelope, event: AgentEvent): Promise<void> | void;
  /**
   * Per-peer auth registry. When present, every inbound envelope is
   * verified against the registered {@link RpcAuthProvider}. Peers
   * without an entry remain on the legacy `internal`/`hmac` path
   * (envelope passes through unchanged).
   *
   * @since 1.2.0
   */
  authRegistry?: AuthVerifyRegistry;
  /**
   * Fail-CLOSED mode. When `true` and an {@link authRegistry} is present, an
   * envelope whose `from` has no registry entry is REJECTED (reason
   * `unknown-peer`) instead of falling through to the legacy accept path. This
   * closes the spoof where an attacker sets `from: agent://not-in-registry` to
   * bypass verification.
   *
   * Defaults to `false` for backward compatibility; `declaragent up` sets it to
   * `true` whenever `agent.yaml#rpc.auth.enabled: true` (explicit opt-in), and
   * it becomes the default at the 0.8.0 zero-trust cutover.
   *
   * @since 0.7.6 — production-readiness WS2
   */
  strictAuth?: boolean;
  /**
   * Sink for auth-rejected envelopes. Receivers wire this to
   * `EventStore.upsertRejection` so rejects land in `rejected_events`
   * under `kind=auth-rejected`.
   */
  authRejectSink?: AuthRejectSink;
  /**
   * Audit sink for `auth_check` records. One record is emitted per
   * envelope — accept OR reject — so operators can audit authentication
   * decisions on the hash chain.
   */
  auditSink?: TenantAuditSink;
  /** Injected clock for audit record timestamps. */
  now?(): number;
}

interface AgentInboxMetrics {
  received: number;
  processed: number;
  failed: number;
  dlq: number;
  tenantRejects: number;
  authAccepted: number;
  authRejected: number;
  responsesMatched: number;
  responsesStale: number;
  lastMessageAt: number | null;
}

/**
 * Produces an `EventSourceAdapter<AgentInboxConfig>`. Registered via the
 * two-step `adapterExtension` + `sourceInstanceExtension` flow.
 */
export function createAgentInboxAdapter(
  opts: CreateAgentInboxAdapterOptions,
): EventSourceAdapter<AgentInboxConfig> {
  return {
    type: 'agent-inbox',
    agentCompat: '>=0.0.1',
    validateConfig(config: unknown): asserts config is AgentInboxConfig {
      if (!config || typeof config !== 'object') {
        throw new Error('agent-inbox: config must be an object');
      }
      const c = config as Partial<AgentInboxConfig>;
      if (typeof c.id !== 'string' || c.id.length === 0) {
        throw new Error('agent-inbox: config.id is required');
      }
      if (typeof c.agentId !== 'string' || c.agentId.length === 0) {
        throw new Error('agent-inbox: config.agentId is required');
      }
    },
    async create(config: AgentInboxConfig, deps: SourceDependencies): Promise<EventSourceInstance> {
      return new AgentInboxInstance(config, deps, opts);
    },
  };
}

class AgentInboxInstance implements EventSourceInstance {
  readonly id: string;
  readonly type = 'agent-inbox';
  private readonly config: AgentInboxConfig;
  private readonly deps: SourceDependencies;
  private readonly opts: CreateAgentInboxAdapterOptions;
  private readonly metrics_: AgentInboxMetrics = {
    received: 0,
    processed: 0,
    failed: 0,
    dlq: 0,
    tenantRejects: 0,
    authAccepted: 0,
    authRejected: 0,
    responsesMatched: 0,
    responsesStale: 0,
    lastMessageAt: null,
  };
  private detachers: Array<() => void> = [];
  private state: SourceHealth['status'] = 'starting';
  private startedAt: number | null = null;

  constructor(
    config: AgentInboxConfig,
    deps: SourceDependencies,
    opts: CreateAgentInboxAdapterOptions,
  ) {
    this.id = config.id;
    this.config = config;
    this.deps = deps;
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.state = 'starting';
    const requestsTopic = this.config.requestsTopic ?? `agents.${this.config.agentId}.requests`;
    const responsesTopic = this.config.responsesTopic ?? `agents.${this.config.agentId}.responses`;
    const eventsTopic = this.config.eventsTopic;

    this.detachers.push(
      this.opts.transport.subscribe(requestsTopic, this.makeHandler(requestsTopic)),
    );
    this.detachers.push(
      this.opts.transport.subscribe(responsesTopic, this.makeHandler(responsesTopic)),
    );
    if (eventsTopic) {
      this.detachers.push(
        this.opts.transport.subscribe(eventsTopic, this.makeHandler(eventsTopic)),
      );
    }
    this.state = 'healthy';
    this.startedAt = Date.now();
  }

  async stop(): Promise<void> {
    for (const detach of this.detachers.splice(0)) detach();
    this.state = 'stopped';
  }

  async pause(): Promise<void> {
    // No fine-grained pause; we just detach subscriptions.
    for (const detach of this.detachers.splice(0)) detach();
    this.state = 'degraded';
  }

  async resume(): Promise<void> {
    await this.start();
  }

  async health(): Promise<SourceHealth> {
    const out: SourceHealth = { status: this.state };
    if (this.startedAt !== null) out.lastConnectedAt = this.startedAt;
    if (this.metrics_.lastMessageAt !== null) out.lastMessageAt = this.metrics_.lastMessageAt;
    return out;
  }

  metrics(): SourceMetrics {
    return {
      eventsPublished: this.metrics_.processed,
      lastEventAt: this.metrics_.lastMessageAt,
      messagesReceived: this.metrics_.received,
      messagesProcessed: this.metrics_.processed,
      messagesFailed: this.metrics_.failed,
      messagesDLQ: this.metrics_.dlq,
    };
  }

  private makeHandler(topic: string): RpcSubscriptionHandler {
    return async (envelope) => {
      await this.handleEnvelope(topic, envelope);
    };
  }

  private async handleEnvelope(topic: string, envelope: AgentRpcEnvelope): Promise<void> {
    this.metrics_.received += 1;
    this.metrics_.lastMessageAt = Date.now();

    // Tenant scope check. `envelope.tenantId` absent → default tenant;
    // adapters bound to a non-default tenant require a match.
    if (this.deps.tenant && envelope.tenantId && envelope.tenantId !== this.deps.tenant.id) {
      this.metrics_.tenantRejects += 1;
      this.deps.logger.warn('agent-inbox.tenant-mismatch', {
        id: this.id,
        envelopeTenant: envelope.tenantId,
        boundTenant: this.deps.tenant.id,
        messageId: envelope.messageId,
      });
      return;
    }

    // Auth verify (Item #4). Only runs for peers the registry knows about;
    // peers without a registered provider fall back to the legacy path.
    if (this.opts.authRegistry) {
      const authOk = await this.verifyAuth(envelope);
      if (!authOk) return;
    } else {
      await this.emitAuthCheck(envelope, 'accept', envelope.auth?.kind ?? 'none');
    }

    try {
      switch (envelope.kind) {
        case 'request':
          await this.handleRequest(envelope);
          break;
        case 'response':
          this.handleResponse(envelope);
          break;
        case 'event':
          await this.handleEventKind(envelope);
          break;
      }
      this.metrics_.processed += 1;
    } catch (err) {
      this.metrics_.failed += 1;
      this.deps.logger.error('agent-inbox.handler-error', {
        id: this.id,
        topic,
        messageId: envelope.messageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Returns `true` when the envelope passes auth verify (including the
   * no-registry-entry fallback), `false` when rejected. Rejected
   * envelopes are dispatched to the reject sink + increment the
   * authRejected metric.
   */
  private async verifyAuth(envelope: AgentRpcEnvelope): Promise<boolean> {
    const registry = this.opts.authRegistry;
    if (!registry) {
      await this.emitAuthCheck(envelope, 'accept', envelope.auth?.kind ?? 'none');
      return true;
    }
    const entry = registry.resolve(envelope.from);
    if (!entry) {
      if (this.opts.strictAuth) {
        // Fail closed: an unregistered sender cannot be verified, so reject
        // rather than accept. Closes the `from: agent://not-in-registry` spoof.
        this.metrics_.authRejected += 1;
        this.deps.logger.warn('agent-inbox.auth-rejected', {
          id: this.id,
          from: envelope.from,
          reason: 'unknown-peer',
          messageId: envelope.messageId,
        });
        await this.emitAuthCheck(envelope, 'reject', 'none', undefined, 'unknown-peer');
        if (this.opts.authRejectSink) {
          try {
            await this.opts.authRejectSink({
              envelope,
              reason: 'unknown-peer',
              message: `sender ${envelope.from} is not in the auth registry (strict mode)`,
            });
          } catch (err) {
            this.deps.logger.error('agent-inbox.auth-reject-sink-error', {
              id: this.id,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return false;
      }
      // Non-strict (legacy): fall through to the legacy path. We still emit an
      // accept audit record so ops can see which peers bypass verification.
      await this.emitAuthCheck(envelope, 'accept', envelope.auth?.kind ?? 'none');
      return true;
    }
    const { config, provider } = entry;
    try {
      const result = await provider.verify(
        envelope,
        // The provider contract is parameterised on its own peer config
        // shape; at the registry boundary we just hand the discriminated
        // union through. Each provider's verify narrows by `provider.name`.
        config as unknown as Parameters<typeof provider.verify>[1],
      );
      if (result.ok) {
        this.metrics_.authAccepted += 1;
        await this.emitAuthCheck(envelope, 'accept', provider.name, result.principal.subject);
        return true;
      }
      this.metrics_.authRejected += 1;
      this.deps.logger.warn('agent-inbox.auth-rejected', {
        id: this.id,
        from: envelope.from,
        provider: provider.name,
        reason: result.reason,
        messageId: envelope.messageId,
      });
      await this.emitAuthCheck(envelope, 'reject', provider.name, undefined, result.reason);
      if (this.opts.authRejectSink) {
        try {
          await this.opts.authRejectSink({
            envelope,
            reason: result.reason,
            message: result.message,
          });
        } catch (err) {
          this.deps.logger.error('agent-inbox.auth-reject-sink-error', {
            id: this.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return false;
    } catch (err) {
      this.metrics_.authRejected += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error('agent-inbox.auth-verify-error', {
        id: this.id,
        from: envelope.from,
        provider: provider.name,
        err: message,
        messageId: envelope.messageId,
      });
      await this.emitAuthCheck(envelope, 'reject', provider.name, undefined, 'idp-unreachable');
      if (this.opts.authRejectSink) {
        try {
          await this.opts.authRejectSink({
            envelope,
            reason: 'idp-unreachable',
            message,
          });
        } catch {
          // already logged
        }
      }
      return false;
    }
  }

  private async emitAuthCheck(
    envelope: AgentRpcEnvelope,
    decision: 'accept' | 'reject',
    provider: AuthCheckAuditRecord['provider'],
    subject?: string,
    reason?: string,
  ): Promise<void> {
    if (!this.opts.auditSink) return;
    const now = this.opts.now ?? Date.now;
    const record: AuthCheckAuditRecord = {
      kind: 'auth_check',
      ts: now(),
      tenantId: envelope.tenantId ?? this.deps.tenant?.id ?? 'default',
      peerId: envelope.from,
      provider,
      decision,
      correlationId: envelope.correlationId,
    };
    if (reason !== undefined) record.reason = reason;
    if (subject !== undefined && subject.length > 0) record.subject = subject;
    try {
      await this.opts.auditSink.record(record);
    } catch (err) {
      this.deps.logger.error('agent-inbox.audit-sink-error', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleRequest(envelope: AgentRpcEnvelope): Promise<void> {
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      kind: 'mailbox.message',
      source: { type: 'mailbox', fromAgent: envelope.from },
      target: { type: 'skill', name: envelope.capability, inputs: { payload: envelope.payload } },
      timestamp: Date.now(),
      payload: envelope.payload,
      auth: { kind: 'internal' },
      meta: {
        correlationId: envelope.correlationId,
        ...(envelope.causedBy !== undefined && { causedBy: envelope.causedBy }),
        ...(envelope.tenantId !== undefined && { tenantId: envelope.tenantId }),
      },
    };

    if (this.opts.onRequest) {
      await this.opts.onRequest(envelope, event);
      return;
    }

    await this.deps.bus.publish(event);
  }

  private handleResponse(envelope: AgentRpcEnvelope): void {
    if (!this.opts.pending) {
      this.deps.logger.warn('agent-inbox.response.no-registry', {
        id: this.id,
        correlationId: envelope.correlationId,
      });
      return;
    }

    const payload = envelope.payload as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string; details?: unknown } }
      | undefined;

    if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
      this.metrics_.responsesStale += 1;
      this.deps.logger.warn('agent-inbox.response.malformed', {
        id: this.id,
        correlationId: envelope.correlationId,
      });
      return;
    }

    const settled = this.opts.pending.settle(
      envelope.correlationId,
      payload.ok ? { status: 'ok', data: payload.data } : { status: 'error', error: payload.error },
    );

    if (settled) this.metrics_.responsesMatched += 1;
    else this.metrics_.responsesStale += 1;
  }

  private async handleEventKind(envelope: AgentRpcEnvelope): Promise<void> {
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      kind: 'mailbox.message',
      source: { type: 'mailbox', fromAgent: envelope.from },
      target: { type: 'broadcast' },
      timestamp: Date.now(),
      payload: envelope.payload,
      auth: { kind: 'internal' },
      meta: {
        correlationId: envelope.correlationId,
        ...(envelope.tenantId !== undefined && { tenantId: envelope.tenantId }),
      },
    };

    if (this.opts.onEvent) {
      await this.opts.onEvent(envelope, event);
      return;
    }
    await this.deps.bus.publish(event);
  }
}

/**
 * Decode a raw wire message into an envelope, returning `undefined` on
 * invalid input. Convenience for transports that hand us bytes; the
 * in-memory transport bypasses this.
 */
export function decodeFromWire(raw: string | Uint8Array): AgentRpcEnvelope | undefined {
  try {
    return decodeEnvelope(raw);
  } catch {
    return undefined;
  }
}
