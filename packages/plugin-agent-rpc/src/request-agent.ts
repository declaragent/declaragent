/**
 * `RequestAgent` — the producer-side RPC tool. Given a peer registry +
 * an `RpcTransport`, build an envelope, publish it to the peer's
 * requests topic, and (in sync mode) `await` a matching response via
 * the pending-RPC registry.
 *
 * @since 1.1.0
 */

import {
  type AgentAddress,
  type AgentRpcEnvelope,
  type BrokerAddress,
  type LoadedPeers,
  RpcAbandonedError,
  RpcBusyError,
  type RpcError,
  RpcNoPeerError,
  RpcNoTransportError,
  RpcTimeoutError,
  type RpcTransport,
  type RpcTransportKind,
  type Tool,
  resolvePeerTransport,
} from '@declaragent/core';
import type { PendingRegistry } from './pending-registry.js';

export type RequestAgentMode = 'sync' | 'async' | 'fire-and-forget';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface RequestAgentInput {
  to: AgentAddress;
  capability: string;
  payload: unknown;
  /** Default 30s. Clamped to [1, 600_000]. */
  timeoutMs?: number;
  /** Default 'sync'. */
  mode?: RequestAgentMode;
  /** Caller-supplied key; defaults to a fresh UUID. */
  idempotencyKey?: string;
  /**
   * Override the resolved transport/broker address. Rare — for A/B
   * migrations or testing.
   */
  transport?: BrokerAddress;
}

export interface RequestAgentOutput {
  status: 'ok' | 'error' | 'timeout' | 'abandoned' | 'busy';
  correlationId: string;
  latencyMs: number;
  response?: unknown;
  error?: RpcError;
}

export interface CreateRequestAgentToolOptions {
  /** Local agent-id. Stamped on every envelope's `from`. */
  selfAgent: AgentAddress;
  /** Resolved peer table. */
  peers: LoadedPeers;
  /** Transport factory. Keyed by transport kind so multi-transport deployments work. */
  transports: ReadonlyMap<RpcTransportKind, RpcTransport>;
  /** Producer-side pending-RPC registry. */
  pending: PendingRegistry;
  /**
   * Sync-mode reply topic the `agent-inbox` source is subscribed to.
   * Stamped as `envelope.replyTo`. Omit for fire-and-forget-only deployments.
   */
  replyTo?: BrokerAddress;
  /**
   * Opt-in `x-fleet-version` header stamped on every outbound envelope
   * (FLEET_PLAN.md §14.8). When supplied, receivers can compare against
   * their own version and reject old callers via `minFleetVersion`.
   * Omit to leave envelopes unstamped (the default). @since 1.2.0
   */
  fleetVersion?: string;
  /** Clock. Default `Date.now`. */
  now?: () => number;
  /** UUID generator. Default `crypto.randomUUID`. */
  randomUUID?: () => string;
}

