/**
 * `declaragent fleet audit-rpc [--suggest-enable] [--strict] [--json]` —
 * pre-flight inspector for RPC envelope auth (`rpc.auth.enabled`) across
 * every agent in the fleet.
 *
 * The `fleet.yaml` loader gives us the per-agent directory; we then read
 * each `agent.yaml` directly (not through the zod loader) so we can
 * honestly report three states:
 *
 *   1. **absent** — the `rpc.auth` block is missing entirely. Most new
 *      fleets are here. Default posture is opt-in (`enabled: false`), so
 *      this is *the* gap `--suggest-enable` wants to close.
 *   2. **disabled** — the block exists and explicitly sets
 *      `enabled: false`. Same risk posture as `absent` but the operator
 *      has clearly chosen to opt out; the suggestion is informational.
 *   3. **enabled** — the block exists with `enabled: true`. Pass.
 *
 * The output is a human-readable table by default or a structured JSON
 * object with `--json`. When `--suggest-enable` is set we append a
 * copy-pasteable YAML diff for each agent that needs the flip. When
 * `--strict` is set we exit non-zero on any agent that isn't
 * fully enabled — safe for CI use.
 *
 * **Scope:** Part A of `docs/POST_ENTERPRISE_BACKLOG.md` row #5. Part B
 * (flipping the `enabled: false` default to `true`) is deliberately
 * held back until a 0.8.0 minor so the SemVer signal + at least one
 * release cycle of `--suggest-enable` warning reaches operators before
 * the behavioural change lands.
 *
 * @since 0.7.3 — POST_ENTERPRISE_BACKLOG.md row #5 Part A
 */

import { readFile } from 'node:fs/promises';
import type { LoadedFleet, PeerAuthConfig } from '@declaragent/core';
import { FleetConfigError, FleetManifestError, findFleetRoot, loadFleet } from '@declaragent/core';
import { parse as parseYaml } from 'yaml';

export interface FleetAuditRpcIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetAuditRpcIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export type RpcAuthState = 'enabled' | 'disabled' | 'absent' | 'unreadable';

export interface AgentAuditReport {
  readonly agentId: string;
  /** Absolute path to `<agentDir>/agent.yaml`. */
  readonly agentYamlPath: string;
  readonly state: RpcAuthState;
  /** Present when state is `'unreadable'`. */
  readonly reason?: string;
  /**
   * The peer-auth block the operator declared on *this* agent as a
   * callee in `rpc-peers.yaml` — used to pre-fill the suggested
   * `rpc.auth` YAML snippet so the operator doesn't have to re-pick
   * provider / issuer / audience. `undefined` when no peer references
   * this agent (external-only or dangling).
   */
  readonly suggestedFromPeer?: PeerAuthConfig;
}

export interface FleetAuditRpcReport {
  readonly agents: readonly AgentAuditReport[];
  /** True when every agent's state is `'enabled'`. */
  readonly allEnabled: boolean;
}

/**
 * Read + parse a single `agent.yaml` just enough to answer
 * `rpc.auth.enabled`. We intentionally avoid the full zod loader
 * because:
 *
 *   - we want to report on agents whose YAML has unrelated errors
 *     (e.g. a missing skill file) without blocking the audit, and
 *   - the inspector is read-only — it never acts on the parsed data.
 */
