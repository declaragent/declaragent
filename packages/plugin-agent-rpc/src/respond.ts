/**
 * Build the `ctx.respond` hook for a skill that was triggered by an
 * agent-rpc request. The engine (or the `agent-inbox` source) wires this
 * onto the `ToolContext` of the triggered turn so skills can reply.
 *
 * @since 1.1.0
 */

import type {
  AgentAddress,
  AgentRpcEnvelope,
  RpcRespondResult,
  RpcTransport,
} from '@declaragent/core';
import { brokerAddressToTopic } from './request-agent.js';

export interface CreateRespondHookOptions {
  request: AgentRpcEnvelope;
  transport: RpcTransport;
  /** Our own agent address. Stamped as `from` on the response envelope. */
  selfAgent: AgentAddress;
  /** UUID generator. Defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
}

export function createRespondHook(
  opts: CreateRespondHookOptions,
): (result: RpcRespondResult) => Promise<void> {
  const randomUUID = opts.randomUUID ?? (() => crypto.randomUUID());

  return async (result) => {
    if (!opts.request.replyTo) {
      // Nothing to respond to — the caller used `event` or `fire-and-forget`.
      return;
    }

    const envelope: AgentRpcEnvelope = {
      version: 1,
      kind: 'response',
      messageId: randomUUID(),
      correlationId: opts.request.correlationId,
      causedBy: opts.request.messageId,
      from: opts.selfAgent,
      to: opts.request.from,
      capability: opts.request.capability,
      payload: result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error },
      ...(opts.request.tenantId !== undefined && { tenantId: opts.request.tenantId }),
      auth: { kind: 'internal' },
    };

    await opts.transport.publish(brokerAddressToTopic(opts.request.replyTo), envelope);
  };
}
