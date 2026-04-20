import { AdapterDiscoveryError, discoverAdapters } from '@declaragent/core';
import { configDir } from './paths.js';

export interface AdminCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: AdminCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface SourceAdaptersCliDeps {
  io?: AdminCliIO;
  /** Override the scan paths — tests supply a tmpdir. */
  searchPaths?: readonly string[];
  coreVersion?: string;
}

/**
 * `declaragent source-adapters list` — print each installed adapter
 * package + its semver range + where it was found.
 *
 * Read-only: does NOT register the discovered adapters. Use when you
 * want to confirm an adapter is installed, or when debugging why an
 * `event-sources.yaml` reference is failing to resolve.
 */
export async function sourceAdaptersList(deps: SourceAdaptersCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const searchPaths = deps.searchPaths ?? [process.cwd(), configDir()];
  try {
    const adapters = await discoverAdapters({
      searchPaths,
      ...(deps.coreVersion !== undefined && { coreVersion: deps.coreVersion }),
    });
    if (adapters.length === 0) {
      io.out('no adapter packages discovered.\n');
      io.out(
        'install one with `npm install @declaragent/source-<name>` (kafka, sqs, mqtt, amqp, nats).\n',
      );
      return 0;
    }
    io.out(`adapters (${adapters.length}):\n`);
    for (const a of adapters) {
      io.out(`  ${a.type}\n`);
      io.out(`    package: ${a.packageName}@${a.packageVersion}\n`);
      if (a.agentCompat) io.out(`    agent_compat: ${a.agentCompat}\n`);
      io.out(`    path: ${a.path}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof AdapterDiscoveryError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    io.err(`✗ discovery failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
