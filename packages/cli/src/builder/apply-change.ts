/**
 * `DeclaraApplyChange` builder tool — walks a confirmed proposal's
 * steps, dispatching each to the matching builder runner. See
 * BUILDER_PLAN §3.2.
 *
 * Phase-3 dispatch coverage:
 *   - addSkill   → runAddSkill(payload)
 *   - addSecret  → runAddSecret(payload)
 *   - everything else → "not supported yet in this version"
 *
 * On the first step failure we:
 *   1. Capture which paths had already been mutated.
 *   2. Attempt `git checkout <headBefore> -- <paths>` via
 *      {@link revertPaths}. Best-effort; if git isn't available we
 *      emit the failure on the step's result and let `/undo`
 *      (phase 6) handle manual recovery.
 *   3. Return `ok: false` with the per-step results so the model can
 *      explain what failed and re-propose.
 *
 * The `auditCorrelationId` returned here is the tie-back for phase 6's
 * `audit query --kind 'builder.*'` surface. We don't yet write audit
 * records from the builder (that's bundled with `/history` in phase 6);
 * for now the id is a stable UUID per apply.
 *
 * @since 0.2.0
 */

import { randomUUID } from 'node:crypto';
import type { TenantAuditSink, Tool, ToolEvent } from '@declaragent/core';
import { DEFAULT_TENANT_ID } from '@declaragent/core';
import { runAddPeer } from './add-peer.js';
import { runAddSecret } from './add-secret.js';
import { runAddSkill } from './add-skill.js';
import { runFleetAdd } from './fleet-add.js';
import { captureHead, revertPaths } from './git.js';
import type { Proposal, ProposalRegistry, ProposalStep } from './proposals.js';
import {
  type AddPeerInput,
  type AddSecretInput,
  type AddSkillInput,
  type FleetAddInput,
  addPeerInputSchema,
  addSecretInputSchema,
  addSkillInputSchema,
  fleetAddInputSchema,
} from './types.js';
import {
  type ApplyChangeInput,
  type ApplyChangeOutput,
  type ApplyStepResult,
  BuilderValidationError,
  applyChangeInputSchema,
  formatZodError,
} from './types.js';

export interface DeclaraApplyChangeContext {
  registry: ProposalRegistry;
  scopeRoot: string;
  /**
   * Optional audit sink. When provided, `DeclaraApplyChange` writes
   * one `tool_call` record per step (plus a summary for the apply
   * itself) so `/history` can surface the action log. Injected by
   * the REPL at session start; tests can leave it undefined.
   */
  auditSink?: TenantAuditSink;
  /** Tenant id for audit records. Defaults to `DEFAULT_TENANT_ID`. */
  tenantId?: string;
  /** Session id for audit records. Defaults to a stable per-context id. */
  sessionId?: string;
}

