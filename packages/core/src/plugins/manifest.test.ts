import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { loadPluginManifest, parsePluginManifest } from './manifest.js';
import { PluginManifestError } from './types.js';

describe('parsePluginManifest', () => {
  test('accepts a minimal manifest and applies defaults to contributes', () => {
    const fm = parsePluginManifest({ name: 'foo', version: '1.0.0' }, '/tmp/foo');
    expect(fm.name).toBe('foo');
    expect(fm.permissions).toEqual([]);
    expect(fm.contributes.tools).toEqual([]);
    expect(fm.contributes.skills).toEqual([]);
    expect(fm.contributes.mcpServers).toEqual([]);
    expect(fm.contributes.hooks).toEqual([]);
    expect(fm.contributes.commands).toEqual([]);
  });

  test('parses an mcpServers entry with stdio transport', () => {
    const fm = parsePluginManifest(
      {
        name: 'gh',
        version: '1.0.0',
        contributes: {
          mcpServers: [
            {
              name: 'github',
              transport: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-server-github'] },
              protocolVersion: '2024-11-05',
            },
          ],
        },
      },
      '/tmp/gh',
    );
    expect(fm.contributes.mcpServers).toHaveLength(1);
    const srv = fm.contributes.mcpServers[0];
    expect(srv?.name).toBe('github');
    expect(srv?.transport.type).toBe('stdio');
  });

  test('rejects mcpServers[].name that contains slashes', () => {
    expect(() =>
      parsePluginManifest(
        {
          name: 'x',
          version: '1.0.0',
          contributes: {
            mcpServers: [
              {
                name: 'github/main',
                transport: { type: 'stdio', command: 'a' },
                protocolVersion: '2024-11-05',
              },
            ],
          },
        },
        '/tmp/x',
      ),
    ).toThrow(PluginManifestError);
  });

  test('rejects missing required name/version', () => {
    expect(() => parsePluginManifest({ name: 'x' }, '/tmp/x')).toThrow(/version/);
    expect(() => parsePluginManifest({ version: '1.0.0' }, '/tmp/x')).toThrow(/name/);
  });

  test('error message includes the offending field path', () => {
    let err: unknown;
    try {
      parsePluginManifest({ name: 'x', version: '1.0.0', permissions: 'wrong' }, '/tmp/x');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PluginManifestError);
    expect((err as Error).message).toContain('permissions');
  });
});

describe('loadPluginManifest', () => {
  test('reads the fixture plugin.json and validates it', async () => {
    const dir = path.resolve(import.meta.dir, '__fixtures__', 'plugin-sample');
    const fm = await loadPluginManifest(dir);
    expect(fm.name).toBe('@declaragent/plugin-sample');
    expect(fm.contributes.tools).toEqual(['./dist/tools.ts']);
    expect(fm.contributes.skills).toEqual(['./skills/']);
    expect(fm.contributes.hooks).toEqual(['./dist/hooks.ts']);
  });

  test('throws PluginManifestError for a missing plugin.json', async () => {
    await expect(loadPluginManifest('/tmp/declaragent-no-such-plugin')).rejects.toBeInstanceOf(
      PluginManifestError,
    );
  });
});
