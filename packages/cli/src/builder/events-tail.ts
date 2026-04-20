/**
 * `DeclaraEventsTail` — read-only peek at the event store. Wraps the
 * same `createEventStore({ db })` the CLI verb uses, so rows you'd
 * see via `declaragent events list` are exactly what this tool
 * returns. See BUILDER_PLAN §3.11.
 *
 * The tool trims each record to a short envelope (id, kind, source,
 * outcome, optional payload preview) so one call can't blow the
 * context window. Callers that need the full payload fall back to
 * `declaragent events list --json`.
 *
 * @since 0.2.0
 */

import { Database } from 'bun:sqlite';
import type { EventKind, EventStore, Tool, ToolEvent } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { sessionsDbPath } from '../paths.js';
import type { EventsTailInput, EventsTailOutput, EventsTailRecord } from './types.js';
import { eventsTailInputSchema, formatZodError } from './types.js';

const DEFAULT_TAIL = 20;

export interface RunEventsTailOptions {
  /** Override the sqlite path — defaults to `sessionsDbPath()`. */
  storePath?: string;
  /**
   * Pre-constructed store (tests). When set, `storePath` is used only
   * for the response's `storePath` field; no sqlite handle is opened
   * or closed by the runner.
   */
  store?: EventStore;
}

export async function runEventsTail(
  input: EventsTailInput,
  options: RunEventsTailOptions = {},
): Promise<EventsTailOutput> {
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
    // `kind` widens to `string` from the Zod input; the store's filter
    // is typed with the `EventKind` union. An unknown kind just returns
    // zero rows, so the cast is safe — we pay no correctness cost and
    // keep the model's error surface tight (no "invalid kind" gotchas).
    const records = await store.list({
      limit: input.last ?? DEFAULT_TAIL,
      ...(input.kind !== undefined && { kind: input.kind as EventKind }),
      ...(input.correlationId !== undefined && { correlationId: input.correlationId }),
      ...(input.sinceMs !== undefined && { sinceMs: input.sinceMs }),
    });
    const events: EventsTailRecord[] = records.map((r) => summariseRecord(r));
    return {
      ok: true,
      count: events.length,
      events,
      storePath,
    };
  } finally {
    db?.close();
  }
}

function summariseRecord(record: {
  event: {
    id: string;
    kind: string;
    timestamp: number;
    source: unknown;
    target: unknown;
    payload: unknown;
    meta?: { correlationId?: string };
  };
  outcome?: unknown;
}): EventsTailRecord {
  const { event, outcome } = record;
  const rec: EventsTailRecord = {
    id: event.id,
    kind: event.kind,
    timestamp: event.timestamp,
    source: toRecord(event.source),
    target: toRecord(event.target),
    ...(event.meta?.correlationId !== undefined && {
      correlationId: event.meta.correlationId,
    }),
    ...(outcome !== undefined && { outcome: toRecord(outcome) }),
    ...(event.payload !== undefined && { payloadPreview: previewPayload(event.payload) }),
  };
  return rec;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Stringify the payload, cap at 140 chars, and squelch binary blobs.
 * The model never needs the full body to answer "what just happened?".
 */
function previewPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    return '<payload:unserialisable>';
  }
  const max = 140;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export interface DeclaraEventsTailContext {
  storePath?: string;
}

export function createEventsTailTool(
  ctx: DeclaraEventsTailContext = {},
): Tool<EventsTailInput, EventsTailOutput> {
  return {
    name: 'DeclaraEventsTail',
    description:
      'Read the last N entries from the session event store. Read-only — no writes, no bus ' +
      'subscription. Filter by kind or correlationId to thread a causal chain. Use this before ' +
      'speculating about what already happened.',
    inputSchema: {
      type: 'object',
      properties: {
        last: { type: 'integer', minimum: 1, maximum: 1000, default: DEFAULT_TAIL },
        kind: { type: 'string' },
        correlationId: { type: 'string' },
        sinceMs: { type: 'integer', minimum: 0 },
      },
    },
    readonly: true,
    parallelSafe: true,
    permissionKey(input) {
      const parts: string[] = [];
      if (input.kind !== undefined) parts.push(`kind:${input.kind}`);
      if (input.correlationId !== undefined) parts.push(`corr:${input.correlationId}`);
      return parts.length === 0 ? 'events-tail' : `events-tail:${parts.join(',')}`;
    },
    async *execute(input, _toolCtx): AsyncIterable<ToolEvent<EventsTailOutput>> {
      const parsed = eventsTailInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraEventsTail: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        const out = await runEventsTail(parsed.data, {
          ...(ctx.storePath !== undefined && { storePath: ctx.storePath }),
        });
        yield { type: 'result', output: out };
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_EVENTS',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
        };
      }
    },
  };
}
