/**
 * Tests for `declaragent capabilities gen`:
 *   - Emits `generated/<peer>.ts` with per-capability Request/Response types.
 *   - Output is deterministic — same schema on repeat runs ⇒ identical bytes.
 *   - The emitted file compiles under `tsc --noEmit` (smoke-test via Bun's
 *     transpiler, since we don't ship `tsc` as a direct dep in this package).
 *   - Handles back-compat: capabilities without schemas emit `unknown`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilitiesGen, emitTypes, renderType } from './capabilities-gen-cli.js';

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out,
    err,
  };
}

function mkTempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-capgen-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const SAMPLE_YAML = `version: 1
agent: agent://pr-reviewer
transports:
  - kind: memory
    topics:
      requests: agents.pr-reviewer.requests
capabilities:
  - name: review-pr
    description: "Review a PR"
    inputSchema:
      type: object
      properties:
        title: { type: string }
        severity: { enum: [low, med, high] }
      required: [title, severity]
    outputSchema:
      type: object
      properties:
        verdict: { enum: [approve, reject] }
        findings:
          type: array
          items:
            type: object
            properties:
              line: { type: integer }
              note: { type: string }
            required: [line]
      required: [verdict, findings]
`;

describe('emitTypes', () => {
  test('emits deterministic output for key-shuffled equivalent schemas', () => {
    const schemaA = {
      version: 1 as const,
      agent: 'agent://x',
      transports: [{ kind: 'memory' as const, topics: { requests: 'a' } }],
      capabilities: [
        {
          name: 'cap',
          inputSchema: {
            type: 'object',
            required: ['b', 'a'],
            properties: {
              b: { type: 'integer' },
              a: { type: 'string' },
            },
          },
        },
      ],
    };
    const schemaB = {
      version: 1 as const,
      agent: 'agent://x',
      transports: [{ kind: 'memory' as const, topics: { requests: 'a' } }],
      capabilities: [
        {
          name: 'cap',
          inputSchema: {
            properties: {
              a: { type: 'string' },
              b: { type: 'integer' },
            },
            required: ['b', 'a'],
            type: 'object',
          },
        },
      ],
    };
    expect(emitTypes(schemaA)).toBe(emitTypes(schemaB));
  });

  test('renderType: enum produces union of string literals', () => {
    expect(renderType({ enum: ['low', 'med', 'high'] }, 0)).toBe('"low" | "med" | "high"');
  });

  test('renderType: type:array with items', () => {
    expect(renderType({ type: 'array', items: { type: 'string' } }, 0)).toBe('Array<string>');
  });

  test('renderType: missing schema ⇒ unknown (back-compat)', () => {
    expect(renderType(undefined, 0)).toBe('unknown');
  });
});

describe('capabilitiesGen CLI', () => {
  test('rejects when neither --peer nor --capabilities supplied', async () => {
    const { io, err } = captureIo();
    const code = await capabilitiesGen({}, io);
    expect(code).toBe(1);
    expect(err.join('')).toContain('usage: declaragent capabilities gen');
  });

  test('writes generated/<peer>.ts and second run is byte-identical', async () => {
    const dir = mkTempDir();
    try {
      const capsDir = join(dir.path, 'agents', 'pr-reviewer');
      mkdirSync(capsDir, { recursive: true });
      writeFileSync(join(capsDir, 'capabilities.yaml'), SAMPLE_YAML, 'utf-8');

      const { io } = captureIo();
      const code1 = await capabilitiesGen({ peer: 'pr-reviewer' }, { ...io, cwd: dir.path });
      expect(code1).toBe(0);

      const outPath = join(dir.path, 'generated', 'pr-reviewer.ts');
      const first = readFileSync(outPath, 'utf-8');
      expect(first).toContain('export type ReviewPrRequest');
      expect(first).toContain('export type ReviewPrResponse');
      expect(first).toContain('"low" | "med" | "high"');
      expect(first).toContain('severity: "low" | "med" | "high"');
      expect(first).toContain('export interface Capabilities');

      // Determinism: re-run, assert byte equality.
      const code2 = await capabilitiesGen({ peer: 'pr-reviewer' }, { ...io, cwd: dir.path });
      expect(code2).toBe(0);
      const second = readFileSync(outPath, 'utf-8');
      expect(second).toBe(first);
    } finally {
      dir.cleanup();
    }
  });

  test('--capabilities path override works', async () => {
    const dir = mkTempDir();
    try {
      const capsFile = join(dir.path, 'my-caps.yaml');
      writeFileSync(capsFile, SAMPLE_YAML, 'utf-8');
      const { io } = captureIo();
      const code = await capabilitiesGen(
        { capabilities: capsFile, out: join(dir.path, 'out') },
        { ...io, cwd: dir.path },
      );
      expect(code).toBe(0);
      const emitted = readFileSync(join(dir.path, 'out', 'pr-reviewer.ts'), 'utf-8');
      expect(emitted).toContain('export interface Capabilities');
    } finally {
      dir.cleanup();
    }
  });

  test('back-compat: capability with no schema renders Request/Response = unknown', async () => {
    const dir = mkTempDir();
    try {
      const capsFile = join(dir.path, 'caps.yaml');
      writeFileSync(
        capsFile,
        `version: 1
agent: agent://legacy
transports:
  - kind: memory
    topics:
      requests: agents.legacy.requests
capabilities:
  - name: ping
`,
        'utf-8',
      );
      const { io } = captureIo();
      const code = await capabilitiesGen(
        { capabilities: capsFile, out: join(dir.path, 'gen') },
        { ...io, cwd: dir.path },
      );
      expect(code).toBe(0);
      const content = readFileSync(join(dir.path, 'gen', 'legacy.ts'), 'utf-8');
      expect(content).toContain('export type PingRequest = unknown;');
      expect(content).toContain('export type PingResponse = unknown;');
    } finally {
      dir.cleanup();
    }
  });

  test('generated code is valid TypeScript (transpile smoke test)', async () => {
    const dir = mkTempDir();
    try {
      const capsDir = join(dir.path, 'agents', 'pr-reviewer');
      mkdirSync(capsDir, { recursive: true });
      writeFileSync(join(capsDir, 'capabilities.yaml'), SAMPLE_YAML, 'utf-8');
      const { io } = captureIo();
      await capabilitiesGen({ peer: 'pr-reviewer' }, { ...io, cwd: dir.path });
      const outPath = join(dir.path, 'generated', 'pr-reviewer.ts');
      const src = readFileSync(outPath, 'utf-8');
      // Ship to Bun's transpiler — rejects invalid TS.
      const transpiler = new Bun.Transpiler({ loader: 'ts' });
      expect(() => transpiler.transformSync(src)).not.toThrow();
      // And the file must be importable.
      const mod = (await import(outPath)) as Record<string, unknown>;
      // Only `Capabilities` is a runtime-visible interface? No — interfaces
      // are erased. The module should at least exist + have no runtime code.
      expect(typeof mod).toBe('object');
    } finally {
      dir.cleanup();
    }
  });

  test('generated code passes tsc --noEmit (acceptance #2)', async () => {
    const dir = mkTempDir();
    try {
      const capsDir = join(dir.path, 'agents', 'pr-reviewer');
      mkdirSync(capsDir, { recursive: true });
      writeFileSync(join(capsDir, 'capabilities.yaml'), SAMPLE_YAML, 'utf-8');
      const { io } = captureIo();
      await capabilitiesGen({ peer: 'pr-reviewer' }, { ...io, cwd: dir.path });

      // Emit a tsconfig mirroring the project's strict baseline.
      writeFileSync(
        join(dir.path, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              strict: true,
              noUncheckedIndexedAccess: true,
              exactOptionalPropertyTypes: true,
              noEmit: true,
              skipLibCheck: true,
            },
            include: ['generated/**/*.ts'],
          },
          null,
          2,
        ),
        'utf-8',
      );
      const proc = Bun.spawnSync({
        cmd: ['bunx', 'tsc', '--noEmit', '-p', dir.path],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr);
        const stdout = new TextDecoder().decode(proc.stdout);
        throw new Error(`tsc failed: ${stdout}\n${stderr}`);
      }
      expect(proc.exitCode).toBe(0);
    } finally {
      dir.cleanup();
    }
  });
});
