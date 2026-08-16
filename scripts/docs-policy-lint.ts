#!/usr/bin/env bun
/**
 * Docs-truth mechanisms #4 + #7 — policy lint.
 *
 * #4 Single scoreboard: capability-status verdicts live in AGENTS.md
 *    (the evidence ledger) and nowhere else. The 2026-08 audit found the
 *    "5 of 5 pillars ✅" scoreboard copied into 6+ docs that drifted
 *    independently — one of them contradicting itself in the same file.
 *    This check fails on positive enterprise-scoreboard ASSERTIONS
 *    outside the allowlist (quoting the phrase in an audit record is
 *    fine — asserting it is not).
 *
 * #7 Placeholder gate: no `todo-block` / "placeholder — landing" stubs
 *    may ship on the docs site. Placeholders occupied real pages for
 *    two quarters while reading as finished docs.
 *
 * Usage: bun scripts/docs-policy-lint.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');

const SCOREBOARD_ASSERTIONS = [
  'Enterprise production: ✅',
  'pillars are ✅ at enterprise scale',
  'all five pillars shipped',
  '5 of 5 pillars).**',
  '(5 of 5 pillars)',
];

/** Files allowed to carry scoreboard language: the ledger itself + audit records. */
const SCOREBOARD_ALLOWLIST = new Set(['AGENTS.md', 'docs/DOCS_TRUTH_PLAN.md']);

const PLACEHOLDER_PATTERNS = ['todo-block', 'placeholder — landing'];

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
      if (
        entry === 'node_modules' ||
        entry === 'dist' ||
        entry === 'build' ||
        entry === 'archive'
      ) {
        continue;
      }
      out.push(...walk(rel, match));
    } else if (match(entry)) {
      out.push(rel);
    }
  }
  return out;
}

function main(): number {
  const problems: string[] = [];

  // #4 — scoreboard assertions outside the ledger.
  const proseFiles = [
    ...walk('docs', (n) => n.endsWith('.md')),
    ...walk('docs-site/docs', (n) => n.endsWith('.mdx') || n.endsWith('.md')),
    ...walk('templates', (n) => n === 'README.md'),
    ...walk('packages', (n) => n === 'README.md'),
    'README.md',
    'CLAUDE.md',
  ];
  for (const file of proseFiles) {
    if (SCOREBOARD_ALLOWLIST.has(file)) continue;
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const phrase of SCOREBOARD_ASSERTIONS) {
      if (text.includes(phrase)) {
        problems.push(
          `${file}: asserts the enterprise scoreboard ("${phrase}") — capability verdicts live in AGENTS.md only; link there instead of copying`,
        );
      }
    }
  }

  // #7 — placeholder stubs on the docs site.
  for (const file of walk('docs-site/docs', (n) => n.endsWith('.mdx') || n.endsWith('.md'))) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (text.includes(pattern)) {
        problems.push(
          `${file}: contains a placeholder stub ("${pattern}") — publish real content or delete the section`,
        );
      }
    }
  }

  const unique = [...new Set(problems)];
  if (unique.length > 0) {
    console.error(`✗ docs-policy-lint: ${unique.length} problem(s):\n`);
    for (const p of unique) console.error(`  ${p}`);
    return 1;
  }
  console.log('✓ docs-policy-lint: single scoreboard + no placeholders hold.');
  return 0;
}

process.exit(main());
