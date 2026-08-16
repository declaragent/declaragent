import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentValidate, validateAgentDir } from './agent-cli.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'declaragent-agent-validate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAgent(yaml: string): void {
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'agent.yaml'), yaml, 'utf8');
}

describe('validateAgentDir', () => {
  test('clean agent validates with no findings', async () => {
    writeAgent(`name: tidy
model: claude-sonnet-4-5
tools:
  defaults: [Read, Glob, Grep]
`);
    const res = await validateAgentDir(dir);
    expect(res.ok).toBe(true);
    expect(res.findings).toEqual([]);
  });

  test('warns on an unknown top-level key (typo) without failing', async () => {
    writeAgent(`name: typo
model: claude-sonnet-4-5
rcp:
  auth:
    enabled: true
tools:
  defaults: [Read]
`);
    const res = await validateAgentDir(dir);
    expect(res.ok).toBe(true); // warning, not error
    expect(res.findings.some((f) => f.code === 'unknown-key' && f.message.includes('rcp'))).toBe(
      true,
    );
  });

  test('errors on an unknown tool name in tools.defaults', async () => {
    writeAgent(`name: badtool
model: claude-sonnet-4-5
tools:
  defaults: [Read, Bsah]
`);
    const res = await validateAgentDir(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === 'tools' && f.severity === 'error')).toBe(true);
  });

  test('errors on a schema-invalid strict sub-block', async () => {
    writeAgent(`name: badmemory
model: claude-sonnet-4-5
memory:
  enabled: "yes"
`);
    const res = await validateAgentDir(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === 'schema')).toBe(true);
  });

  test('errors when name is missing', async () => {
    writeAgent(`model: claude-sonnet-4-5
`);
    const res = await validateAgentDir(dir);
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.code === 'schema')).toBe(true);
  });
});

describe('agentValidate (CLI entry)', () => {
  function captureIo() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
  }

  test('exit 0 + clean message for a good agent', async () => {
    writeAgent(`name: ok
model: claude-sonnet-4-5
tools:
  defaults: [Read]
`);
    const cap = captureIo();
    const code = await agentValidate({ dir }, { io: cap.io });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('validates clean');
  });

  test('exit 1 for an unknown tool, with the error printed', async () => {
    writeAgent(`name: bad
model: claude-sonnet-4-5
tools:
  defaults: [Nope]
`);
    const cap = captureIo();
    const code = await agentValidate({ dir }, { io: cap.io });
    expect(code).toBe(1);
    expect(cap.out.join('')).toContain('✗');
  });

  test('--json emits machine-readable findings', async () => {
    writeAgent(`name: j
model: claude-sonnet-4-5
zzzz: oops
tools:
  defaults: [Read]
`);
    const cap = captureIo();
    const code = await agentValidate({ dir, json: true }, { io: cap.io });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join('')) as {
      ok: boolean;
      findings: Array<{ code: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.findings.some((f) => f.code === 'unknown-key')).toBe(true);
  });
});
