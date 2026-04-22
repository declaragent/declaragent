import type { Hook } from '../../../../hooks/types.js';

/**
 * Fixture hooks. The `tool.before` subscriber records every call into a
 * module-level array so tests can assert it ran.
 */
export const SEEN: Array<{ point: string; toolName: string }> = [];

const toolBefore: Hook<'tool.before'> = {
  point: 'tool.before',
  subscriber: ({ call }) => {
    SEEN.push({ point: 'tool.before', toolName: call.toolName });
    return undefined;
  },
};

export const hooks: Hook[] = [toolBefore as Hook];
