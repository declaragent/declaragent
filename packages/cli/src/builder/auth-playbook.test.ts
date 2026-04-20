import { describe, expect, test } from 'bun:test';
import { createAuthPlaybookTool } from './auth-playbook.js';
import {
  AUTH_PLAYBOOKS,
  AUTH_PLAYBOOK_PROVIDERS,
  getAuthPlaybook,
  isAuthPlaybookProvider,
} from './auth-playbooks.js';

describe('auth-playbooks registry', () => {
  test('covers the five providers named in BUILDER_PLAN §7 phase 2', () => {
    expect([...AUTH_PLAYBOOK_PROVIDERS].sort()).toEqual([
      'anthropic',
      'github',
      'openai',
      'slack',
      'vault',
    ]);
  });

  test('every provider has a non-trivial playbook body', () => {
    for (const p of AUTH_PLAYBOOK_PROVIDERS) {
      const md = getAuthPlaybook(p);
      expect(md.length).toBeGreaterThan(200);
      // Each playbook carries a heading + "Never do" section.
      expect(md).toMatch(/^#\s/);
      expect(md).toContain('Never do');
    }
  });

  test('isAuthPlaybookProvider narrows on recognised names only', () => {
    expect(isAuthPlaybookProvider('slack')).toBe(true);
    expect(isAuthPlaybookProvider('not-a-provider')).toBe(false);
    expect(isAuthPlaybookProvider('')).toBe(false);
  });

  test('the registry is frozen — mutations are no-ops or throw', () => {
    expect(Object.isFrozen(AUTH_PLAYBOOKS)).toBe(true);
  });
});

describe('DeclaraAuthPlaybook tool', () => {
  test('readonly + parallelSafe', () => {
    const tool = createAuthPlaybookTool();
    expect(tool.readonly).toBe(true);
    expect(tool.parallelSafe).toBe(true);
  });

  test('permissionKey namespaces by provider', () => {
    const tool = createAuthPlaybookTool();
    expect(tool.permissionKey({ provider: 'slack' })).toBe('playbook:slack');
  });

  test('execute returns the markdown for a known provider', async () => {
    const tool = createAuthPlaybookTool();
    const ctx = {
      session: {} as never,
      permissions: {} as never,
      abortSignal: new AbortController().signal,
      depth: 0,
      runAgent: (async () => ({}) as never) as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      } as never,
    };
    const events: unknown[] = [];
    for await (const ev of tool.execute({ provider: 'github' }, ctx)) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; output?: { content?: string; provider?: string } };
    expect(ev.type).toBe('result');
    expect(ev.output?.provider).toBe('github');
    expect(ev.output?.content).toContain('GitHub PAT');
  });

  test('execute rejects an unknown provider with a validation error', async () => {
    const tool = createAuthPlaybookTool();
    const ctx = {
      session: {} as never,
      permissions: {} as never,
      abortSignal: new AbortController().signal,
      depth: 0,
      runAgent: (async () => ({}) as never) as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      } as never,
    };
    const events: unknown[] = [];
    for await (const ev of tool.execute({ provider: 'aws' as never }, ctx)) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; error?: { code?: string } };
    expect(ev.type).toBe('error');
    expect(ev.error?.code).toBe('E_BUILDER_VALIDATION');
  });
});
