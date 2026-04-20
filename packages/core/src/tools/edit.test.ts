import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectToolEvents, makeToolContext } from '../testing/context.js';
import { Edit } from './edit.js';

describe('Edit tool', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-edit-'));
    path = join(dir, 'f.txt');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('replaces a unique occurrence', async () => {
    writeFileSync(path, 'hello world');
    const out = await collectToolEvents(
      Edit.execute({ path, oldString: 'world', newString: 'there' }, makeToolContext()),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.replacements).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('hello there');
  });

  test('refuses when oldString matches multiple times without replaceAll', async () => {
    writeFileSync(path, 'foo foo foo');
    const out = await collectToolEvents(
      Edit.execute({ path, oldString: 'foo', newString: 'bar' }, makeToolContext()),
    );
    expect(out.error?.code).toBe('EAMBIGUOUS');
  });

  test('replaceAll substitutes every occurrence', async () => {
    writeFileSync(path, 'foo foo foo');
    const out = await collectToolEvents(
      Edit.execute(
        { path, oldString: 'foo', newString: 'bar', replaceAll: true },
        makeToolContext(),
      ),
    );
    expect(out.result?.replacements).toBe(3);
    expect(readFileSync(path, 'utf8')).toBe('bar bar bar');
  });

  test('ENOMATCH when oldString is missing', async () => {
    writeFileSync(path, 'hello');
    const out = await collectToolEvents(
      Edit.execute({ path, oldString: 'absent', newString: 'x' }, makeToolContext()),
    );
    expect(out.error?.code).toBe('ENOMATCH');
  });

  test('EINVAL when old and new are identical', async () => {
    writeFileSync(path, 'hello');
    const out = await collectToolEvents(
      Edit.execute({ path, oldString: 'hi', newString: 'hi' }, makeToolContext()),
    );
    expect(out.error?.code).toBe('EINVAL');
  });

  test('ENOENT when file is missing', async () => {
    const out = await collectToolEvents(
      Edit.execute(
        { path: join(dir, 'missing.txt'), oldString: 'a', newString: 'b' },
        makeToolContext(),
      ),
    );
    expect(out.error?.code).toBe('ENOENT');
  });
});
