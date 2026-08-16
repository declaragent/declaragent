#!/usr/bin/env bun
/**
 * Stamp the marketing site (`website/index.html`) with the CLI version
 * currently published on npm, so the page never advertises a version
 * that `npm i @declaragent/cli` doesn't resolve.
 *
 * Three spots carry the version, each matched by shape (not by the old
 * literal) so the script keeps working as releases move:
 *
 *   1. JSON-LD  `"softwareVersion": "X.Y.Z"`
 *   2. Hero kicker  `vX.Y.Z on npm`
 *   3. Prose  `@declaragent/cli@X.Y.Z`
 *
 * A pattern that stops matching fails the run — that's the drift guard:
 * if a redesign drops or rephrases a version spot, the deploy breaks
 * loudly instead of silently shipping a stale number.
 *
 * Usage:
 *   bun scripts/website-inject-version.ts                # fetch latest from npm
 *   bun scripts/website-inject-version.ts --version 0.7.7
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const TARGET = join(REPO_ROOT, 'website', 'index.html');
const REGISTRY_URL = 'https://registry.npmjs.org/@declaragent/cli/latest';

async function resolveVersion(): Promise<string> {
  const flag = process.argv.indexOf('--version');
  if (flag !== -1) {
    const v = process.argv[flag + 1];
    if (v === undefined || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
      console.error(`✗ --version requires a semver argument, got: ${v ?? '(none)'}`);
      process.exit(1);
    }
    return v;
  }
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) {
    console.error(`✗ registry fetch failed: ${res.status} ${REGISTRY_URL}`);
    process.exit(1);
  }
  const meta = (await res.json()) as { version?: string };
  if (typeof meta.version !== 'string') {
    console.error('✗ registry response has no `version` field');
    process.exit(1);
  }
  return meta.version;
}

const SEMVER = /\d+\.\d+\.\d+(?:-[\w.]+)?/;
const PATTERNS: Array<{ label: string; re: RegExp; replace: (v: string) => string }> = [
  {
    label: 'JSON-LD softwareVersion',
    re: new RegExp(`"softwareVersion": "${SEMVER.source}"`, 'g'),
    replace: (v) => `"softwareVersion": "${v}"`,
  },
  {
    label: 'hero kicker "vX.Y.Z on npm"',
    re: new RegExp(`v${SEMVER.source} on npm`, 'g'),
    replace: (v) => `v${v} on npm`,
  },
  {
    label: 'prose "@declaragent/cli@X.Y.Z"',
    re: new RegExp(`@declaragent/cli@${SEMVER.source}`, 'g'),
    replace: (v) => `@declaragent/cli@${v}`,
  },
];

const version = await resolveVersion();
let html = readFileSync(TARGET, 'utf8');
let changed = 0;
for (const { label, re, replace } of PATTERNS) {
  const hits = html.match(re);
  if (hits === null) {
    console.error(`✗ pattern not found in website/index.html: ${label}`);
    console.error('  The version spot moved or was removed — update scripts/website-inject-version.ts to match.');
    process.exit(1);
  }
  const next = html.replace(re, replace(version));
  if (next !== html) changed += hits.length;
  html = next;
}
writeFileSync(TARGET, html);
console.log(
  changed === 0
    ? `✓ website already at ${version} (all ${PATTERNS.length} spots current)`
    : `✓ stamped ${version} into ${changed} spot(s) across ${PATTERNS.length} pattern(s)`,
);
