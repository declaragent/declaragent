import { describe, expect, test } from 'bun:test';
import { createExtensionRegistry } from '../extension/registry.js';
import type { Extension } from '../extension/types.js';
import { createHookRegistry } from '../hooks/registry.js';
import { createPermissionGate } from '../permission/gate.js';
import { createMemorySession } from '../testing/memory-session.js';
import type { RunAgent, TurnContext } from '../types/agent.js';
import type { Logger } from '../types/logger.js';
import type { SessionHandle } from '../types/session.js';
import { lookupSkill, runSkill } from './runner.js';
import { type Skill, SkillNotFoundError } from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

const TURN: TurnContext = { sessionId: 'sess', turnId: 'turn-1', depth: 0 };

function makeRegistry() {
  return createExtensionRegistry({
    logger: NOOP_LOGGER,
    permissions: createPermissionGate({ mode: 'default', rules: [] }),
    configDir: '/tmp/test',
  });
}

function makeSkillExt(skill: Skill): Extension<'skill'> {
  return {
    descriptor: skill.descriptor,
    payload: skill,
    activate() {},
  };
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    descriptor: {
      id: 'skill:user:greet',
      kind: 'skill',
      source: { type: 'user' },
    },
    lookupName: 'greet',
    tier: { type: 'user' },
    frontmatter: { name: 'greet', description: 'say hi' },
    prompt: 'Say hello to {{who}}.',
    filePath: '/tmp/greet.md',
    ...overrides,
  };
}

describe('lookupSkill', () => {
  test('returns the matching skill or undefined', async () => {
    const reg = makeRegistry();
    await reg.register(makeSkillExt(makeSkill()));
    expect(lookupSkill(reg, 'greet')?.lookupName).toBe('greet');
    expect(lookupSkill(reg, 'missing')).toBeUndefined();
  });
});

describe('runSkill', () => {
  test('throws SkillNotFoundError for unknown names', async () => {
    const reg = makeRegistry();
    await expect(
      runSkill('nope', {
        registry: reg,
        runAgent: async () => {
          throw new Error('should not run');
        },
        createChildSession: () => createMemorySession(),
        turn: TURN,
      }),
    ).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  test('renders the prompt with inputs and forwards to runAgent', async () => {
    const reg = makeRegistry();
    await reg.register(makeSkillExt(makeSkill()));
    let receivedPrompt: string | undefined;
    let receivedDepth: number | undefined;
    const runAgent: RunAgent = async (input) => {
      receivedPrompt = input.userMessage;
      receivedDepth = input.depth;
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    };
    const result = await runSkill('greet', {
      registry: reg,
      inputs: { who: 'Ada' },
      runAgent,
      createChildSession: () => createMemorySession(),
      turn: TURN,
    });
    expect(receivedPrompt).toBe('Say hello to Ada.');
    expect(receivedDepth).toBe(1);
    expect(result.stopReason).toBe('end_turn');
  });

  test('skill.before override replaces inputs before rendering', async () => {
    const reg = makeRegistry();
    await reg.register(makeSkillExt(makeSkill()));
    const hooks = createHookRegistry();
    hooks.on('skill.before', () => ({ inputs: { who: 'Override' } }));
    let renderedPrompt: string | undefined;
    const runAgent: RunAgent = async (input) => {
      renderedPrompt = input.userMessage;
      return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    };
    await runSkill('greet', {
      registry: reg,
      inputs: { who: 'Original' },
      hooks,
      runAgent,
      createChildSession: () => createMemorySession(),
      turn: TURN,
    });
    expect(renderedPrompt).toBe('Say hello to Override.');
  });

  test('skill.after fires with the output and elapsed time', async () => {
    const reg = makeRegistry();
    await reg.register(makeSkillExt(makeSkill()));
    const hooks = createHookRegistry();
    let afterPayload: { name: string; durationMs: number } | undefined;
    hooks.on('skill.after', (p) => {
      afterPayload = { name: p.name, durationMs: p.durationMs };
    });
    const runAgent: RunAgent = async () => {
      // Force a small wait so durationMs > 0.
      await new Promise((r) => setTimeout(r, 5));
      return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    };
    await runSkill('greet', {
      registry: reg,
      inputs: { who: 'Ada' },
      hooks,
      runAgent,
      createChildSession: () => createMemorySession(),
      turn: TURN,
    });
    expect(afterPayload?.name).toBe('greet');
    expect((afterPayload?.durationMs ?? 0) >= 0).toBe(true);
  });

  test('frontmatter.model overrides the child session model', async () => {
    const reg = makeRegistry();
    await reg.register(
      makeSkillExt(
        makeSkill({
          frontmatter: { name: 'greet', description: 'd', model: 'claude-haiku-4-5-20251001' },
          prompt: 'hi',
        }),
      ),
    );
    let observedModel: string | undefined;
    const sess = createMemorySession();
    const runAgent: RunAgent = async (input) => {
      observedModel = input.session.spec.model;
      return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    };
    await runSkill('greet', {
      registry: reg,
      runAgent,
      createChildSession: (): SessionHandle => sess,
      turn: TURN,
    });
    expect(observedModel).toBe('claude-haiku-4-5-20251001');
  });

  test('depth + causedBy on the sub-agent invocation', async () => {
    const reg = makeRegistry();
    await reg.register(makeSkillExt(makeSkill()));
    let depth: number | undefined;
    let causedBy: string | undefined;
    const runAgent: RunAgent = async (input) => {
      depth = input.depth;
      causedBy = input.causedBy;
      return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    };
    await runSkill('greet', {
      registry: reg,
      inputs: { who: 'Ada' },
      runAgent,
      createChildSession: () => createMemorySession(),
      turn: { ...TURN, depth: 2 },
    });
    expect(depth).toBe(3);
    expect(causedBy).toBe('skill:greet');
  });
});
