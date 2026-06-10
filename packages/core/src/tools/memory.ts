/**
 * Built-in long-term memory tools (durable-with-memory "mode 3").
 *
 * Three `Tool`s — `memory_write`, `memory_read`, `memory_search` — bound
 * to a {@link MemoryStore} instance + a namespace. They give the model an
 * explicit, opt-in way to persist and recall facts ACROSS sessions and
 * process restarts (the in-session transcript is the only other memory and
 * it evaporates when the session ends).
 *
 * Mirrors the bound-factory shape of `send-message.ts`
 * ({@link createSendMessageTool}) — the store + namespace are closed over,
 * so callers (the CLI's `up` wiring) construct one set per agent.
 *
 * Permission keys are namespace-scoped so operators can glob:
 *
 * ```yaml
 * permissions:
 *   allow:
 *     - memory_read:support/*       # read any key in the support namespace
 *     - memory_write:support/note-* # write only note-* keys
 *   deny:
 *     - memory_write:*              # block all writes by default
 * ```
 *
 * Semantic / embedding recall and automatic transcript summarization are
 * explicit FUTURE work — see `docs/AGENT_MEMORY.md`.
 *
 * @since 0.5.6
 */

import type { MemoryStore } from '../memory/sqlite-memory.js';
import { type TenantContext, isDefaultTenant } from '../tenancy/types.js';
import type { Tool } from '../types/tool.js';

/**
 * WS8 — per-tenant memory isolation. Long-term memory is keyed `(namespace,
 * key)` with `namespace` defaulting to the agent id, so in a multi-tenant fleet
 * every tenant's end-users would share ONE namespace and commingle their stored
 * PII. This scopes the namespace by the executing tenant: the default
 * (single-tenant) deployment keeps the bare namespace — no migration, fully
 * backward-compatible — while each non-default tenant gets an isolated
 * `<namespace>::t::<tenantId>` partition that another tenant's turns can't read
 * or overwrite. (Per-end-user isolation within a tenant additionally needs a
 * subject identity threaded through `ToolContext`; that remains.)
 */
export function tenantScopedNamespace(base: string, tenant?: TenantContext): string {
  if (tenant === undefined || isDefaultTenant(tenant)) return base;
  return `${base}::t::${tenant.id}`;
}

/**
 * WS8 — full memory partition for a turn: tenant scope (above) plus an optional
 * per-end-user `subject` segment. With a subject present, two end-users of the
 * SAME agent + tenant get isolated memory (`…::sub::<id>`), so one user's
 * preferences/PII never leak into another's recall. No subject → tenant-only
 * scope (unchanged), so single-user agents and cron/webhook turns are
 * unaffected. The subject is threaded from the inbound event's channel
 * principal via `ToolContext.subject`.
 */
export function scopedNamespace(base: string, tenant?: TenantContext, subject?: string): string {
  const tenantScoped = tenantScopedNamespace(base, tenant);
  return subject !== undefined && subject !== ''
    ? `${tenantScoped}::sub::${subject}`
    : tenantScoped;
}

// ── Input / output shapes ──────────────────────────────────────────────────

export interface MemoryWriteInput {
  key: string;
  value: string;
  tags?: string[];
}

export interface MemoryWriteOutput {
  key: string;
  namespace: string;
}

export interface MemoryReadInput {
  key: string;
}

export interface MemoryReadOutput {
  key: string;
  found: boolean;
  value?: string;
  tags?: readonly string[];
}

export interface MemorySearchInput {
  query: string;
  tags?: string[];
}

/** Lightweight projection of a record returned to the model. */
export interface MemorySearchMatch {
  key: string;
  value: string;
  tags: readonly string[];
}

export interface MemorySearchOutput {
  matches: MemorySearchMatch[];
}

// ── Factory ────────────────────────────────────────────────────────────────

export interface CreateMemoryToolsDeps {
  store: MemoryStore;
  /** Per-agent isolation boundary (CLI defaults this to the agent id). */
  namespace: string;
}

export interface MemoryTools {
  memoryWrite: Tool<MemoryWriteInput, MemoryWriteOutput>;
  memoryRead: Tool<MemoryReadInput, MemoryReadOutput>;
  memorySearch: Tool<MemorySearchInput, MemorySearchOutput>;
  /** All three, in a stable order, for spreading into a runtime tool set. */
  all: readonly Tool[];
}

