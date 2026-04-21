/**
 * Bare-letter shortcut resolver for pending builder proposals.
 *
 * When a proposal is outstanding, a user message of just `y` / `yes` /
 * `n` / `no` is treated as the matching `/yes` / `/no` slash command.
 * Preserves the typed flow for longer messages (prose starting with
 * `y…` still reaches the model) and for explicit-yes proposals that
 * require the full `/yes <phrase>` form per BUILDER_PLAN §5.4.
 *
 * Extracted from app.tsx so the logic is unit-testable without
 * loading react / ink.
 *
 * @since 0.4.1
 */

import type { Proposal } from './builder/index.js';
import type { SlashCommand } from './slash-commands.js';

export function matchProposalShortcut(raw: string, proposal: Proposal | null): SlashCommand | null {
  if (!proposal) return null;
  const c = raw.trim().toLowerCase();
  if (c === 'y' || c === 'yes') {
    // Explicit-yes proposals deliberately skip the `y` shortcut:
    // phrase-match (§5.4) would reject a reflexive keypress, and
    // surfacing "this one needs the full phrase" via the hint is
    // more useful than firing a no-op confirmation.
    if (proposal.requiresExplicitYes) return null;
    return { kind: 'proposalYes' };
  }
  if (c === 'n' || c === 'no') return { kind: 'proposalNo' };
  return null;
}
