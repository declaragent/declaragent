import { existsSync } from 'node:fs';
import type {
  StoredAuditEntry,
  TenantAuditQuery,
  TenantAuditRecordKind,
  TenantAuditSink,
} from '@declaragent/core';
import { createSqliteAuditSink, erasePlatformUser } from '@declaragent/core';
import { auditDbPath } from './paths.js';

export interface AuditCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: AuditCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface AuditCliDeps {
  io?: AuditCliIO;
  /** Path override; defaults to `${configDir}/audit.db`. */
  dbPath?: string;
  /** Injected sink factory for tests. */
  openSink?: (path: string) => Promise<TenantAuditSink>;
}

async function openOrExplain(
  deps: AuditCliDeps,
  io: AuditCliIO,
  { allowMissing }: { allowMissing?: boolean } = {},
): Promise<TenantAuditSink | 1> {
  const path = deps.dbPath ?? auditDbPath();
  if (!deps.openSink && !allowMissing && !existsSync(path)) {
    io.err(
      `✗ audit database not found at "${path}". Configure the daemon's audit sink to land here, or pass --db <path>.\n`,
    );
    return 1;
  }
  try {
    const opener = deps.openSink ?? ((p) => createSqliteAuditSink({ path: p }));
    return await opener(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to open audit database: ${msg}\n`);
    return 1;
  }
}

export interface AuditQueryArgs {
  tenant?: string;
  kind?: TenantAuditRecordKind;
  since?: number;
  until?: number;
  limit?: number;
  json?: boolean;
}

/** `declaragent audit query [--tenant X] [--kind Y] [--since ms] [--until ms] [--limit N] [--json]` */
export async function auditQuery(
  args: AuditQueryArgs = {},
  deps: AuditCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const sink = await openOrExplain(deps, io);
  if (sink === 1) return 1;

  try {
    const query: TenantAuditQuery = {
      ...(args.tenant !== undefined && { tenantId: args.tenant }),
      ...(args.kind !== undefined && { kind: args.kind }),
      ...(args.since !== undefined && { sinceMs: args.since }),
      ...(args.until !== undefined && { untilMs: args.until }),
      ...(args.limit !== undefined && { limit: args.limit }),
    };
    const entries = await sink.query(query);

    if (args.json) {
      io.out(`${JSON.stringify(entries, null, 2)}\n`);
      return 0;
    }

    if (entries.length === 0) {
      io.out('no audit records match the query.\n');
      return 0;
    }

    io.out(`audit records (${entries.length}):\n`);
    for (const entry of entries) {
      io.out(`  ${formatEntry(entry)}\n`);
    }
    return 0;
  } finally {
    await sink.close();
  }
}

export interface AuditVerifyArgs {
  tenant?: string;
  json?: boolean;
}

/** `declaragent audit verify [--tenant X] [--json]` — exit 0 on ok, 1 on violations. */
export async function auditVerify(
  args: AuditVerifyArgs = {},
  deps: AuditCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const sink = await openOrExplain(deps, io);
  if (sink === 1) return 1;

  try {
    const report = await sink.verify(args.tenant);
    if (args.json) {
      io.out(`${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? 0 : 1;
    }
    if (report.ok) {
      io.out(
        `✓ chain intact — ${report.verifiedEntries}/${report.totalEntries} entries verified${
          args.tenant ? ` for tenant "${args.tenant}"` : ''
        }.\n`,
      );
      return 0;
    }
    io.err(
      `✗ chain verification failed: ${report.violations.length} violation${
        report.violations.length === 1 ? '' : 's'
      } (${report.verifiedEntries}/${report.totalEntries} entries verified).\n`,
    );
    for (const v of report.violations.slice(0, 10)) {
      io.err(`  seq=${v.seq} kind=${v.kind} — ${v.message}\n`);
    }
    if (report.violations.length > 10) {
      io.err(`  … ${report.violations.length - 10} more\n`);
    }
    return 1;
  } finally {
    await sink.close();
  }
}

export interface AuditEraseArgs {
  /** Platform user id whose records should be tombstoned. */
  user: string;
  reason?: string;
  json?: boolean;
}

/** `declaragent audit erase --user <platformUserId> [--reason R] [--json]` */
export async function auditErase(args: AuditEraseArgs, deps: AuditCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const sink = await openOrExplain(deps, io);
  if (sink === 1) return 1;

  try {
    const erased = await erasePlatformUser(sink, {
      platformUserId: args.user,
      ...(args.reason !== undefined && { reason: args.reason }),
    });
    if (args.json) {
      io.out(`${JSON.stringify({ erased, platformUserId: args.user }, null, 2)}\n`);
      return 0;
    }
    io.out(
      `✓ erased ${erased} record${erased === 1 ? '' : 's'} mentioning platform user "${args.user}"\n`,
    );
    return 0;
  } finally {
    await sink.close();
  }
}

export interface AuditPruneArgs {
  tenant: string;
  retentionDays: number;
  json?: boolean;
}

/** `declaragent audit prune --tenant <id> --retention-days N [--json]` */
export async function auditPrune(args: AuditPruneArgs, deps: AuditCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const sink = await openOrExplain(deps, io);
  if (sink === 1) return 1;

  try {
    const pruned = await sink.prune({
      tenantId: args.tenant,
      retentionDays: args.retentionDays,
    });
    if (args.json) {
      io.out(
        `${JSON.stringify(
          { pruned, tenantId: args.tenant, retentionDays: args.retentionDays },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    io.out(
      `✓ pruned ${pruned} record${pruned === 1 ? '' : 's'} from tenant "${args.tenant}" older than ${args.retentionDays} day${args.retentionDays === 1 ? '' : 's'}.\n`,
    );
    return 0;
  } finally {
    await sink.close();
  }
}

function formatEntry(entry: StoredAuditEntry): string {
  const ts =
    typeof entry.record === 'object' && entry.record !== null && 'ts' in entry.record
      ? new Date((entry.record as { ts: number }).ts).toISOString()
      : '(no ts)';
  const tenant = 'tenantId' in entry.record ? (entry.record as { tenantId: string }).tenantId : '—';
  return `seq=${entry.seq}  ts=${ts}  tenant=${tenant}  kind=${entry.record.kind}`;
}
