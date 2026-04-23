/**
 * Fleet-run LLM handler factory — plugs a real engine turn in where
 * `defaultHandler` previously echoed.
 *
 * This closes Phase A.2 of USABILITY_PLAN.md:
 * `declaragent fleet run` now actually invokes each agent's skills
 * on incoming RPC requests. The stub that shipped with slice-3 of
 * the fleet work is preserved in `fleet-run.ts` as a named export
 * for tests that need a deterministic echo.
 *
 * For each scaffolded agent the factory:
 *   1. Calls {@link loadAgent} to parse `agent.yaml` + walk `skills/`.
 *   2. Builds a per-agent extension registry and registers each
 *      skill — so `runSkill(name, …)` can resolve by lookup name
 *      without cross-agent bleed.
 *   3. Constructs a {@link createEngine} instance bound to the shared
 *      provider + built-in tools.
 *   4. Returns a handler that, on each RPC request, calls
 *      {@link runSkill} with `capability` as the skill name and the
 *      request envelope's payload as the input dictionary.
 *
 * Non-goals for this PR:
 *   - No per-agent model override via `agent.yaml`'s `tools` list;
 *     every agent gets the shared BUILTIN_TOOLS. Filter-down by
 *     declared tool names is a refinement.
 *   - No audit-sink wiring. The fleet daemon doesn't emit `tool_call`
 *     records yet; audit correlation lands with a future slice.
 *   - No streaming responses. `runSkill` returns once the turn ends,
 *     and we send a single `respond({ ok, data })` envelope back.
 *
 * @since 0.3.6
 */

import {
  type AgentSpec,
  type LLMProvider,
  type LoadedAgentEntry,
  type Message,
  RPC_ERROR_CODES,
  type RpcRespondResult,
  SkillNotFoundError,
  type SqliteSessionStore,
  type Tool,
  createEngine,
  createExtensionRegistry,
  createPermissionGate,
  loadAgent,
  runSkill,
  skillExtension,
} from '@declaragent/core';
import { createPendingRegistry, createRequestAgentTool } from '@declaragent/plugin-agent-rpc';
import type {
  FleetAgentHandler,
  FleetAgentRequestContext,
  FleetAgentRpcContext,
} from './fleet-run.js';

export interface CreateLLMHandlerFactoryOptions {
  /** Shared LLM provider. One per daemon process. */
  provider: LLMProvider;
  /** Session store — sessions for every agent land here. */
  sessionStore: SqliteSessionStore;
  /**
   * Fallback model when the agent's `agent.yaml` doesn't declare
   * one. Usually the user's preferred default (provider preset or
   * `--model` flag).
   */
  defaultModel: string;
}

/**
 * Build the `makeHandler` factory `startFleetDaemon` consumes.
 *
 * Returns an async function because each agent requires a disk read
 * (`loadAgent`) to resolve its spec + skills — the synchronous path
 * would have to load everything upfront and keep the union-typed
 * entry around, which hurts readability without buying anything.
 */
