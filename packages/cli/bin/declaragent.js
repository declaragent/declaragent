#!/usr/bin/env node
// packages/cli/bin/declaragent.js — npm launcher.
//
// Phase 7 slice 3. `npm install -g @declaragent/cli` places this file
// on the user's PATH as `declaragent`. It exec's the single-file
// binary downloaded by `postinstall.js`, forwarding argv + stdio.
//
// If the binary isn't present (DECLARAGENT_NO_POSTINSTALL was set, a
// sandboxed install blocked the network, etc.), we print a one-line
// recovery hint and exit non-zero so CI picks the problem up.
//
// 0.5.2 update (Bug 2 of PATCH_0_5_2_PLAN): the compiled binary's
// dynamic-import resolver can't load external event-source adapters
// (`@declaragent/source-kafka`, etc.) because `bun build --compile`
// intercepts bare specifiers and has no on-disk `node_modules` to
// walk. When `bun` is on PATH + the CLI's `dist/index.js` is
// resolvable, prefer `bun dist/index.js`. Commands that don't touch
// external adapters keep working on the binary fallback.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The compiled binary lives next to this launcher, dropped by
// `postinstall.js`.
const binaryPath = resolve(__dirname, 'declaragent-binary', 'declaragent');

// The JS entrypoint ships in the same package tarball, one directory up.
// When `bun` is available we route through it so dynamic imports of
// external adapters resolve against the real filesystem.
const distEntry = resolve(__dirname, '..', 'dist', 'index.js');

function findOnPath(cmd) {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = dir + sep + cmd + suffix;
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // ignore and keep searching
      }
    }
  }
  return null;
}

function exitWith(result) {
  if (result.error) {
    process.stderr.write(`declaragent: failed to launch: ${result.error.message}\n`);
    process.exit(1);
  }
  // Mirror the child's signal if it died from one; otherwise forward
  // its exit code so scripts that wrap declaragent see the real result.
  if (typeof result.signal === 'string' && result.signal.length > 0) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

// Prefer Bun + dist JS when both are available. Users can opt out by
// setting DECLARAGENT_USE_BINARY=1 — useful when debugging the compiled
// binary, and a safety valve if the Bun path ever regresses.
const preferBinary = process.env.DECLARAGENT_USE_BINARY === '1';
const bunPath = preferBinary ? null : findOnPath('bun');
const canUseBun = bunPath !== null && existsSync(distEntry);

if (canUseBun) {
  const result = spawnSync(bunPath, [distEntry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  exitWith(result);
}

if (!existsSync(binaryPath)) {
  const postinstallPath = resolve(__dirname, 'postinstall.js');
  process.stderr.write(
    `declaragent: binary not found. Re-run the postinstall step:\n  node "${postinstallPath}"\n(or reinstall: npm install -g @declaragent/cli). If you set DECLARAGENT_NO_POSTINSTALL=1, re-run without it, or download the binary manually from https://github.com/declaragent/declaragent/releases.\n`,
  );
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  // Pass every env var through — the CLI reads DECLARAGENT_* itself.
  env: process.env,
});

exitWith(result);