export function createMemoryTools(deps: CreateMemoryToolsDeps): MemoryTools {
  const { store, namespace } = deps;

  const memoryWrite: Tool<MemoryWriteInput, MemoryWriteOutput> = {
    name: 'memory_write',
    description:
      'Persist a durable fact, preference, or note to long-term memory under a key, so you can recall it in a LATER session. ' +
      'Use this for things worth remembering across conversations (user preferences, decisions, runbook steps) — NOT for transient working state. ' +
      'Writing the same key again overwrites the previous value.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable identifier for this memory (e.g. "user:tz").' },
        value: { type: 'string', description: 'The text to remember.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional labels for later filtering via memory_search.',
        },
      },
      required: ['key', 'value'],
    },
    permissionKey: ({ key }) => `${namespace}/${key}`,
    async *execute(input, ctx) {
      if (ctx.abortSignal.aborted) {
        yield { type: 'error', error: { code: 'ABORTED', message: 'memory_write aborted' } };
        return;
      }
      try {
        const ns = scopedNamespace(namespace, ctx.tenant, ctx.subject);
        store.write(
          ns,
          input.key,
          input.value,
          input.tags !== undefined ? { tags: input.tags } : undefined,
        );
        yield { type: 'result', output: { key: input.key, namespace: ns } };
      } catch (err) {
        yield {
          type: 'error',
          error: { message: err instanceof Error ? err.message : String(err), cause: err },
        };
      }
    },
  };

  const memoryRead: Tool<MemoryReadInput, MemoryReadOutput> = {
    name: 'memory_read',
    description:
      'Read a value previously saved with memory_write, by its exact key. ' +
      'Returns `found: false` (not an error) when nothing is stored under that key, so you can branch on it. ' +
      'Use memory_search when you do not know the exact key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The exact key to look up.' },
      },
      required: ['key'],
    },
    readonly: true,
    permissionKey: ({ key }) => `${namespace}/${key}`,
    async *execute(input, ctx) {
      if (ctx.abortSignal.aborted) {
        yield { type: 'error', error: { code: 'ABORTED', message: 'memory_read aborted' } };
        return;
      }
      try {
        const rec = store.read(scopedNamespace(namespace, ctx.tenant, ctx.subject), input.key);
        if (!rec) {
          yield { type: 'result', output: { key: input.key, found: false } };
          return;
        }
        yield {
          type: 'result',
          output: { key: rec.key, found: true, value: rec.value, tags: rec.tags },
        };
      } catch (err) {
        yield {
          type: 'error',
          error: { message: err instanceof Error ? err.message : String(err), cause: err },
        };
      }
    },
  };

  const memorySearch: Tool<MemorySearchInput, MemorySearchOutput> = {
    name: 'memory_search',
    description:
      'Search long-term memory for stored records whose key or value contains the query text, optionally narrowed to records carrying ALL of the given tags. ' +
      'Use this to recall relevant memories when you do not know the exact key. An empty query (with no tags) returns everything stored.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring matched against each record key and value. Empty matches all.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: only return records carrying ALL of these tags.',
        },
      },
      required: ['query'],
    },
    readonly: true,
    permissionKey: () => namespace,
    async *execute(input, ctx) {
      if (ctx.abortSignal.aborted) {
        yield { type: 'error', error: { code: 'ABORTED', message: 'memory_search aborted' } };
        return;
      }
      try {
        const records = store.search(scopedNamespace(namespace, ctx.tenant, ctx.subject), {
          ...(input.query !== '' && { substring: input.query }),
          ...(input.tags !== undefined && input.tags.length > 0 && { tags: input.tags }),
        });
        const matches: MemorySearchMatch[] = records.map((r) => ({
          key: r.key,
          value: r.value,
          tags: r.tags,
        }));
        yield { type: 'result', output: { matches } };
      } catch (err) {
        yield {
          type: 'error',
          error: { message: err instanceof Error ? err.message : String(err), cause: err },
        };
      }
    },
  };

  return {
    memoryWrite,
    memoryRead,
    memorySearch,
    all: [memoryWrite, memoryRead, memorySearch] as readonly Tool[],
  };
}
