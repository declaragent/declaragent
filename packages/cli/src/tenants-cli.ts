import { existsSync } from 'node:fs';
import type { LoadedTenant, LoadedTenantsConfig } from '@declaragent/core';
import { TenantsConfigError, loadTenantsConfig } from '@declaragent/core';
import { tenantsConfigPath } from './paths.js';

export interface TenantsCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: TenantsCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface TenantsCliDeps {
  io?: TenantsCliIO;
  /** Path override; defaults to `${configDir}/tenants.yaml`. */
  configPath?: string;
  /** Injected loader for tests that want to bypass disk. */
  load?: (path: string) => Promise<LoadedTenantsConfig>;
}

async function loadOrExplain(
  deps: TenantsCliDeps,
  io: TenantsCliIO,
): Promise<LoadedTenantsConfig | 1> {
  const path = deps.configPath ?? tenantsConfigPath();
  if (!deps.load && !existsSync(path)) {
    io.err(`✗ no tenants config found at "${path}". Create \`tenants.yaml\` in the config dir.\n`);
    return 1;
  }
  try {
    const loader = deps.load ?? ((p) => loadTenantsConfig({ path: p }));
    return await loader(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to load tenants config: ${msg}\n`);
    return 1;
  }
}

export interface TenantsListArgs {
  json?: boolean;
}

/** `declaragent tenants list [--json]` */
export async function tenantsList(
  args: TenantsListArgs = {},
  deps: TenantsCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const loaded = await loadOrExplain(deps, io);
  if (loaded === 1) return 1;

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          strategy: loaded.strategy,
          tenants: loaded.tenants.map((t) => ({
            id: t.context.id,
            displayName: t.context.displayName,
            residency: t.context.residency,
            quotas: t.context.quotas,
            labels: t.context.labels,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (loaded.tenants.length === 0) {
    io.out('no tenants configured.\n');
    return 0;
  }

  io.out(`strategy: bus=${loaded.strategy.bus}\n`);
  io.out(`tenants (${loaded.tenants.length}):\n`);
  for (const t of loaded.tenants) {
    const name = t.context.displayName
      ? `${t.context.id} (${t.context.displayName})`
      : t.context.id;
    const residency = t.context.residency ? ` residency=${t.context.residency}` : '';
    const quotaCount = t.context.quotas ? Object.keys(t.context.quotas).length : 0;
    io.out(`  • ${name}${residency}  quotas:${quotaCount}\n`);
  }
  return 0;
}

export interface TenantsShowArgs {
  id: string;
  json?: boolean;
}

/** `declaragent tenants show <id> [--json]` */
export async function tenantsShow(
  args: TenantsShowArgs,
  deps: TenantsCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const loaded = await loadOrExplain(deps, io);
  if (loaded === 1) return 1;

  const match = loaded.tenants.find((t) => t.context.id === args.id);
  if (!match) {
    io.err(`✗ tenant "${args.id}" not found in tenants.yaml\n`);
    return 1;
  }

  if (args.json) {
    io.out(`${JSON.stringify(tenantToShape(match), null, 2)}\n`);
    return 0;
  }

  io.out(`tenant: ${match.context.id}\n`);
  if (match.context.displayName) io.out(`  displayName: ${match.context.displayName}\n`);
  if (match.context.residency) io.out(`  residency:   ${match.context.residency}\n`);
  if (match.context.auditRetentionDays !== undefined) {
    io.out(`  auditRetentionDays: ${match.context.auditRetentionDays}\n`);
  }
  if (match.context.quotas) {
    io.out('  quotas:\n');
    for (const [k, v] of Object.entries(match.context.quotas)) {
      io.out(`    ${k}: ${v}\n`);
    }
  }
  if (match.context.labels && Object.keys(match.context.labels).length > 0) {
    io.out('  labels:\n');
    for (const [k, v] of Object.entries(match.context.labels)) {
      io.out(`    ${k}: ${v}\n`);
    }
  }
  if (match.extensions) {
    io.out('  extensions:\n');
    if (match.extensions.allow?.length) {
      io.out(`    allow: ${match.extensions.allow.join(', ')}\n`);
    }
    if (match.extensions.deny?.length) {
      io.out(`    deny:  ${match.extensions.deny.join(', ')}\n`);
    }
  }
  if (match.secretScopes?.length) {
    io.out(`  secretScopes: ${match.secretScopes.join(', ')}\n`);
  }
  return 0;
}

/** `declaragent tenants diff [--json]` */
export async function tenantsDiff(
  args: TenantsListArgs = {},
  deps: TenantsCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  // Slice 0.3 ships a config-vs-config validation: we parse the local
  // `tenants.yaml` and report back the tenants that would be loaded into
  // the daemon. Live-vs-on-disk drift (surfacing a daemon that loaded a
  // different file moments earlier) needs a daemon control-plane method
  // that isn't in scope for 0.3 — tracked for slice 0.5.
  const loaded = await loadOrExplain(deps, io);
  if (loaded === 1) return 1;

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          status: 'ok',
          message: 'local tenants.yaml parses; live-vs-disk drift is not yet surfaced',
          tenants: loaded.tenants.map((t) => t.context.id),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  io.out(
    `✓ tenants.yaml parses — would load ${loaded.tenants.length} tenant${
      loaded.tenants.length === 1 ? '' : 's'
    }:\n`,
  );
  for (const t of loaded.tenants) io.out(`  • ${t.context.id}\n`);
  io.out('\n');
  io.out(
    'live-vs-disk drift is not yet surfaced (needs a daemon control-plane method; tracked for slice 0.5).\n',
  );
  return 0;
}

function tenantToShape(t: LoadedTenant): Record<string, unknown> {
  return {
    id: t.context.id,
    displayName: t.context.displayName,
    residency: t.context.residency,
    auditRetentionDays: t.context.auditRetentionDays,
    quotas: t.context.quotas,
    labels: t.context.labels,
    extensions: t.extensions,
    secretScopes: t.secretScopes,
  };
}

/** Exported for `TenantsConfigError` re-use in callers / tests. */
export { TenantsConfigError };
