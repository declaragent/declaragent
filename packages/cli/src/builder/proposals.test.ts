import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROPOSAL_TTL_MS,
  PROPOSAL_STEP_KINDS,
  ProposalRegistry,
  renderProposal,
} from './proposals.js';
import type { ProposalEvent } from './proposals.js';

function mkStep(description = 'do thing') {
  return { kind: 'addSkill' as const, description, payload: {} };
}

describe('ProposalRegistry.register', () => {
  test('returns a pending proposal + a promise', () => {
    const reg = new ProposalRegistry();
    const { proposal, wait } = reg.register({ summary: 'x', steps: [mkStep()] });
    expect(proposal.status).toBe('pending');
    expect(proposal.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(wait).toBeInstanceOf(Promise);
  });

  test('emits a "registered" event to subscribers', () => {
    const reg = new ProposalRegistry();
    const events: ProposalEvent[] = [];
    reg.subscribe((ev) => events.push(ev));
    reg.register({ summary: 'x', steps: [mkStep()] });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('registered');
  });

  test('active() returns the most-recent pending proposal', () => {
    const reg = new ProposalRegistry();
    const a = reg.register({ summary: 'first', steps: [mkStep()] }).proposal;
    const b = reg.register({ summary: 'second', steps: [mkStep()] }).proposal;
    expect(reg.active()?.id).toBe(b.id);
    reg.reject(b.id);
    expect(reg.active()?.id).toBe(a.id);
  });
});

describe('ProposalRegistry.confirm / reject', () => {
  test('confirm resolves with confirmed: true', async () => {
    const reg = new ProposalRegistry();
    const { proposal, wait } = reg.register({ summary: 'x', steps: [mkStep()] });
    expect(reg.confirm(proposal.id)).toBe(true);
    const res = await wait;
    expect(res.confirmed).toBe(true);
    expect(res.reason).toBe('confirmed');
    expect(reg.get(proposal.id)?.status).toBe('confirmed');
  });

  test('reject resolves with confirmed: false', async () => {
    const reg = new ProposalRegistry();
    const { proposal, wait } = reg.register({ summary: 'x', steps: [mkStep()] });
    expect(reg.reject(proposal.id)).toBe(true);
    const res = await wait;
    expect(res.confirmed).toBe(false);
    expect(res.reason).toBe('rejected');
    expect(reg.get(proposal.id)?.status).toBe('rejected');
  });

  test('confirming a missing id is a no-op', () => {
    const reg = new ProposalRegistry();
    expect(reg.confirm('nope')).toBe(false);
  });

  test('second confirm on the same proposal is a no-op', async () => {
    const reg = new ProposalRegistry();
    const { proposal, wait } = reg.register({ summary: 'x', steps: [mkStep()] });
    reg.confirm(proposal.id);
    await wait;
    expect(reg.confirm(proposal.id)).toBe(false);
  });
});

describe('ProposalRegistry.edit', () => {
  test('mutates the step description in place', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({
      summary: 'x',
      steps: [mkStep('old'), mkStep('other')],
    });
    expect(reg.edit(proposal.id, 0, 'new')).toBe(true);
    expect(proposal.steps[0]?.description).toBe('new');
    expect(proposal.steps[1]?.description).toBe('other');
  });

  test('rejects out-of-range indices', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({ summary: 'x', steps: [mkStep()] });
    expect(reg.edit(proposal.id, -1, 'n')).toBe(false);
    expect(reg.edit(proposal.id, 5, 'n')).toBe(false);
  });

  test('rejects edits once the proposal is no longer pending', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({ summary: 'x', steps: [mkStep()] });
    reg.confirm(proposal.id);
    expect(reg.edit(proposal.id, 0, 'n')).toBe(false);
  });

  test('emits "edited" with step index + replacement', () => {
    const reg = new ProposalRegistry();
    const events: ProposalEvent[] = [];
    reg.subscribe((ev) => events.push(ev));
    const { proposal } = reg.register({ summary: 'x', steps: [mkStep()] });
    reg.edit(proposal.id, 0, 'revised');
    const edited = events.find((e) => e.type === 'edited');
    expect(edited).toBeDefined();
    if (edited?.type === 'edited') {
      expect(edited.stepIndex).toBe(0);
      expect(edited.replacement).toBe('revised');
    }
  });
});

