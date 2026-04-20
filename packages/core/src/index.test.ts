import { describe, expect, test } from 'bun:test';
import { VERSION } from './index.js';
import type { Message, PermissionDecision, PermissionRule, Tool, ToolEvent } from './index.js';

describe('@declaragent/core', () => {
  test('exports a version string', () => {
    expect(VERSION).toBe('0.0.1');
  });

  test('types compile and shape as expected', () => {
    const msg: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    };
    expect(msg.role).toBe('user');

    const rule: PermissionRule = { pattern: 'Bash:git *', decision: 'allow' };
    const decision: PermissionDecision = {
      outcome: 'allow',
      matchedRule: rule,
    };
    expect(decision.outcome).toBe('allow');

    const event: ToolEvent<string> = { type: 'result', output: 'ok' };
    expect(event.type).toBe('result');

    const fakeTool: Tool<{ path: string }, string> = {
      name: 'Fake',
      description: 'fake',
      inputSchema: {},
      permissionKey: (input) => `Fake:${input.path}`,
      execute: async function* () {
        yield { type: 'result', output: 'ok' };
      },
    };
    expect(fakeTool.permissionKey({ path: 'a.txt' })).toBe('Fake:a.txt');
  });
});
