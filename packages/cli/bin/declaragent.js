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

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const binaryPath = resolve(__dirname, 'declaragent-binary', 'declaragent');

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

if (result.error) {
  process.stderr.write(`declaragent: failed to launch binary: ${result.error.message}\n`);
  process.exit(1);
}

// Mirror the child's exit signal if it died from one; otherwise
// forward its exit code so scripts that wrap declaragent see the real
// result.
if (typeof result.signal === 'string' && result.signal.length > 0) {
  process.kill(process.pid, result.signal);
  process.exit(1);
}

process.exit(result.status ?? 0);
