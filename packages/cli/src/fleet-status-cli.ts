/**
 * `declaragent fleet status` — snapshot of a fleet's config + reachability
 * + deploy history. Slice 8 scope.
 *
 * Composes existing pieces:
 *   - Slice 0's {@link loadFleet} gives us the manifest + agent entries.
 *   - Slice 6's {@link buildPeersReport} classifies each peer transport
 *     as reachable / unreachable / external / not-yet-probed.
 *   - Slice 5's {@link readDeployHistory} surfaces `--history` entries.
 *
 * Live daemon introspection (attach to a running `fleet run` and pull
 * per-agent `source.health()` + channel `health()`) is tracked for
 * slice 8.1 — today's output is a static snapshot plus history. The
 * `--json` shape is stable so dashboards can start consuming now.
 *
 * @since 1.2.0
 */

import type { LoadedFleet } from '@declaragent/core';
import { FleetConfigError, FleetManifestError, findFleetRoot, loadFleet } from '@declaragent/core';
import { type FleetDeployRecord, readDeployHistory } from './fleet-deploy-cli.js';
import { type FleetPeersReport, buildPeersReport } from './fleet-peers-cli.js';
import { DEFAULT_FLEET_FS, type FleetFS } from './fleet-scaffold.js';

export interface FleetStatusIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetStatusIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

// ── Report shape ───────────────────────────────────────────────────────

export interface AgentConfigFiles {
  readonly agentYaml: boolean;
  readonly capabilitiesYaml: boolean;
  readonly eventSourcesYaml: boolean;
  readonly skills: boolean;
}

export interface AgentStatusRow {
  readonly id: string;
  readonly env: string;
  readonly capabilities: readonly string[];
  readonly files: AgentConfigFiles;
  readonly deployTarget?: string;
  /**
   * Most recent deploy outcome from history. Absent when the agent
   * hasn't been recorded in `.declaragent/fleet-deploys.jsonl` yet.
   */
  readonly lastDeploy?: {
    fleetVersion: string;
    timestamp: string;
    ok: boolean;
    artifact?: string;
    error?: string;
  };
}

export interface FleetStatusReport {
  readonly fleet: {
    readonly name: string;
    readonly root: string;
    /** Resolved from `DECLARAGENT_FLEET_VERSION` when present. */
    readonly selfVersion?: string;
  };
  readonly agents: readonly AgentStatusRow[];
  readonly peers: FleetPeersReport;
  /** Populated when `--history` is set. Ordered newest-first. */
  readonly history?: readonly FleetDeployRecord[];
}

// ── Builder (pure) ─────────────────────────────────────────────────────

export interface BuildStatusOptions {
  /** Include the deploy history tail. */
  history?: boolean;
  /** Max history entries. Defaults to 5 per §16 acceptance #7. */
  historyLimit?: number;
  /** Override the self fleet-version (tests). */
  selfVersion?: string;
  fs?: FleetFS;
}

export function buildFleetStatus(
  fleet: LoadedFleet,
  options: BuildStatusOptions = {},
): FleetStatusReport {
  const fs = options.fs ?? DEFAULT_FLEET_FS;
  const limit = options.historyLimit ?? 5;

  const agents: AgentStatusRow[] = [];
  let history: readonly FleetDeployRecord[] | undefined;
  const allHistory = readDeployHistory(fleet.root, fs);
  // Map agent → most recent record that touched it.
  const lastByAgent = new Map<
    string,
    { record: FleetDeployRecord; agentRecord: FleetDeployRecord['agents'][string] }
  >();
  for (const record of allHistory) {
    for (const [agentId, agentRec] of Object.entries(record.agents)) {
      lastByAgent.set(agentId, { record, agentRecord: agentRec });
    }
  }

  for (const agent of fleet.agents) {
    const files: AgentConfigFiles = {
      agentYaml: fs.exists(`${agent.path}/agent.yaml`),
      capabilitiesYaml:
        fs.exists(`${agent.path}/capabilities.yaml`) || fs.exists(`${agent.path}/capabilities.yml`),
      eventSourcesYaml:
        fs.exists(`${agent.path}/event-sources.yaml`) ||
        fs.exists(`${agent.path}/event-sources.yml`),
      skills: fs.exists(`${agent.path}/skills`) && fs.isDir(`${agent.path}/skills`),
    };
    const last = lastByAgent.get(agent.id);
    const caps =
      agent.capabilities?.config.capabilities.map((c) => c.name) ?? ([] as readonly string[]);
    const row: AgentStatusRow = {
      id: agent.id,
      env: agent.env,
      capabilities: caps,
      files,
      ...(agent.entry.deploy?.target !== undefined && { deployTarget: agent.entry.deploy.target }),
      ...(last !== undefined && {
        lastDeploy: {
          fleetVersion: last.record.fleetVersion,
          timestamp: last.record.timestamp,
          ok: last.agentRecord.ok,
          ...(last.agentRecord.artifact !== undefined && { artifact: last.agentRecord.artifact }),
          ...(last.agentRecord.error !== undefined && { error: last.agentRecord.error }),
        },
      }),
    };
    agents.push(row);
  }

  if (options.history) {
    history = allHistory.slice(-limit).reverse();
  }

  const peers = buildPeersReport(fleet);

  return {
    fleet: {
      name: fleet.manifest.name,
      root: fleet.root,
      ...(options.selfVersion !== undefined && { selfVersion: options.selfVersion }),
    },
    agents,
    peers,
    ...(history !== undefined && { history }),
  };
}