describe('ProposalRegistry.markApplied', () => {
  test('only transitions from confirmed → applied', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({ summary: 'x', steps: [mkStep()] });
    // Not confirmed yet.
    expect(reg.markApplied(proposal.id)).toBe(false);
    reg.confirm(proposal.id);
    expect(reg.markApplied(proposal.id)).toBe(true);
    // Idempotent second call.
    expect(reg.markApplied(proposal.id)).toBe(false);
  });

  test('stores rollback metadata when provided', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({ summary: 'x', steps: [mkStep()] });
    reg.confirm(proposal.id);
    reg.markApplied(proposal.id, {
      gitHeadBefore: 'deadbeef',
      writes: ['/tmp/a', '/tmp/b'],
      appliedAt: 12345,
    });
    const last = reg.lastApplied();
    expect(last?.proposalId).toBe(proposal.id);
    expect(last?.gitHeadBefore).toBe('deadbeef');
    expect(last?.writes).toEqual(['/tmp/a', '/tmp/b']);
    expect(last?.appliedAt).toBe(12345);
  });

  test('lastApplied reflects the most recent apply', () => {
    const reg = new ProposalRegistry();
    const a = reg.register({ summary: 'a', steps: [mkStep()] });
    const b = reg.register({ summary: 'b', steps: [mkStep()] });
    reg.confirm(a.proposal.id);
    reg.confirm(b.proposal.id);
    reg.markApplied(a.proposal.id, { gitHeadBefore: 'aa', writes: ['/a'], appliedAt: 1 });
    reg.markApplied(b.proposal.id, { gitHeadBefore: 'bb', writes: ['/b'], appliedAt: 2 });
    expect(reg.lastApplied()?.proposalId).toBe(b.proposal.id);
  });

  test('markApplied without meta leaves lastApplied untouched', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({ summary: 'x', steps: [mkStep()] });
    reg.confirm(proposal.id);
    reg.markApplied(proposal.id);
    expect(reg.lastApplied()).toBeUndefined();
  });
});

describe('ProposalRegistry.markReverted + clearLastApplied', () => {
  test('markReverted emits event + clears lastApplied', () => {
    const reg = new ProposalRegistry();
    const events: Array<{ type: string }> = [];
    reg.subscribe((ev) => events.push(ev));
    const { proposal } = reg.register({ summary: 'x', steps: [mkStep()] });
    reg.confirm(proposal.id);
    reg.markApplied(proposal.id, { gitHeadBefore: 'x', writes: ['/a'], appliedAt: 1 });
    expect(reg.lastApplied()).toBeDefined();
    reg.markReverted(proposal.id, ['/a']);
    expect(reg.lastApplied()).toBeUndefined();
    expect(events.some((e) => e.type === 'reverted')).toBe(true);
  });

  test('clearLastApplied is callable standalone', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({ summary: 'x', steps: [mkStep()] });
    reg.confirm(proposal.id);
    reg.markApplied(proposal.id, { gitHeadBefore: 'x', writes: ['/a'], appliedAt: 1 });
    reg.clearLastApplied();
    expect(reg.lastApplied()).toBeUndefined();
  });
});

describe('ProposalRegistry expiry', () => {
  test('expires after ttlMs and resolves with reason: expired', async () => {
    const reg = new ProposalRegistry({ ttlMs: 20 });
    const { proposal, wait } = reg.register({ summary: 'x', steps: [mkStep()] });
    const res = await wait;
    expect(res.confirmed).toBe(false);
    expect(res.reason).toBe('expired');
    expect(reg.get(proposal.id)?.status).toBe('expired');
  });

  test('DEFAULT_PROPOSAL_TTL_MS is 15 minutes', () => {
    expect(DEFAULT_PROPOSAL_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe('purgeResolved', () => {
  test('clears non-pending proposals', async () => {
    const reg = new ProposalRegistry();
    const a = reg.register({ summary: 'a', steps: [mkStep()] });
    const b = reg.register({ summary: 'b', steps: [mkStep()] });
    reg.confirm(a.proposal.id);
    await a.wait;
    expect(reg.size()).toBe(2);
    expect(reg.purgeResolved()).toBe(1);
    expect(reg.size()).toBe(1);
    expect(reg.get(b.proposal.id)?.status).toBe('pending');
    reg.reject(b.proposal.id);
    await b.wait;
  });
});

describe('renderProposal', () => {
  test('includes header, steps, and the help line', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({
      summary: 'add pr-review skill',
      steps: [
        { kind: 'addSkill', description: 'create skills/pr-review.md', payload: {} },
        {
          kind: 'addSecret',
          description: 'reserve GITHUB_TOKEN',
          preview: 'DECLARA_GITHUB_TOKEN=',
          payload: {},
        },
      ],
    });
    const md = renderProposal(proposal);
    expect(md).toContain('add pr-review skill');
    expect(md).toContain('1. [addSkill]');
    expect(md).toContain('2. [addSecret]');
    expect(md).toContain('DECLARA_GITHUB_TOKEN=');
    expect(md).toContain('/yes');
    expect(md).toContain('/no');
    expect(md).toContain('/edit');
    reg.reject(proposal.id);
  });

  test('marks the explicit-yes requirement when present', () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({
      summary: 'deploy to prod',
      steps: [mkStep()],
      requiresExplicitYes: true,
    });
    expect(renderProposal(proposal)).toContain('requires typing "/yes <exact-phrase>"');
    reg.reject(proposal.id);
  });
});

describe('PROPOSAL_STEP_KINDS', () => {
  test('exposes the ten planned kinds', () => {
    expect(PROPOSAL_STEP_KINDS).toEqual([
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
    ]);
  });
});
