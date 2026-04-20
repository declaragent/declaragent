import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectToolEvents, makeToolContext } from '../testing/context.js';
import { GlobTool } from './glob.js';

describe('Glob tool', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-glob-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'src/nested'));
    writeFileSync(join(dir, 'src/a.ts'), 'a');
    writeFileSync(join(dir, 'src/b.ts'), 'b');
    writeFileSync(join(dir, 'src/nested/c.ts'), 'c');
    writeFileSync(join(dir, 'readme.md'), '# hi');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('finds files matching a glob pattern', async () => {
    const out = await collectToolEvents(
      GlobTool.execute({ pattern: '**/*.ts', path: dir }, makeToolContext()),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.matches.length).toBe(3);
    expect(out.result?.matches.every((m) => m.endsWith('.ts'))).toBe(true);
  });

  test('returns empty matches on no hit', async () => {
    const out = await collectToolEvents(
      GlobTool.execute({ pattern: '**/*.rs', path: dir }, makeToolContext()),
    );
    expect(out.result?.matches).toEqual([]);
  });

  test('permission key includes cwd and pattern', () => {
    const key = GlobTool.permissionKey({ pattern: '**/*.ts', path: dir });
    expect(key).toBe(`${dir}:**/*.ts`);
  });
});