export function createApplyChangeTool(
  ctx: DeclaraApplyChangeContext,
): Tool<ApplyChangeInput, ApplyChangeOutput> {
  return {
    name: 'DeclaraApplyChange',
    description:
      'Apply a proposal previously confirmed via DeclaraProposeChange + /yes. Captures git HEAD ' +
      'before mutating; on failure, best-effort reverts the paths touched so far.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
      },
      required: ['proposalId'],
    },
    readonly: false,
    permissionKey(input) {
      return `apply:${input.proposalId}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<ApplyChangeOutput>> {
      const parsed = applyChangeInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraApplyChange: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }

      const proposal = ctx.registry.get(parsed.data.proposalId);
      if (!proposal) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `no proposal with id ${parsed.data.proposalId}`,
          },
        };
        return;
      }
      if (proposal.status === 'rejected' || proposal.status === 'expired') {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_CONFLICT',
            message: `proposal ${proposal.id} is ${proposal.status} — re-propose before applying`,
          },
        };
        return;
      }
      if (proposal.status === 'applied') {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_CONFLICT',
            message: `proposal ${proposal.id} has already been applied`,
          },
        };
        return;
      }
      if (proposal.status !== 'confirmed') {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_CONFLICT',
            message: `proposal ${proposal.id} is ${proposal.status} — needs /yes first`,
          },
        };
        return;
      }

      const auditCorrelationId = randomUUID();
      const gitHeadBefore = await captureHead(ctx.scopeRoot);
      const results: ApplyStepResult[] = [];
      const writesAccumulated: string[] = [];
      let failed = false;
      const startTs = Date.now();

      try {
        for (const step of proposal.steps) {
          if (toolCtx.abortSignal.aborted) {
            results.push({
              kind: step.kind,
              ok: false,
              writes: [],
              error: 'aborted before dispatch',
            });
            failed = true;
            break;
          }
          const stepStart = Date.now();
          const stepResult = await dispatchStep(step, ctx.scopeRoot);
          await emitStepAudit(ctx, step, stepResult, auditCorrelationId, Date.now() - stepStart);
          results.push(stepResult);
          if (!stepResult.ok) {
            failed = true;
            break;
          }
          writesAccumulated.push(...stepResult.writes);
        }
      } catch (err) {
        failed = true;
        results.push({
          kind: 'unknown',
          ok: false,
          writes: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let rolledBack = false;
      if (failed && writesAccumulated.length > 0 && gitHeadBefore) {
        try {
          await revertPaths(ctx.scopeRoot, gitHeadBefore, writesAccumulated);
          rolledBack = true;
        } catch {
          // Rollback is best-effort in phase 3. Phase 6's /undo
          // surfaces a richer recovery path.
        }
      }

      if (!failed) {
        ctx.registry.markApplied(proposal.id, {
          gitHeadBefore,
          writes: writesAccumulated.slice(),
          appliedAt: Date.now(),
          auditCorrelationId,
        });
      }

      await emitApplySummaryAudit(
        ctx,
        proposal.id,
        !failed,
        auditCorrelationId,
        Date.now() - startTs,
      );

      yield {
        type: 'result',
        output: {
          ok: !failed,
          proposalId: proposal.id,
          results,
          gitHeadBefore,
          auditCorrelationId,
          rolledBack,
        },
      };
    },
  };
}

// ── Step dispatcher ────────────────────────────────────────────────────

async function dispatchStep(step: ProposalStep, scopeRoot: string): Promise<ApplyStepResult> {
  switch (step.kind) {
    case 'addSkill': {
      const parsed = addSkillInputSchema.safeParse(step.payload);
      if (!parsed.success) {
        return {
          kind: step.kind,
          ok: false,
          writes: [],
          error: `addSkill payload invalid: ${formatZodError(parsed.error)}`,
        };
      }
      try {
        const out = await runAddSkill(parsed.data as AddSkillInput, { scopeRoot });
        return { kind: step.kind, ok: true, writes: out.writes, output: out };
      } catch (err) {
        return {
          kind: step.kind,
          ok: false,
          writes: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'addSecret': {
      const parsed = addSecretInputSchema.safeParse(step.payload);
      if (!parsed.success) {
        return {
          kind: step.kind,
          ok: false,
          writes: [],
          error: `addSecret payload invalid: ${formatZodError(parsed.error)}`,
        };
      }
      try {
        const out = await runAddSecret(parsed.data as AddSecretInput, { scopeRoot });
        return { kind: step.kind, ok: true, writes: out.writes, output: out };
      } catch (err) {
        return {
          kind: step.kind,
          ok: false,
          writes: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'addAgent': {
      const parsed = fleetAddInputSchema.safeParse(step.payload);
      if (!parsed.success) {
        return {
          kind: step.kind,
          ok: false,
          writes: [],
          error: `addAgent payload invalid: ${formatZodError(parsed.error)}`,
        };
      }
      try {
        const out = await runFleetAdd(parsed.data as FleetAddInput, { scopeRoot });
        return { kind: step.kind, ok: true, writes: out.writes, output: out };
      } catch (err) {
        return {
          kind: step.kind,
          ok: false,
          writes: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    case 'addPeer': {
      const parsed = addPeerInputSchema.safeParse(step.payload);
      if (!parsed.success) {
        return {
          kind: step.kind,
          ok: false,
          writes: [],
          error: `addPeer payload invalid: ${formatZodError(parsed.error)}`,
        };
      }
      try {
        const out = await runAddPeer(parsed.data as AddPeerInput, { scopeRoot });
        return { kind: step.kind, ok: true, writes: out.writes, output: out };
      } catch (err) {
        return {
          kind: step.kind,
          ok: false,
          writes: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Phases 5+ fill these in. For now we surface a clear error so
    // the model can re-propose with a supported kind.
    case 'addSource':
    case 'addChannel':
    case 'addMCP':
    case 'addPlugin':
    case 'editFile':
    case 'runCommand':
      return {
        kind: step.kind,
        ok: false,
        writes: [],
        error: `step kind "${step.kind}" is not supported yet in this build`,
      };

    default: {
      // Exhaustiveness sentinel — unreachable if the registry+Zod
      // schema are in sync.
      const _exhaustive: never = step.kind;
      throw new BuilderValidationError(`unknown proposal step kind: ${String(_exhaustive)}`);
    }
  }
}

// Keep these re-exports narrow so consumers reach into this module
// only for the public Tool factory + type aliases.
export type { Proposal };

// ── Audit helpers ──────────────────────────────────────────────────────

/**
 * Per-step audit record. We reuse the existing `tool_call` kind —
 * see `history.ts` header for the rationale. The `tool` field carries
 * the builder step kind prefixed with `Declara` so the history filter
 * (which looks for that prefix) surfaces these records.
 */
async function emitStepAudit(
  ctx: DeclaraApplyChangeContext,
  step: ProposalStep,
  result: ApplyStepResult,
  correlationId: string,
  durationMs: number,
): Promise<void> {
  if (!ctx.auditSink) return;
  try {
    await ctx.auditSink.record({
      kind: 'tool_call',
      ts: Date.now(),
      tenantId: ctx.tenantId ?? DEFAULT_TENANT_ID,
      sessionId: ctx.sessionId ?? 'repl',
      tool: `Declara:${step.kind}`,
      permissionKey: `apply-step:${step.kind}`,
      outcome: result.ok ? 'allow' : 'deny',
      durationMs,
      correlationId,
      ...(result.error !== undefined && { error: { message: result.error } }),
    });
  } catch {
    // Audit failures must not poison the apply. A missing record is
    // an operational issue; a failed record would be a regression.
  }
}

async function emitApplySummaryAudit(
  ctx: DeclaraApplyChangeContext,
  proposalId: string,
  ok: boolean,
  correlationId: string,
  durationMs: number,
): Promise<void> {
  if (!ctx.auditSink) return;
  try {
    await ctx.auditSink.record({
      kind: 'tool_call',
      ts: Date.now(),
      tenantId: ctx.tenantId ?? DEFAULT_TENANT_ID,
      sessionId: ctx.sessionId ?? 'repl',
      tool: 'DeclaraApplyChange',
      permissionKey: `apply:${proposalId}`,
      outcome: ok ? 'allow' : 'deny',
      durationMs,
      correlationId,
    });
  } catch {
    // Same rationale as the per-step emit.
  }
}
