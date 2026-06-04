import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The npm postinstall shim. P1-12: every failure path must surface a
// next action that works even when the release pipeline is broken.
//
// We copy the shim into a sandbox alongside a minimal package.json so
// `readPkgVersion()` resolves without touching the real package, then
// drive it with spawnSync and assert on the printed hints. The shim
// always exits 0 on recoverable errors (header invariant), so we assert
// both the exit code and the message content.

const realPostinstallPath = fileURLToPath(new URL('./postinstall.js', import.meta.url));

describe('declaragent postinstall hints', () => {
  let sandbox: string;
  let shimPath: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'declara-postinstall-'));
    // Layout the shim assumes:
    //   sandbox/bin/postinstall.js   ← copy of the real shim
    //   sandbox/package.json         ← read by readPkgVersion()
    const binDir = join(sandbox, 'bin');
    mkdirSync(binDir, { recursive: true });
    shimPath = join(binDir, 'postinstall.js');
    copyFileSync(realPostinstallPath, shimPath);
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify({ name: '@declaragent/cli', version: '9.9.9' }),
    );
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test('DECLARAGENT_NO_POSTINSTALL=1 skips download, exits 0, and points at the Bun fallback', () => {
    const result = spawnSync(process.execPath, [shimPath], {
      env: { ...process.env, DECLARAGENT_NO_POSTINSTALL: '1' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const text = `${result.stdout}${result.stderr}`;
    expect(text).toContain('skipping binary download');
    // Pipeline-independent next action.
    expect(text).toContain('bun.sh');
    expect(text).toContain('dist/index.js');
  });

  test('a failed download exits 0 but surfaces the from-source fallback + asset diagnostic', () => {
    // Point the shim at a file:// origin that does not exist so the
    // download fails on the very first fetch. The shim must NOT fail the
    // install (exit 0) but must print actionable recovery.
    const missingOrigin = `file://${join(sandbox, 'no-such-release-dir')}`;
    const result = spawnSync(process.execPath, [shimPath], {
      env: {
        ...process.env,
        // Ensure the download path runs (not the skip path).
        DECLARAGENT_NO_POSTINSTALL: '',
        DECLARAGENT_BASE_URL: missingOrigin,
        // Pin a version so the printed asset URL is deterministic.
        DECLARAGENT_VERSION: 'v9.9.9',
      },
      encoding: 'utf8',
    });

    // Recoverable error → install still succeeds.
    expect(result.status).toBe(0);
    const text = `${result.stdout}${result.stderr}`;
    expect(text).toContain('download failed');
    // Fallback #1 — install Bun, no asset needed.
    expect(text).toContain('bun.sh');
    expect(text).toContain('dist/index.js');
    // Diagnostic — the real computed asset URL the user can probe.
    expect(text).toContain('declaragent-');
    expect(text).toContain('v9.9.9');
    // Enterprise-mirror hint preserved.
    expect(text).toContain('DECLARAGENT_BASE_URL');
  });
});
