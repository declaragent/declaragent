/**
 * Zero-trust RPC auth **preview-mode** validator — implements the
 * 0.8.0 default flip described in `docs/ZERO_TRUST_DEFAULT_MIGRATION.md`
 * behind the `DECLARAGENT_RPC_AUTH_DEFAULT` env var.
 *
 * The flip itself does NOT ship in 0.7.6 — only the detection +
 * opt-in preview does. When the env var is on:
 *
 *   - Every agent whose fleet declares peers (fleet-root
 *     `rpc-peers.yaml` OR a per-agent `<agent>/rpc-peers.yaml`) MUST
 *     have an explicit `rpc.auth.enabled` value. Agents with the
 *     block absent entirely fail boot with `AUTH_REJECTED`.
 *   - Agents that explicitly set `rpc.auth.enabled: false` are
 *     honoured (Migration Path B) but listed as "intentionally
 *     unauthenticated" so the operator can audit them.
 *   - Agents with the memory-only transport (no peers declared) are
 *     exempt — they never cross a trust boundary.
 *
 * When the env var is off (the 0.7.6 default), this function returns
 * an empty result set and callers boot the fleet exactly as before.
 *
 * Used by:
 *
 *   - `up-cli.ts` + `fleet-run.ts` pre-boot gate: one failing agent
 *     aborts the whole daemon before any socket is bound.
 *   - `fleet-audit-rpc-cli.ts --dry-run-with-flag`: same detection
 *     logic, reported as a diff instead of a thrown error. Lets CI
 *     rehearse the flip without actually failing the boot.
 *
 * @since 0.7.6 — POST_ENTERPRISE_BACKLOG.md #5b prep (ships at 0.8.0)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type LoadedAgentEntry,
  type LoadedFleet,
  isRpcAuthDefaultFlagOn,
  resolveEffectiveRpcAuth,
} from '@declaragent/core';
import { loadAgent } from '@declaragent/core';

export type ZeroTrustPreviewReason =
  | 'explicit'
  | 'explicit-optout'
  | 'flag-default'
  | 'legacy-default'
  | 'boot-fail'
  | 'no-peers';

export interface ZeroTrustAgentResult {
  readonly agentId: string;
  readonly agentYamlPath: string;
  readonly posture: 'enabled' | 'disabled' | 'absent';
  /** Whether peers are declared for this agent's fleet (fleet-root OR per-agent). */
  readonly peersDeclared: boolean;
  /** Effective `rpc.auth.enabled` that would apply under the flag. */
  readonly wouldEnable: boolean;
  /** Reason — `boot-fail` means this agent fails pre-boot under the flag. */
  readonly reason: ZeroTrustPreviewReason;
}

export interface ZeroTrustPreviewResult {
  /** `true` iff the flag is considered "on" for this evaluation. */
  readonly flagOn: boolean;
  /** Per-agent classification. */
  readonly agents: readonly ZeroTrustAgentResult[];
  /**
   * Agents that fail the pre-boot gate — posture `absent`, peers
   * declared, flag on. Empty when the flag is off OR every agent has
   * an explicit posture OR none of the agents declare peers.
   */
  readonly failingAgents: readonly ZeroTrustAgentResult[];
  /**
   * Agents with an explicit opt-out (`rpc.auth.enabled: false`). Not
   * blocking but worth surfacing in the inspector output so the
   * operator can audit them.
   */
  readonly intentionalOptOuts: readonly ZeroTrustAgentResult[];
}

export interface EvaluateZeroTrustOptions {
  readonly fleet: LoadedFleet;
  /**
   * Env bag used for flag detection. Defaults to `process.env`.
   * Tests inject a `{ DECLARAGENT_RPC_AUTH_DEFAULT: 'on' }` bag to
   * exercise the flip without mutating the ambient process.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Force the flag to a specific value — used by
   * `fleet audit-rpc --dry-run-with-flag` to simulate the flip
   * regardless of what `process.env` currently holds.
   */
  readonly forceFlagOn?: boolean;
  /**
   * Injected loader for tests that bypass disk. Defaults to
   * `@declaragent/core` `loadAgent`.
   */
  readonly loader?: (agent: LoadedAgentEntry) => Promise<{
    readonly posture: 'enabled' | 'disabled' | 'absent';
  }>;
}

