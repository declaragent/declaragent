import { describe, expect, test } from 'bun:test';
import { parseSkillFrontmatter, splitFrontmatter } from './frontmatter.js';
import { SkillFrontmatterError } from './types.js';

describe('splitFrontmatter', () => {
  test('separates YAML frontmatter from the body', () => {
    const out = splitFrontmatter('---\nname: x\n---\nhello\n');
    expect(out.frontmatter).toBe('name: x');
    expect(out.body).toBe('hello\n');
  });

  test('returns null frontmatter when no leading fence', () => {
    const out = splitFrontmatter('plain markdown body');
    expect(out.frontmatter).toBeNull();
    expect(out.body).toBe('plain markdown body');
  });

  test('handles CRLF line endings', () => {
    const out = splitFrontmatter('---\r\nname: x\r\n---\r\nbody\r\n');
    expect(out.frontmatter).toBe('name: x');
    expect(out.body).toBe('body\r\n');
  });

  test('strips a leading UTF-8 BOM', () => {
    const out = splitFrontmatter('\uFEFF---\nname: x\n---\nbody');
    expect(out.frontmatter).toBe('name: x');
  });
});

describe('parseSkillFrontmatter', () => {
  test('parses required + optional fields', () => {
    const raw = `---
name: pr-review
description: Review a PR
triggers:
  - "review pr"
  - "check this pr"
inputs:
  prUrl:
    type: string
    description: PR URL
outputs:
  type: object
model: claude-opus-4-6
---
You are reviewing PR {{prUrl}}.`;
    const { frontmatter, body } = parseSkillFrontmatter(raw, '/skills/pr.md');
    expect(frontmatter.name).toBe('pr-review');
    expect(frontmatter.description).toBe('Review a PR');
    expect(frontmatter.triggers).toEqual(['review pr', 'check this pr']);
    expect(frontmatter.inputs?.prUrl).toEqual({ type: 'string', description: 'PR URL' });
    expect(frontmatter.outputs).toEqual({ type: 'object' });
    expect(frontmatter.model).toBe('claude-opus-4-6');
    expect(body).toBe('You are reviewing PR {{prUrl}}.');
  });

  test('missing frontmatter throws ESKILLFM', () => {
    expect(() => parseSkillFrontmatter('plain body', '/skills/x.md')).toThrow(
      SkillFrontmatterError,
    );
  });

  test('missing required name throws with file path in message', () => {
    expect(() => parseSkillFrontmatter('---\ndescription: x\n---\nbody', '/skills/x.md')).toThrow(
      /\/skills\/x\.md.*name/,
    );
  });

  test('triggers must be a list of strings', () => {
    const raw = `---
name: x
description: y
triggers:
  - 1
  - "two"
---
body`;
    expect(() => parseSkillFrontmatter(raw, '/x.md')).toThrow(/triggers/);
  });

  test('invalid YAML reports the parser error', () => {
    expect(() => parseSkillFrontmatter('---\n: : : invalid\n---\nbody', '/x.md')).toThrow(
      SkillFrontmatterError,
    );
  });

  test('inline-flow JSON-schema entries parse correctly', () => {
    const raw = `---
name: s
description: d
inputs:
  count: { type: integer, minimum: 0 }
---
body`;
    const { frontmatter } = parseSkillFrontmatter(raw, '/x.md');
    expect(frontmatter.inputs?.count).toEqual({ type: 'integer', minimum: 0 });
  });
});
