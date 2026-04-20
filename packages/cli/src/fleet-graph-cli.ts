/**
 * `declaragent fleet graph` — emit a directed graph of inter-agent RPC
 * edges. Drives the Docusaurus cookbook page (mermaid), ad-hoc graphviz
 * pipelines (dot), and CI topology gates (json).
 *
 * Slice 6 scope (§9 + §14.9). The edge source is the aggregated
 * `rpc-peers.yaml`: each peer entry is a *target* someone calls. Without
 * caller-side annotations (landing in a later slice) we approximate:
 *
 *   - Every in-fleet agent with zero declared capabilities is a
 *     potential client → draw edges from it to every peer target.
 *   - Every in-fleet peer with at least one capability is a potential
 *     callee → additionally, draw edges from every *other* in-fleet
 *     agent to it. Clients inferred above are not double-drawn.
 *
 * Edges carry the transport kind (and capability name when the callee
 * declares exactly one). Mermaid output color-codes by kind so the
 * Docusaurus render is readable at a glance.
 *
 * @since 1.2.0
 */

import type { LoadedAgentEntry, LoadedFleet, PeerTransport } from '@declaragent/core';
import {
  FleetConfigError,
  FleetManifestError,
  aggregatePeers,
  findFleetRoot,
  loadFleet,
} from '@declaragent/core';

export interface FleetGraphIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetGraphIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export type GraphFormat = 'mermaid' | 'dot' | 'json';

export interface GraphNode {
  readonly id: string;
  readonly clientOnly: boolean;
  readonly capabilities: readonly string[];
  readonly external: boolean;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly transport: PeerTransport['kind'];
  readonly capability?: string;
}

export interface GraphModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/**
 * Pure, test-friendly transformation from `LoadedFleet` → graph model.
 * Callers format the output themselves; the model is independently
 * interesting for CI scripts that want to assert "no new edges".
 */
