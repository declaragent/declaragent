import { describe, expect, test } from 'bun:test';
import type { Tool, ToolContext, ToolEvent } from '../types/tool.js';
import { toolExtension } from './tool-extension.js';

const fakeTool: Tool = {
  name: 'Bash',
  description: 'fake',
  inputSchema: { type: 'object' },
  permissionKey: () => 'k',
  async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    yield { type: 'result', output: null };
  },
};

describe('toolExtension', () => {
  test('produces a `tool` descriptor with built-in source by default', () => {
    const ext = toolExtension(fakeTool);
    expect(ext.descriptor.id).toBe('tool:Bash');
    expect(ext.descriptor.kind).toBe('tool');
    expect(ext.descriptor.source).toEqual({ type: 'built-in' });
    expect(ext.payload).toBe(fakeTool);
  });

  test('accepts a custom source (e.g. plugin-contributed tool)', () => {
    const ext = toolExtension(fakeTool, {
      type: 'plugin',
      pluginId: '@declaragent/plugin-x',
      pluginVersion: '1.2.3',
    });
    expect(ext.descriptor.source).toEqual({
      type: 'plugin',
      pluginId: '@declaragent/plugin-x',
      pluginVersion: '1.2.3',
    });
  });

  test('activate is a no-op (does not throw)', async () => {
    const ext = toolExtension(fakeTool);
    await expect(
      Promise.resolve(
        ext.activate({
          registry: {} as never,
          logger: {} as never,
          permissions: {} as never,
          configDir: '/tmp',
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
