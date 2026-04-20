import { describe, expect, test } from 'bun:test';
import {
  BuilderConflictError,
  BuilderScopeError,
  BuilderSecretLeakError,
  BuilderValidationError,
  addSkillInputSchema,
  formatZodError,
  skillNameSchema,
} from './types.js';

describe('skillNameSchema', () => {
  test('accepts lowercase + digits + hyphen + underscore', () => {
    for (const ok of ['a', 'pr-review', 'pr_review', 'skill1', '1two-3']) {
      expect(skillNameSchema.safeParse(ok).success).toBe(true);
    }
  });

  test('rejects uppercase, leading symbol, slashes, spaces, dots', () => {
    for (const bad of ['PrReview', '-leading', '_leading', 'a/b', 'a b', 'a.b', '']) {
      expect(skillNameSchema.safeParse(bad).success).toBe(false);
    }
  });

  test('rejects > 64 chars', () => {
    expect(skillNameSchema.safeParse('x'.repeat(65)).success).toBe(false);
    expect(skillNameSchema.safeParse('x'.repeat(64)).success).toBe(true);
  });
});

describe('addSkillInputSchema', () => {
  test('parses a minimal valid input', () => {
    const result = addSkillInputSchema.safeParse({
      name: 'concierge',
      description: 'Greet + answer questions.',
      body: 'Hi — ask me anything about this repo.',
    });
    expect(result.success).toBe(true);
  });

  test('requires name, description, and body', () => {
    expect(addSkillInputSchema.safeParse({}).success).toBe(false);
    expect(addSkillInputSchema.safeParse({ name: 'a' }).success).toBe(false);
    expect(addSkillInputSchema.safeParse({ name: 'a', description: 'd' }).success).toBe(false);
  });

  test('passes through optional inputs / outputs / agentPath', () => {
    const parsed = addSkillInputSchema.parse({
      name: 'pr-review',
      description: 'Review a PR.',
      body: 'body',
      agentPath: '/tmp/agent',
      inputs: { url: { type: 'string' } },
      outputs: { type: 'object' },
      addToAgentYaml: false,
      confirmOutsideScope: true,
    });
    expect(parsed.agentPath).toBe('/tmp/agent');
    expect(parsed.inputs?.url).toEqual({ type: 'string' });
    expect(parsed.addToAgentYaml).toBe(false);
    expect(parsed.confirmOutsideScope).toBe(true);
  });

  test('rejects when body is empty', () => {
    expect(addSkillInputSchema.safeParse({ name: 'x', description: 'd', body: '' }).success).toBe(
      false,
    );
  });
});

describe('formatZodError', () => {
  test('produces a `path: message; path: message` string', () => {
    const result = addSkillInputSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatZodError(result.error);
      expect(msg).toContain('name');
      expect(msg.split('; ').length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('BuilderError hierarchy', () => {
  test('every subclass carries a distinct code + name', () => {
    const scope = new BuilderScopeError('/x/y', '/x');
    expect(scope.code).toBe('E_BUILDER_SCOPE');
    expect(scope.name).toBe('BuilderScopeError');
    expect(scope.offendingPath).toBe('/x/y');
    expect(scope.scopeRoot).toBe('/x');

    const validation = new BuilderValidationError('nope');
    expect(validation.code).toBe('E_BUILDER_VALIDATION');
    expect(validation.name).toBe('BuilderValidationError');

    const conflict = new BuilderConflictError('dupe');
    expect(conflict.code).toBe('E_BUILDER_CONFLICT');

    const secret = new BuilderSecretLeakError('GitHub PAT');
    expect(secret.code).toBe('E_BUILDER_SECRET');
    expect(secret.label).toBe('GitHub PAT');
    expect(secret.message).toContain('GitHub PAT');
  });
});
