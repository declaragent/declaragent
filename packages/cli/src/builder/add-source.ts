/**
 * `DeclaraAddSource` builder tool — append an event source to an
 * agent's per-agent `event-sources.yaml`. See USABILITY_PLAN.md Phase
 * B (P1) — this was one of the four step-kinds
 * `DeclaraApplyChange` previously rejected as "not supported yet".
 *
 * What this unlocks: the builder can now scaffold event-driven
 * agents end-to-end. "build a PR-review bot triggered by a github
 * webhook" → one proposal with `addAgent` + `addSource` + `addSkill`;
 * `/yes` applies; `declaragent run .` picks up the source via
 * `startAgentSources` and fires it in-process.
 *
 * Behaviour:
 *   1. Resolve the agent root (input.agentPath or scopeRoot).
 *   2. Confirm `agent.yaml` exists there — prevents writing sources
 *      for a directory that isn't actually a scaffolded agent.
 *   3. Load (or synthesise) `event-sources.yaml` via
 *      `yaml.parseDocument` so comments + formatting survive.
 *   4. Reject duplicate `{ type, config.id }` entries — the daemon's
 *      diff key relies on id uniqueness per type.
 *   5. Append the new entry and write.
 *   6. Round-trip through core's `validateEventSourcesConfig` with
 *      the three in-process adapters. On failure, restore the prior
 *      file (or delete it when we just created it) and surface the
 *      validation error.
 *
 * External-broker types (kafka / nats / sqs / amqp / mqtt) pass
 * through without adapter-level validation — core reports them as
 * `unknownTypes` at run time and the builder surfaces a hint so the
 * user knows they need the matching `@declaragent/source-*` package +
 * credentials before the source will fire.
 *
 * @since 0.4.0
 */

import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  createCronAdapter,
  createFileWatchAdapter,
  createWebhookAdapter,
  validateEventSourcesConfig,
} from '@declaragent/core';
import type { EventSourceAdapter, Tool, ToolEvent } from '@declaragent/core';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { assertWithinScope } from './scope.js';
import {
  type AddSourceInput,
  type AddSourceOutput,
  BuilderConflictError,
  BuilderValidationError,
  addSourceInputSchema,
  formatZodError,
} from './types.js';

// ── Internal runner (exported for tests) ───────────────────────────────

export interface RunAddSourceOptions {
  scopeRoot: string;
}

const IN_PROCESS_TYPES = new Set(['webhook', 'cron', 'file-watch']);

/**
 * Adapter map used for the post-write validation round-trip. Lazily
 * constructed per invocation so tests don't have to tear down adapter
 * state between runs — the adapters themselves are stateless factories,
 * instances only come to life when `.create()` is called.
 */
function builtinAdapters(): Record<string, EventSourceAdapter<unknown>> {
  return {
    webhook: createWebhookAdapter() as EventSourceAdapter<unknown>,
    cron: createCronAdapter() as EventSourceAdapter<unknown>,
    'file-watch': createFileWatchAdapter() as EventSourceAdapter<unknown>,
  };
}

