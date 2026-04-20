/**
 * `declaragent fleet <verb>` family. Slice 1 ships the read-only verbs:
 *
 *   - `fleet list` — print the agents in the fleet.
 *   - `fleet validate` — schema + peer-graph dry-run; non-zero on any finding.
 *   - `fleet capabilities` — aggregated capability table across every agent.
 *
 * Mutations (`init --fleet`, `add`, `promote`, `run`, `deploy`) land in
 * later slices. The verb router here deliberately avoids any disk writes
 * so slice 1 can merge cleanly without depending on the scaffolder.
 *
 * @since 1.2.0
 */

import type { AggregatedCapabilityTable, LoadedFleet } from '@declaragent/core';
import {
  FleetConfigError,
  FleetManifestError,
  aggregateCapabilities,
  aggregatePeers,
  findFleetRoot,
  loadFleet,
} from '@declaragent/core';

export interface FleetCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface FleetCliDeps {
  io?: FleetCliIO;
  /**
   * Absolute path to the fleet root. When omitted, we walk up from `cwd`
   * looking for a `fleet.yaml` (same rule as the rest of the CLI).
   */
  root?: string;
  /** Cwd for `findFleetRoot`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injected loader for tests that want to bypass disk. */
  load?: (root: string) => Promise<LoadedFleet>;
}

async function resolveFleet(deps: FleetCliDeps, io: FleetCliIO): Promise<LoadedFleet | 1> {
  const root = deps.root ?? (await findFleetRoot(deps.cwd ?? process.cwd()));
  if (!root) {
    io.err(
      '✗ no fleet.yaml found in this directory or any parent. Run `declaragent init --fleet <name>` to create one.\n',
    );
    return 1;
  }
  try {
    const loader = deps.load ?? ((r) => loadFleet({ root: r }));
    return await loader(root);
  } catch (err) {
    if (err instanceof FleetManifestError || err instanceof FleetConfigError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to load fleet: ${msg}\n`);
    return 1;
  }
}

// ── `fleet list` ───────────────────────────────────────────────────────

export interface FleetListArgs {
  json?: boolean;
}

export async function fleetList(
  args: FleetListArgs = {},
  deps: FleetCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fleet = await resolveFleet(deps, io);
  if (fleet === 1) return 1;

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          root: fleet.root,
          manifest: { name: fleet.manifest.name, version: fleet.manifest.version },
          agents: fleet.agents.map((a) => ({
            id: a.id,
            path: a.path,
            env: a.env,
            capabilities: a.capabilities
              ? a.capabilities.config.capabilities.map((c) => c.name)
              : [],
          })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  io.out(`fleet: ${fleet.manifest.name}\n`);
  io.out(`root:  ${fleet.root}\n`);
  io.out(`agents (${fleet.agents.length}):\n`);
  for (const a of fleet.agents) {
    const caps = a.capabilities
      ? ` capabilities=${a.capabilities.config.capabilities.length}`
      : ' (client-only)';
    io.out(`  • ${a.id}  env=${a.env}${caps}\n`);
  }
  return 0;
}

// ── `fleet capabilities` ───────────────────────────────────────────────

export interface FleetCapabilitiesArgs {
  json?: boolean;
}

export async function fleetCapabilities(
  args: FleetCapabilitiesArgs = {},
  deps: FleetCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fleet = await resolveFleet(deps, io);
  if (fleet === 1) return 1;

  const table = aggregateCapabilities(fleet);

  if (args.json) {
    io.out(`${JSON.stringify(capabilitiesTableToShape(fleet, table), null, 2)}\n`);
    return 0;
  }

  if (table.byKey.size === 0) {
    io.out('no capabilities declared in this fleet.\n');
    if (table.clientOnly.length > 0) {
      io.out(`client-only agents: ${table.clientOnly.join(', ')}\n`);
    }
    return 0;
  }

  const byAgent = new Map<string, Array<ReturnType<typeof formatCap>>>();
  for (const entry of table.byKey.values()) {
    const rows = byAgent.get(entry.agentId) ?? [];
    rows.push(formatCap(entry.capability));
    byAgent.set(entry.agentId, rows);
  }
  io.out('capabilities:\n');
  for (const agent of fleet.agents) {
    const rows = byAgent.get(agent.id);
    if (!rows || rows.length === 0) {
      io.out(`  agent://${agent.id}  (no capabilities — client-only)\n`);
      continue;
    }
    io.out(`  agent://${agent.id}\n`);
    for (const row of rows) io.out(`    ${row}\n`);
  }
  return 0;
}

