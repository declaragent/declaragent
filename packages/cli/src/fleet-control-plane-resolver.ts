/**
 * Fleet-level `controlPlane:` precedence resolver.
 *
 * POST_ENTERPRISE_BACKLOG.md #17. Until 0.7.5, each agent's
 * `agent.yaml#controlPlane.auth` block was read independently, and the
 * `up` process-wide HTTP listener picked the FIRST agent's block while
 * warning about any others (see `up-cli.ts:635-679`). That worked for
 * single-agent hosts but collapsed the moment a fleet wanted ONE auth
 * config shared across every agent on a host — operators had to copy
 * the same block into N `agent.yaml` files with no guardrail against
 * drift.
 *
 * 0.7.5 adds a top-level `controlPlane:` block on `fleet.yaml`. When
 * present it wins over every per-agent block (deprecation warning on
 * the per-agent overrides) and the HTTP listener boots with the fleet-
 * level config. When absent we fall back to the legacy first-agent
 * path, preserving 0.7.4 and prior behaviour bit-for-bit.
 *
 * Orthogonality note: `fleet.yaml#hosts[]` (shipped in #50) is the
 * CLIENT-SIDE address book — what the CLI fans OUT to. The
 * `controlPlane:` block in this file is the SERVER-SIDE config — what
 * each agent on this fleet's hosts exposes. Both may coexist; they
 * address different concerns.
 *
 * @since 0.7.5 — POST_ENTERPRISE_BACKLOG.md #17
 */

import type { FleetControlPlane, FleetManifest, LoadedControlPlaneAuth } from '@declaragent/core';
import { parseControlPlaneAuth } from '@declaragent/core';

/**
 * Per-agent `controlPlane.auth` config collected from loaded agents.
 * Same shape `up-cli.ts` has always built from the loaded agents — the
 * resolver takes it as input so it stays pure + trivially testable.
 */
export interface PerAgentControlPlaneAuthCandidate {
  readonly id: string;
  readonly cfg: LoadedControlPlaneAuth | undefined;
}

export type ControlPlaneAuthSource = 'fleet' | 'agent' | 'none';

/**
 * Resolver output. `cfg` is the effective block (undefined when neither
 * source declared auth). `warnings` are human-readable strings the CLI
 * should emit on stderr; the resolver never writes output itself.
 *
 *   - `source === 'fleet'`: the fleet-level block wins. One warning per
 *     per-agent block that was ignored.
 *   - `source === 'agent'`: fallback path. Same single-warning rule
 *     `up-cli.ts` has always used when multiple agents set auth.
 *   - `source === 'none'`: neither source declared auth. CLI boots the
 *     listener without middleware.
 */
export interface ResolvedControlPlaneAuth {
  readonly cfg: LoadedControlPlaneAuth | undefined;
  readonly source: ControlPlaneAuthSource;
  readonly warnings: readonly string[];
  /**
   * The agent id chosen when `source === 'agent'`. Useful for the
   * banner line `up-cli.ts` already prints. `undefined` otherwise.
   */
  readonly chosenAgentId?: string;
}

/**
 * Resolve the effective control-plane auth config given a fleet manifest
 * (or `undefined` for single-`agent.yaml` mode) plus the list of per-
 * agent blocks already parsed by `loadAgent`.
 *
 * Pure function — no I/O, no side-effects. The CLI is responsible for
 * printing warnings and wiring the result into `startControlPlaneServer`.
 */
export function resolveControlPlaneAuth(params: {
  fleetManifest: FleetManifest | undefined;
  perAgentCandidates: readonly PerAgentControlPlaneAuthCandidate[];
}): ResolvedControlPlaneAuth {
  const { fleetManifest, perAgentCandidates } = params;
  const fleetBlock: FleetControlPlane | undefined = fleetManifest?.controlPlane;

  if (fleetBlock) {
    let fleetCfg: LoadedControlPlaneAuth | undefined;
    try {
      fleetCfg = parseControlPlaneAuth(fleetBlock.auth);
    } catch (err) {
      // Bubble up as a warning + fall back to the per-agent path. An
      // invalid fleet-level block should NOT silently disable every
      // agent's otherwise-valid auth.
      const msg = err instanceof Error ? err.message : String(err);
      const warnings = [
        `⚠ fleet.yaml#controlPlane.auth failed validation: ${msg}. Falling back to per-agent blocks.`,
      ];
      const agentResult = resolveFromAgents(perAgentCandidates);
      return {
        cfg: agentResult.cfg,
        source: agentResult.cfg === undefined ? 'none' : 'agent',
        warnings: [...warnings, ...agentResult.warnings],
        ...(agentResult.chosenAgentId !== undefined && {
          chosenAgentId: agentResult.chosenAgentId,
        }),
      };
    }

    // Per-agent overrides present? Warn once per conflicting agent
    // then drop them on the floor — the fleet-level block is the
    // single source of truth.
    const overriders = perAgentCandidates.filter((c) => c.cfg !== undefined).map((c) => c.id);
    const warnings: string[] = [];
    if (overriders.length > 0) {
      warnings.push(
        `⚠ fleet.yaml#controlPlane is set — ignoring per-agent controlPlane.auth blocks on: ${overriders.join(', ')}. Remove them from the agent.yaml files to silence this warning.`,
      );
    }
    return {
      cfg: fleetCfg,
      source: fleetCfg === undefined ? 'none' : 'fleet',
      warnings,
    };
  }

  // No fleet-level block → legacy per-agent path.
  const agentResult = resolveFromAgents(perAgentCandidates);
  return {
    cfg: agentResult.cfg,
    source: agentResult.cfg === undefined ? 'none' : 'agent',
    warnings: agentResult.warnings,
    ...(agentResult.chosenAgentId !== undefined && {
      chosenAgentId: agentResult.chosenAgentId,
    }),
  };
}

interface AgentFallbackResult {
  cfg: LoadedControlPlaneAuth | undefined;
  warnings: readonly string[];
  chosenAgentId?: string;
}

function resolveFromAgents(
  candidates: readonly PerAgentControlPlaneAuthCandidate[],
): AgentFallbackResult {
  const enabled = candidates.filter(
    (c): c is { id: string; cfg: LoadedControlPlaneAuth } => c.cfg !== undefined,
  );
  if (enabled.length === 0) {
    return { cfg: undefined, warnings: [] };
  }
  const first = enabled[0];
  if (!first) {
    return { cfg: undefined, warnings: [] };
  }
  const warnings: string[] = [];
  if (enabled.length > 1) {
    const others = enabled
      .slice(1)
      .map((x) => x.id)
      .join(', ');
    warnings.push(
      `⚠ multiple agents set controlPlane.auth.enabled=true (${others}). Using ${first.id}'s config for the process-wide listener. Consider moving the block to fleet.yaml#controlPlane (see POST_ENTERPRISE_BACKLOG.md #17).`,
    );
  }
  return { cfg: first.cfg, warnings, chosenAgentId: first.id };
}
