import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  migrateAgentYaml,
  migrateSessionSchema,
  migrateTenantsYaml,
} from './migrate-transforms.js';
import { configDir, tenantsConfigPath } from './paths.js';

export interface MigrateCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: MigrateCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface MigrateFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
}

const DEFAULT_FS: MigrateFs = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c, 'utf8'),
};

export interface MigrateArgs {
  /** Absolute path to the config dir. Defaults to `configDir()`. */
  configDir?: string;
  /** Apply changes when true; dry-run otherwise. */
  apply?: boolean;
  /** Emit a single JSON report instead of line-by-line text. */
  json?: boolean;
}

export interface MigrateDeps {
  io?: MigrateCliIO;
  fs?: MigrateFs;
  now?: () => number;
  /** Injected DB opener for tests. */
  openDb?: (path: string) => Database;
}

type Status = 'no-op' | 'would-apply' | 'applied' | 'advise' | 'error';

interface Step {
  id: string;
  status: Status;
  description: string;
  notes: readonly string[];
}

function formatLine(step: Step): string {
  const prefix =
    step.status === 'no-op'
      ? '  no-op    :'
      : step.status === 'would-apply'
        ? '  pending  :'
        : step.status === 'applied'
          ? '  applied  :'
          : step.status === 'advise'
            ? '  advise   :'
            : '  error    :';
  return `${prefix} ${step.description}\n`;
}

/**
 * `declaragent migrate` — walks pre-v1.0 configs forward. Dry-run by
 * default; `--apply` writes changes. Every migration is idempotent.
 *
 * Returns a process exit code: 0 on success (dry-run always returns 0
 * when loading succeeded), 1 on any apply-time failure.
 */
