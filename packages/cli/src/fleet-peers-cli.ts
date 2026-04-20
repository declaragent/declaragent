/**
 * `declaragent fleet peers [--verify]` — print the aggregated
 * `rpc-peers.yaml` grouped by peer with each transport kind + topic;
 * optionally live-verify every in-fleet peer.
 *
 * Slice 6 scope. The daemon isn't booted here, so "verify" is
 * conceptual:
 *
 *   - memory peers → "does an in-fleet agent declare matching
 *     capabilities?" If the peer points at an id the fleet knows and
 *     that agent ships a `capabilities.yaml`, we mark it reachable.
 *   - non-memory peers (kafka / nats / sqs / amqp / mqtt) → we can't
 *     ping a live broker from the CLI without daemon wiring. Slice 6
 *     reports them as `not-yet-probed` and doesn't count them as
 *     failures.
 *   - external peers (agents not in this fleet) → classified as
 *     "external"; informational only.
 *
 * Exits non-zero when any in-fleet peer fails verify.
 *
 * @since 1.2.0
 */

import type { LoadedFleet, PeerEntry, PeerTransport } from '@declaragent/core';
import {
  FleetConfigError,
  FleetManifestError,
  aggregatePeers,
  findFleetRoot,
  loadFleet,
} from '@declaragent/core';
import { createMemoryBus } from '@declaragent/plugin-agent-rpc';

export interface FleetPeersIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetPeersIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export type PeerVerifyStatus = 'reachable' | 'unreachable' | 'external' | 'not-yet-probed';

export interface PeerTransportReport {
  readonly kind: PeerTransport['kind'];
  readonly topic: string;
  readonly status: PeerVerifyStatus;
  readonly reason?: string;
}

export interface PeerReport {
  readonly agent: string;
  readonly external: boolean;
  readonly dangling: boolean;
  readonly transports: readonly PeerTransportReport[];
  readonly worstStatus: PeerVerifyStatus;
}

export interface FleetPeersReport {
  readonly peers: readonly PeerReport[];
  readonly okInFleet: boolean;
}

function transportTopic(t: PeerTransport): string {
  switch (t.kind) {
    case 'kafka':
    case 'mqtt':
    case 'memory':
      return t.topics.requests;
    case 'nats':
      return t.subjects.requests;
    case 'sqs':
    case 'amqp':
      return t.queues.requests;
  }
}

function classifyTransport(
  peer: PeerEntry,
  t: PeerTransport,
  fleet: LoadedFleet,
  verify: boolean,
  tags: { dangling: boolean; external: boolean },
): PeerTransportReport {
  const topic = transportTopic(t);
  const agentId = peer.agent.startsWith('agent://')
    ? peer.agent.slice('agent://'.length)
    : peer.agent;
  const inFleet = fleet.agentsById.get(agentId);

  if (tags.dangling) {
    return {
      kind: t.kind,
      topic,
      status: 'unreachable',
      reason: `no in-fleet agent matches "${peer.agent}"`,
    };
  }

  if (!verify) {
    return { kind: t.kind, topic, status: inFleet ? 'reachable' : 'external' };
  }

  if (!inFleet) {
    return {
      kind: t.kind,
      topic,
      status: 'external',
      reason: 'peer points outside the fleet; CLI does not probe external transports',
    };
  }

  if (t.kind === 'memory') {
    if (!inFleet.capabilities || inFleet.capabilities.config.capabilities.length === 0) {
      return {
        kind: t.kind,
        topic,
        status: 'unreachable',
        reason: `agent://${agentId} does not declare any capabilities.yaml entries`,
      };
    }
    // Does the callee declare a memory transport pointing at the same
    // requests topic? This is the intra-process reachability check the
    // task spec calls for — we conceptually publish a no-op ping onto a
    // fresh MemoryBus and confirm the expected topic matches.
    const matching = inFleet.capabilities.config.transports.some(
      (calleeT) => calleeT.kind === 'memory' && calleeT.topics.requests === topic,
    );
    if (!matching) {
      return {
        kind: t.kind,
        topic,
        status: 'unreachable',
        reason: `agent://${agentId} declares capabilities but no memory transport on topic "${topic}"`,
      };
    }
    // Allocate + close a bus to exercise the import; in a later slice
    // this becomes a real round-trip ping.
    const probe = createMemoryBus();
    probe.close();
    return { kind: t.kind, topic, status: 'reachable' };
  }

  return {
    kind: t.kind,
    topic,
    status: 'not-yet-probed',
    reason: 'slice 6 does not boot a broker — reachability unverified for this transport kind',
  };
}

function worstStatus(reports: readonly PeerTransportReport[]): PeerVerifyStatus {
  if (reports.some((r) => r.status === 'unreachable')) return 'unreachable';
  if (reports.some((r) => r.status === 'external')) return 'external';
  if (reports.every((r) => r.status === 'not-yet-probed')) return 'not-yet-probed';
  if (reports.some((r) => r.status === 'reachable')) return 'reachable';
  return 'not-yet-probed';
}