export function createRequestAgentTool(
  opts: CreateRequestAgentToolOptions,
): Tool<RequestAgentInput, RequestAgentOutput> {
  const now = opts.now ?? Date.now;
  const randomUUID = opts.randomUUID ?? (() => crypto.randomUUID());

  return {
    name: 'RequestAgent',
    description:
      'Call a capability on another agent over the agent-rpc bus. ' +
      "Returns the peer's response (sync, default), or an opaque correlation id (async / fire-and-forget). " +
      'Permission key: `RequestAgent:<to>/<capability>`.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target agent address, e.g. `agent://pr-reviewer`.',
          pattern: '^agent://.+',
        },
        capability: { type: 'string', description: 'Capability name on the peer.' },
        payload: { description: 'Capability-specific JSON payload.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
        mode: { enum: ['sync', 'async', 'fire-and-forget'] },
        idempotencyKey: { type: 'string' },
        transport: { type: 'string' },
      },
      required: ['to', 'capability', 'payload'],
    },
    permissionKey: (input) => `${input.to}/${input.capability}`,
    async *execute(input, ctx) {
      const mode: RequestAgentMode = input.mode ?? 'sync';
      const timeoutMs = clamp(input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 1, 600_000);
      const started = now();
      const correlationId = ctx.correlationId ?? randomUUID();
      const messageId = randomUUID();

      const resolution = resolveTarget(input, opts.peers);
      if (!resolution) {
        yield {
          type: 'error',
          error: {
            code: 'EAGENTRPC_NO_PEER',
            message: `no peer registered for ${input.to}`,
          },
        };
        return;
      }

      const transport = opts.transports.get(resolution.kind);
      if (!transport) {
        yield {
          type: 'error',
          error: {
            code: 'EAGENTRPC_NO_TRANSPORT',
            message: `no transport registered for kind "${resolution.kind}"`,
          },
        };
        return;
      }

      const envelope: AgentRpcEnvelope = {
        version: 1,
        kind: mode === 'fire-and-forget' ? 'event' : 'request',
        messageId,
        correlationId,
        from: opts.selfAgent,
        to: input.to,
        capability: input.capability,
        payload: input.payload,
        ...(ctx.correlationId !== undefined &&
          ctx.correlationId !== correlationId && { causedBy: ctx.correlationId }),
        ...(mode !== 'fire-and-forget' && opts.replyTo !== undefined && { replyTo: opts.replyTo }),
        ...(timeoutMs !== undefined && { deadline: started + timeoutMs }),
        ...(ctx.tenant?.id !== undefined && { tenantId: ctx.tenant.id }),
        // Opt-in `x-fleet-version` header (FLEET_PLAN.md §14.8).
        ...(opts.fleetVersion !== undefined && {
          headers: { 'x-fleet-version': opts.fleetVersion },
        }),
        auth: { kind: 'internal' },
      };

      // ── fire-and-forget ─────────────────────────────────────────────
      if (mode === 'fire-and-forget') {
        try {
          await transport.publish(brokerAddressToTopic(resolution.address), envelope);
        } catch (err) {
          yield errorEvent(err);
          return;
        }
        yield {
          type: 'result',
          output: {
            status: 'ok',
            correlationId,
            latencyMs: now() - started,
          },
        };
        return;
      }

      // ── async ────────────────────────────────────────────────────────
      if (mode === 'async') {
        try {
          await transport.publish(brokerAddressToTopic(resolution.address), envelope);
        } catch (err) {
          yield errorEvent(err);
          return;
        }
        yield {
          type: 'result',
          output: {
            status: 'ok',
            correlationId,
            latencyMs: now() - started,
          },
        };
        return;
      }

      // ── sync ────────────────────────────────────────────────────────
      let pendingPromise: Promise<
        { status: 'ok'; data: unknown } | { status: 'error'; error: RpcError }
      >;
      try {
        pendingPromise = opts.pending.register({
          correlationId,
          deadlineMs: started + timeoutMs,
        });
      } catch (err) {
        if (err instanceof RpcBusyError) {
          yield {
            type: 'result',
            output: {
              status: 'busy',
              correlationId,
              latencyMs: now() - started,
              error: {
                code: err.code,
                message: err.message,
              },
            },
          };
          return;
        }
        yield errorEvent(err);
        return;
      }

      try {
        await transport.publish(brokerAddressToTopic(resolution.address), envelope);
      } catch (err) {
        opts.pending.settle(correlationId, {
          status: 'error',
          error: {
            code: 'EAGENTRPC_PUBLISH_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        });
        yield errorEvent(err);
        return;
      }

      try {
        const settled = await pendingPromise;
        const latencyMs = now() - started;
        if (settled.status === 'ok') {
          yield {
            type: 'result',
            output: { status: 'ok', correlationId, latencyMs, response: settled.data },
          };
        } else {
          yield {
            type: 'result',
            output: {
              status: 'error',
              correlationId,
              latencyMs,
              error: settled.error,
            },
          };
        }
      } catch (err) {
        const latencyMs = now() - started;
        if (err instanceof RpcTimeoutError) {
          yield {
            type: 'result',
            output: {
              status: 'timeout',
              correlationId,
              latencyMs,
              error: { code: err.code, message: err.message },
            },
          };
          return;
        }
        if (err instanceof RpcAbandonedError) {
          yield {
            type: 'result',
            output: {
              status: 'abandoned',
              correlationId,
              latencyMs,
              error: { code: err.code, message: err.message },
            },
          };
          return;
        }
        yield errorEvent(err);
      }
    },
  };
}

interface ResolvedTarget {
  kind: RpcTransportKind;
  address: BrokerAddress;
}

/**
 * Strip the transport scheme from a `BrokerAddress` (e.g.
 * `kafka://orders.in` → `orders.in`). Transport implementations take a
 * bare topic/subject/queue; the scheme is only meaningful at the config
 * layer to pick which transport to use.
 */
export function brokerAddressToTopic(addr: BrokerAddress): string {
  const idx = addr.indexOf('://');
  return idx === -1 ? addr : addr.slice(idx + 3);
}

function resolveTarget(input: RequestAgentInput, peers: LoadedPeers): ResolvedTarget | undefined {
  if (input.transport) {
    const kind = brokerKind(input.transport);
    if (!kind) return undefined;
    return { kind, address: input.transport };
  }
  const entry = resolvePeerTransport(peers, input.to);
  if (!entry) return undefined;
  return { kind: entry.transport.kind, address: entry.address };
}

function brokerKind(addr: BrokerAddress): RpcTransportKind | undefined {
  const scheme = addr.split('://')[0] as RpcTransportKind | undefined;
  if (!scheme) return undefined;
  const known: readonly RpcTransportKind[] = ['kafka', 'nats', 'sqs', 'amqp', 'mqtt', 'memory'];
  return known.includes(scheme) ? scheme : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function errorEvent(err: unknown): {
  type: 'error';
  error: { message: string; code?: string; cause?: unknown };
} {
  if (err instanceof RpcNoPeerError || err instanceof RpcNoTransportError) {
    return { type: 'error', error: { code: err.code, message: err.message, cause: err } };
  }
  return {
    type: 'error',
    error: {
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    },
  };
}
