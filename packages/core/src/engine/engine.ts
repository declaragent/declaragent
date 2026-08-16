import { frameEvent } from '../events/dispatcher.js';
import type { Mailbox } from '../events/mailbox.js';
import { POWER_OF_TWO_BUCKETS } from '../events/observability.js';
import type { AgentEvent, EventBus, MetricsRegistry } from '../events/types.js';
import { bindLoopHooks, createHookRegistry } from '../hooks/registry.js';
import type { HookRegistry } from '../hooks/types.js';
import { shouldEscalate } from '../permission/gate.js';
import { estimateCostUSD } from '../session/pricing.js';
import { QuotaExceededError, type QuotaTracker } from '../tenancy/quota.js';
import { stampTenantId } from '../tenancy/stamp.js';
import type { TenantContext } from '../tenancy/types.js';
import type { ToolRateLimitGate } from '../tools/rate-limit-gate.js';
import type {
  RunAgent,
  RunAgentInput,
  RunAgentResult,
  RunStopReason,
  TurnContext,
} from '../types/agent.js';
import type { LoopHooks } from '../types/hooks.js';
import type { LLMProvider, LLMRequest, LLMToolDefinition } from '../types/llm.js';
import type { Logger } from '../types/logger.js';
import type { Message, MessageContent } from '../types/messages.js';
import type { PermissionDecision, PermissionGate } from '../types/permission.js';
import type { SessionHandle } from '../types/session.js';
import type {
  CompletedToolCall,
  PendingToolCall,
  Tool,
  ToolContext,
  ToolError,
} from '../types/tool.js';

export const DEFAULT_MAX_ITERATIONS = 50;
export const DEFAULT_SUBAGENT_DEPTH_CAP = 2;

export type Prompter = (call: PendingToolCall, decision: PermissionDecision) => Promise<boolean>;

/**
 * Payload of the `assistant.final` bus event. Phase-5 channels consume
 * this via `ChannelOutboundBridge` to post the assistant's reply back to
 * the originating conversation. Kept as a plain struct (not a class) so
 * non-channel subscribers can pattern-match on the shape without importing
 * channel types.
 */
export interface AssistantFinalPayload {
  sessionId: string;
  turnId: string;
  stopReason: RunStopReason;
  /** Engine message content array for the assistant's last turn output. */
  content: Message['content'];
  usage: RunAgentResult['usage'];
  /** Optional correlation id forwarded from `RunAgentInput.causedBy`. */
  causedBy?: string;
}

/**
 * Payload of the `turn.started` bus event. Emitted before the first LLM
 * call of a turn so channel bridges can light up typing indicators
 * without waiting for the assistant's final response. Mirrors the turn
 * context handed to hooks (`turn.start`) but is visible to non-extension
 * subscribers on the bus.
 */
export interface TurnStartedPayload {
  sessionId: string;
  turnId: string;
  /** Sub-agent depth; 0 for a top-level session turn. */
  depth: number;
  /** Optional correlation id forwarded from `RunAgentInput.causedBy`. */
  causedBy?: string;
}

/**
 * Payload of the `assistant.message` bus event. Phase-5 streaming mode
 * consumes this to drive send-then-edit outbound behavior; non-streaming
 * subscribers ignore it.
 *
 * Slice-13 engine emits a single `assistant.message` per turn with
 * `done: true` carrying the full text content (the LLM provider returns
 * a complete response, not incremental deltas). When true streaming
 * lands in a future slice, the engine will emit one event per delta
 * with `done: false` then a final `done: true`. The bridge's streaming
 * logic is written to handle either case.
 */
export interface AssistantMessagePayload {
  sessionId: string;
  turnId: string;
  /** Either the full content (buffered emit) or one delta (future streaming). */
  delta: string;
  /** True on the last emission for this turn. */
  done: boolean;
}

