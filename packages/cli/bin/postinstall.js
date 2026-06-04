#!/usr/bin/env node
// packages/cli/bin/postinstall.js — npm postinstall shim.
//
// Phase 7 slice 3. Invoked by `npm install -g @declaragent/cli` (or a
// local install). Downloads the single-file `declaragent` binary that
// matches the host's (os, arch) from the matching GitHub release and
// lands it at `<package>/bin/declaragent-binary/declaragent`, where
// `bin/declaragent.js` will exec it.
//
// Why a postinstall step at all? `bun build --compile` is the
// distribution format for Phase 7 and Bun isn't guaranteed to exist on
// every developer's machine, so the npm package can't simply run the
// TypeScript source. Shipping the binary in the npm tarball is also a
// no-go: it would quadruple the download size (four targets) and
// Windows users would still need a separate path.
//
// Opt-outs / overrides:
//   DECLARAGENT_NO_POSTINSTALL=1  Skip the download; `npm install`
//                                 still succeeds. The launcher in
//                                 `bin/declaragent.js` will print a
//                                 one-line re-run hint on first use.
//                                 Air-gapped installs rely on this.
//   DECLARAGENT_BASE_URL=<url>    Override the release origin. Used by
//                                 the CI smoke test to point the shim
//                                 at a local `file://` mirror, and by
//                                 enterprise mirrors.
//   DECLARAGENT_VERSION=vX.Y.Z    Override the resolved tag. Defaults
//                                 to `v<package.version>`.
//
// Exit behavior: we return 0 on every recoverable error so `npm
// install` doesn't fail the user's broader install. A non-fatal
// warning is printed; the launcher re-hints when `declaragent` is
// actually run.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PKG_ROOT = resolve(__dirname, '..');
const BIN_DIR = resolve(__dirname, 'declaragent-binary');

const DEFAULT_BASE_URL = 'https://github.com/declaragent/declaragent/releases';

function log(line) {
  process.stdout.write(`[declaragent postinstall] ${line}\n`);
}

function warn(line) {
  process.stderr.write(`[declaragent postinstall] ${line}\n`);
}

function readPkgVersion() {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('package.json has no version');
  }
  return pkg.version;
}

// Mirror of the (os,arch) → target mapping in scripts/install.sh.
function detectTarget() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    return { unsupported: 'windows' };
  }
  if (platform === 'linux' && arch === 'x64') return { target: 'linux-x64' };
  if (platform === 'linux' && arch === 'arm64') return { target: 'linux-arm64' };
  if (platform === 'darwin' && arch === 'x64') return { target: 'darwin-x64' };
  if (platform === 'darwin' && arch === 'arm64') return { target: 'darwin-arm64' };
  return { unsupported: `${platform}-${arch}` };
}

