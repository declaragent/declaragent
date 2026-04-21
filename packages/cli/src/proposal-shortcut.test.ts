import { describe, expect, test } from 'bun:test';
import type { Proposal } from './builder/index.js';
import { matchProposalShortcut } from './proposal-shortcut.js';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'test-proposal',
    summary: 'add pr-review scaffold',
    steps: [],
    status: 'pending',
    createdAt: Date.now(),
    requiresExplicitYes: false,
    ...overrides,
  } as Proposal;
}

describe('matchProposalShortcut', () => {
  test('returns null when no proposal is pending', () => {
    expect(matchProposalShortcut('y', null)).toBeNull();
    expect(matchProposalShortcut('yes please', null)).toBeNull();
  });

  test('maps bare y / yes to proposalYes when a proposal is pending', () => {
    const p = makeProposal();
    expect(matchProposalShortcut('y', p)).toEqual({ kind: 'proposalYes' });
    expect(matchProposalShortcut('yes', p)).toEqual({ kind: 'proposalYes' });
    expect(matchProposalShortcut('Y', p)).toEqual({ kind: 'proposalYes' });
    expect(matchProposalShortcut('YES', p)).toEqual({ kind: 'proposalYes' });
    // Whitespace tolerated.
    expect(matchProposalShortcut('  y  ', p)).toEqual({ kind: 'proposalYes' });
  });

  test('maps bare n / no to proposalNo', () => {
    const p = makeProposal();
    expect(matchProposalShortcut('n', p)).toEqual({ kind: 'proposalNo' });
    expect(matchProposalShortcut('no', p)).toEqual({ kind: 'proposalNo' });
    expect(matchProposalShortcut('N', p)).toEqual({ kind: 'proposalNo' });
  });

  test("longer prose starting with y/n doesn't trigger — still goes to the model", () => {
    const p = makeProposal();
    expect(matchProposalShortcut('yeah maybe', p)).toBeNull();
    expect(matchProposalShortcut('yes please help me think about this', p)).toBeNull();
    expect(matchProposalShortcut('now what?', p)).toBeNull();
    expect(matchProposalShortcut('not today', p)).toBeNull();
  });

  test('explicit-yes proposals skip the y shortcut but still route bare n', () => {
    const p = makeProposal({ requiresExplicitYes: true, summary: 'deploy to prod' });
    expect(matchProposalShortcut('y', p)).toBeNull();
    expect(matchProposalShortcut('yes', p)).toBeNull();
    // "no" still works — rejection never needs a phrase match.
    expect(matchProposalShortcut('n', p)).toEqual({ kind: 'proposalNo' });
    expect(matchProposalShortcut('no', p)).toEqual({ kind: 'proposalNo' });
  });

  test('ignores any input that is not exactly y/yes/n/no', () => {
    const p = makeProposal();
    expect(matchProposalShortcut('ok', p)).toBeNull();
    expect(matchProposalShortcut('/yes', p)).toBeNull(); // leading slash ≠ bare
    expect(matchProposalShortcut('', p)).toBeNull();
  });
});
