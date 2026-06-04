import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The npm launcher. 0.5.2 (Bug 2 of PATCH_0_5_2_PLAN) adds a Bun path
// in front of the compiled-binary path so external adapters can load.
// We copy the launcher into a sandbox so `binaryPath` resolves to a
// sandboxed location and the real compiled binary in the repo (if any)
// isn't touched.

const realLauncherPath = fileURLToPath(new URL('./declaragent.js', import.meta.url));

describe('declaragent npm launcher', () => {
  let sandbox: string;
  let launcherPath: string;
  let fakeBinDir: string;
  let binaryDir: string;
  let distDir: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'declara-launcher-'));

    // Mirror the real package layout the launcher assumes.
    //   sandbox/bin/declaragent.js      ← launcher (copy of real one)
    //   sandbox/bin/declaragent-binary/ ← the compiled binary dir
    //   sandbox/dist/index.js           ← the JS entrypoint
    const pkgBinDir = join(sandbox, 'bin');
    mkdirSync(pkgBinDir, { recursive: true });
    launcherPath = join(pkgBinDir, 'declaragent.js');
    copyFileSync(realLauncherPath, launcherPath);

    binaryDir = join(pkgBinDir, 'declaragent-binary');
    distDir = join(sandbox, 'dist');
    mkdirSync(distDir, { recursive: true });

    fakeBinDir = join(sandbox, 'fake-path');
    mkdirSync(fakeBinDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function writeShim(dir: string, name: string, body: string): string {
    const shim = join(dir, name);
    writeFileSync(shim, body);
    chmodSync(shim, 0o755);
    return shim;
  }

  test('prefers bun + dist/index.js when bun is on PATH', () => {
    writeShim(fakeBinDir, 'bun', '#!/bin/sh\necho "FAKE_BUN" "$@"\nexit 0\n');
    // A non-empty dist entry is enough — existsSync() is the gate.
    writeFileSync(join(distDir, 'index.js'), '// placeholder\n');

    const result = spawnSync(process.execPath, [launcherPath, '--version'], {
      env: { ...process.env, PATH: fakeBinDir, DECLARAGENT_USE_BINARY: '' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FAKE_BUN');
    expect(result.stdout).toContain('index.js');
    expect(result.stdout).toContain('--version');
  });

  test('falls back to the binary when DECLARAGENT_USE_BINARY=1', () => {
    writeShim(fakeBinDir, 'bun', '#!/bin/sh\necho "FAKE_BUN" "$@"\nexit 0\n');
    writeFileSync(join(distDir, 'index.js'), '// placeholder\n');

    mkdirSync(binaryDir, { recursive: true });
    writeShim(binaryDir, 'declaragent', '#!/bin/sh\necho "FAKE_BINARY" "$@"\nexit 0\n');

    const result = spawnSync(process.execPath, [launcherPath, 'ping'], {
      env: { ...process.env, PATH: fakeBinDir, DECLARAGENT_USE_BINARY: '1' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FAKE_BINARY');
    expect(result.stdout).not.toContain('FAKE_BUN');
  });

  test('falls back to the binary when bun is NOT on PATH', () => {
    // No bun shim. Launcher must pick the binary fallback.
    mkdirSync(binaryDir, { recursive: true });
    writeShim(binaryDir, 'declaragent', '#!/bin/sh\necho "FAKE_BINARY" "$@"\nexit 0\n');

    const result = spawnSync(process.execPath, [launcherPath, 'ping'], {
      env: { ...process.env, PATH: fakeBinDir },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FAKE_BINARY');
  });

  test('falls back to the binary when dist/index.js is missing even with bun on PATH', () => {
    // Regression guard: globally-installed CLI ships the compiled
    // binary but the JS dist is also present in the tarball. Running
    // the launcher out of a build where dist was pruned must still
    // exec the binary rather than crashing.
    writeShim(fakeBinDir, 'bun', '#!/bin/sh\necho "FAKE_BUN" "$@"\nexit 0\n');
    // intentionally no dist/index.js
    mkdirSync(binaryDir, { recursive: true });
    writeShim(binaryDir, 'declaragent', '#!/bin/sh\necho "FAKE_BINARY" "$@"\nexit 0\n');

    const result = spawnSync(process.execPath, [launcherPath, 'ping'], {
      env: { ...process.env, PATH: fakeBinDir },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FAKE_BINARY');
    expect(result.stdout).not.toContain('FAKE_BUN');
  });

  test('prints a recovery hint and exits 1 when neither bun-dist nor binary are present', () => {
    // No bun, no binary — the pre-0.5.2 behavior is preserved.
    const result = spawnSync(process.execPath, [launcherPath, 'ping'], {
      env: { ...process.env, PATH: fakeBinDir },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('binary not found');
  });

  test('recovery hint surfaces pipeline-independent next actions (P1-12)', () => {
    // No bun, no binary. The hint must point at a fix that works even
    // when the release pipeline never published a binary.
    const result = spawnSync(process.execPath, [launcherPath, 'ping'], {
      env: { ...process.env, PATH: fakeBinDir },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const err = result.stderr;
    // Leading phrase preserved for the existing assertion + scripts.
    expect(err).toContain('binary not found');
    // Fallback #1 — install Bun, no download needed.
    expect(err).toContain('bun.sh');
    // Diagnostic — confirm whether the release asset exists (curl -sI …).
    expect(err).toContain('releases/download');
    // Env-var clarifications.
    expect(err).toContain('DECLARAGENT_NO_POSTINSTALL');
    expect(err).toContain('DECLARAGENT_USE_BINARY');
  });
});
