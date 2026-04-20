import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectToolEvents, makeToolContext } from '../testing/context.js';
import { Grep } from './grep.js';

describe('Grep tool', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-grep-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'import { foo } from "lib";\nexport const bar = 1;\n');
    writeFileSync(join(dir, 'src/b.ts'), 'const FOO = 2;\nconst baz = 3;\n');
    writeFileSync(join(dir, 'readme.md'), 'foo appears here\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('finds regex matches across matching files', async () => {
    const out = await collectToolEvents(
      Grep.execute({ pattern: 'foo', path: dir, glob: '**/*.ts' }, makeToolContext()),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.matches.length).toBe(1);
    expect(out.result?.matches[0]?.file.endsWith('a.ts')).toBe(true);
    expect(out.result?.matches[0]?.line).toBe(1);
  });

  test('respects caseInsensitive flag', async () => {
    const out = await collectToolEvents(
      Grep.execute(
        { pattern: 'foo', path: dir, glob: '**/*.ts', caseInsensitive: true },
        makeToolContext(),
      ),
    );
    expect(out.result?.matches.length).toBe(2);
  });

  test('defaults to scanning all files when glob is omitted', async () => {
    const out = await collectToolEvents(
      Grep.execute({ pattern: 'foo', path: dir }, makeToolContext()),
    );
    expect(out.result?.matches.length).toBe(2); // a.ts + readme.md
  });

  test('truncates at maxMatches', async () => {
    const out = await collectToolEvents(
      Grep.execute({ pattern: '.', path: dir, maxMatches: 2 }, makeToolContext()),
    );
    expect(out.result?.matches.length).toBe(2);
    expect(out.result?.truncated).toBe(true);
  });

  test('reports EINVAL on invalid regex', async () => {
    const out = await collectToolEvents(
      Grep.execute({ pattern: '[unclosed', path: dir }, makeToolContext()),
    );
    expect(out.error?.code).toBe('EINVAL');
  });
});