export async function migrateConfig(
  args: MigrateArgs = {},
  deps: MigrateDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fs = deps.fs ?? DEFAULT_FS;
  const apply = args.apply === true;
  const cfgDir = args.configDir ?? configDir();

  const steps: Step[] = [];
  let failed = false;

  // 1. agent.yaml — bump schemaVersion forward.
  steps.push(await migrateAgentYamlStep(cfgDir, fs, apply));
  if (steps[steps.length - 1]?.status === 'error') failed = true;

  // 2. tenants.yaml — advise only; never auto-write.
  steps.push(migrateTenantsYamlStep(cfgDir, fs));

  // 3. sessions.db — confirm + report on the on-open migration.
  steps.push(migrateSessionsDbStep(cfgDir, deps.openDb));
  if (steps[steps.length - 1]?.status === 'error') failed = true;

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          configDir: cfgDir,
          apply,
          steps: steps.map((s) => ({
            id: s.id,
            status: s.status,
            description: s.description,
            notes: s.notes,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return failed ? 1 : 0;
  }

  const mode = apply ? 'apply' : 'dry-run';
  io.out(`declaragent migrate (${mode})\n`);
  io.out(`  configDir: ${cfgDir}\n`);
  io.out('\n');
  for (const step of steps) {
    io.out(formatLine(step));
    for (const note of step.notes) {
      io.out(`             - ${note}\n`);
    }
  }
  io.out('\n');
  if (failed) {
    io.err('migrate finished with errors (see above)\n');
    return 1;
  }
  if (!apply && steps.some((s) => s.status === 'would-apply')) {
    io.out('run again with `--apply` to write pending changes\n');
  } else {
    io.out('migrate complete\n');
  }
  return 0;
}

// ── step helpers ──────────────────────────────────────────────────────────

async function migrateAgentYamlStep(cfgDir: string, fs: MigrateFs, apply: boolean): Promise<Step> {
  const path = join(cfgDir, 'agent.yaml');
  const description = `agent.yaml (${path})`;

  if (!fs.exists(path)) {
    return {
      id: 'agent.yaml',
      status: 'no-op',
      description,
      notes: ['no agent.yaml found in config dir; skipping'],
    };
  }

  let parsed: unknown;
  let raw: string;
  try {
    raw = fs.readFile(path);
    parsed = parseYaml(raw);
  } catch (err) {
    return {
      id: 'agent.yaml',
      status: 'error',
      description,
      notes: [`failed to parse: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const result = migrateAgentYaml(parsed);
  if (!result.changed) {
    return {
      id: 'agent.yaml',
      status: 'no-op',
      description,
      notes: result.notes,
    };
  }

  if (!apply) {
    return {
      id: 'agent.yaml',
      status: 'would-apply',
      description,
      notes: result.notes,
    };
  }

  try {
    fs.writeFile(path, stringifyYaml(result.next));
    return {
      id: 'agent.yaml',
      status: 'applied',
      description,
      notes: result.notes,
    };
  } catch (err) {
    return {
      id: 'agent.yaml',
      status: 'error',
      description,
      notes: [
        ...result.notes,
        `failed to write: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

function migrateTenantsYamlStep(cfgDir: string, fs: MigrateFs): Step {
  const path = tenantsConfigPath(cfgDir);
  const exists = fs.exists(path);

  // Multi-tenant detection is a pragmatic heuristic: the CLI has no
  // access to the running daemon from this entry point, so we look
  // for on-disk markers that suggest multi-tenant features are wired
  // (channel configs or event-source configs that reference tenants).
  const multiTenantInUse = detectMultiTenantHints(cfgDir, fs);
  const result = migrateTenantsYaml({ tenantsPath: path, tenantsExists: exists, multiTenantInUse });
  const status: Status =
    result.action === 'no-op' ? 'no-op' : result.action === 'advise' ? 'advise' : 'no-op';
  return {
    id: 'tenants.yaml',
    status,
    description: `tenants.yaml (${path})`,
    notes: result.notes,
  };
}

function migrateSessionsDbStep(
  cfgDir: string,
  openDb: ((path: string) => Database) | undefined,
): Step {
  const path = join(cfgDir, 'sessions.db');
  const description = `sessions.db (${path})`;

  if (!openDb && !existsSync(path)) {
    return {
      id: 'sessions.db',
      status: 'no-op',
      description,
      notes: ['no sessions.db present yet; will be created at tenant-aware schema on first open'],
    };
  }

  let db: Database;
  try {
    db = openDb ? openDb(path) : new Database(path, { readonly: true });
  } catch (err) {
    return {
      id: 'sessions.db',
      status: 'error',
      description,
      notes: [`failed to open: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  try {
    const result = migrateSessionSchema(db);
    db.close();
    if (result.tableMissing || result.alreadyMigrated) {
      return {
        id: 'sessions.db',
        status: 'no-op',
        description,
        notes: result.notes,
      };
    }
    return {
      id: 'sessions.db',
      status: 'would-apply',
      description,
      notes: [
        ...result.notes,
        'the daemon / CLI will perform this migration automatically on first open',
      ],
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore close failure after primary error
    }
    return {
      id: 'sessions.db',
      status: 'error',
      description,
      notes: [`inspection failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

function detectMultiTenantHints(cfgDir: string, fs: MigrateFs): boolean {
  const candidates = ['channels.json', 'event-sources.json', 'agent.yaml'];
  for (const name of candidates) {
    const p = join(cfgDir, name);
    if (!fs.exists(p)) continue;
    try {
      const raw = fs.readFile(p);
      if (raw.includes('tenantId') || raw.includes('tenants:') || raw.includes('tenant_id')) {
        return true;
      }
    } catch {
      // ignore unreadable files; don't block migrate on an unrelated read error.
    }
  }
  return false;
}

// ── Zod schema placeholder for agent.yaml ─────────────────────────────────

/**
 * Placeholder export that the real Zod schema will replace once the
 * agent.yaml loader lands (tracked out-of-scope for slice 8). Consumers
 * should import the final schema from `@declaragent/core`, not from
 * this CLI module.
 *
 * @since 1.0.0
 */
export const AGENT_YAML_SCHEMA_PLACEHOLDER = Object.freeze({
  schemaVersion: 1,
  note: 'Full Zod schema lands with the agent.yaml loader post-slice-8.',
}) as Readonly<{ schemaVersion: 1; note: string }>;
