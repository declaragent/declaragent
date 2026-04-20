import { describe, expect, test } from 'bun:test';
import type { TurnContext } from '../types/agent.js';
import type { LoopHooks } from '../types/hooks.js';
import type { CompletedToolCall, PendingToolCall } from '../types/tool.js';
import { bindLoopHooks, createHookRegistry } from './registry.js';

const TURN: TurnContext = { sessionId: 'sess-1', turnId: 'turn-1', depth: 0 };

const PENDING_CALL: PendingToolCall = {
  id: 'call-1',
  toolName: 'Bash',
  input: { command: 'ls' },
  permissionKey: 'ls',
};

const COMPLETED_CALL: CompletedToolCall = {
  ...PENDING_CALL,
  output: 'a\nb',
  durationMs: 12,
};

describe('createHookRegistry', () => {
  test('subscribers run in registration order', async () => {
    const reg = createHookRegistry();
    const order: string[] = [];
    reg.on('turn.start', () => {
      order.push('a');
    });
    reg.on('turn.start', () => {
      order.push('b');
    });
    reg.on('turn.start', () => {
      order.push('c');
    });
    await reg.fire('turn.start', { turn: TURN });
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('unsubscribe stops a subscriber from being invoked', async () => {
    const reg = createHookRegistry();
    let count = 0;
    const off = reg.on('turn.start', () => {
      count++;
    });
    await reg.fire('turn.start', { turn: TURN });
    off();
    await reg.fire('turn.start', { turn: TURN });
    expect(count).toBe(1);
  });

  test('before-style hooks short-circuit on first non-undefined return', async () => {
    const reg = createHookRegistry();
    const calls: string[] = [];
    reg.on('tool.before', () => {
      calls.push('first');
      return undefined;
    });
    reg.on('tool.before', () => {
      calls.push('second');
      return { output: 'intercepted' };
    });
    reg.on('tool.before', () => {
      calls.push('third'); // must not run
      return { output: 'should-not-win' };
    });
    const result = await reg.fire('tool.before', { call: PENDING_CALL, turn: TURN });
    expect(calls).toEqual(['first', 'second']);
    expect(result).toEqual({ output: 'intercepted' });
  });

  test('after-style hooks fan out and return undefined', async () => {
    const reg = createHookRegistry();
    const seen: string[] = [];
    reg.on('tool.after', () => {
      seen.push('a');
      return undefined;
    });
    reg.on('tool.after', () => {
      seen.push('b');
      return undefined;
    });
    reg.on('tool.after', () => {
      seen.push('c');
      return undefined;
    });
    const result = await reg.fire('tool.after', { call: COMPLETED_CALL, turn: TURN });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(result).toBeUndefined();
  });

  test('async subscribers are awaited and their order is preserved', async () => {
    const reg = createHookRegistry();
    const order: string[] = [];
    reg.on('turn.start', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('slow');
    });
    reg.on('turn.start', () => {
      order.push('fast');
    });
    await reg.fire('turn.start', { turn: TURN });
    expect(order).toEqual(['slow', 'fast']);
  });

  test('after-hook errors are caught (logged) so other subscribers still run', async () => {
    const seen: string[] = [];
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const reg = createHookRegistry({
      logger: {
        debug() {},
        info() {},
        warn(_event, data) {
          warnings.push(data);
        },
        error() {},
        child: () => ({
          debug() {},
          info() {},
          warn(_event: string, data: Record<string, unknown> | undefined) {
            warnings.push(data);
          },
          error() {},
          child: () => undefined as never,
        }),
      },
    });
    reg.on('tool.after', () => {
      throw new Error('telemetry oops');
    });
    reg.on('tool.after', () => {
      seen.push('still-ran');
    });
    await reg.fire('tool.after', { call: COMPLETED_CALL, turn: TURN });
    expect(seen).toEqual(['still-ran']);
    expect(warnings.length).toBe(1);
  });

  test('before-hook errors abort the chain (caller-handled)', async () => {
    const reg = createHookRegistry();
    let secondCalled = false;
    reg.on('tool.before', () => {
      throw new Error('compliance block');
    });
    reg.on('tool.before', () => {
      secondCalled = true;
    });
    await expect(reg.fire('tool.before', { call: PENDING_CALL, turn: TURN })).rejects.toThrow(
      'compliance block',
    );
    expect(secondCalled).toBe(false);
  });

  test('list and count reflect current subscriptions', async () => {
    const reg = createHookRegistry();
    expect(reg.list()).toEqual([]);
    const off = reg.on('turn.start', () => {});
    reg.on('tool.after', () => {});
    expect(new Set(reg.list())).toEqual(new Set(['turn.start', 'tool.after']));
    expect(reg.count('turn.start')).toBe(1);
    off();
    expect(reg.count('turn.start')).toBe(0);
  });

  test('compact.before override returns the rewritten transcript', async () => {
    const reg = createHookRegistry();
    reg.on('compact.before', () => ({ transcript: [] }));
    const out = await reg.fire('compact.before', { transcript: [] });
    expect(out).toEqual({ transcript: [] });
  });
});

describe('bindLoopHooks (back-compat shim)', () => {
  test('routes Phase-1 LoopHooks callbacks through the registry', async () => {
    const seen: string[] = [];
    const hooks: LoopHooks = {
      onTurnStart: () => {
        seen.push('turn.start');
      },
      onTurnEnd: () => {
        seen.push('turn.end');
      },
      onToolCallBefore: () => {
        seen.push('tool.before');
        return { output: 'shim-intercepted' };
      },
      onToolCallAfter: () => {
        seen.push('tool.after');
      },
      onCompactBefore: () => {
        seen.push('compact.before');
      },
    };
    const reg = createHookRegistry();
    bindLoopHooks(reg, hooks);

    await reg.fire('turn.start', { turn: TURN });
    const before = await reg.fire('tool.before', { call: PENDING_CALL, turn: TURN });
    await reg.fire('tool.after', { call: COMPLETED_CALL, turn: TURN });
    await reg.fire('compact.before', { transcript: [] });
    await reg.fire('turn.end', {
      turn: TURN,
      result: { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    });

    expect(seen).toEqual(['turn.start', 'tool.before', 'tool.after', 'compact.before', 'turn.end']);
    expect(before).toEqual({ output: 'shim-intercepted' });
  });

  test('returned unsubscribe handles detach the shim', async () => {
    let count = 0;
    const reg = createHookRegistry();
    const offs = bindLoopHooks(reg, {
      onTurnStart: () => {
        count++;
      },
    });
    await reg.fire('turn.start', { turn: TURN });
    for (const off of offs) off();
    await reg.fire('turn.start', { turn: TURN });
    expect(count).toBe(1);
  });
});
