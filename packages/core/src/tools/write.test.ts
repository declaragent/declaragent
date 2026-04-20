import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectToolEvents, makeToolContext } from '../testing/context.js';
import { Write } from './write.js';

describe('Write tool', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-write-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const name of ['a.txt', 'over.txt']) {
      const p = join(dir, name);
      if (existsSync(p)) rmSync(p);
    }
  });

  test('writes a new file', async () => {
    const path = join(dir, 'a.txt');
    const out = await collectToolEvents(
      Write.execute({ path, content: 'hello' }, makeToolContext()),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.created).toBe(true);
    expect(out.result?.bytesWritten).toBe(5);
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  test('overwrites an existing file', async () => {
    const path = join(dir, 'over.txt');
    writeFileSync(path, 'old');
    const out = await collectToolEvents(Write.execute({ path, content: 'new' }, makeToolContext()));
    expect(out.result?.created).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  test('createDirs mkdir -p the parent directory', async () => {
    const path = join(dir, 'deep/nested/f.txt');
    const out = await collectToolEvents(
      Write.execute({ path, content: 'x', createDirs: true }, makeToolContext()),
    );
    expect(out.error).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe('x');
  });

  test('is not readonly', () => {
    expect(Write.readonly).toBeUndefined();
  });
});
