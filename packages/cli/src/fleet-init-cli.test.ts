import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetInit } from './fleet-init-cli.js';

function captureIo(): {
  io: { out: (s: string) => void; err: (s: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    out,
    err,
  };
}

function mkHarness(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-init-cli-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('fleetInit', () => {
  test('scaffolds a new fleet with the given name', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetInit({ name: 'demo' }, { io: cap.io, cwd: h.root });
      expect(code).toBe(0);
      const fleetDir = join(h.root, 'demo');
      expect(existsSync(join(fleetDir, 'fleet.yaml'))).toBe(true);
      expect(existsSync(join(fleetDir, 'package.json'))).toBe(true);
      expect(cap.out.join('')).toContain('✓ fleet "demo" scaffolded');
    } finally {
      h.cleanup();
    }
  });

  test('--out overrides the default output dir', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const customOut = join(h.root, 'custom/location');
      const code = await fleetInit({ name: 'demo', out: customOut }, { io: cap.io, cwd: h.root });
      expect(code).toBe(0);
      expect(existsSync(join(customOut, 'fleet.yaml'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('errors without --force if fleet.yaml already exists', async () => {
    const h = mkHarness();
    try {
      await fleetInit({ name: 'demo' }, { cwd: h.root, io: captureIo().io });
      const cap = captureIo();
      const code = await fleetInit({ name: 'demo' }, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('refusing to overwrite');
    } finally {
      h.cleanup();
    }
  });

  test('--force overwrites an existing scaffold', async () => {
    const h = mkHarness();
    try {
      const first = captureIo();
      await fleetInit({ name: 'demo' }, { cwd: h.root, io: first.io });
      const before = readFileSync(join(h.root, 'demo/fleet.yaml'), 'utf-8');
      const cap = captureIo();
      const code = await fleetInit(
        { name: 'renamed', force: true, out: join(h.root, 'demo') },
        { cwd: h.root, io: cap.io },
      );
      expect(code).toBe(0);
      const after = readFileSync(join(h.root, 'demo/fleet.yaml'), 'utf-8');
      expect(after).not.toBe(before);
      expect(after).toContain('name: renamed');
    } finally {
      h.cleanup();
    }
  });

  test('invalid fleet name → 1 + helpful error', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetInit({ name: '-bogus' }, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/URL-safe identifier/);
    } finally {
      h.cleanup();
    }
  });
});
