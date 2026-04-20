/**
 * `DeclaraFleetStatus` — read-only fleet report. Wraps slice-8's pure
 * `buildFleetStatus(fleet, options)` (see
 * `packages/cli/src/fleet-status-cli.ts`). Reuses the same
 * `loadFleet()` used by `declaragent fleet status`, so the tool
 * surfaces exactly what the CLI verb would render — minus the
 * formatting.
 *
 * Returns the full `FleetStatusReport` as the tool's `output.report`.
 * We don't re-narrow it here: the model reads the raw JSON, and
 * downstream REPL rendering (phase 6 polish) can pretty-print. See
 * BUILDER_PLAN §3.11.
 *
 * @since 0.2.0
 */

import { resolve } from 'node:path';
import { loadFleet } from '@declaragent/core';
import type { LoadedFleet, Tool, ToolEvent } from '@declaragent/core';
import { buildFleetStatus } from '../fleet-status-cli.js';
import { assertWithinScope } from './scope.js';
import type { FleetStatusInput, FleetStatusOutput } from './types.js';
import { BuilderValidationError, fleetStatusInputSchema, formatZodError } from './types.js';

export interface RunFleetStatusOptions {
  scopeRoot: string;
}

export async function runFleetStatus(
  input: FleetStatusInput,
  options: RunFleetStatusOptions,
): Promise<FleetStatusOutput> {
  const fleetRoot = resolve(input.fleetRoot ?? options.scopeRoot);
  assertWithinScope(fleetRoot, options.scopeRoot);

  let fleet: LoadedFleet;
  try {
    fleet = await loadFleet({ root: fleetRoot });
  } catch (err) {
    // loadFleet throws FleetManifestError / FleetConfigError for
    // anything missing or malformed. Wrap as BuilderValidationError
    // so the caller gets a consistent error code.
    throw new BuilderValidationError(
      `could not load fleet at ${fleetRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const report = buildFleetStatus(fleet, {
    ...(input.history !== undefined && { history: input.history }),
    ...(input.historyLimit !== undefined && { historyLimit: input.historyLimit }),
  });

  return { ok: true, report };
}

export interface DeclaraFleetStatusContext {
  scopeRoot: string;
}

export function createFleetStatusTool(
  ctx: DeclaraFleetStatusContext,
): Tool<FleetStatusInput, FleetStatusOutput> {
  return {
    name: 'DeclaraFleetStatus',
    description:
      'Return the current fleet status — agents, envs, capabilities, peer topology, optional ' +
      'deploy history. Read-only. Prefer this to guessing; the report is always authoritative.',
    inputSchema: {
      type: 'object',
      properties: {
        history: { type: 'boolean', default: false },
        historyLimit: { type: 'integer', minimum: 1, maximum: 50 },
        fleetRoot: { type: 'string' },
      },
    },
    readonly: true,
    parallelSafe: true,
    permissionKey(input) {
      return `fleet-status${input.history ? ':history' : ''}`;
    },
    async *execute(input, _toolCtx): AsyncIterable<ToolEvent<FleetStatusOutput>> {
      const parsed = fleetStatusInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraFleetStatus: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        const out = await runFleetStatus(parsed.data, { scopeRoot: ctx.scopeRoot });
        yield { type: 'result', output: out };
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code:
              err && typeof err === 'object' && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'E_BUILDER_FLEET',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
        };
      }
    },
  };
}