/**
 * Walk every agent in `fleet` and report what would happen under the
 * 0.8.0 flip. Safe to call with the flag off — returns a report where
 * every agent is `reason: 'legacy-default'` / `'explicit'` /
 * `'explicit-optout'` and no failing agents.
 *
 * Does NOT throw. The CLI wrappers decide how to surface a non-empty
 * `failingAgents` list (stderr + exit 1 for the boot gate; a dry-run
 * diff for the inspector).
 */
export async function evaluateZeroTrustPreview(
  opts: EvaluateZeroTrustOptions,
): Promise<ZeroTrustPreviewResult> {
  const flagOn =
    opts.forceFlagOn !== undefined
      ? opts.forceFlagOn
      : isRpcAuthDefaultFlagOn(opts.env ?? process.env);

  // "Peers declared" for an agent: fleet-root peers OR a per-agent
  // `<agentDir>/rpc-peers.yaml`. Fleets without either for any agent
  // are exempt in full — the memory-only path.
  const fleetRootPeersDeclared = opts.fleet.peers !== undefined;

  const loader =
    opts.loader ??
    (async (agent) => {
      const loaded = await loadAgent({ agentDir: agent.path });
      return { posture: loaded.rpcAuthPosture };
    });

  const agents: ZeroTrustAgentResult[] = [];
  for (const agent of opts.fleet.agents) {
    const perAgentPeersPath = join(agent.path, 'rpc-peers.yaml');
    const perAgentPeersDeclared = existsSync(perAgentPeersPath);
    const peersDeclared = fleetRootPeersDeclared || perAgentPeersDeclared;

    let posture: 'enabled' | 'disabled' | 'absent';
    try {
      const loaded = await loader(agent);
      posture = loaded.posture;
    } catch {
      // Loader failure → report as `absent` so the inspector prompts
      // the operator to fix the agent.yaml before taking 0.8.0. We
      // don't want a loader crash to silently pass the gate.
      posture = 'absent';
    }

    const resolved = resolveEffectiveRpcAuth({ posture, peersDeclared, flagOn });

    const reason: ZeroTrustPreviewReason = peersDeclared
      ? resolved.reason
      : posture === 'enabled'
        ? 'explicit'
        : posture === 'disabled'
          ? 'explicit-optout'
          : 'no-peers';

    agents.push({
      agentId: agent.id,
      agentYamlPath: agent.agentYamlPath,
      posture,
      peersDeclared,
      wouldEnable: resolved.enabled,
      reason,
    });
  }

  const failingAgents = agents.filter((a) => a.reason === 'boot-fail');
  const intentionalOptOuts = agents.filter((a) => a.reason === 'explicit-optout');

  return { flagOn, agents, failingAgents, intentionalOptOuts };
}

/**
 * Format a `failingAgents` list into a boot-rejection message the CLI
 * prints to stderr + copies into the `AUTH_REJECTED` error. Shaped to
 * be grep-friendly: one `AUTH_REJECTED` prefix per agent + a pointer
 * to the migration doc.
 */
export function formatZeroTrustBootReject(failing: readonly ZeroTrustAgentResult[]): string {
  const lines: string[] = [
    `AUTH_REJECTED: ${failing.length} agent(s) fail the 0.8.0 zero-trust preview gate (DECLARAGENT_RPC_AUTH_DEFAULT=on).`,
    '',
    'Each agent below declares peers (rpc-peers.yaml) but does not set rpc.auth.enabled explicitly.',
    'Under 0.8.0 this combination fails boot by default. Add `rpc.auth.enabled: true` (recommended) or',
    '`rpc.auth.enabled: false` (explicit opt-out, discouraged) to each agent.yaml listed below:',
    '',
  ];
  for (const a of failing) {
    lines.push(`  - agent://${a.agentId}  (${a.agentYamlPath})`);
  }
  lines.push(
    '',
    'See docs/ZERO_TRUST_DEFAULT_MIGRATION.md for the full migration plan. Or run:',
    '  declaragent fleet audit-rpc --suggest-enable',
    'for copy-pasteable YAML diffs.',
  );
  return lines.join('\n');
}
