/**
 * `/history` — render recent builder-tool activity from the audit
 * sink. See BUILDER_PLAN §6 (audit records) + §7 phase 6.
 *
 * The plan's ideal emits a `builder.<action>` audit kind. Core's
 * `TenantAuditRecord` union is closed — adding a new discriminant
 * requires a core change that's outside phase 6's budget. Phase 6
 * therefore reuses the existing `tool_call` kind: every builder-tool
 * invocation becomes a `tool_call` record whose `tool` field starts
 * with "Declara" (e.g. `DeclaraApplyChange`, `DeclaraAddSkill`). The
 * history query filters on that prefix.
 *
 * Consequence for future phases: when `builder.*` kinds land in
 * core, {@link runHistory} adds them to the filter — the sink
 * schema is purely additive.
 *
 * @since 0.2.0
 */

import type { StoredAuditEntry, TenantAuditSink } from '@declaragent/core';

export interface RunHistoryOptions {
  sink: TenantAuditSink;
  /** Tenant to scope to — defaults to the session's implicit tenant. */
  tenant?: string;
  /** Max rows. Defaults to 50. */
  limit?: number;
  /** Only records at or after this ms-epoch. */
  sinceMs?: number;
}

export interface HistoryEntry {
  readonly seq: number;
  readonly ts: number;
  readonly tool: string;
  readonly permissionKey: string;
  readonly outcome: 'allow' | 'deny' | 'prompt';
  readonly durationMs?: number;
  readonly correlationId?: string;
  readonly error?: { code?: string; message: string };
}

export interface RunHistoryOutput {
  readonly ok: true;
  readonly count: number;
  readonly entries: readonly HistoryEntry[];
}

const DEFAULT_LIMIT = 50;
const BUILDER_TOOL_PREFIX = 'Declara';

export async function runHistory(options: RunHistoryOptions): Promise<RunHistoryOutput> {
  const entries = await options.sink.query({
    kind: 'tool_call',
    limit: options.limit ?? DEFAULT_LIMIT,
    order: 'desc',
    ...(options.tenant !== undefined && { tenantId: options.tenant }),
    ...(options.sinceMs !== undefined && { sinceMs: options.sinceMs }),
  });

  const filtered: HistoryEntry[] = [];
  for (const entry of entries) {
    const rec = entry.record;
    if (rec.kind !== 'tool_call') continue;
    if (!rec.tool.startsWith(BUILDER_TOOL_PREFIX)) continue;
    filtered.push(toHistoryEntry(entry));
  }
  return {
    ok: true,
    count: filtered.length,
    entries: filtered,
  };
}

function toHistoryEntry(entry: StoredAuditEntry): HistoryEntry {
  const rec = entry.record as Extract<typeof entry.record, { kind: 'tool_call' }>;
  const out: HistoryEntry = {
    seq: entry.seq,
    ts: rec.ts,
    tool: rec.tool,
    permissionKey: rec.permissionKey,
    outcome: rec.outcome,
    ...(rec.durationMs !== undefined && { durationMs: rec.durationMs }),
    ...(rec.correlationId !== undefined && { correlationId: rec.correlationId }),
    ...(rec.error !== undefined && { error: rec.error }),
  };
  return out;
}

/**
 * Plain-text renderer for the REPL. One entry per line — timestamp,
 * tool, outcome, optional error. Phase 7+ will polish this into a
 * coloured table; for now readability beats aesthetics.
 */
export function renderHistory(output: RunHistoryOutput): string {
  if (output.count === 0) {
    return 'no builder actions yet in this audit chain.';
  }
  const lines: string[] = [`builder actions (${output.count}, newest first):`];
  for (const e of output.entries) {
    const when = new Date(e.ts).toISOString();
    const tag = `[${e.outcome}]`;
    const head = `  ${when} ${tag} ${e.tool} (${e.permissionKey})`;
    if (e.error !== undefined) {
      lines.push(`${head} — ${e.error.message}`);
    } else if (e.durationMs !== undefined) {
      lines.push(`${head} — ${e.durationMs}ms`);
    } else {
      lines.push(head);
    }
  }
  return lines.join('\n');
}
