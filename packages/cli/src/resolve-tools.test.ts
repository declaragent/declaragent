import { describe, expect, test } from 'bun:test';
import type { Tool } from '@declaragent/core';
import { BUILTIN_TOOLS } from './builtin-tools.js';
import { AgentToolConfigError, resolveRuntimeTools } from './resolve-tools.js';

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permissionKey: () => '',
    // biome-ignore lint/correctness/useYield: test stub
    async *execute() {},
  };
}

const names = (tools: readonly Tool[]) => tools.map((t) => t.name).sort();

async function allowed(
  gate: ReturnType<typeof resolveRuntimeTools>['gate'],
  tool: string,
  key = 'x',
) {
  const d = await gate.check(tool, key);
  return d.outcome;
}

describe('resolveRuntimeTools', () => {
  test('declared builtins only — Bash/Write/Edit/Agent excluded when not declared', async () => {
    const res = resolveRuntimeTools({ declared: ['Read', 'Glob', 'Grep'] });
    expect(names(res.tools)).toEqual(['Glob', 'Grep', 'Read']);
    expect(res.tools.find((t) => t.name === 'Bash')).toBeUndefined();
    expect(await allowed(res.gate, 'Read')).toBe('allow');
    // Bash is not in the list and has no allow rule → prompt (denied headless).
    expect(await allowed(res.gate, 'Bash', 'rm -rf /')).toBe('prompt');
  });

  test('unknown builtin name fails boot', () => {
    expect(() => resolveRuntimeTools({ declared: ['Read', 'Bsah'] })).toThrow(AgentToolConfigError);
    expect(() => resolveRuntimeTools({ declared: ['Bsah'] })).toThrow(/unknown tool/);
  });

  test('capability tools are auto-exempt and always allowed', async () => {
    const send = fakeTool('SendMessage');
    const res = resolveRuntimeTools({ declared: ['Read'], extra: [send] });
    expect(res.tools.find((t) => t.name === 'SendMessage')).toBeDefined();
    expect(await allowed(res.gate, 'SendMessage')).toBe('allow');
    // and declaring a capability tool that isn't present is harmless (no throw)
    expect(() => resolveRuntimeTools({ declared: ['Read', 'RequestAgent'] })).not.toThrow();
  });

  test('MCP glob matches included tools and warns on zero match', async () => {
    const mcp = [fakeTool('mcp__github__list_issues'), fakeTool('mcp__github__create_issue')];
    const res = resolveRuntimeTools({
      declared: ['Read', 'mcp__github__*', 'mcp__slack__*'],
      mcpTools: mcp,
    });
    expect(names(res.tools)).toContain('mcp__github__list_issues');
    expect(names(res.tools)).toContain('mcp__github__create_issue');
    expect(await allowed(res.gate, 'mcp__github__list_issues')).toBe('allow');
    expect(res.warnings.some((w) => w.includes('mcp__slack__*'))).toBe(true);
  });

  test('operator deny rule overrides the synthesized allow', async () => {
    const res = resolveRuntimeTools({
      declared: ['Bash'],
      permissionRules: [{ pattern: 'Bash:rm **', decision: 'deny' }],
    });
    expect(await allowed(res.gate, 'Bash', 'git status')).toBe('allow');
    expect(await allowed(res.gate, 'Bash', 'rm -rf /')).toBe('deny');
  });

  test('empty tools.defaults exposes all builtins but warns (legacy default)', async () => {
    const res = resolveRuntimeTools({ declared: [] });
    expect(names(res.tools)).toEqual(names(BUILTIN_TOOLS));
    expect(await allowed(res.gate, 'Bash', 'x')).toBe('allow');
    expect(res.warnings.some((w) => w.includes('no tools.defaults'))).toBe(true);
  });

  test('legacy flag bypasses enforcement and exposes everything', async () => {
    const mcp = [fakeTool('mcp__x__y')];
    const res = resolveRuntimeTools({ declared: ['Read'], mcpTools: mcp, legacy: true });
    expect(names(res.tools)).toContain('Bash');
    expect(names(res.tools)).toContain('mcp__x__y');
    expect(await allowed(res.gate, 'Bash', 'x')).toBe('allow');
    expect(res.warnings.some((w) => w.includes('LEGACY'))).toBe(true);
  });

  test('tool list ordering is builtins → MCP → capability/plugin', () => {
    const mcp = [fakeTool('mcp__x__y')];
    const send = fakeTool('SendMessage');
    const res = resolveRuntimeTools({
      declared: ['Read', 'mcp__x__*'],
      mcpTools: mcp,
      extra: [send],
    });
    expect(res.tools.map((t) => t.name)).toEqual(['Read', 'mcp__x__y', 'SendMessage']);
  });
});
