/**
 * `DeclaraFleetAdd` builder tool — scaffold a new agent into a fleet
 * from a named template. See BUILDER_PLAN §3.9.
 *
 * Thin wrapper around slice-2's {@link addAgentFromTemplate}:
 *   1. Resolve the target `fleetRoot` (explicit input or scope root).
 *   2. Verify `fleet.yaml` exists there — this tool does not create
 *      fleets from scratch; `declaragent init --fleet <name>` is the
 *      supported path for that.
 *   3. Resolve the templates directory via the same helper the
 *      `declaragent fleet add` CLI verb uses, so builder-scaffolded
 *      agents land in the same shape as CLI-scaffolded ones.
 *   4. Call `addAgentFromTemplate` and translate its result shape into
 *      the builder-standard `{ ok, writes, ... }` envelope.
 *
 * Note: the scaffolder itself is sync + pure-FS. We still mark the
 * tool as async because the engine's Tool contract expects an async
 * generator; the cost is a single microtask.
 *
 * @since 0.2.0
 */

import { join, relative, resolve } from 'node:path';
import type { Tool, ToolEvent } from '@declaragent/core';
import { defaultTemplatesDir } from '../fleet-add-cli.js';
import { DEFAULT_FLEET_FS, FleetScaffoldError, addAgentFromTemplate } from '../fleet-scaffold.js';
import { assertWithinScope } from './scope.js';
import type { FleetAddInput, FleetAddOutput } from './types.js';
import { BuilderValidationError, fleetAddInputSchema, formatZodError } from './types.js';

// ── Internal runner (exported for tests) ───────────────────────────────

export interface RunFleetAddOptions {
  scopeRoot: string;
  /** Override the templates dir. Production callers let this default to the helper. */
  templatesDir?: string;
}

export async function runFleetAdd(
  input: FleetAddInput,
  options: RunFleetAddOptions,
): Promise<FleetAddOutput> {
  const fleetRoot = resolve(input.fleetRoot ?? options.scopeRoot);
  assertWithinScope(fleetRoot, options.scopeRoot, {
    ...(input.confirmOutsideScope !== undefined && {
      confirmOutsideScope: input.confirmOutsideScope,
    }),
  });

  // A fleet must already exist — we don't auto-init one from a tool
  // call. This is the mirror of `fleet add`'s "no fleet.yaml found"
  // error; keeping parity means a user who's been using the CLI sees
  // the same diagnostic from the builder.
  if (!DEFAULT_FLEET_FS.exists(join(fleetRoot, 'fleet.yaml'))) {
    throw new BuilderValidationError(
      `no fleet.yaml at ${fleetRoot}. Run \`declaragent init --fleet <name>\` first, or point fleetRoot at an existing fleet.`,
    );
  }

  const templatesDir = options.templatesDir ?? defaultTemplatesDir();

  try {
    const result = addAgentFromTemplate(
      {
        fleetRoot,
        template: input.template,
        templatesDir,
        ...(input.id !== undefined && { id: input.id }),
        ...(input.force !== undefined && { force: input.force }),
      },
      DEFAULT_FLEET_FS,
    );
    return {
      ok: true,
      agentId: result.agentId,
      agentPath: result.agentPath,
      manifestPath: result.manifestPath,
      writes: [...result.written, result.manifestPath],
    };
  } catch (err) {
    if (err instanceof FleetScaffoldError) {
      throw new BuilderValidationError(err.message);
    }
    throw err;
  }
}

// ── Public Tool ────────────────────────────────────────────────────────

export interface DeclaraFleetAddContext {
  scopeRoot: string;
  templatesDir?: string;
}

export function createFleetAddTool(
  ctx: DeclaraFleetAddContext,
): Tool<FleetAddInput, FleetAddOutput> {
  return {
    name: 'DeclaraFleetAdd',
    description:
      'Scaffold a new agent into the current fleet from a named template. Requires a pre-existing ' +
      'fleet.yaml at the scope root (or at the supplied fleetRoot). Mirrors `declaragent fleet add`.',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template name, e.g. rpc-client or concierge.' },
        id: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9_-]*$',
          description: 'Optional override — defaults to the template id.',
        },
        force: { type: 'boolean', default: false },
        fleetRoot: { type: 'string' },
        confirmOutsideScope: { type: 'boolean', default: false },
      },
      required: ['template'],
    },
    readonly: false,
    permissionKey(input) {
      const scopeKey =
        input.fleetRoot !== undefined
          ? relative(ctx.scopeRoot, resolve(input.fleetRoot)) || '.'
          : '.';
      return `${scopeKey}:${input.template}${input.id ? `#${input.id}` : ''}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<FleetAddOutput>> {
      const parsed = fleetAddInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraFleetAdd: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        if (toolCtx.abortSignal.aborted) {
          yield { type: 'error', error: { code: 'ABORTED', message: 'DeclaraFleetAdd aborted' } };
          return;
        }
        const out = await runFleetAdd(parsed.data, {
          scopeRoot: ctx.scopeRoot,
          ...(ctx.templatesDir !== undefined && { templatesDir: ctx.templatesDir }),
        });
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