function capabilitiesTableToShape(
  fleet: LoadedFleet,
  table: AggregatedCapabilityTable,
): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  for (const agent of fleet.agents) {
    const caps: Array<{
      name: string;
      timeoutMs?: number;
      idempotent?: boolean;
      description?: string;
    }> = [];
    for (const [key, entry] of table.byKey) {
      if (!key.startsWith(`${agent.id}/`)) continue;
      caps.push({
        name: entry.capability.name,
        ...(entry.capability.timeoutMs !== undefined && {
          timeoutMs: entry.capability.timeoutMs,
        }),
        ...(entry.capability.idempotent !== undefined && {
          idempotent: entry.capability.idempotent,
        }),
        ...(entry.capability.description !== undefined && {
          description: entry.capability.description,
        }),
      });
    }
    agents[`agent://${agent.id}`] = caps;
  }
  return { agents, clientOnly: table.clientOnly };
}

function formatCap(cap: {
  name: string;
  timeoutMs?: number | undefined;
  idempotent?: boolean | undefined;
  description?: string | undefined;
}): string {
  const parts = [cap.name];
  if (cap.timeoutMs !== undefined) parts.push(`timeoutMs=${cap.timeoutMs}`);
  if (cap.idempotent !== undefined) parts.push(`idempotent=${cap.idempotent}`);
  return parts.join('  ');
}

// ── `fleet validate` ───────────────────────────────────────────────────

export interface FleetValidateArgs {
  json?: boolean;
}

interface ValidationFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export async function fleetValidate(
  args: FleetValidateArgs = {},
  deps: FleetCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fleet = await resolveFleet(deps, io);
  if (fleet === 1) return 1;

  const findings = runValidations(fleet);

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          ok: findings.every((f) => f.severity !== 'error'),
          findings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (findings.length === 0) {
      io.out('✓ fleet validates clean.\n');
    } else {
      for (const f of findings) {
        const tag = f.severity === 'error' ? '✗' : '!';
        io.out(`${tag} [${f.code}] ${f.message}\n`);
      }
    }
  }

  return findings.some((f) => f.severity === 'error') ? 1 : 0;
}

function runValidations(fleet: LoadedFleet): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  // 1. Aggregate peers and flag danglings as errors (slice 0's aggregator
  //    classified them as such) but preserve externals as informational.
  const peerReport = aggregatePeers(fleet);
  for (const dangling of peerReport.danglingInFleet) {
    findings.push({
      severity: 'error',
      code: 'peer.dangling',
      message: `rpc-peers.yaml references ${dangling} but no in-fleet agent declares that id`,
    });
  }

  // 2. Capability graph: every peer that targets an in-fleet agent should
  //    resolve to an agent that declares at least one capability. A bare
  //    `agent://x` peer entry for an agent that only publishes RPCs (no
  //    capabilities.yaml) is a smell — probably meant as the inverse peer.
  const table = aggregateCapabilities(fleet);
  for (const entry of peerReport.entries) {
    if (entry.external) continue;
    const agent = fleet.agentsById.get(entry.agentId);
    if (!agent) continue; // already surfaced as dangling
    if (!agent.capabilities) {
      findings.push({
        severity: 'warning',
        code: 'peer.client-only',
        message: `peer agent://${entry.agentId} has no capabilities.yaml — callers will error at request time`,
      });
    }
  }

  // 3. Cross-agent duplicate capability names — allowed, but flag as a
  //    warning so the operator knows ambiguity exists (§14.3-adjacent).
  for (const [name, entries] of table.byName) {
    if (entries.length > 1) {
      const owners = entries.map((e) => `agent://${e.agentId}`).join(', ');
      findings.push({
        severity: 'warning',
        code: 'capability.duplicate',
        message: `capability "${name}" is declared by multiple agents: ${owners}`,
      });
    }
  }

  // 4. Agents that declare a deploy target must reach a declared target.
  //    (Schema-level deploy.target presence is enforced by the loader;
  //    this is the belt-and-braces check for cases where someone swaps
  //    the schema for a passthrough variant later.)
  const targets = fleet.manifest.deploy?.targets ?? {};
  for (const agent of fleet.agents) {
    if (!agent.entry.deploy) continue;
    if (!Object.hasOwn(targets, agent.entry.deploy.target)) {
      findings.push({
        severity: 'error',
        code: 'deploy.target.missing',
        message: `agent "${agent.id}" deploys to target "${agent.entry.deploy.target}" which is not declared in deploy.targets{}`,
      });
    }
  }

  return findings;
}
