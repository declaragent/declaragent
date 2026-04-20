import { describe, expect, test } from 'bun:test';
import { createPermissionGate } from '../permission/gate.js';
import type { Logger } from '../types/logger.js';
import type { Tool, ToolContext, ToolEvent } from '../types/tool.js';
import {
  ExtensionConflictError,
  ExtensionNotFoundError,
  createExtensionRegistry,
} from './registry.js';
import { toolExtension } from './tool-extension.js';
import type { Extension, ExtensionContext } from './types.js';

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

function makeRegistry() {
  return createExtensionRegistry({
    logger: NOOP_LOGGER,
    permissions: createPermissionGate({ mode: 'default', rules: [] }),
    configDir: '/tmp/declaragent-test',
  });
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: { type: 'object' },
    permissionKey: () => name,
    async *execute(_input: unknown, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield { type: 'result', output: name };
    },
  };
}

describe('ExtensionRegistry', () => {
  test('registers a built-in tool extension and looks it up by id', async () => {
    const reg = makeRegistry();
    const ext = toolExtension(fakeTool('Bash'));
    await reg.register(ext);
    expect(reg.get('tool:Bash')).toBe(ext);
  });

  test('byKind returns only matching extensions, in registration order', async () => {
    const reg = makeRegistry();
    await reg.register(toolExtension(fakeTool('Read')));
    await reg.register(toolExtension(fakeTool('Write')));
    const tools = reg.byKind('tool');
    expect(tools.map((e) => e.payload.name)).toEqual(['Read', 'Write']);
    expect(reg.byKind('skill')).toEqual([]);
  });

  test('list returns descriptors in registration order', async () => {
    const reg = makeRegistry();
    await reg.register(toolExtension(fakeTool('Read')));
    await reg.register(toolExtension(fakeTool('Write')));
    expect(reg.list().map((d) => d.id)).toEqual(['tool:Read', 'tool:Write']);
  });

  test('throws ExtensionConflictError on duplicate id', async () => {
    const reg = makeRegistry();
    await reg.register(toolExtension(fakeTool('Bash')));
    await expect(reg.register(toolExtension(fakeTool('Bash')))).rejects.toBeInstanceOf(
      ExtensionConflictError,
    );
  });

  test('conflict error names existing and incoming sources', async () => {
    const reg = makeRegistry();
    await reg.register(toolExtension(fakeTool('Bash')));
    try {
      await reg.register(
        toolExtension(fakeTool('Bash'), {
          type: 'plugin',
          pluginId: '@declaragent/plugin-x',
          pluginVersion: '1.0.0',
        }),
      );
      throw new Error('expected conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionConflictError);
      const e = err as ExtensionConflictError;
      expect(e.message).toContain('built-in');
      expect(e.message).toContain('@declaragent/plugin-x@1.0.0');
    }
  });

  test('register awaits activate and unregister awaits deactivate', async () => {
    const reg = makeRegistry();
    const calls: string[] = [];
    const ext: Extension<'tool'> = {
      descriptor: { id: 'tool:Slow', kind: 'tool', source: { type: 'built-in' } },
      payload: fakeTool('Slow'),
      async activate() {
        await Promise.resolve();
        calls.push('activate');
      },
      async deactivate() {
        await Promise.resolve();
        calls.push('deactivate');
      },
    };
    await reg.register(ext);
    expect(calls).toEqual(['activate']);
    await reg.unregister('tool:Slow');
    expect(calls).toEqual(['activate', 'deactivate']);
    expect(reg.get('tool:Slow')).toBeUndefined();
  });

  test('activate receives a context whose registry is the live one', async () => {
    const reg = makeRegistry();
    let received: ExtensionContext | undefined;
    const ext: Extension<'tool'> = {
      descriptor: { id: 'tool:Probe', kind: 'tool', source: { type: 'built-in' } },
      payload: fakeTool('Probe'),
      activate(ctx) {
        received = ctx;
      },
    };
    await reg.register(ext);
    expect(received?.registry).toBe(reg);
    expect(received?.configDir).toBe('/tmp/declaragent-test');
  });

  test('reload calls deactivate then activate, preserving registration order', async () => {
    const reg = makeRegistry();
    const calls: string[] = [];
    const trackedExt = (id: string): Extension<'tool'> => ({
      descriptor: { id, kind: 'tool', source: { type: 'built-in' } },
      payload: fakeTool(id),
      activate() {
        calls.push(`activate:${id}`);
      },
      deactivate() {
        calls.push(`deactivate:${id}`);
      },
    });
    await reg.register(trackedExt('tool:A'));
    await reg.register(trackedExt('tool:B'));
    await reg.register(trackedExt('tool:C'));
    calls.length = 0;

    await reg.reload('tool:B');
    expect(calls).toEqual(['deactivate:tool:B', 'activate:tool:B']);

    expect(reg.list().map((d) => d.id)).toEqual(['tool:A', 'tool:B', 'tool:C']);
  });

  test('unregister and reload throw ExtensionNotFoundError for unknown ids', async () => {
    const reg = makeRegistry();
    await expect(reg.unregister('tool:Missing')).rejects.toBeInstanceOf(ExtensionNotFoundError);
    await expect(reg.reload('tool:Missing')).rejects.toBeInstanceOf(ExtensionNotFoundError);
  });

  test('unregister removes the entry even if deactivate throws', async () => {
    const reg = makeRegistry();
    const ext: Extension<'tool'> = {
      descriptor: { id: 'tool:Bad', kind: 'tool', source: { type: 'built-in' } },
      payload: fakeTool('Bad'),
      activate() {},
      deactivate() {
        throw new Error('boom');
      },
    };
    await reg.register(ext);
    await expect(reg.unregister('tool:Bad')).rejects.toThrow('boom');
    expect(reg.get('tool:Bad')).toBeUndefined();
  });
});
