/**
 * Minimal semver-range matcher — no deps. Handles the range forms that
 * adapter `agent_compat` strings realistically use:
 *
 *   1.2.3                       — exact match
 *   >=1.2.3, <=1.2.3, >1.2.3, <1.2.3, =1.2.3
 *   ^1.2.3                      — compatible within major (0.x special-cased)
 *   ~1.2.3                      — compatible within minor
 *   >=1.2.3 <2.0.0              — space-separated AND (compound)
 *   *                           — any version
 *   <empty>                     — any version (treats undefined as "no constraint")
 *
 * Deliberately NOT supported:
 *   OR ranges ("1.x || 2.x")
 *   Prerelease/build metadata (1.2.3-beta, 1.2.3+meta)
 *   Partial comparators (">= 1", "^1")
 *
 * If adapters need those, upgrading to the `semver` npm peer-dep is a
 * drop-in replacement.
 */

export function parseSemver(version: string): [number, number, number] | null {
  const trimmed = version.trim();
  const m = trimmed.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [
    Number.parseInt(m[1] as string, 10),
    Number.parseInt(m[2] as string, 10),
    Number.parseInt(m[3] as string, 10),
  ];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return Number.NaN;
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  return pa[2] - pb[2];
}

export function satisfies(version: string, range: string | undefined): boolean {
  if (range === undefined) return true;
  const r = range.trim();
  if (r === '*' || r === '') return true;

  // Compound: space-separated AND.
  const parts = r.split(/\s+/);
  if (parts.length > 1) {
    for (const p of parts) if (!satisfies(version, p)) return false;
    return true;
  }

  // Single comparator.
  const m = r.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+\.\d+\.\d+)$/);
  if (!m) return false;
  const op = m[1] ?? '=';
  const target = m[2] as string;

  const parsedV = parseSemver(version);
  const parsedT = parseSemver(target);
  if (!parsedV || !parsedT) return false;

  const cmp = compareSemver(version, target);

  switch (op) {
    case '=':
      return cmp === 0;
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    case '^': {
      // ^x.y.z semantics:
      //   x > 0  →  same major, version >= target
      //   x == 0 →  0.y.z where y is fixed; patch flexible
      //   x == 0, y == 0 → exact match on patch only
      if (parsedT[0] > 0) {
        return parsedV[0] === parsedT[0] && cmp >= 0;
      }
      if (parsedT[1] > 0) {
        return parsedV[0] === 0 && parsedV[1] === parsedT[1] && parsedV[2] >= parsedT[2];
      }
      return cmp === 0;
    }
    case '~': {
      // ~x.y.z — major + minor fixed, patch flexible (and must be >= target).
      return parsedV[0] === parsedT[0] && parsedV[1] === parsedT[1] && parsedV[2] >= parsedT[2];
    }
  }
  return false;
}
