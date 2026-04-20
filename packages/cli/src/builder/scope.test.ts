import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertWithinScope, findAgentRoot, isWithinScope, resolveScopeRoot } from './scope.js';
import { BuilderScopeError } from './types.js';

describe('findAgentRoot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-scope-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns undefined when no agent.yaml anywhere up the chain', async () => {
    expect(await findAgentRoot(dir)).toBeUndefined();
  });

  test('finds agent.yaml in cwd itself', async () => {
    writeFileSync(join(dir, 'agent.yaml'), 'name: x\n');
    expect(await findAgentRoot(dir)).toBe(dir);
  });

  test('walks up from a nested cwd', async () => {
    writeFileSync(join(dir, 'agent.yaml'), 'name: x\n');
    const nested = join(dir, 'skills', 'deep', 'subdir');
    mkdirSync(nested, { recursive: true });
    expect(await findAgentRoot(nested)).toBe(dir);
  });

  test('stops at the first agent.yaml (no nested fall-through)', async () => {
    const outer = dir;
    const inner = join(dir, 'inner');
    mkdirSync(inner);
    writeFileSync(join(outer, 'agent.yaml'), 'name: outer\n');
    writeFileSync(join(inner, 'agent.yaml'), 'name: inner\n');
    expect(await findAgentRoot(inner)).toBe(inner);
  });
});

describe('resolveScopeRoot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-scope-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('prefers fleet.yaml over agent.yaml', async () => {
    writeFileSync(join(dir, 'fleet.yaml'), 'name: f\nagents: []\n');
    const agentDir = join(dir, 'agents', 'a');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.yaml'), 'name: a\n');
    expect(await resolveScopeRoot(agentDir)).toBe(dir);
  });

  test('falls back to agent.yaml when no fleet is present', async () => {
    writeFileSync(join(dir, 'agent.yaml'), 'name: x\n');
    const nested = join(dir, 'skills');
    mkdirSync(nested);
    expect(await resolveScopeRoot(nested)).toBe(dir);
  });

  test('returns cwd itself when neither fleet nor agent exists', async () => {
    expect(await resolveScopeRoot(dir)).toBe(dir);
  });
});

describe('isWithinScope / assertWithinScope', () => {
  test('accepts the scope root itself', () => {
    expect(isWithinScope('/foo/bar', '/foo/bar')).toBe(true);
    expect(() => assertWithinScope('/foo/bar', '/foo/bar')).not.toThrow();
  });

  test('accepts paths beneath the scope root', () => {
    expect(isWithinScope('/foo/bar/baz', '/foo/bar')).toBe(true);
    expect(() => assertWithinScope('/foo/bar/skills/x.md', '/foo/bar')).not.toThrow();
  });

  test('rejects the classic prefix-sibling ("/foo" vs "/foo-bar")', () => {
    expect(isWithinScope('/foo-bar/x', '/foo')).toBe(false);
    expect(() => assertWithinScope('/foo-bar/x', '/foo')).toThrow(BuilderScopeError);
  });

  test('rejects a parent path', () => {
    expect(isWithinScope('/foo', '/foo/bar')).toBe(false);
    expect(() => assertWithinScope('/foo', '/foo/bar')).toThrow(BuilderScopeError);
  });

  test('confirmOutsideScope: true bypasses the check', () => {
    expect(() =>
      assertWithinScope('/etc/passwd', '/home/u/agent', { confirmOutsideScope: true }),
    ).not.toThrow();
  });

  test('throws BuilderScopeError with both paths populated', () => {
    try {
      assertWithinScope('/etc/passwd', '/home/u/agent');
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(BuilderScopeError);
      const scoped = err as BuilderScopeError;
      expect(scoped.offendingPath).toContain('/etc/passwd');
      expect(scoped.scopeRoot).toContain('/home/u/agent');
    }
  });
});
