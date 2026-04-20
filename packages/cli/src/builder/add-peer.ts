/**
 * `DeclaraAddPeer` builder tool — append / merge a peer entry in a
 * fleet's `rpc-peers.yaml`. See BUILDER_PLAN §3.10.
 *
 * Behaviour:
 *   1. Resolve the fleet root (input.fleetRoot or scopeRoot) and
 *      confirm `rpc-peers.yaml` is addressable there. If the file
 *      doesn't exist yet we create it with `version: 1, peers: []`.
 *   2. Parse with `yaml.parseDocument` so comments + formatting
 *      survive the round-trip.
 *   3. If a peer entry for `input.agent` already exists, merge the
 *      new transports into it (append, skipping byte-equal
 *      duplicates). Otherwise append a fresh entry to the `peers`
 *      sequence.
 *   4. Run `peersConfigSchema.parse` on the final object — the tool
 *      refuses to write anything that wouldn't load via core.
 *
 * Never wires transports the model made up — any invalid kind or
 * missing required field is rejected by the upstream schema.
 *
 * @since 0.2.0
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { peersConfigSchema } from '@declaragent/core';
import type { Tool, ToolEvent } from '@declaragent/core';
import { parseDocument } from 'yaml';
import { assertWithinScope } from './scope.js';
import type { AddPeerInput, AddPeerOutput } from './types.js';
import { BuilderValidationError, addPeerInputSchema, formatZodError } from './types.js';

// ── Internal runner (exported for tests) ───────────────────────────────

export interface RunAddPeerOptions {
  scopeRoot: string;
}

export async function runAddPeer(
  input: AddPeerInput,
  options: RunAddPeerOptions,
): Promise<AddPeerOutput> {
  const fleetRoot = resolve(input.fleetRoot ?? options.scopeRoot);
  assertWithinScope(fleetRoot, options.scopeRoot, {
    ...(input.confirmOutsideScope !== undefined && {
      confirmOutsideScope: input.confirmOutsideScope,
    }),
  });

  const peersPath = join(fleetRoot, 'rpc-peers.yaml');
  const { next, merged } = await appendPeerEntry(peersPath, input);

  // Final validation — bounce anything that core would reject at
  // load time. This is the authoritative gate: we never ship a
  // rpc-peers.yaml the runtime can't read.
  const parsed = peersConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw new BuilderValidationError(
      `rpc-peers.yaml would fail validation: ${formatZodError(parsed.error)}`,
    );
  }

  return {
    ok: true,
    agent: input.agent,
    peersPath,
    writes: [peersPath],
    merged,
  };
}

// ── YAML surgical append ───────────────────────────────────────────────

interface AppendResult {
  /** Plain JS object after the mutation — what core validates. */
  next: unknown;
  merged: boolean;
}

/**
 * Load `rpc-peers.yaml` (or synthesise a fresh one), append or merge
 * the peer entry, and write the file back. Preserves comments and
 * surrounding key order via `yaml.parseDocument`.
 */
export async function appendPeerEntry(
  peersPath: string,
  input: AddPeerInput,
): Promise<AppendResult> {
  let raw: string | undefined;
  try {
    raw = await readFile(peersPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const doc = raw !== undefined ? parseDocument(raw) : parseDocument('version: 1\npeers: []\n');

  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new BuilderValidationError(
      `rpc-peers.yaml is not valid YAML: ${first ? first.message : 'unknown parse error'}`,
    );
  }

  // The schema is strict — it does not accept keys beyond
  // `version` + `peers`. If the file had version 0 / missing,
  // override to 1 so the append is guaranteed loadable.
  if (doc.get('version') === undefined) doc.set('version', 1);

  const peersNode = doc.get('peers', true) as unknown;
  let merged = false;

  if (peersNode === null || peersNode === undefined) {
    doc.set('peers', [{ agent: input.agent, transports: input.transports }]);
  } else {
    const seqLike = peersNode as {
      items?: ReadonlyArray<unknown>;
      add?: (v: unknown) => void;
    };
    if (!Array.isArray(seqLike.items) || typeof seqLike.add !== 'function') {
      throw new BuilderValidationError('rpc-peers.yaml "peers" must be a YAML list');
    }

    // Look for an existing entry with the same agent id.
    let existingIndex = -1;
    seqLike.items.forEach((item, i) => {
      const obj = item as { get?: (key: string) => unknown } | undefined;
      if (obj && typeof obj.get === 'function') {
        if (obj.get('agent') === input.agent) existingIndex = i;
      }
    });

    if (existingIndex === -1) {
      seqLike.add({ agent: input.agent, transports: input.transports });
    } else {
      // Merge transports — append anything byte-structurally new. A
      // duplicate kind+topics entry is a no-op.
      merged = true;
      const entryDoc = doc.getIn(['peers', existingIndex, 'transports'], true) as {
        items?: ReadonlyArray<unknown>;
        add?: (v: unknown) => void;
      };
      const existingTransports = Array.isArray(entryDoc?.items)
        ? entryDoc.items.map((t) => (t as { toJSON?: () => unknown }).toJSON?.() ?? t)
        : [];
      const existingKeys = new Set(existingTransports.map((t) => stableKey(t)));
      for (const transport of input.transports) {
        const key = stableKey(transport);
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        if (typeof entryDoc?.add === 'function') entryDoc.add(transport);
      }
    }
  }

  const out = doc.toString();
  const normalised = out.endsWith('\n') ? out : `${out}\n`;
  await writeFile(peersPath, normalised, 'utf-8');
  return { next: doc.toJS(), merged };
}

/**
 * Deterministic JSON key for transport entries so duplicate-merge
 * checks work on structurally-equal objects regardless of key order.
 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`;
}

// ── Public Tool ────────────────────────────────────────────────────────

export interface DeclaraAddPeerContext {
  scopeRoot: string;
}

export function createAddPeerTool(ctx: DeclaraAddPeerContext): Tool<AddPeerInput, AddPeerOutput> {
  return {
    name: 'DeclaraAddPeer',
    description:
      "Append or merge a peer entry in the fleet's rpc-peers.yaml. Preserves comments via " +
      "yaml.parseDocument. Validates the final file against @declaragent/core's peersConfigSchema.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', pattern: '^agent://.+' },
        transports: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['memory', 'kafka', 'nats', 'sqs', 'amqp', 'mqtt'] },
            },
            required: ['kind'],
          },
        },
        fleetRoot: { type: 'string' },
        confirmOutsideScope: { type: 'boolean', default: false },
      },
      required: ['agent', 'transports'],
    },
    readonly: false,
    permissionKey(input) {
      const scopeKey =
        input.fleetRoot !== undefined
          ? relative(ctx.scopeRoot, resolve(input.fleetRoot)) || '.'
          : '.';
      return `${scopeKey}:${input.agent}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<AddPeerOutput>> {
      const parsed = addPeerInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAddPeer: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        if (toolCtx.abortSignal.aborted) {
          yield { type: 'error', error: { code: 'ABORTED', message: 'DeclaraAddPeer aborted' } };
          return;
        }
        const out = await runAddPeer(parsed.data, { scopeRoot: ctx.scopeRoot });
        yield { type: 'result', output: out };
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code:
              err && typeof err === 'object' && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'E_BUILDER',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
        };
      }
    },
  };
}
