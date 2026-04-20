import { describe, expect, test } from 'bun:test';
import { SECRET_PATTERNS, detectSecret, formatLeakWarning, redactSecrets } from './secret-guard.js';

describe('detectSecret', () => {
  test('returns undefined for benign text', () => {
    for (const benign of [
      '',
      'hello world',
      'run `bun test` then commit',
      'the file is ~/.env.example (placeholder only)',
      'an id like 1234-5678 is not a secret',
    ]) {
      expect(detectSecret(benign)).toBeUndefined();
    }
  });

  test('detects an Anthropic-shaped API key', () => {
    const finding = detectSecret(`sk-ant-${'x'.repeat(40)}`);
    expect(finding?.label).toBe('likely API key');
  });

  test('detects a GitHub fine-grained PAT', () => {
    const finding = detectSecret(`ghp_${'a'.repeat(36)}`);
    expect(finding?.label).toBe('GitHub PAT');
  });

  test('detects a GitHub OAuth token', () => {
    const finding = detectSecret(`gho_${'b'.repeat(36)}`);
    expect(finding?.label).toBe('GitHub OAuth token');
  });

  test('detects an npm token', () => {
    const finding = detectSecret(`npm_${'c'.repeat(36)}`);
    expect(finding?.label).toBe('npm token');
  });

  test('detects a Slack token', () => {
    const finding = detectSecret(`xoxb-${'1234567890-'.repeat(3)}abcdefgh`);
    expect(finding?.label).toBe('Slack token');
  });

  test('detects an AWS access key id', () => {
    expect(detectSecret('AKIAABCDEFGHIJKLMNOP')?.label).toBe('AWS access key id');
  });

  test('detects a JWT-shaped token', () => {
    const jwt = `ey${'a'.repeat(22)}.${'b'.repeat(22)}.${'c'.repeat(22)}`;
    expect(detectSecret(jwt)?.label).toBe('JWT');
  });

  test('is case-sensitive on the prefix (does not match GHP_)', () => {
    expect(detectSecret(`GHP_${'a'.repeat(36)}`)).toBeUndefined();
  });

  test('ignores short-prefix strings that look like tokens', () => {
    expect(detectSecret('ghp_tiny')).toBeUndefined();
    expect(detectSecret('sk-ant-short')).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  test('is a no-op on benign text and returns no findings', () => {
    const { redacted, findings } = redactSecrets('hello world');
    expect(redacted).toBe('hello world');
    expect(findings).toHaveLength(0);
  });

  test('replaces a match with <redacted:label>', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const { redacted, findings } = redactSecrets(`my token is ${token} please`);
    expect(redacted).toBe('my token is <redacted:GitHub PAT> please');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.label).toBe('GitHub PAT');
  });

  test('captures two findings when the same pattern appears twice', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const { findings } = redactSecrets(`${token} and ${token}`);
    expect(findings).toHaveLength(2);
  });

  test('redacts mixed-provider tokens in a single pass', () => {
    const gh = `ghp_${'a'.repeat(36)}`;
    const slack = `xoxb-${'1234567890-'.repeat(3)}abcdefgh`;
    const aws = 'AKIAABCDEFGHIJKLMNOP';
    const { redacted, findings } = redactSecrets(`${gh} ${slack} ${aws}`);
    const labels = findings.map((f) => f.label).sort();
    expect(labels).toEqual(['AWS access key id', 'GitHub PAT', 'Slack token']);
    expect(redacted).not.toContain('ghp_');
    expect(redacted).not.toContain('xoxb-');
    expect(redacted).not.toContain('AKIA');
  });

  test('idempotent — redacting redacted text is a no-op', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const first = redactSecrets(`user typed ${token}`);
    const second = redactSecrets(first.redacted);
    expect(second.redacted).toBe(first.redacted);
    expect(second.findings).toHaveLength(0);
  });

  test('reports an index within the input text', () => {
    const prefix = 'pasted: ';
    const token = `ghp_${'a'.repeat(36)}`;
    const { findings } = redactSecrets(`${prefix}${token}`);
    expect(findings[0]?.index).toBe(prefix.length);
  });
});

describe('formatLeakWarning', () => {
  test('empty input returns an empty string', () => {
    expect(formatLeakWarning([])).toBe('');
  });

  test('singular wording for one finding', () => {
    expect(formatLeakWarning([{ label: 'GitHub PAT', index: 0 }])).toMatch(
      /redacted 1 secret \(GitHub PAT\)/,
    );
  });

  test('plural wording + deduplicated labels', () => {
    const out = formatLeakWarning([
      { label: 'GitHub PAT', index: 0 },
      { label: 'GitHub PAT', index: 80 },
      { label: 'Slack token', index: 160 },
    ]);
    expect(out).toMatch(/redacted 3 secrets/);
    expect(out).toContain('GitHub PAT, Slack token');
    expect(out).toContain('${env:VAR}');
  });
});

describe('SECRET_PATTERNS', () => {
  test('every pattern carries the global flag + a human label', () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.re.flags).toContain('g');
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});