export interface EngineConfig {
  provider: LLMProvider;
  tools: Tool[];
  permissions: PermissionGate;
  /**
   * Phase-1 callback bag. Kept as a back-compat shim — when supplied, its
   * callbacks are auto-registered onto the hook registry. New code should
   * use `hookRegistry` directly.
   */
  hooks?: LoopHooks;
  /**
   * Phase-2 hook registry. If absent, one is created internally so the
   * engine still fires hooks for any extension that subscribes later.
   */
  hookRegistry?: HookRegistry;
  maxIterations?: number;
  logger?: Logger;
  /**
   * Resolves 'prompt' outcomes. If absent, prompts are treated as denials.
   */
  prompter?: Prompter;
  /**
   * Factory for sub-agent sessions. Supplied to the Agent tool via
   * ToolContext.createChildSession. If absent, Agent will error with
   * ENOSESSION.
   */
  createChildSession?: () => SessionHandle;
  /**
   * Optional mailbox. When supplied, the engine drains
   * `mailbox.drainFor(session.spec.name)` at the start of every turn and
   * injects each pending message as a framed user message before the
   * caller's own userMessage. Lets agents exchange messages via the
   * `SendMessage` tool without a live bus in scope.
   */
  mailbox?: Mailbox;
  /**
   * Phase 5. When supplied, the engine publishes one `assistant.final`
   * event per turn so the `ChannelOutboundBridge` (and any other
   * subscriber) can route the assistant's reply back to the originating
   * channel. Absent → emit is skipped; the engine stays bus-free.
   */
  bus?: EventBus;
  /**
   * Phase 6. When supplied alongside `bus`, every engine-emitted event
   * (`turn.started`, `assistant.message`, `assistant.final`) is stamped
   * with `meta.tenantId = tenant.id`. Absent → the default tenant;
   * Phase-1-through-5 callers are unaffected.
   */
  tenant?: TenantContext;
  /**
   * Phase 7 slice 0.2. Per-tenant quota tracker. When supplied, every
   * tool call in the engine loop acquires a slot on
   * `maxConcurrentToolCalls` before running and releases it afterwards.
   * A breach produces a tool result with code `EQUOTA` and continues the
   * loop — the permission gate's escalation policy is unchanged.
   */
  quotas?: QuotaTracker;
  /**
   * Enterprise Production Plan §3 Item #7. Per-tool token-bucket gate.
   * When supplied, each tool's `.execute()` is preceded by
   * `toolRateLimit.acquire(tool.name, ctx)` — capped tools sleep until a
   * token frees; uncapped tools pass through with zero overhead. Audit
   * emission is the gate's responsibility; the engine only supplies the
   * tenant + session + correlation context.
   */
  toolRateLimit?: ToolRateLimitGate;
  /**
   * Item A step 3 — agent-durability observability. When supplied, the
   * engine records, once per turn:
   * - histogram `declaragent.engine.turn.iterations` — the number of LLM
   *   iterations (steps) a turn took, proving agents run a real multi-step
   *   tool-use loop within a turn, not a single prompt;
   * - counter `declaragent.engine.turn.max_iterations_hit_total` —
   *   incremented when a turn exhausts the `maxIterations` cap, so
   *   operators can spot agents that need a higher cap.
   * Both carry low-cardinality labels (`agent`, `depth`). Absent → zero
   * overhead; all emission is guarded by `if (metrics)`.
   */
  metrics?: MetricsRegistry;
}

export interface Engine {
  runAgent: RunAgent;
}

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function toolToLLMDef(tool: Tool): LLMToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function errorToolResult(id: string, message: string, code?: string): MessageContent {
  const prefix = code ? `[${code}] ` : '';
  return {
    type: 'tool_result',
    toolUseId: id,
    content: `${prefix}${message}`,
    isError: true,
  };
}

function isToolUse(c: MessageContent): c is Extract<MessageContent, { type: 'tool_use' }> {
  return c.type === 'tool_use';
}

async function drainToolEvents<I, O>(
  tool: Tool<I, O>,
  input: I,
  ctx: ToolContext,
  logger: Logger,
): Promise<{ output?: O; error?: ToolError }> {
  let output: O | undefined;
  let error: ToolError | undefined;
  for await (const event of tool.execute(input, ctx)) {
    if (event.type === 'progress') {
      logger.debug('tool.progress', {
        toolName: tool.name,
        message: event.message,
      });
    } else if (event.type === 'result') {
      output = event.output;
    } else if (event.type === 'error') {
      error = event.error;
    }
  }
  const out: { output?: O; error?: ToolError } = {};
  if (output !== undefined) out.output = output;
  if (error !== undefined) out.error = error;
  return out;
}

