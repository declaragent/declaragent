#!/usr/bin/env bun
/**
 * Phase 7 slice 7 — CLI-help → MDX extractor.
 *
 * Reads the help-text template literals in `packages/cli/src/index.tsx`
 * (the main `printHelp()` + the per-subcommand `printInitHelp()`) and
 * writes them into `docs-site/docs/reference/cli.mdx` between
 * BEGIN/END auto-extract markers.
 *
 * Pragmatic for v1: the CLI doesn't yet expose `declaragent help --json`,
 * so we use regex over `index.tsx` to pull the help-text template
 * literal. Slice 8 upgrades the CLI to emit JSON and this script flips
 * to that source; the output shape stays the same.
 *
 * Idempotent — running it twice produces identical output, so CI can
 * `diff` the committed file against a fresh extraction.
 *
 * Usage:
 *   bun run scripts/docs-cli-extract.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI_SOURCE = resolve(REPO_ROOT, 'packages/cli/src/index.tsx');
const OUT_FILE = resolve(REPO_ROOT, 'docs-site/docs/reference/cli.mdx');

const BEGIN = '{/* BEGIN auto-extracted CLI help — populated by docs-cli-extract.ts */}';
const END = '{/* END auto-extracted CLI help */}';

interface HelpBlock {
  /** Display label for the subcommand, e.g. `declaragent` or `declaragent init`. */
  label: string;
  /** The raw help text (provider ids stripped for determinism). */
  text: string;
}

/**
 * Extract the template-literal body of the `printFn()` in `source`.
 * Returns the block between the opening `process.stdout.write(` + closing
 * `);` — i.e. the literal text the CLI prints. Template-literal
 * interpolations are left as `{...}` sentinels so the output is stable
 * across runs (provider presets change over time + would otherwise
 * produce churn in the generated doc).
 */
function extractPrintFn(source: string, fnName: string): string | null {
  const fnRegex = new RegExp(
    `function\\s+${fnName}\\s*\\(\\s*\\)\\s*:\\s*void\\s*{([\\s\\S]*?)^}`,
    'm',
  );
  const fnMatch = fnRegex.exec(source);
  if (!fnMatch) return null;
  const body = fnMatch[1] ?? '';
  // Find the template literal inside the first process.stdout.write(...).
  const writeIdx = body.indexOf('process.stdout.write(');
  if (writeIdx < 0) return null;
  const tickStart = body.indexOf('`', writeIdx);
  if (tickStart < 0) return null;
  // Walk forward to the matching closing backtick, respecting escapes.
  let i = tickStart + 1;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') break;
    i += 1;
  }
  if (i >= body.length) return null;
  const raw = body.slice(tickStart + 1, i);
  // Normalize interpolations so the doc stays stable. The actual values
  // (provider lists, config paths) aren't useful in the MDX — users see
  // them at runtime.
  return raw.replace(/\$\{[^}]+\}/g, '{…}').trimEnd();
}

function gather(): HelpBlock[] {
  const source = readFileSync(CLI_SOURCE, 'utf8');
  const blocks: HelpBlock[] = [];

  const mainHelp = extractPrintFn(source, 'printHelp');
  if (mainHelp) {
    blocks.push({ label: 'declaragent', text: mainHelp });
  }

  const initHelp = extractPrintFn(source, 'printInitHelp');
  if (initHelp) {
    blocks.push({ label: 'declaragent init', text: initHelp });
  }

  return blocks;
}

function renderMdx(blocks: HelpBlock[]): string {
  const parts: string[] = [];
  parts.push('_Regenerate this section with `bun run scripts/docs-cli-extract.ts`._');
  parts.push('');
  for (const b of blocks) {
    parts.push(`## \`${b.label}\``);
    parts.push('');
    parts.push('```text');
    parts.push(b.text);
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

function patchMdx(existing: string, replacement: string): string {
  const beginIdx = existing.indexOf(BEGIN);
  const endIdx = existing.indexOf(END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    throw new Error(`Could not find BEGIN/END markers in ${OUT_FILE}`);
  }
  const before = existing.slice(0, beginIdx + BEGIN.length);
  const after = existing.slice(endIdx);
  return `${before}\n\n${replacement}\n\n${after}`;
}

function main(): number {
  const blocks = gather();
  if (blocks.length === 0) {
    process.stderr.write(
      `docs-cli-extract: no help blocks found in ${CLI_SOURCE} — did the CLI refactor?\n`,
    );
    return 1;
  }
  const existing = readFileSync(OUT_FILE, 'utf8');
  const replacement = renderMdx(blocks);
  const next = patchMdx(existing, replacement);
  if (next === existing) {
    process.stdout.write('docs-cli-extract: no changes\n');
    return 0;
  }
  writeFileSync(OUT_FILE, next, 'utf8');
  process.stdout.write(`docs-cli-extract: wrote ${blocks.length} help block(s) → ${OUT_FILE}\n`);
  return 0;
}

process.exit(main());
