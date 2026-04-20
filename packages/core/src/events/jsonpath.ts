/**
 * Minimal JSONPath resolver.
 *
 * Supports:
 *   `$`                           — the root (identity)
 *   `$.foo`                       — dot-access
 *   `$.foo.bar`                   — chained dot-access
 *   `$.arr[0]`                    — numeric index
 *   `$["quoted key"]`             — bracket access with quoted string
 *   `$.['also quoted']`           — dot-bracket form
 *
 * Deliberately NOT supported (throws on parse):
 *   `$..foo`                      — recursive descent
 *   `$.foo[*]`                    — wildcards
 *   `$.foo[?(@.bar)]`             — predicate expressions in path
 *
 * If more is needed later, plugging in `jsonpath-plus` or similar is
 * a peer-dep upgrade path — the engine-level contract is this
 * `resolveJsonPath` function signature.
 */

export type JsonPathSegment = string | number;

export class JsonPathError extends Error {
  readonly code = 'EJSONPATH';
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`JSONPath "${path}": ${reason}`);
    this.name = 'JsonPathError';
  }
}

/** Parse a path into its segment list. Throws `JsonPathError` on bad syntax. */
export function parseJsonPath(path: string): JsonPathSegment[] {
  if (typeof path !== 'string' || path.length === 0) {
    throw new JsonPathError(String(path), 'path must be a non-empty string');
  }
  if (!path.startsWith('$')) {
    throw new JsonPathError(path, 'must start with "$"');
  }
  // Reject unsupported features with explicit messages — silent acceptance
  // would be worse than a hard stop.
  if (path.includes('..')) {
    throw new JsonPathError(path, 'recursive descent ".." is not supported');
  }
  if (/\[\s*\*\s*\]/.test(path)) {
    throw new JsonPathError(path, 'wildcard "[*]" is not supported');
  }
  if (/\[\s*\?/.test(path)) {
    throw new JsonPathError(path, 'predicate expressions are not supported');
  }

  const segments: JsonPathSegment[] = [];
  let i = 1; // skip '$'
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      i += 1;
      // `$.['foo']` is also a valid form.
      if (path[i] === '[') continue;
      let ident = '';
      while (i < path.length) {
        const ch = path[i] ?? '';
        if (ch === '.' || ch === '[') break;
        if (!/[\w$]/.test(ch)) {
          throw new JsonPathError(path, `invalid identifier character "${ch}" at position ${i}`);
        }
        ident += ch;
        i += 1;
      }
      if (ident.length === 0) {
        throw new JsonPathError(path, `empty identifier after "." at position ${i}`);
      }
      segments.push(ident);
    } else if (c === '[') {
      i += 1;
      if (i >= path.length) throw new JsonPathError(path, 'unterminated bracket');
      const next = path[i];
      if (next === '"' || next === "'") {
        // Quoted string key.
        const quote = next;
        i += 1;
        let key = '';
        while (i < path.length && path[i] !== quote) {
          if (path[i] === '\\' && i + 1 < path.length) {
            key += path[i + 1];
            i += 2;
          } else {
            key += path[i];
            i += 1;
          }
        }
        if (path[i] !== quote) {
          throw new JsonPathError(path, 'unterminated quoted key');
        }
        i += 1; // consume closing quote
        if (path[i] !== ']') {
          throw new JsonPathError(path, `expected "]" at position ${i}`);
        }
        i += 1;
        segments.push(key);
      } else {
        // Numeric index.
        let num = '';
        while (i < path.length && /[0-9]/.test(path[i] ?? '')) {
          num += path[i];
          i += 1;
        }
        if (num.length === 0) {
          throw new JsonPathError(path, `expected numeric index at position ${i}`);
        }
        if (path[i] !== ']') {
          throw new JsonPathError(path, `expected "]" at position ${i}`);
        }
        i += 1;
        segments.push(Number.parseInt(num, 10));
      }
    } else {
      throw new JsonPathError(path, `unexpected character "${c}" at position ${i}`);
    }
  }
  return segments;
}

/**
 * Resolve a JSONPath against `root`. Returns `undefined` when any
 * intermediate step is null/undefined or references a missing key.
 * Numeric indexes against non-arrays return `undefined`; string keys
 * against non-objects return `undefined`.
 */
export function resolveJsonPath(root: unknown, path: string): unknown {
  const segments = parseJsonPath(path);
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/** True iff `value` looks like a JSONPath ("$" prefix). */
export function isJsonPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('$');
}