async function fetchToFile(url, outPath) {
  // file:// URLs: stream from disk. Used by the CI smoke test so we
  // can exercise the full postinstall path without a network.
  if (url.startsWith('file://')) {
    const src = fileURLToPath(url);
    if (!existsSync(src)) {
      throw new Error(`source not found: ${src}`);
    }
    await pipeline(createReadStream(src), createWriteStream(outPath));
    return;
  }

  // Node 18+ has global fetch. Follow redirects (GitHub's
  // `/releases/latest/download/...` redirects once), fail on non-2xx.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  if (!res.body) {
    throw new Error(`empty response body for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function parseSha256(contents, tarballBasename) {
  // The `.sha256` file is the canonical `<hash>  <filename>` line
  // produced by `sha256sum` / `shasum -a 256`. Accept either a bare
  // hash or the full form; the latter is what build-binary.sh writes.
  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    throw new Error('.sha256 file is empty');
  }
  const [hash, name] = trimmed.split(/\s+/, 2);
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error(`.sha256 file has invalid hash: ${hash}`);
  }
  if (name && name !== tarballBasename) {
    warn(`.sha256 filename mismatch (${name} vs ${tarballBasename}); continuing`);
  }
  return hash.toLowerCase();
}

function extractTarGz(tarPath, destDir) {
  // Avoid pulling a tar npm dep. `tar` is available on every POSIX
  // system we target, and Windows has tar.exe since Windows 10 1803 —
  // but we bail on Windows earlier anyway.
  const res = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`tar extraction failed with exit ${res.status}`);
  }
}

function stripMacOSProvenance(path) {
  // macOS 14+ slaps a `com.apple.provenance` xattr on freshly written
  // binaries and Gatekeeper SIGKILLs them on first run. Until the
  // release pipeline ships notarized bundles, strip the attr. The
  // call is safe on Linux (xattr missing = try-and-ignore).
  if (process.platform !== 'darwin') return;
  spawnSync('xattr', ['-cr', path], { stdio: 'ignore' });
}

async function main() {
  if (process.env.DECLARAGENT_NO_POSTINSTALL === '1') {
    log('DECLARAGENT_NO_POSTINSTALL=1 — skipping binary download.');
    log('Re-run `node bin/postinstall.js` from inside the package to install later.');
    // Pipeline-independent path: no download required at all.
    log('Or install Bun (https://bun.sh) — the CLI then runs straight from the');
    log('shipped dist/index.js with no binary download.');
    return;
  }

  const detected = detectTarget();
  if ('unsupported' in detected) {
    if (detected.unsupported === 'windows') {
      log('Windows is not yet supported natively; run declaragent under WSL2.');
    } else {
      warn(`unsupported platform (${detected.unsupported}); skipping binary download.`);
      warn(
        'Install Bun (https://bun.sh) and run via the JS launcher — it has no per-platform binary.',
      );
    }
    return;
  }

  const target = detected.target;
  const version = process.env.DECLARAGENT_VERSION?.trim() || `v${readPkgVersion()}`;
  const baseUrl = (process.env.DECLARAGENT_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );

  // `latest` maps to GitHub's `/releases/latest/download/<asset>`
  // redirect; pinned tags go to `/releases/download/<tag>/<asset>`.
  const isLatest = version === 'latest';
  const tarballName = `declaragent-${target}.tar.gz`;
  const checksumName = `declaragent-${target}.sha256`;
  const tarballUrl = isLatest
    ? `${baseUrl}/latest/download/${tarballName}`
    : `${baseUrl}/download/${version}/${tarballName}`;
  const checksumUrl = isLatest
    ? `${baseUrl}/latest/download/${checksumName}`
    : `${baseUrl}/download/${version}/${checksumName}`;

  log(`downloading ${tarballName} (${version}) from ${baseUrl}`);

  const stage = resolve(tmpdir(), `declaragent-postinstall-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  try {
    const tarPath = join(stage, tarballName);
    const checksumPath = join(stage, checksumName);

    await fetchToFile(tarballUrl, tarPath);
    await fetchToFile(checksumUrl, checksumPath);

    const expected = parseSha256(readFileSync(checksumPath, 'utf8'), tarballName);
    const actual = (await sha256File(tarPath)).toLowerCase();
    if (expected !== actual) {
      throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
    }
    log(`sha256 verified: ${actual}`);

    // Tarball layout matches scripts/build-binary.sh:
    //   declaragent-<target>/{declaragent,LICENSE,README.md}
    rmSync(BIN_DIR, { recursive: true, force: true });
    mkdirSync(BIN_DIR, { recursive: true });
    extractTarGz(tarPath, stage);

    const extractedBin = join(stage, `declaragent-${target}`, 'declaragent');
    if (!existsSync(extractedBin)) {
      throw new Error(`extracted tarball missing ${extractedBin}`);
    }
    const destBin = join(BIN_DIR, 'declaragent');
    // `cp` would bring xattrs across on macOS; a fresh rename avoids
    // inheriting anything from the stage dir.
    await pipeline(createReadStream(extractedBin), createWriteStream(destBin));
    chmodSync(destBin, 0o755);
    stripMacOSProvenance(destBin);

    const sizeBytes = statSync(destBin).size;
    log(`installed ${destBin} (${(sizeBytes / 1024 / 1024).toFixed(1)} MiB, target ${target})`);
  } catch (err) {
    // Non-fatal: emit the warning so curious users can re-run, but
    // don't fail the surrounding `npm install`. The launcher at
    // bin/declaragent.js reprints the fix hint on invocation.
    const msg = err instanceof Error ? err.message : String(err);
    warn(`download failed: ${msg}`);
    // Pipeline-independent fallback first — needs no release asset at all.
    warn('Fastest fix: install Bun (https://bun.sh) — the CLI then runs straight');
    warn('from the shipped dist/index.js with no binary download.');
    // Diagnostic: confirm whether the asset was ever published for this version.
    warn(`Verify the asset exists: curl -sI ${tarballUrl}`);
    warn(`  A 404 means no release was published for ${version} — use the Bun fallback above.`);
    // Enterprise mirror / retry hint, demoted below the fallback.
    warn(`Otherwise set DECLARAGENT_BASE_URL=<mirror> (target ${target}) and rerun postinstall.`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  warn(`unexpected error: ${msg}`);
  // Point even an unexpected throw at an action that needs no download.
  warn(
    'Install Bun (https://bun.sh) to run the CLI from the shipped dist/index.js with no binary.',
  );
  // Exit 0 — see the exit-behavior note in the header comment.
});