export function buildGraph(fleet: LoadedFleet): GraphModel {
  const nodes: GraphNode[] = [];
  const nodeById = new Map<string, GraphNode>();

  for (const agent of fleet.agents) {
    const caps = agent.capabilities
      ? agent.capabilities.config.capabilities.map((c) => c.name)
      : [];
    const node: GraphNode = {
      id: agent.id,
      clientOnly: caps.length === 0,
      capabilities: caps,
      external: false,
    };
    nodes.push(node);
    nodeById.set(agent.id, node);
  }

  const peerReport = aggregatePeers(fleet);
  // Materialize external peers as nodes so edges to them render.
  for (const entry of peerReport.entries) {
    if (entry.external && !nodeById.has(entry.agentId)) {
      const node: GraphNode = {
        id: entry.agentId,
        clientOnly: false,
        capabilities: [],
        external: true,
      };
      nodes.push(node);
      nodeById.set(entry.agentId, node);
    }
  }

  const clientOnly = fleet.agents.filter((a) => !a.capabilities);
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  function addEdge(
    from: string,
    to: string,
    transport: PeerTransport['kind'],
    capability: string | undefined,
  ): void {
    if (from === to) return;
    const key = `${from}→${to}::${transport}::${capability ?? ''}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    const edge: GraphEdge = capability
      ? { from, to, transport, capability }
      : { from, to, transport };
    edges.push(edge);
  }

  for (const entry of peerReport.entries) {
    const to = entry.agentId;
    const calleeAgent: LoadedAgentEntry | undefined = fleet.agentsById.get(to);
    const calleeCaps = calleeAgent?.capabilities
      ? calleeAgent.capabilities.config.capabilities.map((c) => c.name)
      : [];
    // When the callee declares exactly one capability we label the edge
    // with it. Otherwise (zero or many) we omit; mermaid still renders.
    const singleCap = calleeCaps.length === 1 ? calleeCaps[0] : undefined;

    for (const transport of entry.peer.transports) {
      // 1. Client-only agents always call any declared peer.
      for (const client of clientOnly) {
        if (client.id === to) continue;
        addEdge(client.id, to, transport.kind, singleCap);
      }

      // 2. If the callee is in-fleet and has capabilities, every *other*
      //    in-fleet agent is a potential caller — regardless of whether
      //    it declares capabilities of its own. Clients already drawn
      //    above are deduped by `seenEdges`.
      if (calleeAgent && calleeCaps.length > 0) {
        for (const other of fleet.agents) {
          if (other.id === to) continue;
          addEdge(other.id, to, transport.kind, singleCap);
        }
      }
    }
  }

  return { nodes, edges };
}

// ── Formatters ─────────────────────────────────────────────────────────

const TRANSPORT_COLORS: Record<PeerTransport['kind'], string> = {
  memory: '#3b82f6', // blue
  kafka: '#ef4444', // red
  nats: '#10b981', // green
  sqs: '#f59e0b', // amber
  amqp: '#8b5cf6', // violet
  mqtt: '#ec4899', // pink
};

function nodeKey(id: string): string {
  // Mermaid + DOT identifiers have to be a safe subset. Replace runs of
  // non-word chars with underscores.
  return `n_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

function edgeLabel(edge: GraphEdge): string {
  return edge.capability ? `${edge.capability} (${edge.transport})` : edge.transport;
}

export function renderMermaid(model: GraphModel): string {
  const lines: string[] = [];
  lines.push('graph LR');
  for (const node of model.nodes) {
    const label = `agent://${node.id}${node.external ? ' (external)' : ''}${
      node.clientOnly && !node.external ? ' (client)' : ''
    }`;
    lines.push(`  ${nodeKey(node.id)}["${label}"]`);
  }
  for (const edge of model.edges) {
    lines.push(`  ${nodeKey(edge.from)} -->|${edgeLabel(edge)}| ${nodeKey(edge.to)}`);
  }
  // Mermaid `linkStyle` supports index-based coloring. Color every edge
  // by its transport kind.
  model.edges.forEach((edge, idx) => {
    const color = TRANSPORT_COLORS[edge.transport];
    lines.push(`  linkStyle ${idx} stroke:${color},stroke-width:2px`);
  });
  return `${lines.join('\n')}\n`;
}

export function renderDot(model: GraphModel): string {
  const lines: string[] = [];
  lines.push('digraph fleet {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box,fontname="Helvetica"];');
  for (const node of model.nodes) {
    const label = `agent://${node.id}${node.external ? '\\n(external)' : ''}${
      node.clientOnly && !node.external ? '\\n(client)' : ''
    }`;
    lines.push(`  ${nodeKey(node.id)} [label="${label}"];`);
  }
  for (const edge of model.edges) {
    const color = TRANSPORT_COLORS[edge.transport];
    lines.push(
      `  ${nodeKey(edge.from)} -> ${nodeKey(edge.to)} [label="${edgeLabel(
        edge,
      )}",color="${color}"];`,
    );
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export function renderJson(model: GraphModel): string {
  return `${JSON.stringify(
    {
      nodes: model.nodes.map((n) => ({
        id: n.id,
        clientOnly: n.clientOnly,
        capabilities: n.capabilities,
        external: n.external,
      })),
      edges: model.edges.map((e) => ({
        from: e.from,
        to: e.to,
        transport: e.transport,
        ...(e.capability !== undefined && { capability: e.capability }),
      })),
    },
    null,
    2,
  )}\n`;
}

// ── CLI verb ───────────────────────────────────────────────────────────

export interface FleetGraphArgs {
  format?: GraphFormat;
}

export interface FleetGraphDeps {
  io?: FleetGraphIO;
  cwd?: string;
  root?: string;
  load?: (root: string) => Promise<LoadedFleet>;
}

export async function fleetGraph(
  args: FleetGraphArgs = {},
  deps: FleetGraphDeps = {},
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

  const model = buildGraph(fleet);
  const format = args.format ?? 'mermaid';
  switch (format) {
    case 'mermaid':
      io.out(renderMermaid(model));
      break;
    case 'dot':
      io.out(renderDot(model));
      break;
    case 'json':
      io.out(renderJson(model));
      break;
  }
  return 0;
}
