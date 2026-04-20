/**
 * Proposal registry — the state machine behind phase 3's plan-confirm-
 * execute flow (BUILDER_PLAN §3.1, §3.2, §10 risk "Proposal churn").
 *
 * Lifecycle:
 *
 *   pending ──/yes──▶ confirmed ──apply──▶ applied
 *       │
 *       ├──/no────▶ rejected
 *       └── TTL ──▶ expired   (§10: 15 minutes, re-propose cleanly)
 *
 * Each {@link ProposalRegistry} is session-scoped: the REPL creates one
 * per session and passes it into the {@link createProposeChangeTool}
 * and {@link createApplyChangeTool} factories. Concurrent sessions do
 * NOT share a registry — proposals from one user's turn must not be
 * apply-able from another's.
 *
 * Listeners let the REPL render proposals inline without reaching into
 * the tool layer. We keep rendering concerns out of this file; the
 * registry only emits structured events.
 *
 * @since 0.2.0
 */

import { randomUUID } from 'node:crypto';

/**
 * Every step kind the builder toolkit intends to support across phases.
 * {@link createApplyChangeTool} dispatches by kind at execute time —
 * kinds beyond the currently-implemented set (phase 3: `addSkill`,
 * `addSecret`) surface a "not yet supported in this version" error.
 */
export const PROPOSAL_STEP_KINDS = [
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
] as const;

export type ProposalStepKind = (typeof PROPOSAL_STEP_KINDS)[number];

export interface ProposalStep {
  readonly kind: ProposalStepKind;
  /** One-line description rendered for the user. `/edit` overwrites this. */
  description: string;
  /** Optional YAML fragment, command string, or diff hunk for the render. */
  readonly preview?: string;
  /** Kind-specific arguments. Validated by the matching tool at apply time. */
  readonly payload: unknown;
}

export type ProposalStatus = 'pending' | 'confirmed' | 'rejected' | 'expired' | 'applied';

export interface Proposal {
  readonly id: string;
  readonly summary: string;
  steps: ProposalStep[];
  /** §5.4 — deploy, audit-erase, and scope-breach propose require exact "/yes deploy". */
  readonly requiresExplicitYes: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  status: ProposalStatus;
}

export type ProposalEvent =
  | { type: 'registered'; proposal: Proposal }
  | { type: 'edited'; proposal: Proposal; stepIndex: number; replacement: string }
  | { type: 'confirmed'; proposal: Proposal }
  | { type: 'rejected'; proposal: Proposal }
  | { type: 'expired'; proposal: Proposal }
  | { type: 'applied'; proposal: Proposal; meta?: AppliedProposalMeta }
  | { type: 'reverted'; proposal: Proposal; revertedPaths: readonly string[] };

/**
 * Rollback metadata captured by `DeclaraApplyChange` and handed to
 * `/undo`. {@link gitHeadBefore} is undefined when the working tree
 * isn't a git repo — the undo path then surfaces a "no git, can't
 * revert" message instead of attempting something destructive.
 */
export interface AppliedProposalMeta {
  /** Proposal id. Mirrors `proposal.id`; duplicated for terse access. */
  readonly proposalId: string;
  /** HEAD sha captured before the apply began. */
  readonly gitHeadBefore: string | undefined;
  /** Absolute paths the apply wrote / touched. Scoped to this apply. */
  readonly writes: readonly string[];
  /** ms-epoch the apply completed. */
  readonly appliedAt: number;
  /** Optional correlation id threaded through audit / event bus. */
  readonly auditCorrelationId?: string;
}

export type ProposalListener = (event: ProposalEvent) => void;

export interface RegisterProposalInput {
  summary: string;
  steps: ProposalStep[];
  requiresExplicitYes?: boolean;
}

export interface ProposalResolution {
  readonly id: string;
  readonly confirmed: boolean;
  readonly finalSteps: readonly ProposalStep[];
  readonly reason?: 'confirmed' | 'rejected' | 'expired';
}

