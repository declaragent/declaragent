#!/usr/bin/env bun
/**
 * Docs-truth mechanism #1 — doc-command linter.
 *
 * Extends the cli.mdx drift guard (docs-cli-extract.ts) to EVERY
 * `declaragent …` invocation inside fenced code blocks across the docs
 * surface, validating it against the command surface derived from
 * `packages/cli/src/index.tsx` at lint time (no second spec to drift):
 *
 *   - top-level verbs   ← `subcommand === '<verb>'` dispatch comparisons
 *   - (verb, subverb)   ← `declaragent <verb> <subverb>` pairs in the
 *                         CLI's own usage/help strings
 *   - flags             ← `--flag` tokens anywhere in packages/cli/src
 *
 * Rules (tuned for zero false positives over maximum strictness):
 *   1. The verb must exist.
 *   2. If the verb has known subverbs and the first argument is a bare
 *      word, it must be a known subverb for that verb.
 *   3. Verbs in ZERO_POSITIONAL_VERBS accept no bare-word argument at
 *      all (catches phantom `declaragent daemon status`).
 *   4. Every `--flag` must exist somewhere in the CLI source (catches
 *      invented flags like `--transport` on `mcp add`).
 *
 * Motivated by the 2026-08 docs-truth audit: phantom verbs/flags were
 * the single largest class (~50 of 214 findings). See
 * docs/DOCS_TRUTH_PLAN.md Wave 3.
 *
 * Usage: bun scripts/docs-command-lint.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');

// ── Doc surface ────────────────────────────────────────────────────────────

/** Historical design docs are bannered as unmaintained — excluded. */
const EXCLUDED_DOCS = new Set(
  [
    'FLEET_PLAN',
    'AGENT_RPC_PLAN',
    'CONTROL_PLANE_PLAN',
    'BUILDER_PLAN',
    'EVENT_SOURCE_REGISTRY',
    'AGENT_BUILDING_AGENT',
    'EXTENDING_YOUR_AGENT',
    'COMMUNICATION_CHANNELS',
    'BUILDING_A_GENERIC_AGENT',
    'EVENT_DRIVEN_AGENT',
  ].map((n) => `docs/${n}.md`),
);

function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    const abs = join(REPO_ROOT, rel);
    if (statSync(abs).isDirectory()) {
      if (entry === 'archive' || entry === 'node_modules' || entry === 'build') continue;
      out.push(...walk(rel, exts));
    } else if (exts.some((e) => entry.endsWith(e)) && !EXCLUDED_DOCS.has(rel)) {
      out.push(rel);
    }
  }
  return out;
}

function docFiles(): string[] {
  return [
    ...walk('docs-site/docs', ['.mdx', '.md']),
    ...walk('docs', ['.md']),
    ...walk('templates', ['README.md']),
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
  ];
}

// ── CLI surface extraction ─────────────────────────────────────────────────

interface CliSurface {
  verbs: Set<string>;
  subverbs: Map<string, Set<string>>;
  flags: Set<string>;
}

/** Verbs that take no bare-word positional at all. Curated (rule 3). */
const ZERO_POSITIONAL_VERBS = new Set([
  'daemon',
  'daemon-reload',
  'daemon-status',
  'daemon-shutdown',
  'ps',
  'down',
  'version',
]);

function cliSourceFiles(): string[] {
  const dir = 'packages/cli/src';
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.includes('.test.') &&
      statSync(join(REPO_ROOT, dir, entry)).isFile()
    ) {
      out.push(`${dir}/${entry}`);
    }
  }
  return out;
}

function extractSurface(): CliSurface {
  const indexSrc = readFileSync(join(REPO_ROOT, 'packages/cli/src/index.tsx'), 'utf8');
  const verbs = new Set<string>();
  for (const m of indexSrc.matchAll(/subcommand === '([a-z0-9-]+)'/g)) {
    verbs.add(m[1] as string);
  }
  // `version`/`--version` handled outside the subcommand dispatch.
  verbs.add('version');

  const subverbs = new Map<string, Set<string>>();
  const flags = new Set<string>();
  for (const file of cliSourceFiles()) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const m of src.matchAll(/declaragent ([a-z][a-z0-9-]*) ([a-z][a-z0-9-]*)/g)) {
      const verb = m[1] as string;
      const sub = m[2] as string;
      if (!verbs.has(verb)) continue;
      if (!subverbs.has(verb)) subverbs.set(verb, new Set());
      (subverbs.get(verb) as Set<string>).add(sub);
    }
    for (const m of src.matchAll(/--[a-z][a-z0-9-]*/g)) {
      flags.add(m[0]);
    }
  }
  return { verbs, subverbs, flags };
}

