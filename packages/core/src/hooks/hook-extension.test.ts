import { describe, expect, test } from 'bun:test';
import type { TurnContext } from '../types/agent.js';
import { bindHookExtensions, hookExtension } from './hook-extension.js';
import { createHookRegistry } from './registry.js';

const TURN: TurnContext = { sessionId: 'sess-1', turnId: 'turn-1', depth: 0 };

describe('hookExtension', () => {
  test('produces a `hook` descriptor with the supplied source', () => {
    const ext = hookExtension(
      { point: 'turn.start', subscriber: () => {} },
      { type: 'plugin', pluginId: '@declaragent/plugin-x', pluginVersion: '0.1.0' },
    );
    expect(ext.descriptor.kind).toBe('hook');
    expect(ext.descriptor.id.startsWith('hook:turn.start:')).toBe(true);
    expect(ext.descriptor.source).toEqual({
      type: 'plugin',
      pluginId: '@declaragent/plugin-x',
      pluginVersion: '0.1.0',
    });
  });

  test('honors a caller-supplied id (used for stable rule attribution)', () => {
    const ext = hookExtension(
      { point: 'tool.after', subscriber: () => {} },
      { type: 'user' },
      'hook:user:metrics',
    );
    expect(ext.descriptor.id).toBe('hook:user:metrics');
  });
});

describe('bindHookExtensions', () => {
  test('subscribes every extension and unbind detaches all of them', async () => {
    const reg = createHookRegistry();
    const seen: string[] = [];
    const exts = [
      hookExtension(
        {
          point: 'turn.start',
          subscriber: () => {
            seen.push('a');
          },
        },
        { type: 'user' },
      ),
      hookExtension(
        {
          point: 'turn.start',
          subscriber: () => {
            seen.push('b');
          },
        },
        { type: 'user' },
      ),
    ];
    const off = bindHookExtensions(reg, exts);
    await reg.fire('turn.start', { turn: TURN });
    expect(seen).toEqual(['a', 'b']);
    off();
    await reg.fire('turn.start', { turn: TURN });
    expect(seen).toEqual(['a', 'b']);
  });
});
