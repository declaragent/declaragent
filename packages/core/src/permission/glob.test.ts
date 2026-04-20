import { describe, expect, test } from 'bun:test';
import { globMatches } from './glob.js';

describe('globMatches', () => {
  test('literal match', () => {
    expect(globMatches('Bash:git status', 'Bash:git status')).toBe(true);
    expect(globMatches('Bash:git status', 'Bash:git log')).toBe(false);
  });

  test('* matches non-slash runs', () => {
    expect(globMatches('Bash:git *', 'Bash:git status')).toBe(true);
    expect(globMatches('Bash:git *', 'Bash:git log --oneline')).toBe(true);
    expect(globMatches('Bash:*', 'Bash:ls')).toBe(true);
  });

  test('* does not cross slash boundary', () => {
    expect(globMatches('Read:/tmp/*', 'Read:/tmp/a.txt')).toBe(true);
    expect(globMatches('Read:/tmp/*', 'Read:/tmp/nested/a.txt')).toBe(false);
  });

  test('** crosses slash boundary', () => {
    expect(globMatches('Read:/tmp/**', 'Read:/tmp/a.txt')).toBe(true);
    expect(globMatches('Read:/tmp/**', 'Read:/tmp/nested/a.txt')).toBe(true);
    expect(globMatches('Read:/tmp/**', 'Read:/etc/passwd')).toBe(false);
  });

  test('? matches single char', () => {
    expect(globMatches('Read:/?.txt', 'Read:/a.txt')).toBe(true);
    expect(globMatches('Read:/?.txt', 'Read:/ab.txt')).toBe(false);
  });

  test('escapes regex metachars', () => {
    expect(globMatches('Bash:cat foo.txt', 'Bash:cat foo.txt')).toBe(true);
    // Dot is literal, not any-char.
    expect(globMatches('Bash:cat foo.txt', 'Bash:cat fooXtxt')).toBe(false);
    expect(globMatches('Bash:find (.)', 'Bash:find (.)')).toBe(true);
  });

  test('anchored at both ends', () => {
    expect(globMatches('Read:/tmp', 'Read:/tmp/a')).toBe(false);
    expect(globMatches('tmp', 'Read:/tmp')).toBe(false);
  });
});
