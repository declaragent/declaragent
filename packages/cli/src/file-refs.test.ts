import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, expandFileRefs } from './file-refs.js';

describe('expandFileRefs', () => {
  test('no refs → input unchanged + empty refs list', () => {
    const out = expandFileRefs('hello world, no attachments here');
    expect(out.expanded).toBe('hello world, no attachments here');
    expect(out.refs).toEqual([]);
  });

  test('inlines a single relative ref resolved against cwd', () => {
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'declara-file-refs-'));
      writeFileSync(join(tmp, 'notes.md'), 'the contents\n');
      const out = expandFileRefs('please summarise @notes.md for me', {
        cwd: tmp,
      });
      expect(out.refs).toHaveLength(1);
      const [ref] = out.refs;
      expect(ref?.ok).toBe(true);
      expect(ref?.requested).toBe('notes.md');
      expect(out.expanded).toContain('Attached files:');
      expect(out.expanded).toContain('## @notes.md');
      expect(out.expanded).toContain('the contents');
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reports missing files without aborting', () => {
    const out = expandFileRefs('check @does-not-exist.md', {
      cwd: '/tmp/nonexistent-dir',
    });
    expect(out.refs).toHaveLength(1);
    const [ref] = out.refs;
    expect(ref?.ok).toBe(false);
    expect(ref?.reason).toBeDefined();
    // Attached block must NOT render when every ref failed.
    expect(out.expanded).toBe('check @does-not-exist.md');
  });

  test('mixes hits and misses; only hits show up in the attached block', () => {
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'declara-file-refs-'));
      writeFileSync(join(tmp, 'exists.txt'), 'real contents\n');
      const out = expandFileRefs('compare @exists.txt and @missing.txt', {
        cwd: tmp,
      });
      expect(out.refs).toHaveLength(2);
      expect(out.refs[0]?.ok).toBe(true);
      expect(out.refs[1]?.ok).toBe(false);
      expect(out.expanded).toContain('## @exists.txt');
      expect(out.expanded).toContain('real contents');
      // The miss must not leak into the attached block.
      expect(out.expanded).not.toContain('## @missing.txt');
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('absolute paths used as-is', () => {
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'declara-file-refs-'));
      const abs = join(tmp, 'brief.md');
      writeFileSync(abs, 'absolute body\n');
      const out = expandFileRefs(`read @${abs}`, { cwd: '/unrelated' });
      expect(out.refs[0]?.ok).toBe(true);
      expect(out.refs[0]?.resolved).toBe(abs);
      expect(out.expanded).toContain('absolute body');
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('~ is expanded to the supplied home dir', () => {
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'declara-file-refs-home-'));
      writeFileSync(join(tmp, 'dotfile.txt'), 'home body\n');
      const out = expandFileRefs('@~/dotfile.txt plz', { home: tmp });
      expect(out.refs[0]?.ok).toBe(true);
      expect(out.expanded).toContain('home body');
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('deduplicates identical tokens', () => {
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'declara-file-refs-'));
      writeFileSync(join(tmp, 'x.md'), 'body\n');
      const out = expandFileRefs('@x.md and @x.md again', { cwd: tmp });
      expect(out.refs).toHaveLength(1);
      // Body appears exactly once in the attached block.
      expect((out.expanded.match(/body/g) ?? []).length).toBe(1);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('does not expand emails / mentions that lack a boundary', () => {
    // `user@host.com` has no leading whitespace — must NOT match.
    const out = expandFileRefs('contact user@host.com for details');
    expect(out.refs).toEqual([]);
    expect(out.expanded).toBe('contact user@host.com for details');
  });

  test('truncates oversized files with a marker', () => {
    const oversize = 'x'.repeat(MAX_ATTACHMENT_BYTES + 100);
    const out = expandFileRefs('@big.txt here', {
      read: () => oversize,
    });
    expect(out.refs[0]?.ok).toBe(true);
    expect(out.refs[0]?.truncated).toBe(true);
    expect(out.refs[0]?.bytes).toBe(MAX_ATTACHMENT_BYTES);
    expect(out.expanded).toContain('truncated');
  });

  test('uses a language hint for the fenced block by extension', () => {
    const out = expandFileRefs('@code.ts now', {
      read: () => 'export const x = 1;',
    });
    expect(out.expanded).toContain('```ts\n');
  });
});
