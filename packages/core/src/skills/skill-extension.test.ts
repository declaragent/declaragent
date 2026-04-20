import { describe, expect, test } from 'bun:test';
import { skillExtension } from './skill-extension.js';
import type { Skill } from './types.js';

const SKILL: Skill = {
  descriptor: {
    id: 'skill:user:hello',
    kind: 'skill',
    source: { type: 'user' },
  },
  lookupName: 'hello',
  tier: { type: 'user' },
  frontmatter: { name: 'hello', description: 'd' },
  prompt: 'Say hi.',
  filePath: '/tmp/hello.md',
};

describe('skillExtension', () => {
  test('forwards the loader-supplied descriptor verbatim', () => {
    const ext = skillExtension(SKILL);
    expect(ext.descriptor).toBe(SKILL.descriptor);
    expect(ext.descriptor.kind).toBe('skill');
    expect(ext.payload).toBe(SKILL);
  });

  test('activate is a no-op (skills are loaded synchronously from disk)', async () => {
    const ext = skillExtension(SKILL);
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