// ── CLI verb ───────────────────────────────────────────────────────────

export interface FleetStatusArgs {
  json?: boolean;
  history?: boolean;
  historyLimit?: number;
}

export interface FleetStatusDeps {
  io?: FleetStatusIO;
  cwd?: string;
  root?: string;
  load?: (root: string) => Promise<LoadedFleet>;
  fs?: FleetFS;
  /** Override `DECLARAGENT_FLEET_VERSION` for deterministic tests. */
  selfVersion?: string;
  /** Env map override (tests). */
  env?: Record<string, string | undefined>;
}

export async function fleetStatus(
  args: FleetStatusArgs = {},
  deps: FleetStatusDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const root = deps.root ?? (await findFleetRoot(deps.cwd ?? process.cwd()));
  if (!root) {
    io.err(
      '✗ no fleet.yaml found in this directory or any parent. Run `declaragent init --fleet <name>` first.\n',
    );
    return 1;
  }

  let fleet: LoadedFleet;
  try {
    const loader = deps.load ?? ((r) => loadFleet({ root: r }));
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

  const env = deps.env ?? process.env;
  const selfVersion = deps.selfVersion ?? env.DECLARAGENT_FLEET_VERSION;

  const report = buildFleetStatus(fleet, {
    ...(args.history === true && { history: true }),
    ...(args.historyLimit !== undefined && { historyLimit: args.historyLimit }),
    ...(selfVersion !== undefined && { selfVersion }),
    ...(deps.fs !== undefined && { fs: deps.fs }),
  });

  if (args.json === true) {
    io.out(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  renderHuman(report, io);
  return 0;
}

// ── Human-readable renderer ────────────────────────────────────────────

function renderHuman(report: FleetStatusReport, io: FleetStatusIO): void {
  io.out(`fleet: ${report.fleet.name}\n`);
  io.out(`root:  ${report.fleet.root}\n`);
  if (report.fleet.selfVersion) {
    io.out(`version: ${report.fleet.selfVersion}\n`);
  }

  io.out(`\nagents (${report.agents.length}):\n`);
  for (const agent of report.agents) {
    const files = agentFilesSummary(agent.files);
    const caps =
      agent.capabilities.length > 0 ? `capabilities=${agent.capabilities.length}` : '(client-only)';
    io.out(`  • ${agent.id}  env=${agent.env}  ${caps}  ${files}\n`);
    if (agent.lastDeploy) {
      const tag = agent.lastDeploy.ok ? '✓' : '✗';
      io.out(
        `      last deploy: ${tag} ${agent.lastDeploy.fleetVersion} at ${agent.lastDeploy.timestamp}\n`,
      );
    }
  }

  io.out(`\npeers (${report.peers.peers.length}):\n`);
  if (report.peers.peers.length === 0) {
    io.out('  (none declared)\n');
  } else {
    for (const peer of report.peers.peers) {
      const tag = statusTag(peer.worstStatus);
      io.out(`  ${tag} ${peer.agent}`);
      if (peer.external) io.out('  (external)');
      if (peer.dangling) io.out('  (dangling!)');
      io.out('\n');
      for (const t of peer.transports) {
        io.out(`      ${statusTag(t.status)} ${t.kind}://${t.topic}`);
        if (t.reason) io.out(`  — ${t.reason}`);
        io.out('\n');
      }
    }
  }

  if (report.history && report.history.length > 0) {
    io.out(`\nrecent deploys (${report.history.length}):\n`);
    for (const rec of report.history) {
      const tag = rec.status === 'deployed' ? '✓' : '↩';
      io.out(
        `  ${tag} ${rec.fleetVersion}  strategy=${rec.strategy}  status=${rec.status}  at ${rec.timestamp}\n`,
      );
    }
  }
}

function statusTag(s: string): string {
  if (s === 'reachable' || s === 'deployed') return '✓';
  if (s === 'unreachable') return '✗';
  if (s === 'external') return 'ℹ';
  return '?';
}

function agentFilesSummary(files: AgentConfigFiles): string {
  const bits: string[] = [];
  if (files.capabilitiesYaml) bits.push('caps');
  if (files.eventSourcesYaml) bits.push('sources');
  if (files.skills) bits.push('skills');
  return bits.length === 0 ? '(agent.yaml only)' : `files=${bits.join('+')}`;
}
