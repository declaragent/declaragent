/**
 * `DeclaraAuditVerify` — hash-chain integrity probe for the audit
 * store. Wraps `sink.verify(tenant?)` on
 * `@declaragent/core`'s SQLite sink, the same call
 * `declaragent audit verify` makes.
 *
 * The tool ALWAYS returns `{ ok, totalEntries, verifiedEntries,
 * violations }` — unlike the CLI verb it does NOT exit non-zero on
 * violations. The model interprets `ok === false` and can decide
 * whether to report + propose a next step.
 *
 * @since 0.2.0
 */

import { createSqliteAuditSink } from '@declaragent/core';
import type { TenantAuditSink, Tool, ToolEvent } from '@declaragent/core';
import { auditDbPath } from '../paths.js';
import type { AuditVerifyInput, AuditVerifyOutput } from './types.js';
import { auditVerifyInputSchema, formatZodError } from './types.js';

export interface RunAuditVerifyOptions {
  /** Override the sqlite path — defaults to `auditDbPath()`. */
  dbPath?: string;
  /**
   * Pre-constructed sink (tests). When set, the runner does NOT
   * close the sink — the caller manages its lifetime.
   */
  sink?: TenantAuditSink;
}

export async function runAuditVerify(
  input: AuditVerifyInput,
  options: RunAuditVerifyOptions = {},
): Promise<AuditVerifyOutput> {
  const path = options.dbPath ?? auditDbPath();
  const injected = options.sink !== undefined;
  const sink = options.sink ?? (await createSqliteAuditSink({ path }));
  try {
    const report = await sink.verify(input.tenant);
    return {
      ok: report.ok,
      totalEntries: report.totalEntries,
      verifiedEntries: report.verifiedEntries,
      violations: report.violations.map((v) => ({
        seq: v.seq,
        kind: v.kind,
        message: v.message,
      })),
      auditDbPath: path,
    };
  } finally {
    if (!injected) {
      await sink.close();
    }
  }
}

export interface DeclaraAuditVerifyContext {
  dbPath?: string;
}

export function createAuditVerifyTool(
  ctx: DeclaraAuditVerifyContext = {},
): Tool<AuditVerifyInput, AuditVerifyOutput> {
  return {
    name: 'DeclaraAuditVerify',
    description:
      'Verify the audit chain for the session (or a specific tenant). Read-only. Returns ' +
      '{ ok, totalEntries, verifiedEntries, violations } — inspect `ok` before reporting.',
    inputSchema: {
      type: 'object',
      properties: {
        tenant: { type: 'string', description: 'Optional tenant id to scope the verify.' },
      },
    },
    readonly: true,
    parallelSafe: true,
    permissionKey(input) {
      return `audit-verify${input.tenant ? `:${input.tenant}` : ''}`;
    },
    async *execute(input, _toolCtx): AsyncIterable<ToolEvent<AuditVerifyOutput>> {
      const parsed = auditVerifyInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAuditVerify: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        const out = await runAuditVerify(parsed.data, {
          ...(ctx.dbPath !== undefined && { dbPath: ctx.dbPath }),
        });
        yield { type: 'result', output: out };
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_AUDIT',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
        };
      }
    },
  };
}