/**
 * 15-minute default per §10 risk "Proposal churn: ... proposals expire
 * after 15 minutes; builder re-proposes cleanly from scratch."
 */
export const DEFAULT_PROPOSAL_TTL_MS = 15 * 60 * 1000;

export class ProposalRegistry {
  private readonly proposals = new Map<string, Proposal>();
  private readonly pending = new Map<string, (resolution: ProposalResolution) => void>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<ProposalListener>();
  private readonly ttlMs: number;
  /** Clock injection keeps expiry tests deterministic. */
  private readonly now: () => number;
  /**
   * Metadata for the most-recently-applied proposal. `/undo` reads
   * this. Reset to `undefined` once the revert completes so a second
   * `/undo` cannot walk further back than phase 6's single-step
   * history (phase 7+ will stack, see §13).
   */
  private lastAppliedMeta: AppliedProposalMeta | undefined;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Most recent apply — the one `/undo` reverts. Undefined until one lands. */
  lastApplied(): AppliedProposalMeta | undefined {
    return this.lastAppliedMeta;
  }

  /** Called by the /undo handler after a successful revert. */
  clearLastApplied(): void {
    this.lastAppliedMeta = undefined;
  }

  subscribe(listener: ProposalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ProposalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors — one bad render must not break the
        // registry. The REPL can log its own errors if it cares.
      }
    }
  }

  /**
   * The single-pending-proposal surface for slash handlers. Most REPL
   * sessions only ever have one proposal outstanding; phase 3 does
   * not support concurrent proposals. If more than one is pending we
   * return the most recently registered.
   */
  active(): Proposal | undefined {
    // Iterate the insertion order of the Map and keep the last
    // pending entry we see — that's the most-recently-registered
    // proposal, regardless of clock resolution.
    let latest: Proposal | undefined;
    for (const p of this.proposals.values()) {
      if (p.status === 'pending') latest = p;
    }
    return latest;
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  /**
   * Register + await. The returned promise resolves when the user
   * confirms, rejects, or the TTL fires.
   */
  register(input: RegisterProposalInput): {
    proposal: Proposal;
    wait: Promise<ProposalResolution>;
  } {
    const id = randomUUID();
    const createdAt = this.now();
    const proposal: Proposal = {
      id,
      summary: input.summary,
      steps: input.steps.slice(),
      requiresExplicitYes: input.requiresExplicitYes ?? false,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: 'pending',
    };
    this.proposals.set(id, proposal);

    const wait = new Promise<ProposalResolution>((resolve) => {
      this.pending.set(id, resolve);
      // When the TTL elapses we auto-reject with reason "expired".
      const timer = setTimeout(() => {
        if (proposal.status === 'pending') {
          proposal.status = 'expired';
          this.emit({ type: 'expired', proposal });
          const resolver = this.pending.get(id);
          this.pending.delete(id);
          this.timers.delete(id);
          resolver?.({ id, confirmed: false, finalSteps: proposal.steps, reason: 'expired' });
        }
      }, this.ttlMs);
      // Allow the process to exit even if a proposal is still pending.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      this.timers.set(id, timer);
    });

    this.emit({ type: 'registered', proposal });
    return { proposal, wait };
  }

  confirm(id: string): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'pending') return false;
    proposal.status = 'confirmed';
    this.emit({ type: 'confirmed', proposal });
    const resolver = this.pending.get(id);
    this.pending.delete(id);
    this.clearTimer(id);
    resolver?.({ id, confirmed: true, finalSteps: proposal.steps, reason: 'confirmed' });
    return true;
  }

  reject(id: string): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'pending') return false;
    proposal.status = 'rejected';
    this.emit({ type: 'rejected', proposal });
    const resolver = this.pending.get(id);
    this.pending.delete(id);
    this.clearTimer(id);
    resolver?.({ id, confirmed: false, finalSteps: proposal.steps, reason: 'rejected' });
    return true;
  }

  /**
   * Replace step `stepIndex`'s *description*. Payloads are not
   * user-editable via `/edit <n> <text>` — the whole point of the
   * payload/preview split is to keep structured args out of a
   * free-form slash command. If the user wants a different payload,
   * they should tell the model to re-propose.
   */
  edit(id: string, stepIndex: number, replacement: string): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== 'pending') return false;
    if (stepIndex < 0 || stepIndex >= proposal.steps.length) return false;
    const step = proposal.steps[stepIndex];
    if (step === undefined) return false;
    step.description = replacement;
    this.emit({ type: 'edited', proposal, stepIndex, replacement });
    return true;
  }

  /**
   * Called by `DeclaraApplyChange` once a confirmed proposal has been
   * fully executed. Stores rollback metadata on the registry so
   * `/undo` has somewhere to read from. Idempotent — calling twice is
   * harmless, but only the first call emits the event.
   */
  markApplied(id: string, meta?: Omit<AppliedProposalMeta, 'proposalId'>): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal) return false;
    if (proposal.status === 'applied') return false;
    if (proposal.status !== 'confirmed') return false;
    proposal.status = 'applied';
    const fullMeta: AppliedProposalMeta | undefined = meta
      ? {
          proposalId: id,
          gitHeadBefore: meta.gitHeadBefore,
          writes: meta.writes,
          appliedAt: meta.appliedAt,
          ...(meta.auditCorrelationId !== undefined && {
            auditCorrelationId: meta.auditCorrelationId,
          }),
        }
      : undefined;
    if (fullMeta) {
      this.lastAppliedMeta = fullMeta;
    }
    this.emit({ type: 'applied', proposal, ...(fullMeta !== undefined && { meta: fullMeta }) });
    return true;
  }

  /**
   * Mark a previously-applied proposal as reverted. Called by
   * `runUndo` after a successful `git checkout`. Does NOT touch the
   * proposal's status (it stays `applied` — a revert is a new action,
   * not a rollback to `pending`).
   */
  markReverted(id: string, revertedPaths: readonly string[]): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal) return false;
    if (this.lastAppliedMeta?.proposalId === id) {
      this.lastAppliedMeta = undefined;
    }
    this.emit({ type: 'reverted', proposal, revertedPaths });
    return true;
  }

  /**
   * For tests and `/scope cleanup` UX down the road. Removes proposals
   * that are no longer pending. Returns the number of purged entries.
   */
  purgeResolved(): number {
    let n = 0;
    for (const [id, p] of this.proposals) {
      if (p.status !== 'pending') {
        this.proposals.delete(id);
        n++;
      }
    }
    return n;
  }

  /** Sized to the test's advantage — production callers won't touch this. */
  size(): number {
    return this.proposals.size;
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}

// ── Rendering ──────────────────────────────────────────────────────────

/**
 * Format a proposal as the system-line body the REPL displays. Pure;
 * no colour codes, no ANSI — Ink's `Text` renderer handles styling at
 * the display layer. We return a single string so callers can compose
 * it into whatever Line kind they prefer.
 */
export function renderProposal(proposal: Proposal): string {
  const header = `Proposal ${proposal.id} — ${proposal.summary}`;
  const lines: string[] = [header];
  if (proposal.requiresExplicitYes) {
    lines.push('(This proposal requires typing "/yes <exact-phrase>" — see the prompt below.)');
  }
  proposal.steps.forEach((step, i) => {
    lines.push(`  ${i + 1}. [${step.kind}] ${step.description}`);
    if (step.preview !== undefined && step.preview.length > 0) {
      for (const previewLine of step.preview.split('\n')) {
        lines.push(`     ${previewLine}`);
      }
    }
  });
  lines.push('Type /yes to apply, /no to cancel, or /edit <n> <replacement> to revise step n.');
  return lines.join('\n');
}