async function readAgentRpcAuthState(
  agentYamlPath: string,
): Promise<{ state: RpcAuthState; reason?: string }> {
  let raw: string;
  try {
    raw = await readFile(agentYamlPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { state: 'unreadable', reason: `failed to read agent.yaml: ${msg}` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { state: 'unreadable', reason: `invalid YAML: ${msg}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { state: 'absent' };
  }
  const record = parsed as Record<string, unknown>;
  const rpc = record.rpc;
  if (!rpc || typeof rpc !== 'object') {
    return { state: 'absent' };
  }
  const auth = (rpc as Record<string, unknown>).auth;
  if (!auth || typeof auth !== 'object') {
    return { state: 'absent' };
  }
  const enabled = (auth as Record<string, unknown>).enabled;
  if (enabled === true) return { state: 'enabled' };
  if (enabled === false) return { state: 'disabled' };
  // The `rpc.auth` block exists but `enabled` is unset — treat this as
  // `absent` for migration purposes (the loader evaluates
  // `enabled === true`, so anything else means the default posture).
  return { state: 'absent' };
}

/**
 * Build an in-memory report across every agent in the fleet. Pure: no
 * IO on the fleet object itself — the caller hands us the `LoadedFleet`
 * and we do the per-agent disk read. Tests can also inject pre-read
 * states via `stateOverrides`.
 */
export async function buildAuditRpcReport(
  fleet: LoadedFleet,
  options: {
    readonly stateOverrides?: ReadonlyMap<string, { state: RpcAuthState; reason?: string }>;
  } = {},
): Promise<FleetAuditRpcReport> {
  const peerAuthByAgent = new Map<string, PeerAuthConfig>();
  for (const peer of fleet.peers?.config.peers ?? []) {
    if (!peer.auth) continue;
    const id = peer.agent.startsWith('agent://') ? peer.agent.slice('agent://'.length) : peer.agent;
    peerAuthByAgent.set(id, peer.auth);
  }

  const agents: AgentAuditReport[] = [];
  for (const agent of fleet.agents) {
    const override = options.stateOverrides?.get(agent.id);
    const result = override ?? (await readAgentRpcAuthState(agent.agentYamlPath));
    const suggestedFromPeer = peerAuthByAgent.get(agent.id);
    agents.push({
      agentId: agent.id,
      agentYamlPath: agent.agentYamlPath,
      state: result.state,
      ...(result.reason !== undefined && { reason: result.reason }),
      ...(suggestedFromPeer !== undefined && { suggestedFromPeer }),
    });
  }

  const allEnabled = agents.every((a) => a.state === 'enabled');
  return { agents, allEnabled };
}

/**
 * Build the YAML snippet the operator can paste into `<agent>/agent.yaml`
 * to flip `rpc.auth.enabled` to true. When we can see a matching peer
 * auth block we echo the provider + issuer + audience (or token
 * endpoint) so the snippet is actionable, not a stub.
 *
 * The snippet never includes secrets — `clientSecretRef` is a
 * resolver reference, safe to commit.
 */
export function suggestRpcAuthYaml(report: AgentAuditReport): string {
  const peer = report.suggestedFromPeer;
  const lines: string[] = ['rpc:', '  auth:', '    enabled: true'];
  if (peer) {
    // We nest the provider echo under a comment so the operator sees
    // what inspired the suggestion but the core YAML stays minimal —
    // `rpc.auth` today only consumes `enabled`; the provider block
    // lives in `rpc-peers.yaml`, not here. This is deliberate: the
    // agent opts *in*, the peer table configures *how*.
    lines.push(
      `    # Callers of agent://${report.agentId} are already declared in`,
      `    # rpc-peers.yaml with provider=${peer.provider}. Turning`,
      '    # enabled: true makes this agent verify those tokens.',
    );
  } else {
    lines.push(
      '    # No peer entry references this agent yet — add an `auth:` block',
      "    # to rpc-peers.yaml before callers can prove they're allowed.",
    );
  }
  return `${lines.join('\n')}\n`;
}

// ── Formatters ─────────────────────────────────────────────────────────

const STATE_MARK: Record<RpcAuthState, string> = {
  enabled: '✓',
  disabled: '!',
  absent: '!',
  unreadable: '✗',
};

const STATE_LABEL: Record<RpcAuthState, string> = {
  enabled: 'enabled',
  disabled: 'disabled (explicit)',
  absent: 'not configured',
  unreadable: 'unreadable',
};

function renderText(
  report: FleetAuditRpcReport,
  args: { suggestEnable: boolean; strict: boolean },
): string {
  const lines: string[] = [];
  if (report.agents.length === 0) {
    lines.push('no agents declared in this fleet.\n');
    return lines.join('');
  }
  lines.push('rpc.auth status by agent:\n');
  for (const a of report.agents) {
    const mark = STATE_MARK[a.state];
    const tail = a.reason ? ` — ${a.reason}` : '';
    lines.push(`  ${mark} ${a.agentId}  ${STATE_LABEL[a.state]}${tail}\n`);
  }

  const needs = report.agents.filter((a) => a.state === 'absent' || a.state === 'disabled');
  if (needs.length > 0) {
    lines.push(
      `\n${needs.length} of ${report.agents.length} agent(s) do not have RPC envelope auth enabled.\n`,
    );
    if (args.suggestEnable) {
      lines.push(
        '\nTo enable, paste the following into each agent.yaml under the top-level keys:\n',
      );
      for (const a of needs) {
        lines.push(`\n# ── ${a.agentId} — ${a.agentYamlPath}\n`);
        lines.push(suggestRpcAuthYaml(a));
      }
      lines.push(
        '\nAfter editing, run `declaragent fleet validate` and `declaragent fleet audit-rpc` to confirm.\n',
      );
    } else {
      lines.push(
        'Run `declaragent fleet audit-rpc --suggest-enable` for a copy-pasteable migration snippet.\n',
      );
    }
  } else {
    lines.push('\n✓ every agent has rpc.auth.enabled: true.\n');
  }

  if (args.strict && !report.allEnabled) {
    lines.push('\n--strict: exiting non-zero because at least one agent is not auth-enabled.\n');
  }
  return lines.join('');
}

function renderJson(
  report: FleetAuditRpcReport,
  args: { suggestEnable: boolean; strict: boolean },
): string {
  return `${JSON.stringify(
    {
      ok: !args.strict || report.allEnabled,
      allEnabled: report.allEnabled,
      agents: report.agents.map((a) => ({
        agentId: a.agentId,
        agentYamlPath: a.agentYamlPath,
        state: a.state,
        ...(a.reason !== undefined && { reason: a.reason }),
        ...(a.suggestedFromPeer !== undefined && {
          peerAuthProvider: a.suggestedFromPeer.provider,
        }),
        ...(args.suggestEnable &&
          (a.state === 'absent' || a.state === 'disabled') && {
            suggestion: suggestRpcAuthYaml(a),
          }),
      })),
    },
    null,
    2,
  )}\n`;
}

// ── CLI verb ───────────────────────────────────────────────────────────

export interface FleetAuditRpcArgs {
  suggestEnable?: boolean;
  strict?: boolean;
  json?: boolean;
}

export interface FleetAuditRpcDeps {
  io?: FleetAuditRpcIO;
  cwd?: string;
  root?: string;
  load?: (root: string) => Promise<LoadedFleet>;
  /** Injected read for tests that bypass disk. Keyed by agent id. */
  readStateForAgent?: (
    agentYamlPath: string,
    agentId: string,
  ) => Promise<{ state: RpcAuthState; reason?: string }>;
}

export async function fleetAuditRpc(
  args: FleetAuditRpcArgs = {},
  deps: FleetAuditRpcDeps = {},
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

  const suggestEnable = args.suggestEnable === true;
  const strict = args.strict === true;

  // Build per-agent state. If a reader override is supplied, use it
  // (keeps the pure-function path for tests); otherwise walk disk.
  const overrides = new Map<string, { state: RpcAuthState; reason?: string }>();
  const readOverride = deps.readStateForAgent;
  if (readOverride) {
    for (const agent of fleet.agents) {
      const result = await readOverride(agent.agentYamlPath, agent.id);
      overrides.set(agent.id, result);
    }
  }

  const report = await buildAuditRpcReport(fleet, {
    ...(overrides.size > 0 && { stateOverrides: overrides }),
  });

  if (args.json) {
    io.out(renderJson(report, { suggestEnable, strict }));
  } else {
    io.out(renderText(report, { suggestEnable, strict }));
  }

  if (strict && !report.allEnabled) return 1;
  return 0;
}
