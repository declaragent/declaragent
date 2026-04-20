/**
 * `DeclaraProposeChange` builder tool — registers a proposal with the
 * session's {@link ProposalRegistry} and *awaits* the user's decision
 * before returning. See BUILDER_PLAN §3.1.
 *
 * Control flow:
 *
 *   model.invokeTool(DeclaraProposeChange, { summary, steps })
 *     └▶ registry.register(...)           // emits 'registered'
 *        └▶ REPL listener renders plan    // user sees it
 *     └▶ await { confirmed, finalSteps }  // blocks until /yes|/no|TTL
 *     └▶ yield { type: 'result', output }
 *
 * Side effects are exactly two:
 *   1. The registry gains a proposal.
 *   2. Subscribed listeners are notified.
 * Neither the filesystem nor git are touched. The actual work happens
 * in `DeclaraApplyChange` once the model passes the returned
 * `proposalId` back.
 *
 * @since 0.2.0
 */

import type { Tool, ToolEvent } from '@declaragent/core';
import type { Proposal, ProposalRegistry, ProposalStep } from './proposals.js';
import {
  type ProposeChangeInput,
  type ProposeChangeOutput,
  formatZodError,
  proposeChangeInputSchema,
} from './types.js';

export interface DeclaraProposeChangeContext {
  /** Session-scoped registry — created once per REPL and shared with apply-change. */
  registry: ProposalRegistry;
}

export function createProposeChangeTool(
  ctx: DeclaraProposeChangeContext,
): Tool<ProposeChangeInput, ProposeChangeOutput> {
  return {
    name: 'DeclaraProposeChange',
    description:
      'Register a plan and wait for the user to /yes, /no, or /edit it. Pure — no file writes. ' +
      'Returns { proposalId, confirmed, finalSteps }. Pass the proposalId to DeclaraApplyChange ' +
      'once confirmed === true.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-sentence goal of the change.' },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'addSkill',
                  'addSecret',
                  'addSource',
                  'addChannel',
                  'addMCP',
                  'addPlugin',
                  'addPeer',
                  'addAgent',
                  'editFile',
                  'runCommand',
                ],
              },
              description: { type: 'string' },
              preview: {
                type: 'string',
                description: 'YAML fragment, shell command, or diff hunk rendered for the user.',
              },
              payload: {
                description:
                  'Kind-specific arguments. Validated by the matching tool at apply time.',
              },
            },
            required: ['kind', 'description', 'payload'],
          },
        },
        requiresExplicitYes: { type: 'boolean', default: false },
      },
      required: ['summary', 'steps'],
    },
    readonly: true,
    parallelSafe: false,
    permissionKey(input) {
      // Permission is gated per-*summary* so the user can scope a
      // "never ask again" rule to a particular proposal shape.
      return `propose:${input.summary.slice(0, 64)}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<ProposeChangeOutput>> {
      const parsed = proposeChangeInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraProposeChange: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }

      // Clone each step into a mutable shape so `/edit` can mutate the
      // description without the model's original input being touched.
      const steps: ProposalStep[] = parsed.data.steps.map((s) => ({
        kind: s.kind,
        description: s.description,
        ...(s.preview !== undefined && { preview: s.preview }),
        payload: s.payload,
      }));

      const { proposal, wait } = ctx.registry.register({
        summary: parsed.data.summary,
        steps,
        ...(parsed.data.requiresExplicitYes !== undefined && {
          requiresExplicitYes: parsed.data.requiresExplicitYes,
        }),
      });

      try {
        // Wire the abort signal to reject the proposal early if the
        // user ^C's mid-plan. We rely on `toolCtx.abortSignal` if
        // supplied; fall through when it's not.
        const resolution = await raceWithAbort(wait, toolCtx.abortSignal, () => {
          ctx.registry.reject(proposal.id);
        });

        yield {
          type: 'result',
          output: {
            ok: true,
            proposalId: proposal.id,
            confirmed: resolution.confirmed,
            summary: parsed.data.summary,
            finalSteps: resolution.finalSteps.map((s) => ({
              kind: s.kind,
              description: s.description,
            })),
            reason: resolution.reason ?? (resolution.confirmed ? 'confirmed' : 'rejected'),
          },
        };
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
        };
      }
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

async function raceWithAbort<T>(
  source: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return source;
  if (signal.aborted) {
    onAbort();
    throw new Error('DeclaraProposeChange aborted');
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => {
      onAbort();
      signal.removeEventListener('abort', handleAbort);
      reject(new Error('DeclaraProposeChange aborted'));
    };
    signal.addEventListener('abort', handleAbort);
    source
      .then((value) => {
        signal.removeEventListener('abort', handleAbort);
        resolve(value);
      })
      .catch((err) => {
        signal.removeEventListener('abort', handleAbort);
        reject(err);
      });
  });
}

// Re-export for convenience so app.tsx can import the Proposal type
// without reaching into `proposals.js` when only propose-change.js is
// pulled in.
export type { Proposal };
