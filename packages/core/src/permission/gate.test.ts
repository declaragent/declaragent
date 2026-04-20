import { describe, expect, test } from 'bun:test';
import { DEFAULT_DENIAL_ESCALATION, createPermissionGate, shouldEscalate } from './gate.js';

describe('permission gate', () => {
  describe('default mode', () => {
    test('allows when an allow rule matches', async () => {
      const gate = createPermissionGate({
        mode: 'default',
        rules: [{ pattern: 'Bash:git *', decision: 'allow' }],
      });
      const d = await gate.check('Bash', 'git status');
      expect(d.outcome).toBe('allow');
      expect(d.matchedRule?.pattern).toBe('Bash:git *');
    });

    test('prompts when no rule matches', async () => {
      const gate = createPermissionGate({ mode: 'default', rules: [] });
      const d = await gate.check('Bash', 'rm -rf /');
      expect(d.outcome).toBe('prompt');
    });

    test('denies when a deny rule matches, even with a wider allow', async () => {
      const gate = createPermissionGate({
        mode: 'default',
        rules: [
          { pattern: 'Bash:*', decision: 'allow' },
          { pattern: 'Bash:rm **', decision: 'deny' },
        ],
      });
      const d = await gate.check('Bash', 'rm -rf /');
      expect(d.outcome).toBe('deny');
      expect(d.matchedRule?.pattern).toBe('Bash:rm **');
    });
  });

  describe('plan mode', () => {
    test('denies non-readonly tools unconditionally', async () => {
      const gate = createPermissionGate({
        mode: 'plan',
        rules: [{ pattern: 'Write:*', decision: 'allow' }],
      });
      const d = await gate.check('Write', '/tmp/a', { readonly: false });
      expect(d.outcome).toBe('deny');
    });

    test('treats readonly tools like default mode', async () => {
      const gate = createPermissionGate({
        mode: 'plan',
        rules: [{ pattern: 'Read:/tmp/**', decision: 'allow' }],
      });
      expect((await gate.check('Read', '/tmp/a.txt', { readonly: true })).outcome).toBe('allow');
      expect((await gate.check('Read', '/etc/passwd', { readonly: true })).outcome).toBe('prompt');
    });

    test('deny rules still win in plan mode', async () => {
      const gate = createPermissionGate({
        mode: 'plan',
        rules: [{ pattern: 'Read:/etc/**', decision: 'deny' }],
      });
      const d = await gate.check('Read', '/etc/passwd', { readonly: true });
      expect(d.outcome).toBe('deny');
    });
  });

  describe('bypass mode', () => {
    test('allows everything', async () => {
      const gate = createPermissionGate({ mode: 'bypass', rules: [] });
      expect((await gate.check('Bash', 'rm -rf /')).outcome).toBe('allow');
    });

    test('explicit deny still wins', async () => {
      const gate = createPermissionGate({
        mode: 'bypass',
        rules: [{ pattern: 'Bash:rm -rf **', decision: 'deny' }],
      });
      expect((await gate.check('Bash', 'rm -rf /')).outcome).toBe('deny');
    });
  });

  describe('auto mode', () => {
    test('allowlisted → allow; else prompt', async () => {
      const gate = createPermissionGate({
        mode: 'auto',
        rules: [{ pattern: 'Read:**', decision: 'allow' }],
      });
      expect((await gate.check('Read', '/any/path')).outcome).toBe('allow');
      expect((await gate.check('Bash', 'ls')).outcome).toBe('prompt');
    });
  });

  describe('denial escalation', () => {
    test('counts denials and reports threshold', () => {
      const gate = createPermissionGate({ mode: 'default', rules: [] });
      expect(gate.denialsInSession()).toBe(0);
      gate.recordDenial('Bash');
      gate.recordDenial('Bash');
      expect(shouldEscalate(gate)).toBe(false);
      gate.recordDenial('Write');
      expect(gate.denialsInSession()).toBe(DEFAULT_DENIAL_ESCALATION);
      expect(shouldEscalate(gate)).toBe(true);
    });

    test('threshold is configurable', () => {
      const gate = createPermissionGate({
        mode: 'default',
        rules: [],
        escalateAfterDenials: 2,
      });
      gate.recordDenial('Bash');
      expect(shouldEscalate(gate, 2)).toBe(false);
      gate.recordDenial('Bash');
      expect(shouldEscalate(gate, 2)).toBe(true);
    });
  });

  describe('scope (sub-agent gate)', () => {
    test('inherits deny rules and narrows allow', async () => {
      const parent = createPermissionGate({
        mode: 'default',
        rules: [
          { pattern: 'Read:/project/**', decision: 'allow' },
          { pattern: 'Read:/project/secrets/**', decision: 'deny' },
        ],
      });
      const child = parent.scope({
        allowSubset: [{ pattern: 'Read:/project/src/**', decision: 'allow' }],
      });
      expect((await child.check('Read', '/project/src/index.ts')).outcome).toBe('allow');
      expect((await child.check('Read', '/project/secrets/key')).outcome).toBe('deny');
      expect((await child.check('Read', '/project/docs/readme.md')).outcome).toBe('prompt');
    });

    test('child denial counter is independent', () => {
      const parent = createPermissionGate({ mode: 'default', rules: [] });
      const child = parent.scope({ allowSubset: [] });
      child.recordDenial('Bash');
      expect(parent.denialsInSession()).toBe(0);
      expect(child.denialsInSession()).toBe(1);
    });
  });
});