export function createEngine(config: EngineConfig): Engine {
  const {
    provider,
    tools,
    permissions,
    hooks,
    prompter,
    createChildSession,
    mailbox,
    bus,
    tenant,
    quotas,
    toolRateLimit,
    metrics,
    logger = NOOP_LOGGER,
  } = config;
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const toolDefs = tools.map(toolToLLMDef);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const hookRegistry = config.hookRegistry ?? createHookRegistry({ logger });
  if (hooks) bindLoopHooks(hookRegistry, hooks);

  // Item A step 3 — register the per-turn iterations histogram once at
  // engine construction. Registration in PrometheusRegistry is idempotent,
  // but doing it here means the series exists (with help text) from the
  // first scrape: every turn records an observation, so the histogram is
  // always meaningful.
  //
  // The `max_iterations_hit_total` counter is registered lazily (only when
  // a turn actually exhausts the cap) so an operator scraping `/metrics`
  // never sees a zero-valued "cap hit" series that implies a problem that
  // hasn't occurred. `metrics.counter(...)` is idempotent, so creating it
  // at hit time is safe and cheap.
  const turnIterationsHistogram = metrics?.histogram(
    'declaragent.engine.turn.iterations',
    'LLM iterations (tool-use steps) used per turn',
  );

  const runAgent: RunAgent = async (input: RunAgentInput): Promise<RunAgentResult> => {
    const { session, userMessage } = input;
    const depth = input.depth ?? 0;
    const depthCap = session.spec.subagentDepthCap ?? DEFAULT_SUBAGENT_DEPTH_CAP;
    // Precedence: per-agent spec override > EngineConfig fallback > default.
    const effectiveMaxIterations = session.spec.maxIterations ?? maxIterations;

    if (depth > depthCap) {
      return {
        stopReason: 'error',
        usage: { inputTokens: 0, outputTokens: 0 },
        error: new Error(`Sub-agent depth cap exceeded (depth=${depth}, cap=${depthCap})`),
      };
    }

    const turnId = crypto.randomUUID();
    const turnCtx: TurnContext = {
      sessionId: session.id,
      turnId,
      depth,
      ...(input.causedBy !== undefined && { causedBy: input.causedBy }),
    };
    const turnLogger = logger.child({ turnId, sessionId: session.id, depth });

    const signal = input.abortSignal ?? new AbortController().signal;

    await hookRegistry.fire('turn.start', { turn: turnCtx });
    turnLogger.info('turn.start', { model: session.spec.model });

    if (bus) {
      const startedPayload: TurnStartedPayload = {
        sessionId: session.id,
        turnId,
        depth,
        ...(input.causedBy !== undefined && { causedBy: input.causedBy }),
      };
      const startedEvent: AgentEvent<TurnStartedPayload> = {
        id: crypto.randomUUID(),
        kind: 'turn.started',
        source: { type: 'engine', sessionId: session.id, turnId },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: startedPayload,
        auth: { kind: 'internal' },
        ...(input.causedBy !== undefined && {
          meta: { correlationId: input.causedBy, causedBy: input.causedBy },
        }),
      };
      try {
        await bus.publish(stampTenantId(startedEvent, tenant));
      } catch (err) {
        turnLogger.warn('turn.started.publish.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (mailbox) {
      try {
        const drained = await mailbox.drainFor(session.spec.name);
        for (const event of drained) {
          await session.appendMessage({
            role: 'user',
            content: [{ type: 'text', text: frameEvent(event) }],
          });
        }
      } catch (err) {
        turnLogger.warn('mailbox.drain.error', {
          agent: session.spec.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastAssistantMessage: Message | undefined;
    let stopReason: RunStopReason | null = null;
    let runError: Error | undefined;
    // Item A step 3 — count the LLM calls (steps) this turn made. At cap
    // exhaustion this equals `effectiveMaxIterations`; on an early
    // end_turn/error/abort break it equals the iteration that broke.
    let iterationsUsed = 0;

    try {
      for (let iter = 0; iter < effectiveMaxIterations; iter += 1) {
        if (signal.aborted) {
          stopReason = 'aborted';
          break;
        }

        iterationsUsed += 1;

        const request: LLMRequest = {
          model: session.spec.model,
          system: session.spec.systemPrompt,
          messages: [...session.transcript],
          tools: toolDefs,
          ...(session.spec.temperature !== undefined && {
            temperature: session.spec.temperature,
          }),
          ...(session.spec.maxTokens !== undefined && {
            maxTokens: session.spec.maxTokens,
          }),
        };

        turnLogger.debug('llm.request', { iteration: iter });
        // WS7 — LLM golden signals. Time the provider call, count requests /
        // errors, and record token + estimated-cost counters so an operator can
        // alert on provider latency, an outage (errors_total climbing), and
        // spend. Labelled by agent + model. All guarded by `if (metrics)`.
        const llmLabels = { agent: session.spec.name, model: session.spec.model ?? 'default' };
        const llmStartedAt = performance.now();
        let response: Awaited<ReturnType<typeof provider.complete>>;
        try {
          response = await provider.complete(request, signal);
        } catch (err) {
          metrics
            ?.counter('declaragent.provider.errors_total', 'LLM provider call errors')
            .inc(1, llmLabels);
          throw err;
        }
        // Estimate cost once — used by both the metric and the WS8 spend cap,
        // so it must be computed even when metrics are off.
        const costUSD = estimateCostUSD(response.model ?? session.spec.model, response.usage, {
          onUnknownModel: (m) =>
            metrics
              ?.counter(
                'declaragent.provider.unpriced_calls_total',
                'LLM calls whose model had no price-book entry (cost undercounted)',
              )
              .inc(1, { agent: session.spec.name, model: m }),
        });
        if (metrics) {
          const durationMs = performance.now() - llmStartedAt;
          metrics
            .histogram(
              'declaragent.provider.request.duration_ms',
              'LLM provider call latency (ms)',
              POWER_OF_TWO_BUCKETS,
            )
            .observe(durationMs, llmLabels);
          metrics
            .counter('declaragent.provider.requests_total', 'LLM provider calls')
            .inc(1, llmLabels);
          metrics
            .counter('declaragent.provider.input_tokens_total', 'LLM input tokens consumed')
            .inc(response.usage.inputTokens, llmLabels);
          metrics
            .counter('declaragent.provider.output_tokens_total', 'LLM output tokens produced')
            .inc(response.usage.outputTokens, llmLabels);
          if (costUSD > 0) {
            metrics
              .counter('declaragent.provider.cost_usd_total', 'Estimated LLM spend (USD)')
              .inc(costUSD, llmLabels);
          }
        }
        totalInputTokens += response.usage.inputTokens;
        totalOutputTokens += response.usage.outputTokens;
        turnLogger.debug('llm.response', {
          iteration: iter,
          stopReason: response.stopReason,
          usage: response.usage,
        });

        const assistantMessage: Message = {
          role: 'assistant',
          content: response.content,
          meta: {
            model: response.model,
            stopReason: response.stopReason,
            usage: response.usage,
          },
        };
        lastAssistantMessage = assistantMessage;
        await session.appendMessage(assistantMessage);

        // WS8 — dollar spend brake. Record this call's cost against the tenant's
        // rolling daily spend; if `dailyTokenUSD` is now breached, halt the turn
        // fail-closed (no further LLM calls). The cost already incurred is kept;
        // the cap prevents the NEXT call, bounding runaway/looping spend.
        if (quotas && costUSD > 0) {
          try {
            quotas.addTokenSpendUSD(costUSD);
          } catch (err) {
            if (err instanceof QuotaExceededError) {
              turnLogger.warn('llm.spend_capped', {
                quota: err.quota,
                limit: err.limit,
                observed: err.observed,
              });
              metrics
                ?.counter(
                  'declaragent.provider.spend_capped_total',
                  'Turns halted by the dailyTokenUSD spend cap',
                )
                .inc(1, llmLabels);
              stopReason = 'quota_exceeded';
              break;
            }
            throw err;
          }
        }

        if (response.stopReason !== 'tool_use') {
          stopReason = response.stopReason === 'error' ? 'error' : 'end_turn';
          break;
        }

        const toolUseBlocks = response.content.filter(isToolUse);
        const toolResults: MessageContent[] = [];
        let escalated = false;
        let innerAbort = false;

        for (const block of toolUseBlocks) {
          if (escalated || innerAbort) {
            toolResults.push(errorToolResult(block.id, 'Turn aborted before execution', 'EABORT'));
            continue;
          }
          if (signal.aborted) {
            innerAbort = true;
            toolResults.push(errorToolResult(block.id, 'Turn aborted before execution', 'EABORT'));
            continue;
          }

          const tool = toolMap.get(block.name);
          if (!tool) {
            toolResults.push(errorToolResult(block.id, `Unknown tool: ${block.name}`, 'ENOTOOL'));
            continue;
          }

          let permissionKey: string;
          try {
            permissionKey = tool.permissionKey(block.input as never);
          } catch (err) {
            toolResults.push(
              errorToolResult(
                block.id,
                `permissionKey failed: ${err instanceof Error ? err.message : String(err)}`,
                'EINVAL',
              ),
            );
            continue;
          }

          const pending: PendingToolCall = {
            id: block.id,
            toolName: tool.name,
            input: block.input,
            permissionKey,
          };

          const override = await hookRegistry.fire('tool.before', { call: pending, turn: turnCtx });
          if (override) {
            if (override.error) {
              toolResults.push(
                errorToolResult(block.id, override.error.message, override.error.code),
              );
            } else {
              toolResults.push({
                type: 'tool_result',
                toolUseId: block.id,
                content: stringifyOutput(override.output),
              });
            }
            continue;
          }

          const decision = await permissions.check(tool.name, permissionKey, {
            readonly: tool.readonly ?? false,
          });
          turnLogger.debug('tool.permission', {
            toolName: tool.name,
            outcome: decision.outcome,
            ...(decision.matchedRule && {
              ruleMatched: decision.matchedRule.pattern,
            }),
          });

          let allowed = decision.outcome === 'allow';
          if (decision.outcome === 'prompt') {
            allowed = prompter ? await prompter(pending, decision) : false;
          }

          if (decision.outcome === 'deny' || !allowed) {
            permissions.recordDenial(tool.name);
            toolResults.push(
              errorToolResult(block.id, decision.reason ?? 'Permission denied', 'EPERM'),
            );
            if (shouldEscalate(permissions)) {
              escalated = true;
            }
            continue;
          }

          // Acquire a tenant quota slot for concurrent tool calls.
          // A breach short-circuits the call with an EQUOTA tool result
          // — the engine keeps running so other tool_use blocks in the
          // same LLM response still execute (mirroring the per-call
          // permission-deny semantics).
          if (quotas) {
            try {
              quotas.acquireToolCall();
            } catch (err) {
              if (err instanceof QuotaExceededError) {
                permissions.recordDenial(tool.name);
                turnLogger.warn('tool.quota_exceeded', {
                  toolName: tool.name,
                  quota: err.quota,
                  limit: err.limit,
                  observed: err.observed,
                });
                toolResults.push(errorToolResult(block.id, err.message, 'EQUOTA'));
                continue;
              }
              throw err;
            }
          }

          // Enterprise Production Plan §3 Item #7 — per-tool rate limit
          // gate. Fires BEFORE `.execute()`. Uncapped tools return 0
          // immediately so the hot path is free. Audit emission (for
          // waits > 1s) lives inside the gate. Placed after permission
          // + quota so a denied call doesn't burn a token.
          if (toolRateLimit) {
            try {
              await toolRateLimit.acquire(tool.name, {
                tenantId: tenant?.id ?? 'default',
                sessionId: session.id,
                ...(input.causedBy !== undefined && { correlationId: input.causedBy }),
              });
            } catch (err) {
              turnLogger.warn('tool.rate_limit.error', {
                toolName: tool.name,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }

          const started = performance.now();
          const ctx: ToolContext = {
            session,
            permissions,
            abortSignal: signal,
            depth,
            runAgent,
            logger: turnLogger.child({ toolName: tool.name }),
            ...(createChildSession !== undefined && { createChildSession }),
            ...(tenant !== undefined && { tenant }),
            ...(input.subject !== undefined && { subject: input.subject }),
            ...(input.causedBy !== undefined && { correlationId: input.causedBy }),
          };
          let output: unknown;
          let error: ToolError | undefined;
          try {
            const drained = await drainToolEvents(tool, block.input, ctx, ctx.logger);
            output = drained.output;
            error = drained.error;
          } finally {
            quotas?.releaseToolCall();
          }
          const durationMs = performance.now() - started;

          const completed: CompletedToolCall = {
            ...pending,
            durationMs,
            ...(output !== undefined && { output }),
            ...(error !== undefined && { error }),
          };
          await hookRegistry.fire('tool.after', { call: completed, turn: turnCtx });

          if (error) {
            toolResults.push(errorToolResult(block.id, error.message, error.code));
          } else {
            toolResults.push({
              type: 'tool_result',
              toolUseId: block.id,
              content: stringifyOutput(output),
            });
          }
        }

        if (toolResults.length > 0) {
          await session.appendMessage({ role: 'user', content: toolResults });
        }

        if (escalated) {
          stopReason = 'permission_escalated';
          break;
        }
        if (innerAbort || signal.aborted) {
          stopReason = 'aborted';
          break;
        }
      }

      if (stopReason === null) {
        stopReason = 'max_iterations';
      }
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
      stopReason = 'error';
      turnLogger.error('turn.error', { message: runError.message });
    }

    const result: RunAgentResult = {
      stopReason,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
      ...(lastAssistantMessage && { lastAssistantMessage }),
      ...(runError && { error: runError }),
    };

    // Item A step 3 — record per-turn durability signal. Emitted on both
    // the success and error paths (runError sets stopReason='error' above)
    // so an erroring turn still reports whatever steps it ran. `hitCap` is
    // only true when the loop exhausted `effectiveMaxIterations`.
    const hitCap = stopReason === 'max_iterations';
    if (metrics) {
      const depthLabel = String(depth);
      turnIterationsHistogram?.observe(iterationsUsed, {
        agent: session.spec.name,
        depth: depthLabel,
      });
      if (hitCap) {
        // Lazily materialize the counter only on a real cap hit (see the
        // construction-time comment) so an unexhausted runtime exposes no
        // zero-valued series.
        metrics
          .counter(
            'declaragent.engine.turn.max_iterations_hit_total',
            'Turns that exhausted the maxIterations cap',
          )
          .inc(1, { agent: session.spec.name, depth: depthLabel });
      }
    }

    const finalTurnStatus =
      stopReason === 'end_turn' ? 'ok' : stopReason === 'aborted' ? 'aborted' : 'error';
    await session.markTurn(turnId, finalTurnStatus);
    await hookRegistry.fire('turn.end', { turn: turnCtx, result });
    turnLogger.info('turn.end', {
      stopReason,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      iterations: iterationsUsed,
      maxIterations: effectiveMaxIterations,
      maxIterationsHit: hitCap,
    });

    if (bus && lastAssistantMessage) {
      // Emit a single `assistant.message` with the complete content and
      // `done: true`. True per-delta streaming requires a provider-level
      // streaming API which the engine does not yet wire; when that
      // lands, the per-iteration loop will emit multiple `done: false`
      // events and the existing `ChannelOutboundBridge` streaming mode
      // will seamlessly switch from send → edit.
      const fullText = extractAssistantText(lastAssistantMessage.content);
      if (fullText.length > 0) {
        const messagePayload: AssistantMessagePayload = {
          sessionId: session.id,
          turnId,
          delta: fullText,
          done: true,
        };
        const messageEvent: AgentEvent<AssistantMessagePayload> = {
          id: crypto.randomUUID(),
          kind: 'assistant.message',
          source: { type: 'engine', sessionId: session.id, turnId },
          target: { type: 'broadcast' },
          timestamp: Date.now(),
          payload: messagePayload,
          auth: { kind: 'internal' },
          ...(input.causedBy !== undefined && {
            meta: { correlationId: input.causedBy, causedBy: input.causedBy },
          }),
        };
        try {
          await bus.publish(stampTenantId(messageEvent, tenant));
        } catch (err) {
          turnLogger.warn('assistant.message.publish.error', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const payload: AssistantFinalPayload = {
        sessionId: session.id,
        turnId,
        stopReason,
        content: lastAssistantMessage.content,
        usage: result.usage,
        ...(input.causedBy !== undefined && { causedBy: input.causedBy }),
      };
      const event: AgentEvent<AssistantFinalPayload> = {
        id: crypto.randomUUID(),
        kind: 'assistant.final',
        source: { type: 'engine', sessionId: session.id, turnId },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload,
        auth: { kind: 'internal' },
        ...(input.causedBy !== undefined && {
          meta: { correlationId: input.causedBy, causedBy: input.causedBy },
        }),
      };
      try {
        await bus.publish(stampTenantId(event, tenant));
      } catch (err) {
        turnLogger.warn('assistant.final.publish.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  };

  return { runAgent };
}

/**
 * Concatenate the `text` blocks of an assistant message content array.
 * Duplicates the plaintext path used by `ChannelOutboundBridge.extractAssistantContent`
 * but kept inline here to avoid a channels → engine import cycle for
 * slice-13's `assistant.message` emission.
 */
function extractAssistantText(content: Message['content']): string {
  const pieces: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text.length > 0) {
      pieces.push(block.text);
    }
  }
  return pieces.join('\n');
}
