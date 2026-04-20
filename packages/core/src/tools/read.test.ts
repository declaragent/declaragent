import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectToolEvents, makeToolContext } from '../testing/context.js';
import { Read } from './read.js';

describe('Read tool', () => {
  let dir: string;
  let filePath: string;
  let missingPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-read-'));
    filePath = join(dir, 'hello.txt');
    missingPath = join(dir, 'absent.txt');
    writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads entire file', async () => {
    const out = await collectToolEvents(Read.execute({ path: filePath }, makeToolContext()));
    expect(out.error).toBeUndefined();
    expect(out.result?.path).toBe(filePath);
    expect(out.result?.totalLines).toBe(6); // trailing newline yields empty last line
    expect(out.result?.truncated).toBe(false);
    expect(out.result?.content.startsWith('line1')).toBe(true);
  });

  test('applies offset and limit', async () => {
    const out = await collectToolEvents(
      Read.execute({ path: filePath, offset: 2, limit: 2 }, makeToolContext()),
    );
    expect(out.result?.content).toBe('line2\nline3');
    expect(out.result?.truncated).toBe(true);
  });

  test('reports ENOENT for missing files', async () => {
    const out = await collectToolEvents(Read.execute({ path: missingPath }, makeToolContext()));
    expect(out.error?.code).toBe('ENOENT');
    expect(out.result).toBeUndefined();
  });

  test('permission key is absolute path', () => {
    expect(Read.permissionKey({ path: filePath })).toBe(filePath);
  });

  test('is marked readonly', () => {
    expect(Read.readonly).toBe(true);
  });
});
