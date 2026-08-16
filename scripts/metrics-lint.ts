#!/usr/bin/env bun
/**
 * Docs-truth mechanism #3 — metrics manifest lint.
 *
 * The runtime's Prometheus exporter emits each registered metric under
 * its dotted name with dots mapped to underscores — and NOTHING else
 * (no `_total` suffixing; histogram samples add `_bucket`/`_sum`/`_count`).
 * The 2026-08 audit found shipped dashboards + alert rules querying
 * names the exporter never emits.
 *
 * Two checks:
 *   1. `scripts/metrics.manifest.json#metrics` exactly matches the
 *      registrations extracted from source (`.counter/.gauge/.histogram`
 *      literals in non-test packages/*'s .ts). Run with `--write` to
 *      regenerate after adding a metric.
 *   2. Every metric-shaped token in the testkit dashboards/alerts,
 *      docs-site, and docs/runbooks resolves to a manifest metric
 *      (exact, histogram-suffix, or prefix-of-real for grep patterns),
 *      a `pending` metric (contracted-but-not-emitted — backlog #65),
 *      or an `ignore` token (label names etc.).
 *
 * Usage: bun scripts/metrics-lint.ts [--write]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const MANIFEST_PATH = join(REPO_ROOT, 'scripts/metrics.manifest.json');

interface Manifest {
  $comment?: string;
  metrics: string[];
  pending: string[];
  ignore: string[];
}

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

function extractRegistrations(): string[] {
  const names = new Set<string>();
  const files = walk('packages', (n) => n.endsWith('.ts') && !n.includes('.test.')).filter(
    (f) => !f.includes('/testing/'),
  );
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(/\.(counter|gauge|histogram)\(\s*\n?\s*'([^']+)'/g)) {
      names.add((m[2] as string).replace(/\./g, '_'));
    }
    // constants passed by identifier (e.g. DAEMON_HEARTBEAT_METRIC)
    for (const m of text.matchAll(/_METRIC\s*=\s*'([^']+)'/g)) {
      names.add((m[1] as string).replace(/\./g, '_'));
    }
  }
  return [...names].sort();
}

const METRIC_TOKEN =
  /\b(?:declaragent_|source_|channel_|mcp_server_|whatsapp_|secret_|tenant_boundary_|webhook_auth_|daemon_|dispatcher_|engine_)[a-z0-9_]+/g;

function main(): number {
  const write = process.argv.includes('--write');
  const extracted = extractRegistrations();

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  } catch {
    manifest = { metrics: [], pending: [], ignore: [] };
  }

  if (write) {
    manifest.metrics = extracted;
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`✓ metrics-lint: wrote ${extracted.length} metrics to the manifest.`);
    return 0;
  }

  const problems: string[] = [];

  // 1. Manifest ↔ source parity.
  const manifestSet = new Set(manifest.metrics);
  for (const name of extracted) {
    if (!manifestSet.has(name)) {
      problems.push(
        `source registers metric "${name}" not in scripts/metrics.manifest.json — run \`bun scripts/metrics-lint.ts --write\``,
      );
    }
  }
  for (const name of manifest.metrics) {
    if (!extracted.includes(name)) {
      problems.push(
        `manifest lists metric "${name}" no longer registered in source — run \`bun scripts/metrics-lint.ts --write\``,
      );
    }
  }

  // 2. Consumers reference real (or explicitly-pending) metrics.
  const valid = new Set([...manifest.metrics, ...manifest.pending]);
  const ignore = new Set(manifest.ignore);
  const resolves = (token: string): boolean => {
    if (valid.has(token) || ignore.has(token)) return true;
    const base = token.replace(/_(bucket|sum|count)$/, '');
    if (valid.has(base)) return true;
    for (const v of valid) {
      // grep/prose prefix patterns (`source_messages`, `declaragent_audit_export_…`)
      if (v.startsWith(token.endsWith('_') ? token : `${token}_`)) return true;
    }
    return false;
  };

  const consumers = [
    ...walk('packages/testkit/alerts', (n) => n.endsWith('.yaml')),
    ...walk('packages/testkit/dashboards', (n) => n.endsWith('.json')),
    ...walk('docs-site/docs', (n) => n.endsWith('.mdx') || n.endsWith('.md')),
    ...walk('docs/runbooks', (n) => n.endsWith('.md')),
  ];
  for (const file of consumers) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(METRIC_TOKEN)) {
      if (!resolves(m[0])) {
        problems.push(`${file}: references metric "${m[0]}" — not registered, pending, or ignored`);
      }
    }
  }

  const unique = [...new Set(problems)];
  if (unique.length > 0) {
    console.error(`✗ metrics-lint: ${unique.length} problem(s):\n`);
    for (const p of unique) console.error(`  ${p}`);
    return 1;
  }
  console.log(
    `✓ metrics-lint: ${manifest.metrics.length} registered metrics; dashboards/alerts/docs consistent (${manifest.pending.length} pending, tracked as backlog #65).`,
  );
  return 0;
}

process.exit(main());
