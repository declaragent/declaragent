/**
 * Glob matcher for permission rules.
 *
 * Syntax:
 *   *   matches any run of characters except `/`
 *   **  matches any run of characters including `/`
 *   ?   matches a single character except `/`
 *   anything else is literal
 *
 * Patterns are anchored (must match the whole key).
 * Regex is explicitly rejected — only these three metacharacters are honored.
 */
export function compileGlob(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    // Escape every regex metacharacter; rely on denylist to be explicit.
    if (c !== undefined && /[.+^${}()|[\]\\]/.test(c)) {
      out += `\\${c}`;
      i += 1;
      continue;
    }
    out += c ?? '';
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

export function globMatches(pattern: string, value: string): boolean {
  return compileGlob(pattern).test(value);
}
