import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * Slice-2 rule-file validation. Every file in `packages/testkit/alerts/`
 * must parse as a Prometheus rule document + every alert must reference
 * a runbook that exists. Keeps the operator config honest as metrics
 * evolve.
 */

interface ParsedAlertGroup {
  name: string;
  interval?: string;
  rules: ParsedAlertRule[];
}

interface ParsedAlertRule {
  alert?: string;
  record?: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface ParsedRuleDoc {
  groups: ParsedAlertGroup[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const alertsDir = resolve(__dirname, '..', 'alerts');
const runbooksDir = resolve(repoRoot, 'docs', 'runbooks');

function alertFiles(): string[] {
  return readdirSync(alertsDir)
    .filter((f) => f.endsWith('.rules.yaml'))
    .sort();
}

describe('alert rule files', () => {
  test('discovers the six expected files', () => {
    expect(alertFiles()).toEqual([
      'channels.rules.yaml',
      'chaos-assertions.rules.yaml',
      'daemon.rules.yaml',
      'event-sources.rules.yaml',
      'security.rules.yaml',
      'whatsapp-windows.rules.yaml',
    ]);
  });

  for (const file of alertFiles()) {
    describe(file, () => {
      const body = readFileSync(resolve(alertsDir, file), 'utf8');
      const parsed = parseYaml(body) as ParsedRuleDoc;

      test('parses as YAML with a `groups` array', () => {
        expect(parsed).toBeTruthy();
        expect(Array.isArray(parsed.groups)).toBe(true);
        expect(parsed.groups.length).toBeGreaterThan(0);
      });

      test('every group has a name + at least one rule', () => {
        for (const group of parsed.groups) {
          expect(typeof group.name).toBe('string');
          expect(group.name.length).toBeGreaterThan(0);
          expect(Array.isArray(group.rules)).toBe(true);
          expect(group.rules.length).toBeGreaterThan(0);
        }
      });

      test('every alert has alert + expr + annotations + runbook_url', () => {
        for (const group of parsed.groups) {
          for (const rule of group.rules) {
            if (!rule.alert) continue;
            expect(rule.alert).toBeTruthy();
            expect(typeof rule.expr).toBe('string');
            expect(rule.expr.trim().length).toBeGreaterThan(0);
            expect(rule.annotations).toBeTruthy();
            const annotations = rule.annotations ?? {};
            expect(annotations.summary).toBeTruthy();
            expect(annotations.description).toBeTruthy();
            expect(annotations.runbook_url).toBeTruthy();
          }
        }
      });

      test('every alert has severity label', () => {
        for (const group of parsed.groups) {
          for (const rule of group.rules) {
            if (!rule.alert) continue;
            const labels = rule.labels ?? {};
            expect(['critical', 'warning']).toContain(labels.severity as string);
          }
        }
      });

      test('every runbook_url resolves to a file on disk', () => {
        for (const group of parsed.groups) {
          for (const rule of group.rules) {
            if (!rule.alert) continue;
            const url = rule.annotations?.runbook_url;
            if (!url) continue;
            // Runbook URLs are repo-relative: `docs/runbooks/<file>.md`.
            const expected = url.startsWith('docs/runbooks/')
              ? resolve(repoRoot, url)
              : resolve(runbooksDir, url);
            expect(existsSync(expected), `${rule.alert} references missing runbook: ${url}`).toBe(
              true,
            );
          }
        }
      });
    });
  }
});
