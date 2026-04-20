/**
 * `/undo` — revert the last applied proposal via scoped
 * `git checkout`. See BUILDER_PLAN §5.3.
 *
 * Phase 6 supports a single-step undo: the registry stores only the
 * most recent `lastAppliedMeta`, and a successful revert clears it.
 * Stacking multiple undos (as the plan's §13 promises) lands in a
 * later slice once the audit chain carries enough context to
 * reconstruct writes without the live registry.
 *
 * Guarantees:
 *   - `git checkout <headBefore> -- <writes>` — paths are scoped to
 *     the apply. Unrelated working-tree changes are untouched.
 *   - If the tree isn't a git repo OR `gitHeadBefore` was never
 *     captured, we refuse with a clear message. No homegrown
 *     snapshot fallback in phase 6 (§13 defers to v0.3).
 *   - On success we call `registry.markReverted(...)` + clear
 *     `lastApplied`, so a second `/undo` surfaces "nothing to undo".
 *
 * @since 0.2.0
 */

import { isGitRepo, revertPaths } from './git.js';
import type { AppliedProposalMeta, ProposalRegistry } from './proposals.js';

export interface RunUndoOptions {
  registry: ProposalRegistry;
  scopeRoot: string;
}

export interface RunUndoOutput {
  readonly ok: boolean;
  /** Absolute paths we restored — empty when ok === false. */
  readonly reverted: readonly string[];
  readonly proposalId?: string;
  readonly gitHeadBefore?: string;
  /** Human-readable reason; always populated. */
  readonly message: string;
}

export async function runUndo(options: RunUndoOptions): Promise<RunUndoOutput> {
  const last = options.registry.lastApplied();
  if (!last) {
    return {
      ok: false,
      reverted: [],
      message: 'nothing to undo — no apply has landed in this session.',
    };
  }

  if (last.writes.length === 0) {
    // An apply that was fully no-op (everything idempotent). Clear
    // the slot — there's nothing to revert, but we also shouldn't
    // make the user re-undo it later.
    options.registry.clearLastApplied();
    return {
      ok: true,
      reverted: [],
      proposalId: last.proposalId,
      message: `proposal ${last.proposalId} had no writes — nothing to revert.`,
    };
  }

  if (!isGitRepo(options.scopeRoot)) {
    return {
      ok: false,
      reverted: [],
      proposalId: last.proposalId,
      message:
        'working tree is not a git repo — /undo needs git to revert. Re-run the builder with ' +
        'git initialised, or manually edit the files back.',
    };
  }

  if (last.gitHeadBefore === undefined) {
    return {
      ok: false,
      reverted: [],
      proposalId: last.proposalId,
      message:
        'no git HEAD was captured for this apply — /undo cannot revert. (Phase 6 limitation; ' +
        'a snapshot fallback lands in v0.3.)',
    };
  }

  try {
    await revertPaths(options.scopeRoot, last.gitHeadBefore, last.writes);
  } catch (err) {
    return {
      ok: false,
      reverted: [],
      proposalId: last.proposalId,
      ...(last.gitHeadBefore !== undefined && { gitHeadBefore: last.gitHeadBefore }),
      message: `git revert failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  options.registry.markReverted(last.proposalId, last.writes);
  options.registry.clearLastApplied();

  return {
    ok: true,
    reverted: last.writes,
    proposalId: last.proposalId,
    ...(last.gitHeadBefore !== undefined && { gitHeadBefore: last.gitHeadBefore }),
    message: `reverted ${last.writes.length} path(s) to ${last.gitHeadBefore.slice(0, 7)} (proposal ${last.proposalId}).`,
  };
}

/** Exposed for tests — re-exporting the type keeps imports flat. */
export type { AppliedProposalMeta };
