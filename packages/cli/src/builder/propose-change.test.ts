import { describe, expect, test } from 'bun:test';
import { ProposalRegistry } from './proposals.js';
import { createProposeChangeTool } from './propose-change.js';

function makeCtx(abortController = new AbortController()) {
  return {
    session: {} as never,
    permissions: {} as never,
    abortSignal: abortController.signal,
    depth: 0,
    runAgent: (async () => ({}) as never) as never,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as never,
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('DeclaraProposeChange tool', () => {
  test('tool metadata reflects "no side effects"', () => {
    const reg = new ProposalRegistry();
    const tool = createProposeChangeTool({ registry: reg });
    expect(tool.name).toBe('DeclaraProposeChange');
    expect(tool.readonly).toBe(true);
    expect(tool.parallelSafe).toBe(false);
  });

  test('validates input shape', async () => {
    const reg = new ProposalRegistry();
    const tool = createProposeChangeTool({ registry: reg });
    const events = await collect(tool.execute({ summary: '', steps: [] } as never, makeCtx()));
    expect((events[0] as { type: string }).type).toBe('error');
  });

  test('happy path: registers + awaits + returns confirmed + finalSteps', async () => {
    const reg = new ProposalRegistry();
    const tool = createProposeChangeTool({ registry: reg });

    // Fire the tool in the background. Resolve when we confirm.
    const promise = collect(
      tool.execute(
        {
          summary: 'add pr-review skill',
          steps: [
            {
              kind: 'addSkill',
              description: 'create skills/pr-review.md',
              payload: { name: 'pr-review', description: 'd', body: 'b' },
            },
          ],
        },
        makeCtx(),
      ),
    );

    // Wait for the registry to have a pending proposal, then confirm it.
    // The registered event fires synchronously from register().
    await Promise.resolve();
    const active = reg.active();
    expect(active).toBeDefined();
    if (!active) throw new Error('no active proposal');
    // Edit step 1 before confirming.
    reg.edit(active.id, 0, 'create skills/pr-review.md (revised)');
    reg.confirm(active.id);

    const events = await promise;
    expect(events).toHaveLength(1);
    const ev = events[0] as {
      type: string;
      output?: {
        confirmed: boolean;
        proposalId: string;
        finalSteps: Array<{ kind: string; description: string }>;
        reason: string;
      };
    };
    expect(ev.type).toBe('result');
    expect(ev.output?.confirmed).toBe(true);
    expect(ev.output?.proposalId).toBe(active.id);
    expect(ev.output?.finalSteps[0]?.description).toBe('create skills/pr-review.md (revised)');
    expect(ev.output?.reason).toBe('confirmed');
  });

  test('rejection path: confirmed false + reason rejected', async () => {
    const reg = new ProposalRegistry();
    const tool = createProposeChangeTool({ registry: reg });
    const promise = collect(
      tool.execute(
        {
          summary: 'x',
          steps: [{ kind: 'addSecret', description: 'x', payload: {} }],
        },
        makeCtx(),
      ),
    );
    await Promise.resolve();
    const active = reg.active();
    if (!active) throw new Error('no active proposal');
    reg.reject(active.id);
    const events = await promise;
    const ev = events[0] as { output?: { confirmed: boolean; reason: string } };
    expect(ev.output?.confirmed).toBe(false);
    expect(ev.output?.reason).toBe('rejected');
  });

  test('expiry path: ttl fires → confirmed false + reason expired', async () => {
    const reg = new ProposalRegistry({ ttlMs: 15 });
    const tool = createProposeChangeTool({ registry: reg });
    const events = await collect(
      tool.execute(
        {
          summary: 'x',
          steps: [{ kind: 'addSecret', description: 'x', payload: {} }],
        },
        makeCtx(),
      ),
    );
    const ev = events[0] as { output?: { confirmed: boolean; reason: string } };
    expect(ev.output?.confirmed).toBe(false);
    expect(ev.output?.reason).toBe('expired');
  });

  test('abort signal before run → rejects the registered proposal', async () => {
    const reg = new ProposalRegistry();
    const tool = createProposeChangeTool({ registry: reg });
    const controller = new AbortController();
    const promise = collect(
      tool.execute(
        {
          summary: 'x',
          steps: [{ kind: 'addSkill', description: 'x', payload: {} }],
        },
        makeCtx(controller),
      ),
    );
    await Promise.resolve();
    controller.abort();
    const events = await promise;
    expect((events[0] as { type: string }).type).toBe('error');
    // Registry state moved to rejected via the abort handler.
    const p = reg.active();
    expect(p).toBeUndefined();
  });
});
