#!/usr/bin/env bun
/**
 * Docs-truth mechanism #2 — env-var registry lint.
 *
 * `scripts/env-vars.registry.json` is the single source of truth for
 * `DECLARAGENT_*` environment variables. Three checks:
 *
 *   1. Every DECLARAGENT_* variable READ in source (packages/*'s
 *      non-test .ts/.tsx via `process.env.X` / `env.X` / `'X'` literals,
 *      plus installer scripts + bin launchers via `$X`) has a registry
 *      entry — a new env var must be registered (and documented, or
 *      explicitly marked `documented: false` with a reason).
 *   2. Every DECLARAGENT_* variable MENTIONED on the docs site has a
 *      registry entry — kills invented vars (the audit found four:
 *      LOG_LEVEL, TELEMETRY, OFFLINE, CHAOS).
 *   3. Every registry entry with `documented: true` appears in
 *      docs-site/docs/reference/env-vars.mdx — kills omission drift.
 *
 * Usage: bun scripts/env-vars-lint.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');

interface Registry {
  vars: Record<string, { documented: boolean; note: string }>;
}

const registry = JSON.parse(
  readFileSync(join(REPO_ROOT, 'scripts/env-vars.registry.json'), 'utf8'),
) as Registry;
const known = new Set(Object.keys(registry.vars));

function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(REPO_ROOT, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
      out.push(...walk(rel, match));
    } else if (match(entry)) {
      out.push(rel);
    }
  }
  return out;
}

/** Resolve a matched name to its registered form (handles the TEST_ prefix). */
function registered(name: string): boolean {
  if (known.has(name)) return true;
  for (const k of known) {
    if (k.endsWith('_') && name.startsWith(k)) return true;
  }
  return false;
}

function main(): number {
  const problems: string[] = [];

  // 1. Source reads.
  const sourceFiles = [
    ...walk('packages', (n) => (n.endsWith('.ts') || n.endsWith('.tsx')) && !n.includes('.test.')),
    ...walk('scripts', (n) => n.endsWith('.sh') || n.endsWith('.ts')),
    ...walk('packages/cli/bin', (n) => n.endsWith('.js')),
  ].filter((f) => !f.startsWith('scripts/env-vars'));
  const readPattern =
    /(?:process\.env\.|(?<![.\w])env\.|['"`]|\$\{?|\bexport )\s*(DECLARAGENT_[A-Z0-9_]+)/g;
  for (const file of sourceFiles) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(readPattern)) {
      const name = m[1] as string;
      if (!registered(name)) {
        problems.push(
          `${file}: env var ${name} is read in source but missing from scripts/env-vars.registry.json`,
        );
      }
    }
  }

  // 2. Docs mentions.
  const docFiles = walk('docs-site/docs', (n) => n.endsWith('.mdx') || n.endsWith('.md'));
  for (const file of docFiles) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(/DECLARAGENT_[A-Z0-9_]+/g)) {
      if (!registered(m[0])) {
        problems.push(
          `${file}: documents env var ${m[0]} which is not in scripts/env-vars.registry.json — invented or renamed?`,
        );
      }
    }
  }

  // 3. Documented entries appear on the reference page.
  const refPage = readFileSync(join(REPO_ROOT, 'docs-site/docs/reference/env-vars.mdx'), 'utf8');
  for (const [name, meta] of Object.entries(registry.vars)) {
    if (meta.documented && !refPage.includes(name)) {
      problems.push(
        `docs-site/docs/reference/env-vars.mdx: registry marks ${name} documented but the page doesn't mention it`,
      );
    }
  }

  const unique = [...new Set(problems)];
  if (unique.length > 0) {
    console.error(`✗ env-vars-lint: ${unique.length} problem(s):\n`);
    for (const p of unique) console.error(`  ${p}`);
    return 1;
  }
  console.log(`✓ env-vars-lint: ${known.size} registered vars; source + docs consistent.`);
  return 0;
}

process.exit(main());
