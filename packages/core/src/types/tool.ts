import type { RpcError } from '../rpc/envelope.js';
import type { TenantContext } from '../tenancy/types.js';
import type { RunAgent } from './agent.js';
import type { Logger } from './logger.js';
import type { PermissionGate } from './permission.js';
import type { SessionHandle } from './session.js';

export type JSONSchema = Record<string, unknown>;

/** @since 1.0.0 */
export interface ToolError {
  message: string;
  code?: string;
  cause?: unknown;
}

/**
 * Shape accepted by `ToolContext.respond`.
 *
 * @since 1.1.0
 */
export type RpcRespondResult = { ok: true; data: unknown } | { ok: false; error: RpcError };

/** @since 1.0.0 */
export type ToolEvent<O = unknown> =
  | { type: 'progress'; message: string }
  | { type: 'result'; output: O }
  | { type: 'error'; error: ToolError };

/** @since 1.0.0 */
export interface ToolContext {
  session: SessionHandle;
  permissions: PermissionGate;
  abortSignal: AbortSignal;
  depth: number;
  runAgent: RunAgent;
  logger: Logger;
  /**
   * Factory for child session handles, used by the Agent tool to spawn
   * sub-agents. The engine supplies this; tools should not construct sessions
   * directly.
   */
  createChildSession?: () => SessionHandle;
  /**
   * Phase 6 addition. Tenant the tool is executing on behalf of. Tool
   * authors read this only when they emit cross-tenant resources (e.g.
   * filesystem paths under a tenant-scoped workspace). Absent = default
   * tenant.
   */
  tenant?: TenantContext;
  /**
   * WS8 — end-user subject this turn runs on behalf of (channel principal's
   * `platformUserId`). Subject-scoped tools (long-term memory) read this to
   * isolate one end-user's data from another within the same agent + tenant.
   * Absent = no subject partition (cron/webhook triggers, or single-user).
   */
  subject?: string;
  /**
   * Phase 6 slice-2 addition. Correlation id of the originating event.
   * Tools that publish bus events should stamp this on
   * `event.meta.correlationId` so the full causal chain (source →
   * dispatcher → engine → tool → channel) shares a single trace id.
   * Absent when the engine turn was triggered outside an event context
   * (REPL, direct `runAgent` call).
   */
  correlationId?: string;
  /**
   * Phase 8 / v1.1 addition. When the current turn was triggered by an
   * agent-rpc request, `respond` publishes a response envelope to the
   * requestor's `replyTo` topic. Auto-populated from the request
   * context — skills don't see the envelope, only the payload + this
   * hook. Multiple calls produce successive response-kind messages
   * (useful for streaming / progress updates). A default hook publishes
   * `{ ok: true, data: assistantFinal.content }` automatically when a
   * skill returns without calling respond, so skills written for the
   * REPL "just work" over RPC.
   *
   * @since 1.1.0
   */
  respond?(result: RpcRespondResult): Promise<void>;
}

/** @since 1.0.0 */
export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  readonly?: boolean;
  parallelSafe?: boolean;
  permissionKey(input: I): string;
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent<O>>;
}

/** @since 1.0.0 */
export interface PendingToolCall {
  id: string;
  toolName: string;
  input: unknown;
  permissionKey: string;
}

/** @since 1.0.0 */
export interface CompletedToolCall extends PendingToolCall {
  output?: unknown;
  error?: ToolError;
  durationMs: number;
}