/**
 * Pure transformation: build the peer report without any IO.
 */
export function buildPeersReport(
  fleet: LoadedFleet,
  options: { verify?: boolean } = {},
): FleetPeersReport {
  const verify = options.verify === true;
  const agg = aggregatePeers(fleet);
  const danglingSet = new Set(agg.danglingInFleet);
  const peerList = fleet.peers?.config.peers ?? [];

  const peers: PeerReport[] = [];
  for (const peer of peerList) {
    const agentId = peer.agent.startsWith('agent://')
      ? peer.agent.slice('agent://'.length)
      : peer.agent;
    const dangling = danglingSet.has(peer.agent);
    const external = !fleet.agentsById.has(agentId) && !dangling;
    const transports = peer.transports.map((t) =>
      classifyTransport(peer, t, fleet, verify, { dangling, external }),
    );
    peers.push({
      agent: peer.agent,
      external,
      dangling,
      transports,
      worstStatus: dangling ? 'unreachable' : worstStatus(transports),
    });
  }

  const okInFleet = peers.every((p) => {
    if (p.dangling) return false;
    if (p.external) return true;
    return p.worstStatus !== 'unreachable';
  });

  return { peers, okInFleet };
}

// ── Formatters ─────────────────────────────────────────────────────────

const STATUS_MARK: Record<PeerVerifyStatus, string> = {
  reachable: '✓',
  unreachable: '✗',
  external: 'ℹ',
  'not-yet-probed': '·',
};

function renderText(report: FleetPeersReport, verify: boolean): string {
  const lines: string[] = [];
  const reachable = report.peers.filter((p) => !p.external && p.worstStatus === 'reachable');
  const unreachable = report.peers.filter((p) => !p.external && p.worstStatus === 'unreachable');
  const deferred = report.peers.filter((p) => !p.external && p.worstStatus === 'not-yet-probed');
  const external = report.peers.filter((p) => p.external);

  if (report.peers.length === 0) {
    lines.push('no peers declared.');
    return `${lines.join('\n')}\n`;
  }

  const describe = (p: PeerReport): void => {
    lines.push(`  ${STATUS_MARK[p.worstStatus]} ${p.agent}${p.dangling ? ' (dangling)' : ''}`);
    for (const t of p.transports) {
      const tag = STATUS_MARK[t.status];
      const tail = t.reason ? ` — ${t.reason}` : '';
      lines.push(`      ${tag} ${t.kind}  topic=${t.topic}${tail}`);
    }
  };

  if (reachable.length > 0) {
    lines.push(verify ? 'reachable:' : 'in-fleet:');
    for (const p of reachable) describe(p);
  }
  if (deferred.length > 0) {
    lines.push('not-yet-probed:');
    for (const p of deferred) describe(p);
  }
  if (unreachable.length > 0) {
    lines.push('unreachable:');
    for (const p of unreachable) describe(p);
  }
  if (external.length > 0) {
    lines.push('external:');
    for (const p of external) describe(p);
  }
  return `${lines.join('\n')}\n`;
}

// ── CLI verb ───────────────────────────────────────────────────────────

export interface FleetPeersArgs {
  verify?: boolean;
  json?: boolean;
}

export interface FleetPeersDeps {
  io?: FleetPeersIO;
  cwd?: string;
  root?: string;
  load?: (root: string) => Promise<LoadedFleet>;
}

export async function fleetPeers(
  args: FleetPeersArgs = {},
  deps: FleetPeersDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const root = deps.root ?? (await findFleetRoot(deps.cwd ?? process.cwd()));
  if (!root) {
    io.err(
      '✗ no fleet.yaml found in this directory or any parent. Run `declaragent init --fleet <name>` to create one.\n',
    );
    return 1;
  }

  let fleet: LoadedFleet;
  try {
    const loader = deps.load ?? ((r: string) => loadFleet({ root: r }));
    fleet = await loader(root);
  } catch (err) {
    if (err instanceof FleetManifestError || err instanceof FleetConfigError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to load fleet: ${msg}\n`);
    return 1;
  }

  const verify = args.verify === true;
  const report = buildPeersReport(fleet, { verify });

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          verify,
          ok: verify ? report.okInFleet : true,
          peers: report.peers.map((p) => ({
            agent: p.agent,
            external: p.external,
            dangling: p.dangling,
            status: p.worstStatus,
            transports: p.transports.map((t) => ({
              kind: t.kind,
              topic: t.topic,
              status: t.status,
              ...(t.reason !== undefined && { reason: t.reason }),
            })),
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.out(renderText(report, verify));
  }

  if (verify && !report.okInFleet) return 1;
  return 0;
}