export async function runAddSource(
  input: AddSourceInput,
  options: RunAddSourceOptions,
): Promise<AddSourceOutput> {
  const agentPath = resolve(input.agentPath ?? options.scopeRoot);
  assertWithinScope(agentPath, options.scopeRoot, {
    ...(input.confirmOutsideScope !== undefined && {
      confirmOutsideScope: input.confirmOutsideScope,
    }),
  });

  const agentYamlPath = join(agentPath, 'agent.yaml');
  try {
    const s = await stat(agentYamlPath);
    if (!s.isFile()) {
      throw new BuilderValidationError(`${agentYamlPath} is not a file`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BuilderValidationError(
        `no agent.yaml at ${agentYamlPath} — point agentPath at a scaffolded agent directory`,
      );
    }
    throw err;
  }

  const eventSourcesPath = await locateEventSourcesFile(agentPath);

  // Stamp the id onto the config so the user can read either field
  // without surprise. The runtime adapters (webhook/cron/file-watch)
  // all accept `config.id`; external adapters generally do too.
  const normalisedConfig: Record<string, unknown> = {
    id: input.id,
    ...input.config,
  };
  if (normalisedConfig.id !== input.id) {
    // Paranoia: spread order means `input.config.id` wins. Reinstate
    // the sanitised id so a mismatched payload doesn't drift.
    normalisedConfig.id = input.id;
  }

  const prior = await readIfExists(eventSourcesPath);
  const { nextYaml, isNew } = appendSourceEntry(prior, {
    type: input.type,
    id: input.id,
    config: normalisedConfig,
  });

  await writeFile(eventSourcesPath, nextYaml, 'utf-8');

  // Authoritative validation via core's loader + the in-process
  // adapter map. Restore the previous file on failure so a rejected
  // payload never leaves behind a broken config.
  try {
    const report = await validateEventSourcesConfig({
      path: eventSourcesPath,
      adapters: builtinAdapters() as Readonly<
        Record<string, { validateConfig: (cfg: unknown) => void }>
      >,
    });
    if (report.errors.length > 0) {
      const first = report.errors[0];
      throw new BuilderValidationError(
        first
          ? `event-sources.yaml would fail validation: entry[${first.index}] type="${first.type}": ${first.message}`
          : 'event-sources.yaml would fail validation',
      );
    }
  } catch (err) {
    // Rollback — either delete (we just created it) or restore prior.
    if (isNew) {
      await unlink(eventSourcesPath).catch(() => {});
    } else if (prior !== undefined) {
      await writeFile(eventSourcesPath, prior, 'utf-8');
    }
    throw err;
  }

  return {
    ok: true,
    type: input.type,
    id: input.id,
    eventSourcesPath,
    writes: [eventSourcesPath],
    external: !IN_PROCESS_TYPES.has(input.type),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the event-sources config path for this agent.
 *
 * Prefers an existing `event-sources.yaml`, then `.yml`, then `.json`,
 * falling back to `event-sources.yaml` for fresh agents. We don't
 * migrate JSON → YAML silently — if the user hand-picked `.json` we
 * keep writing JSON to avoid surprising a format-sensitive toolchain
 * downstream.
 */
async function locateEventSourcesFile(agentPath: string): Promise<string> {
  for (const name of ['event-sources.yaml', 'event-sources.yml', 'event-sources.json']) {
    const p = join(agentPath, name);
    try {
      await stat(p);
      return p;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return join(agentPath, 'event-sources.yaml');
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

interface AppendResult {
  nextYaml: string;
  isNew: boolean;
}

interface SourceEntry {
  type: string;
  id: string;
  config: Record<string, unknown>;
}

/**
 * Append the new entry to the config text. Handles three shapes:
 *   - no prior file → emit a clean yaml sequence
 *   - prior `.json` → parse, append, re-emit as json (preserves extension)
 *   - prior yaml → parseDocument round-trip so comments survive
 *
 * Duplicate `{ type, id }` tuples raise `BuilderConflictError` — the
 * daemon's diff key relies on `config.id` being unique per type.
 */
export function appendSourceEntry(prior: string | undefined, entry: SourceEntry): AppendResult {
  // Fresh file.
  if (prior === undefined || prior.trim().length === 0) {
    const asYaml = stringifyYaml([{ type: entry.type, config: entry.config }]);
    return {
      nextYaml: asYaml.endsWith('\n') ? asYaml : `${asYaml}\n`,
      isNew: true,
    };
  }

  // JSON branch — the user opted into JSON and we keep the extension
  // contract. No comment preservation in JSON, so a plain parse+stringify
  // is fine.
  const looksLikeJson = prior.trimStart().startsWith('[');
  if (looksLikeJson) {
    let current: unknown;
    try {
      current = JSON.parse(prior);
    } catch (err) {
      throw new BuilderValidationError(
        `event-sources.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(current)) {
      throw new BuilderValidationError(
        'event-sources.json must be an array of { type, config } entries',
      );
    }
    assertNoDuplicate(current as SourceEntry[], entry);
    const next = [...current, { type: entry.type, config: entry.config }];
    return { nextYaml: `${JSON.stringify(next, null, 2)}\n`, isNew: false };
  }

  // YAML branch — parseDocument preserves comments + key ordering.
  const doc = parseDocument(prior);
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    throw new BuilderValidationError(
      `event-sources.yaml is not valid YAML: ${first ? first.message : 'unknown parse error'}`,
    );
  }

  const root = doc.contents as {
    items?: ReadonlyArray<unknown>;
    add?: (v: unknown) => void;
  } | null;

  // Empty document (comments-only file). Replace the contents with a
  // fresh sequence so the append lands at the top level.
  if (root === null || !Array.isArray(root.items)) {
    const asYaml = stringifyYaml([{ type: entry.type, config: entry.config }]);
    return {
      nextYaml: asYaml.endsWith('\n') ? asYaml : `${asYaml}\n`,
      isNew: false,
    };
  }

  // Reject duplicate `{ type, id }` — surface the conflict to the user
  // so they can either pick a different id or delete the old entry.
  const existing = root.items.map((it) => {
    const item = it as { toJSON?: () => unknown } | unknown;
    if (item && typeof (item as { toJSON?: () => unknown }).toJSON === 'function') {
      return (item as { toJSON: () => unknown }).toJSON() as Partial<SourceEntry>;
    }
    return item as Partial<SourceEntry>;
  });
  assertNoDuplicate(existing, entry);

  if (typeof root.add === 'function') {
    root.add({ type: entry.type, config: entry.config });
  } else {
    throw new BuilderValidationError('event-sources.yaml top-level must be a YAML list');
  }
  const out = doc.toString();
  return {
    nextYaml: out.endsWith('\n') ? out : `${out}\n`,
    isNew: false,
  };
}

function assertNoDuplicate(
  existing: Partial<SourceEntry>[] | ReadonlyArray<Partial<SourceEntry>>,
  entry: SourceEntry,
): void {
  for (const [i, e] of Array.from(existing).entries()) {
    if (!e || typeof e !== 'object') continue;
    if (e.type !== entry.type) continue;
    const cfg = e.config as { id?: unknown } | undefined;
    const id = cfg?.id;
    if (typeof id === 'string' && id === entry.id) {
      throw new BuilderConflictError(
        `event-sources already has a ${entry.type} source with id "${entry.id}" (entry[${i}]). Pick a different id or remove the existing entry first.`,
      );
    }
  }
}

// ── Public Tool ────────────────────────────────────────────────────────

export interface DeclaraAddSourceContext {
  scopeRoot: string;
}

export function createAddSourceTool(
  ctx: DeclaraAddSourceContext,
): Tool<AddSourceInput, AddSourceOutput> {
  return {
    name: 'DeclaraAddSource',
    description:
      'Register an event source (webhook, cron, file-watch, or external broker) in an agent ' +
      "scaffold's event-sources.yaml. Validates the result via core's loader + in-process " +
      'adapters so the daemon/run-agent-sources path will accept it at startup.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['webhook', 'cron', 'file-watch', 'kafka', 'nats', 'sqs', 'amqp', 'mqtt'],
        },
        id: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9_-]*$',
          description:
            'Stable id surfaced in events + logs. The daemon diff key relies on this being unique per type per agent.',
        },
        config: {
          type: 'object',
          description:
            'Adapter-specific config. Webhook: { path?, port? }. Cron: { schedule, target }. File-watch: { dir, target }.',
        },
        agentPath: { type: 'string' },
        confirmOutsideScope: { type: 'boolean', default: false },
      },
      required: ['type', 'id', 'config'],
    },
    readonly: false,
    permissionKey(input) {
      const scopeKey =
        input.agentPath !== undefined
          ? relative(ctx.scopeRoot, resolve(input.agentPath)) || '.'
          : '.';
      return `${scopeKey}:${input.type}:${input.id}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<AddSourceOutput>> {
      const parsed = addSourceInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAddSource: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        if (toolCtx.abortSignal.aborted) {
          yield {
            type: 'error',
            error: { code: 'ABORTED', message: 'DeclaraAddSource aborted' },
          };
          return;
        }
        const out = await runAddSource(parsed.data, { scopeRoot: ctx.scopeRoot });
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