export function createLLMHandlerFactory(
  options: CreateLLMHandlerFactoryOptions,
): (agent: LoadedAgentEntry, rpcContext: FleetAgentRpcContext) => Promise<FleetAgentHandler> {
  return async (agent, rpcContext) => {
    const loaded = await loadAgent({ agentDir: agent.path });
    const spec: AgentSpec = {
      ...loaded.spec,
      model: loaded.spec.model || options.defaultModel,
    };

    // Extension registry scoped to THIS agent. Skills registered
    // here aren't visible to any sibling agent's handler — the
    // fleet-run model is "one agent per capability namespace."
    const registry = createExtensionRegistry({
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this as never;
        },
      },
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      configDir: '',
    });
    for (const skill of loaded.skills) {
      await registry.register(skillExtension(skill));
    }

    // Engine per agent so `createChildSession` closes over the
    // right spec. One provider is shared; one session store is
    // shared; only the spec identity differs.
    const { buildRuntimeTools } = await import('./builtin-tools.js');
    const extraTools: Tool[] = [];
    // When `rpc-peers.yaml` was supplied at daemon-boot, every agent
    // gets a `RequestAgent` tool that can call its declared peers.
    // The tool uses the shared transport map + a fresh pending-registry
    // per handler (correlation IDs don't cross agents).
    //
    // 0.5.3 fix: subscribe to this agent's own responses topic and
    // plumb a `replyTo` so `mode: sync` RPCs can correlate their
    // response envelopes. Without this, responses had nowhere to go
    // and every sync RequestAgent call timed out — the scaffold
    // pattern that didn't use an `agent-inbox` source never worked.
    if (rpcContext.peers !== undefined) {
      const memoryTransport = rpcContext.transports.get('memory');
      if (memoryTransport !== undefined) {
        const agentId = rpcContext.selfAddress.replace(/^agent:\/\//, '');
        const responsesTopic = `agents.${agentId}.responses`;
        const replyTo = `memory://${responsesTopic}` as const;
        const pending = createPendingRegistry();
        // Subscribe so responses settle the pending registry. This
        // subscription lives for the handler's lifetime; transport.close()
        // at daemon shutdown tears it down.
        memoryTransport.subscribe(responsesTopic, async (envelope) => {
          if (envelope.kind !== 'response') return;
          const payload = envelope.payload as
            | { ok: true; data: unknown }
            | { ok: false; error: { code: string; message: string } };
          pending.settle(
            envelope.correlationId,
            payload.ok
              ? { status: 'ok', data: payload.data }
              : { status: 'error', error: payload.error },
          );
        });
        // #11 typed-capability validation (Enterprise Production Plan §3).
        // When the fleet-run boot wired `peerCapabilities` + `validators`,
        // thread them straight through — the tool uses them to reject
        // outbound requests + inbound responses that violate the
        // peer's declared `inputSchema` / `outputSchema`. Legacy fleets
        // (no schemas declared) see zero change: the tool's internal
        // guard short-circuits when `validators === undefined`.
        extraTools.push(
          createRequestAgentTool({
            selfAgent: rpcContext.selfAddress,
            peers: rpcContext.peers,
            transports: rpcContext.transports,
            pending,
            replyTo,
            ...(rpcContext.peerCapabilities !== undefined && {
              peerCapabilities: rpcContext.peerCapabilities,
            }),
            ...(rpcContext.validators !== undefined && {
              validators: rpcContext.validators,
            }),
            ...(rpcContext.onSchemaViolation !== undefined && {
              onSchemaViolation: rpcContext.onSchemaViolation,
            }),
          }) as Tool,
        );
      }
    }
    const engine = createEngine({
      provider: options.provider,
      tools: [...buildRuntimeTools(extraTools.length > 0 ? { extra: extraTools } : {})],
      // Bypass permissions in fleet-run — there's no human to prompt,
      // and the scaffolded agent has already declared its tool set.
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      createChildSession: () => options.sessionStore.create(spec),
    });

    return async (ctx: FleetAgentRequestContext) => {
      const respond = (result: RpcRespondResult): Promise<void> => ctx.respond(result);
      try {
        const result = await runSkill(ctx.capability, {
          registry,
          runAgent: engine.runAgent,
          createChildSession: () => options.sessionStore.create(spec),
          // Correlate every turn with the RPC envelope so audit
          // records link back to the inbound capability call. The
          // session id is synthesised per request — fleet-run is
          // stateless between RPCs, so there's no long-lived session
          // to reuse here.
          turn: {
            sessionId: `fleet:${ctx.agentId}:${ctx.envelope.correlationId}`,
            turnId: ctx.envelope.messageId,
            depth: 0,
            causedBy: `rpc:${ctx.envelope.from}`,
          },
          inputs: normaliseInputs(ctx.envelope.payload),
        });
        await respond({
          ok: true,
          data: {
            text: extractText(result.lastAssistantMessage),
            stopReason: result.stopReason,
            ...(result.usage !== undefined && { usage: result.usage }),
          },
        });
      } catch (err) {
        await respond({
          ok: false,
          error: mapToRpcError(err),
        });
      }
    };
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Shape the envelope payload for `runSkill`'s `inputs`. When the
 * payload is already an object, pass it through (skill templates
 * reference named variables). When it's a scalar, wrap it in
 * `{ payload: … }` so the skill author can still reference it
 * via `{{payload}}`.
 */
function normaliseInputs(payload: unknown): Record<string, unknown> {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { payload };
}

function extractText(message: Message | undefined): string {
  if (!message) return '';
  return message.content
    .filter((c): c is Extract<Message['content'][number], { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function mapToRpcError(err: unknown): { code: string; message: string } {
  if (err instanceof SkillNotFoundError) {
    // EAGENTRPC_NO_CAPABILITY is the right shape: the caller asked for
    // a capability that the receiver doesn't implement (no matching
    // skill in the agent's on-disk `skills/`). `HANDLER_ERROR` would
    // mask this as a generic runtime failure.
    return {
      code: RPC_ERROR_CODES.NO_CAPABILITY,
      message: err.message,
    };
  }
  return {
    code: 'AGENT_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
}
