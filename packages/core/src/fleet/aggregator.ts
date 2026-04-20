/**
 * Cross-agent aggregation over a loaded fleet.
 *
 *   - {@link aggregateCapabilities} builds the fleet-wide capability table.
 *     Drives `declaragent fleet capabilities` + `fleet graph`.
 *   - {@link aggregatePeers} validates every `rpc-peers.yaml` entry
 *     resolves to an in-fleet agent. External peers (outside the fleet)
 *     are preserved but flagged as `external: true` — callers decide
 *     whether to warn, tolerate, or reject.
 *
 * @since 1.2.0
 */

import type { CapabilityDefinition, LoadedPeers, PeerEntry } from '../rpc/index.js';
import type { LoadedFleet } from './types.js';

export interface AggregatedCapability {
  readonly agentId: string;
  readonly capability: CapabilityDefinition;
}

export interface AggregatedCapabilityTable {
  /**
   * Key: `<agentId>/<capability.name>`. Unique by construction — the
   * capabilities-loader already rejects duplicate names within a single
   * agent. A cross-agent duplicate name is allowed (different agents
   * may offer the same capability name).
   */
  readonly byKey: ReadonlyMap<string, AggregatedCapability>;
  /** By capability name (may contain >1 entry for the same name). */
  readonly byName: ReadonlyMap<string, readonly AggregatedCapability[]>;
  /** Agents that did not ship a `capabilities.yaml`. */
  readonly clientOnly: readonly string[];
}

export function aggregateCapabilities(fleet: LoadedFleet): AggregatedCapabilityTable {
  const byKey = new Map<string, AggregatedCapability>();
  const byNameMut = new Map<string, AggregatedCapability[]>();
  const clientOnly: string[] = [];

  for (const agent of fleet.agents) {
    if (!agent.capabilities) {
      clientOnly.push(agent.id);
      continue;
    }
    for (const cap of agent.capabilities.config.capabilities) {
      const entry: AggregatedCapability = { agentId: agent.id, capability: cap };
      byKey.set(`${agent.id}/${cap.name}`, entry);
      const existing = byNameMut.get(cap.name) ?? [];
      existing.push(entry);
      byNameMut.set(cap.name, existing);
    }
  }

  const byName = new Map<string, readonly AggregatedCapability[]>();
  for (const [k, v] of byNameMut) byName.set(k, v);
  return { byKey, byName, clientOnly };
}

export interface AggregatedPeerEntry {
  readonly agentId: string;
  readonly peer: PeerEntry;
  /** True when the peer address points outside the fleet. */
  readonly external: boolean;
}

export interface AggregatedPeerReport {
  readonly entries: readonly AggregatedPeerEntry[];
  /**
   * In-fleet peers whose id is unknown to the fleet. Slice 1's
   * `fleet validate` reports these as errors; `fleet peers` surfaces
   * them informationally.
   */
  readonly danglingInFleet: readonly string[];
  /**
   * Peers that don't point at any in-fleet agent — legitimate when
   * talking to external services, but flagged so operators can sanity-
   * check.
   */
  readonly external: readonly string[];
}

export function aggregatePeers(fleet: LoadedFleet, peers?: LoadedPeers): AggregatedPeerReport {
  const source = peers ?? fleet.peers;
  if (!source) {
    return { entries: [], danglingInFleet: [], external: [] };
  }
  const entries: AggregatedPeerEntry[] = [];
  const danglingInFleet: string[] = [];
  const external: string[] = [];

  for (const peer of source.config.peers) {
    const id = stripAgentScheme(peer.agent);
    const inFleet = fleet.agentsById.has(id);
    const looksInternal = looksLikeFleetPeer(id, fleet);

    entries.push({ agentId: id, peer, external: !inFleet });

    if (!inFleet) {
      if (looksInternal) {
        // The peer id uses a prefix/shape we recognize as intra-fleet
        // but we don't have it locally → dangling.
        danglingInFleet.push(peer.agent);
      } else {
        external.push(peer.agent);
      }
    }
  }

  return { entries, danglingInFleet, external };
}

/**
 * Conservative heuristic — if any in-fleet agent shares a prefix segment
 * with the peer id, treat it as "looks internal but missing". This keeps
 * the slice-0 aggregator simple; slice 1's `fleet validate` can apply a
 * stricter rule (e.g. declared in a fleet-internal `peers.yaml`).
 *
 * For slice 0 we mark every missing peer as dangling when at least one
 * fleet agent exists — a genuinely external peer is unlikely to share an
 * id with anything in the fleet table anyway.
 */
function looksLikeFleetPeer(id: string, fleet: LoadedFleet): boolean {
  if (fleet.agents.length === 0) return false;
  // If the id contains a '.' we treat it as an FQDN-style external.
  if (id.includes('.')) return false;
  return true;
}

function stripAgentScheme(full: string): string {
  return full.startsWith('agent://') ? full.slice('agent://'.length) : full;
}