// ── Doc command extraction ─────────────────────────────────────────────────

interface DocCommand {
  file: string;
  line: number;
  text: string;
  argv: string[];
}

const FENCE_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', '']);

function extractCommands(file: string): DocCommand[] {
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  const lines = text.split('\n');
  const out: DocCommand[] = [];
  let inFence = false;
  let fenceLints = false;
  let pending = '';
  let pendingLine = 0;

  const flush = () => {
    if (pending === '') return;
    for (const cmd of splitCommands(pending)) {
      const argv = tokenize(cmd);
      if (argv.length > 0) out.push({ file, line: pendingLine, text: cmd.trim(), argv });
    }
    pending = '';
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] as string;
    const fence = raw.match(/^\s*```([a-zA-Z0-9-]*)/);
    if (fence) {
      flush();
      if (inFence) {
        inFence = false;
      } else {
        inFence = true;
        fenceLints = FENCE_LANGS.has((fence[1] ?? '').toLowerCase());
      }
      continue;
    }
    if (!inFence || !fenceLints) continue;
    let lineText = raw.replace(/^\s*\$\s+/, '');
    const hash = lineText.indexOf('#');
    if (hash === 0 || (hash > 0 && /\s/.test(lineText[hash - 1] as string))) {
      lineText = lineText.slice(0, hash < 0 ? undefined : hash);
    }
    if (pending === '') pendingLine = i + 1;
    if (lineText.trimEnd().endsWith('\\')) {
      pending += `${lineText.trimEnd().slice(0, -1)} `;
      continue;
    }
    pending += lineText;
    flush();
  }
  flush();
  return out;
}

/** Split a shell line on control operators, keep declaragent invocations. */
function splitCommands(line: string): string[] {
  return line
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim())
    .map((part) => part.replace(/^bunx @declaragent\/cli\b/, 'declaragent'))
    .map((part) => part.replace(/^(?:[A-Z0-9_]+=\S*\s+)+/, '')) // env prefixes
    .filter(
      (part) => /^(declaragent|d9t)\s/.test(part) || part === 'declaragent' || part === 'd9t',
    );
}

function tokenize(cmd: string): string[] {
  const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);
  // drop the binary name
  return tokens.slice(1);
}

// ── Validation ─────────────────────────────────────────────────────────────

function main(): number {
  const surface = extractSurface();
  const problems: string[] = [];

  for (const file of docFiles()) {
    for (const cmd of extractCommands(file)) {
      const [verb, ...rest] = cmd.argv;
      if (verb === undefined) continue;
      if (verb.startsWith('-')) continue; // `declaragent --version` etc.
      if (!surface.verbs.has(verb)) {
        problems.push(`${file}:${cmd.line}: unknown verb "${verb}" in \`${cmd.text}\``);
        continue;
      }
      const first = rest[0];
      const bareFirst = first !== undefined && !first.startsWith('-') ? first : undefined;
      if (bareFirst !== undefined && ZERO_POSITIONAL_VERBS.has(verb)) {
        problems.push(
          `${file}:${cmd.line}: verb "${verb}" takes no positional — got "${bareFirst}" in \`${cmd.text}\``,
        );
        continue;
      }
      const subs = surface.subverbs.get(verb);
      if (
        bareFirst !== undefined &&
        subs !== undefined &&
        subs.size > 0 &&
        /^[a-z][a-z0-9-]*$/.test(bareFirst) &&
        !subs.has(bareFirst)
      ) {
        problems.push(
          `${file}:${cmd.line}: unknown subcommand "${verb} ${bareFirst}" in \`${cmd.text}\` (known: ${[...subs].sort().join(', ')})`,
        );
        continue;
      }
      for (const token of cmd.argv) {
        if (/^--[a-z][a-z0-9-]*$/.test(token) && !surface.flags.has(token)) {
          problems.push(
            `${file}:${cmd.line}: unknown flag "${token}" in \`${cmd.text}\` (not found anywhere in packages/cli/src)`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(`✗ docs-command-lint: ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      '\nEvery `declaragent …` command in a docs code fence must exist in the CLI surface (packages/cli/src/index.tsx).',
    );
    return 1;
  }
  console.log(
    `✓ docs-command-lint: all declaragent invocations valid (${surface.verbs.size} verbs known).`,
  );
  return 0;
}

process.exit(main());
