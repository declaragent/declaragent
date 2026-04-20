/**
 * `DeclaraDlqShow` — surface events that failed or stalled dispatch so
 * the model can answer "what's stuck?" questions without shelling out.
 *
 * **Deviation from BUILDER_PLAN §3.11.** The plan shape returns
 * `DLQEntry[]` from broker-level DLQs. Those live inside the source
 * adapters (kafka / nats / sqs / amqp / mqtt) and are only reachable
 * through the daemon's RPC (`declaragent dlq show`). Requiring a live
 * daemon here would turn a read-only tool into an operational
 * prerequisite — the opposite of what Phase 5 is for.
 *
 * Pragmatic alternative: query the local event store for events whose
 * outcome is `rejected` (explicitly refused). That's the closest
 * equivalent the client-side has to "stuck events", and it's always
 * available as long as the REPL is running. When the user needs the
 * broker DLQ specifically, they can still run
 * `declaragent dlq show <sourceId> <entryId>` outside the REPL.
 *
 * @since 0.2.0
 */

import { Database } from 'bun:sqlite';
import type { EventStore, Tool, ToolEvent } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { sessionsDbPath } from '../paths.js';
import type { DlqEntry, DlqShowInput, DlqShowOutput } from './types.js';
import { dlqShowInputSchema, formatZodError } from './types.js';

const DEFAULT_LIMIT = 20;

export interface RunDlqShowOptions {
  /** Override the sqlite path — defaults to `sessionsDbPath()`. */
  storePath?: string;
  /** Pre-constructed store for tests. Mirrors `runEventsTail`. */
  store?: EventStore;
}

export async function runDlqShow(
  input: DlqShowInput,
  options: RunDlqShowOptions = {},
): Promise<DlqShowOutput> {
  const storePath = options.storePath ?? sessionsDbPath();
  let db: Database | undefined;
  let store: EventStore;
  if (options.store !== undefined) {
    store = options.store;
  } else {
    db = new Database(storePath, { readonly: true, create: false });
    store = createEventStore({ db });
  }
  try {
    const records = await store.list({
      outcomeKind: 'rejected',
      limit: input.limit ?? DEFAULT_LIMIT,
    });

    const entries: DlqEntry[] = [];
    for (const r of records) {
      if (input.sourceId !== undefined && extractSourceId(r.event.source) !== input.sourceId) {
        continue;
      }
      entries.push(toEntry(r));
    }

    return {
      ok: true,
      count: entries.length,
      entries,
      storePath,
    };
  } finally {
    db?.close();
  }
}

function toEntry(record: {
  event: {
    id: string;
    kind: string;
    timestamp: number;
    source: unknown;
    meta?: { correlationId?: string };
  };
  outcome?: unknown;
  outcomeAt?: number;
}): DlqEntry {
  const outcome = record.outcome as { kind: string; reason?: string; details?: string } | undefined;
  const entry: DlqEntry = {
    id: record.event.id,
    kind: record.event.kind,
    timestamp: record.event.timestamp,
    source: toRecord(record.event.source),
    ...(record.event.meta?.correlationId !== undefined && {
      correlationId: record.event.meta.correlationId,
    }),
    ...(record.outcomeAt !== undefined && { outcomeAt: record.outcomeAt }),
    ...(outcome !== undefined && {
      reason:
        outcome.reason !== undefined
          ? `${outcome.kind}:${outcome.reason}${outcome.details ? ` (${outcome.details})` : ''}`
          : outcome.kind,
    }),
  };
  return entry;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Pull a scalar source id off the discriminated `EventSourceTag`
 * without hard-coding the union. Most adapters expose `triggerId`;
 * memory-bus events carry `sourceId`; webhook / kafka / nats may
 * use different keys. Try the common ones, fall back to `type`.
 */
function extractSourceId(source: unknown): string | undefined {
  const rec = toRecord(source);
  for (const key of ['sourceId', 'triggerId', 'subscription', 'queue', 'topic']) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export interface DeclaraDlqShowContext {
  storePath?: string;
}

export function createDlqShowTool(
  ctx: DeclaraDlqShowContext = {},
): Tool<DlqShowInput, DlqShowOutput> {
  return {
    name: 'DeclaraDlqShow',
    description:
      'List rejected events from the session event store (the client-side analog of the ' +
      'daemon-side DLQ). Filter by sourceId to scope to one adapter. Read-only. For broker-level ' +
      'DLQ entries, run `declaragent dlq show <sourceId> <entryId>` outside the REPL.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: DEFAULT_LIMIT },
      },
    },
    readonly: true,
    parallelSafe: true,
    permissionKey(input) {
      return `dlq-show${input.sourceId ? `:${input.sourceId}` : ''}`;
    },
    async *execute(input, _toolCtx): AsyncIterable<ToolEvent<DlqShowOutput>> {
      const parsed = dlqShowInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraDlqShow: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        const out = await runDlqShow(parsed.data, {
          ...(ctx.storePath !== undefined && { storePath: ctx.storePath }),
        });
        yield { type: 'result', output: out };
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_DLQ',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
        };
      }
    },
  };
}
