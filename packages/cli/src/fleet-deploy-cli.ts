/**
 * `declaragent fleet deploy` — coordinated multi-agent deploys.
 *
 * Slice 5 scope. Ships the `FleetDeployTarget` adapter surface, a pure
 * {@link planDeploy} that orders the deploy plan, an executor that walks
 * the plan according to the manifest's `strategy` (rolling /
 * all-or-nothing / per-agent), and an append-only deploy history
 * recorded at `<root>/.declaragent/fleet-deploys.jsonl`.
 *
 * Out of scope for slice 5: the real `gcp-cloud-run` adapter (Docker
 * build + `gcloud run deploy` shell-outs). A `createGcpCloudRunTarget()`
 * lands in a follow-up PR once the shell-out surface solidifies. For
 * now, tests exercise every path through {@link createMemoryDeployTarget}
 * — an in-memory adapter with deterministic failure injection.
 *
 * Every adapter takes its FS surface via `FleetFS` (from
 * `fleet-scaffold.ts`) so tests are hermetic.
 *
 * @since 1.2.0
 */

import { isAbsolute, join, resolve as pathResolve } from 'node:path';
import type {
  FleetDeployStrategy,
  FleetDeployTargetConfig,
  LoadedAgentEntry,
  LoadedFleet,
} from '@declaragent/core';
import {
  FLEET_VERSION_ENV,
  FleetConfigError,
  FleetManifestError,
  findFleetRoot,
  loadFleet,
} from '@declaragent/core';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_FLEET_FS, type FleetFS } from './fleet-scaffold.js';

// ── IO + deps ──────────────────────────────────────────────────────────

export interface FleetCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

// ── Target adapter surface ─────────────────────────────────────────────

export interface DeployContext {
  readonly fleet: LoadedFleet;
  readonly fleetVersion: string;
  readonly targetConfig: FleetDeployTargetConfig;
  readonly logger: FleetCliIO;
  /**
   * Env vars adapters must stamp onto the deployed agent's runtime. At
   * minimum, `DECLARAGENT_FLEET_VERSION` is present — agents read it at
   * boot to populate their outbound `x-fleet-version` header (§8.2).
   * Adapters may append target-specific vars before invoking the
   * underlying platform (Cloud Run env, K8s env, Docker Compose, etc.).
   * @since 1.2.0
   */
  readonly injectedEnv: Readonly<Record<string, string>>;
}

export type DeployOutcome = { ok: true; artifact: string } | { ok: false; error: string };

export interface FleetDeployTarget {
  /** Target adapter kind, matching `fleet.yaml → deploy.targets{}.<k>.kind`. */
  readonly kind: string;
  deploy(agent: LoadedAgentEntry, context: DeployContext): Promise<DeployOutcome>;
  healthCheck?(
    agent: LoadedAgentEntry,
    context: DeployContext,
  ): Promise<{ ok: boolean; message?: string }>;
  rollback?(
    agent: LoadedAgentEntry,
    previous: FleetDeployRecord,
    context: DeployContext,
  ): Promise<void>;
}

/**
 * In-memory adapter used by tests + dry-runs. Every agent deploy
 * succeeds unless the caller's `failFor(agent)` predicate says
 * otherwise; health check probes read from a per-instance map tests
 * mutate to simulate probe failure.
 *
 * Deploys are recorded on the returned instance's `deployed` /
 * `rolledBack` arrays — useful for asserting execution order.
 */
export interface MemoryDeployTargetOptions {
  /** Adapter `kind`. Defaults to `memory`. */
  kind?: string;
  /** Return `true` to make `deploy(agent)` fail for that agent. */
  failFor?: (agent: LoadedAgentEntry) => boolean;
}

export interface MemoryDeployTarget extends FleetDeployTarget {
  /** Order agents were deployed, for test assertions. */
  readonly deployed: readonly string[];
  /** Order agents were rolled back, for test assertions. */
  readonly rolledBack: readonly string[];
  /** Mutable per-agent health flag; flip to simulate probe failure. */
  readonly health: Map<string, boolean>;
  /** Env vars seen at deploy time, keyed by agent id (§8.2). @since 1.2.0 */
  readonly envForAgent: Map<string, Readonly<Record<string, string>>>;
}

export function createMemoryDeployTarget(
  options: MemoryDeployTargetOptions = {},
): MemoryDeployTarget {
  const kind = options.kind ?? 'memory';
  const failFor = options.failFor ?? (() => false);
  const deployed: string[] = [];
  const rolledBack: string[] = [];
  const health = new Map<string, boolean>();
  const envForAgent = new Map<string, Readonly<Record<string, string>>>();

  const target: MemoryDeployTarget = {
    kind,
    deployed,
    rolledBack,
    health,
    envForAgent,
    async deploy(agent, context) {
      if (failFor(agent)) {
        return { ok: false, error: `memory-target: injected failure for ${agent.id}` };
      }
      deployed.push(agent.id);
      health.set(agent.id, true);
      envForAgent.set(agent.id, { ...context.injectedEnv });
      return {
        ok: true,
        artifact: `memory://${agent.id}@${context.fleetVersion}`,
      };
    },
    async healthCheck(agent) {
      const ok = health.get(agent.id) ?? false;
      return ok ? { ok: true } : { ok: false, message: `no health for ${agent.id}` };
    },
    async rollback(agent) {
      rolledBack.push(agent.id);
      health.delete(agent.id);
    },
  };
  return target;
}

// ── Plan + execution ───────────────────────────────────────────────────

export interface PlanEntry {
  readonly agent: LoadedAgentEntry;
  /** Resolved target key (after any `--target` override). */
  readonly targetKey: string;
  readonly targetConfig: FleetDeployTargetConfig;
}

export interface PlanDeployOptions {
  /** Subset by agent id; default = every agent in manifest order. */
  agents?: readonly string[];
  /** Override the per-agent target key. */
  targetOverride?: string;
  /** Ad-hoc target configs keyed by name — merged on top of manifest targets. */
  extraTargets?: Readonly<Record<string, FleetDeployTargetConfig>>;
}

export class FleetDeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetDeployError';
  }
}

export function planDeploy(fleet: LoadedFleet, opts: PlanDeployOptions = {}): PlanEntry[] {
  const manifestTargets = fleet.manifest.deploy?.targets ?? {};
  const merged: Record<string, FleetDeployTargetConfig> = {
    ...manifestTargets,
    ...(opts.extraTargets ?? {}),
  };

  const filter = opts.agents && opts.agents.length > 0 ? new Set(opts.agents) : undefined;
  const plan: PlanEntry[] = [];
  for (const agent of fleet.agents) {
    if (filter && !filter.has(agent.id)) continue;
    const targetKey = opts.targetOverride ?? agent.entry.deploy?.target;
    if (!targetKey) {
      throw new FleetDeployError(
        `agent "${agent.id}" has no deploy.target in fleet.yaml and no --target override was supplied`,
      );
    }
    const targetConfig = merged[targetKey];
    if (!targetConfig) {
      throw new FleetDeployError(
        `deploy target "${targetKey}" referenced by agent "${agent.id}" is not declared in fleet.yaml → deploy.targets{}`,
      );
    }
    plan.push({ agent, targetKey, targetConfig });
  }
  return plan;
}

export interface ExecuteDeployOptions {
  readonly strategy: FleetDeployStrategy;
  readonly fleet: LoadedFleet;
  readonly fleetVersion: string;
  readonly logger: FleetCliIO;
  readonly previousRecord?: FleetDeployRecord;
  /**
   * Canary soak window. After the first agent deploys the executor
   * waits this many ms, then re-runs its health probe before rolling
   * out the rest. Only honored when `strategy === 'canary'`. Default
   * 60s — long enough to catch slow-starting crashes, short enough
   * that one canary doesn't hold up the whole rollout.
   * @since 0.6.0-slice.8
   */
  readonly canaryWaitMs?: number;
  /** Injectable sleep — tests pin the canary wait to zero. @since 0.6.0-slice.8 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ExecuteDeployResult {
  ok: boolean;
  deployed: string[];
  failed?: string;
  rolledBack: string[];
  /** Per-agent outcome map — what the executor accomplished. */
  outcomes: Record<string, FleetDeployAgentRecord>;
}

/**
 * Execute the plan against the supplied targets.
 *
 * - `rolling`: sequential. On failure, rollback every agent deployed so
 *   far in reverse order, then stop.
 * - `all-or-nothing`: parallel. On any failure, rollback every agent
 *   that did deploy successfully.
 * - `per-agent`: parallel, fire-and-forget. Failures don't cascade.
 */
export async function executeDeploy(
  plan: readonly PlanEntry[],
  targets: ReadonlyMap<string, FleetDeployTarget>,
  opts: ExecuteDeployOptions,
): Promise<ExecuteDeployResult> {
  const deployed: string[] = [];
  const rolledBack: string[] = [];
  const outcomes: Record<string, FleetDeployAgentRecord> = {};
  let failed: string | undefined;

  function pickTarget(entry: PlanEntry): FleetDeployTarget {
    const adapter = targets.get(entry.targetKey) ?? targets.get(entry.targetConfig.kind);
    if (!adapter) {
      throw new FleetDeployError(
        `no adapter registered for target "${entry.targetKey}" (kind=${entry.targetConfig.kind})`,
      );
    }
    return adapter;
  }

  function contextFor(entry: PlanEntry): DeployContext {
    return {
      fleet: opts.fleet,
      fleetVersion: opts.fleetVersion,
      targetConfig: entry.targetConfig,
      logger: opts.logger,
      injectedEnv: { [FLEET_VERSION_ENV]: opts.fleetVersion },
    };
  }

  if (opts.strategy === 'rolling') {
    for (const entry of plan) {
      const adapter = pickTarget(entry);
      const outcome = await adapter.deploy(entry.agent, contextFor(entry));
      if (outcome.ok) {
        deployed.push(entry.agent.id);
        outcomes[entry.agent.id] = {
          target: entry.targetKey,
          ok: true,
          artifact: outcome.artifact,
        };
        if (adapter.healthCheck) {
          const probe = await adapter.healthCheck(entry.agent, contextFor(entry));
          if (!probe.ok) {
            failed = entry.agent.id;
            outcomes[entry.agent.id] = {
              target: entry.targetKey,
              ok: false,
              error: `health-probe: ${probe.message ?? 'failed'}`,
            };
            break;
          }
        }
      } else {
        failed = entry.agent.id;
        outcomes[entry.agent.id] = {
          target: entry.targetKey,
          ok: false,
          error: outcome.error,
        };
        break;
      }
    }
    if (failed !== undefined) {
      for (const id of [...deployed].reverse()) {
        const entry = plan.find((p) => p.agent.id === id);
        if (!entry) continue;
        const adapter = pickTarget(entry);
        if (!adapter.rollback) continue;
        try {
          await adapter.rollback(
            entry.agent,
            opts.previousRecord ?? emptyPreviousRecord(opts.fleetVersion),
            contextFor(entry),
          );
          rolledBack.push(id);
        } catch (err) {
          opts.logger.err(
            `rollback failed for ${id}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  } else if (opts.strategy === 'canary') {
    // Canary: deploy first agent, soak, re-probe, then roll out the
    // rest. A canary failure (deploy OR post-soak health) rolls back
    // every deployed agent exactly like `rolling`'s failure path.
    const canary = plan[0];
    if (!canary) {
      return { ok: true, deployed: [], rolledBack: [], outcomes: {} };
    }
    const canaryAdapter = pickTarget(canary);
    const canaryOutcome = await canaryAdapter.deploy(canary.agent, contextFor(canary));
    if (!canaryOutcome.ok) {
      failed = canary.agent.id;
      outcomes[canary.agent.id] = {
        target: canary.targetKey,
        ok: false,
        error: canaryOutcome.error,
      };
    } else {
      deployed.push(canary.agent.id);
      outcomes[canary.agent.id] = {
        target: canary.targetKey,
        ok: true,
        artifact: canaryOutcome.artifact,
      };
      // Soak. In tests the injected sleep resolves synchronously.
      const sleepMs = opts.canaryWaitMs ?? 60_000;
      const sleep = opts.sleep ?? defaultSleep;
      opts.logger.out(
        `  canary "${canary.agent.id}" deployed. Soaking ${sleepMs}ms before full rollout…\n`,
      );
      await sleep(sleepMs);
      // Post-soak health check — a crash loop often needs a minute to
      // manifest, which is why we re-probe instead of trusting the
      // immediate-after-deploy health signal.
      if (canaryAdapter.healthCheck) {
        const probe = await canaryAdapter.healthCheck(canary.agent, contextFor(canary));
        if (!probe.ok) {
          failed = canary.agent.id;
          outcomes[canary.agent.id] = {
            target: canary.targetKey,
            ok: false,
            error: `canary-soak-health: ${probe.message ?? 'failed'}`,
          };
        } else {
          opts.logger.out(`  canary "${canary.agent.id}" healthy post-soak. Rolling out rest.\n`);
        }
      }
      // Roll out the remaining agents only if the canary passed.
      if (failed === undefined) {
        for (const entry of plan.slice(1)) {
          const adapter = pickTarget(entry);
          const outcome = await adapter.deploy(entry.agent, contextFor(entry));
          if (outcome.ok) {
            deployed.push(entry.agent.id);
            outcomes[entry.agent.id] = {
              target: entry.targetKey,
              ok: true,
              artifact: outcome.artifact,
            };
            if (adapter.healthCheck) {
              const probe = await adapter.healthCheck(entry.agent, contextFor(entry));
              if (!probe.ok) {
                failed = entry.agent.id;
                outcomes[entry.agent.id] = {
                  target: entry.targetKey,
                  ok: false,
                  error: `health-probe: ${probe.message ?? 'failed'}`,
                };
                break;
              }
            }
          } else {
            failed = entry.agent.id;
            outcomes[entry.agent.id] = {
              target: entry.targetKey,
              ok: false,
              error: outcome.error,
            };
            break;
          }
        }
      }
    }
    // Rollback cascade: same path as `rolling`.
    if (failed !== undefined) {
      for (const id of [...deployed].reverse()) {
        const entry = plan.find((p) => p.agent.id === id);
        if (!entry) continue;
        const adapter = pickTarget(entry);
        if (!adapter.rollback) continue;
        try {
          await adapter.rollback(
            entry.agent,
            opts.previousRecord ?? emptyPreviousRecord(opts.fleetVersion),
            contextFor(entry),
          );
          rolledBack.push(id);
        } catch (err) {
          opts.logger.err(
            `rollback failed for ${id}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  } else if (opts.strategy === 'all-or-nothing') {
    const settled = await Promise.all(
      plan.map(async (entry) => {
        const adapter = pickTarget(entry);
        const outcome = await adapter.deploy(entry.agent, contextFor(entry));
        return { entry, adapter, outcome };
      }),
    );
    let firstFailure: string | undefined;
    for (const { entry, outcome } of settled) {
      if (outcome.ok) {
        deployed.push(entry.agent.id);
        outcomes[entry.agent.id] = {
          target: entry.targetKey,
          ok: true,
          artifact: outcome.artifact,
        };
      } else {
        if (firstFailure === undefined) firstFailure = entry.agent.id;
        outcomes[entry.agent.id] = {
          target: entry.targetKey,
          ok: false,
          error: outcome.error,
        };
      }
    }
    if (firstFailure !== undefined) {
      failed = firstFailure;
      for (const id of [...deployed].reverse()) {
        const entry = plan.find((p) => p.agent.id === id);
        if (!entry) continue;
        const adapter = pickTarget(entry);
        if (!adapter.rollback) continue;
        try {
          await adapter.rollback(
            entry.agent,
            opts.previousRecord ?? emptyPreviousRecord(opts.fleetVersion),
            contextFor(entry),
          );
          rolledBack.push(id);
        } catch (err) {
          opts.logger.err(
            `rollback failed for ${id}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  } else {
    // per-agent: no coordination, no rollback, no cascade.
    await Promise.all(
      plan.map(async (entry) => {
        const adapter = pickTarget(entry);
        try {
          const outcome = await adapter.deploy(entry.agent, contextFor(entry));
          if (outcome.ok) {
            deployed.push(entry.agent.id);
            outcomes[entry.agent.id] = {
              target: entry.targetKey,
              ok: true,
              artifact: outcome.artifact,
            };
          } else {
            outcomes[entry.agent.id] = {
              target: entry.targetKey,
              ok: false,
              error: outcome.error,
            };
          }
        } catch (err) {
          outcomes[entry.agent.id] = {
            target: entry.targetKey,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  const ok = failed === undefined && Object.values(outcomes).every((o) => o.ok);
  const result: ExecuteDeployResult = {
    ok,
    deployed,
    rolledBack,
    outcomes,
  };
  if (failed !== undefined) result.failed = failed;
  return result;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyPreviousRecord(fleetVersion: string): FleetDeployRecord {
  return {
    fleetVersion,
    timestamp: new Date(0).toISOString(),
    strategy: 'rolling',
    agents: {},
    status: 'deployed',
  };
}

// ── Deploy history (jsonl) ─────────────────────────────────────────────

export interface FleetDeployAgentRecord {
  target: string;
  ok: boolean;
  artifact?: string;
  error?: string;
}

export interface FleetDeployRecord {
  fleetVersion: string;
  timestamp: string;
  strategy: FleetDeployStrategy;
  agents: Record<string, FleetDeployAgentRecord>;
  status: 'deployed' | 'rolled-back';
}

export const FLEET_DEPLOY_HISTORY_PATH = '.declaragent/fleet-deploys.jsonl';

export function readDeployHistory(
  root: string,
  fs: FleetFS = DEFAULT_FLEET_FS,
): FleetDeployRecord[] {
  const path = join(root, FLEET_DEPLOY_HISTORY_PATH);
  if (!fs.exists(path)) return [];
  const text = fs.readFile(path);
  const out: FleetDeployRecord[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as FleetDeployRecord;
      out.push(parsed);
    } catch {
      // Skip malformed lines; history is append-only but we don't want
      // a single stray byte to wedge `fleet status --history`.
    }
  }
  return out;
}

export function appendDeployRecord(
  root: string,
  record: FleetDeployRecord,
  fs: FleetFS = DEFAULT_FLEET_FS,
): void {
  const path = join(root, FLEET_DEPLOY_HISTORY_PATH);
  const existing = fs.exists(path) ? fs.readFile(path) : '';
  const next = existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`;
  fs.writeFile(path, `${next}${JSON.stringify(record)}\n`);
}

// ── Fleet version ──────────────────────────────────────────────────────

/**
 * Compute the fleet version: `v${pkg.version}-${gitSha.slice(0,7)}`.
 *
 * Falls back to `v0.0.0-nosha` when neither the fleet-root
 * `package.json` nor `.git/HEAD` can be read. Tests inject a custom
 * `FleetFS` so the resolution stays hermetic.
 */
export function computeFleetVersion(root: string, fs: FleetFS = DEFAULT_FLEET_FS): string {
  const pkgVersion = readPackageVersion(root, fs);
  const sha = readGitSha(root, fs);
  return `v${pkgVersion}-${sha.slice(0, 7)}`;
}

function readPackageVersion(root: string, fs: FleetFS): string {
  const pkgPath = join(root, 'package.json');
  if (!fs.exists(pkgPath)) return '0.0.0';
  try {
    const parsed = JSON.parse(fs.readFile(pkgPath)) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
  } catch {
    // fall through
  }
  return '0.0.0';
}

function readGitSha(root: string, fs: FleetFS): string {
  const headPath = join(root, '.git', 'HEAD');
  if (!fs.exists(headPath)) return 'nosha';
  try {
    const head = fs.readFile(headPath).trim();
    if (head.startsWith('ref: ')) {
      const refPath = join(root, '.git', head.slice(5).trim());
      if (fs.exists(refPath)) {
        return fs.readFile(refPath).trim() || 'nosha';
      }
      // Packed refs fallback — skip; nosha is the conservative answer.
      return 'nosha';
    }
    return head || 'nosha';
  } catch {
    return 'nosha';
  }
}

// ── CLI verb ───────────────────────────────────────────────────────────

export interface FleetDeployArgs {
  target?: string;
  agents?: readonly string[];
  strategy?: FleetDeployStrategy;
  dryRun?: boolean;
  rollback?: boolean;
  targetConfigPath?: string;
  json?: boolean;
  /**
   * Canary soak window. Only consulted when `strategy === 'canary'`.
   * Default 60_000 (60s). Tests pin this to 0.
   * @since 0.6.0-slice.8
   */
  canaryWaitMs?: number;
}

export interface FleetDeployDeps {
  io?: FleetCliIO;
  fs?: FleetFS;
  cwd?: string;
  root?: string;
  /** Injected loader for tests. */
  load?: (root: string) => Promise<LoadedFleet>;
  /** Map of target-key → adapter. Takes precedence over `kind` lookup. */
  targets?: ReadonlyMap<string, FleetDeployTarget>;
  /** Factory for adapters keyed by `kind` (fallback when no per-key adapter). */
  targetFactory?: (kind: string) => FleetDeployTarget | undefined;
  /** Override the fleet version (tests). */
  fleetVersion?: string;
  /** Override `Date.now` for deterministic timestamps. */
  now?: () => Date;
  /**
   * Injected sleep — used by the canary strategy's soak window.
   * Tests pin this to a synchronous stub.
   * @since 0.6.0-slice.8
   */
  sleep?: (ms: number) => Promise<void>;
}

export async function fleetDeploy(
  args: FleetDeployArgs = {},
  deps: FleetDeployDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fs = deps.fs ?? DEFAULT_FLEET_FS;

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

  // Rollback path: re-invoke against the previous record's target set.
  if (args.rollback) {
    return runRollback(fleet, { io, fs, ...deps }, args);
  }

  // Load any ad-hoc target configs (`--target-config <path>`).
  let extraTargets: Record<string, FleetDeployTargetConfig> = {};
  if (args.targetConfigPath) {
    const cfgPath = isAbsolute(args.targetConfigPath)
      ? args.targetConfigPath
      : pathResolve(deps.cwd ?? process.cwd(), args.targetConfigPath);
    if (!fs.exists(cfgPath)) {
      io.err(`✗ target config file not found: ${cfgPath}\n`);
      return 1;
    }
    try {
      const parsed = parseYaml(fs.readFile(cfgPath));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const targetsField = (parsed as Record<string, unknown>).targets;
        if (targetsField && typeof targetsField === 'object' && !Array.isArray(targetsField)) {
          extraTargets = targetsField as Record<string, FleetDeployTargetConfig>;
        } else {
          extraTargets = parsed as Record<string, FleetDeployTargetConfig>;
        }
      }
    } catch (err) {
      io.err(
        `✗ failed to parse target-config: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  let plan: PlanEntry[];
  try {
    const planOpts: PlanDeployOptions = {};
    if (args.agents) planOpts.agents = args.agents;
    if (args.target !== undefined) planOpts.targetOverride = args.target;
    if (Object.keys(extraTargets).length > 0) planOpts.extraTargets = extraTargets;
    plan = planDeploy(fleet, planOpts);
  } catch (err) {
    if (err instanceof FleetDeployError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (plan.length === 0) {
    io.err(
      args.agents && args.agents.length > 0
        ? `✗ none of --agent ${args.agents.join(',')} match agents declared in fleet.yaml.\n`
        : '✗ fleet has no agents to deploy.\n',
    );
    return 1;
  }

  const strategy: FleetDeployStrategy =
    args.strategy ?? fleet.manifest.deploy?.strategy ?? 'rolling';
  const fleetVersion = deps.fleetVersion ?? computeFleetVersion(root, fs);

  if (args.dryRun) {
    if (args.json) {
      io.out(
        `${JSON.stringify(
          {
            dryRun: true,
            strategy,
            fleetVersion,
            plan: plan.map((e) => ({
              agent: e.agent.id,
              target: e.targetKey,
              kind: e.targetConfig.kind,
            })),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.out(`plan (strategy=${strategy}, version=${fleetVersion}):\n`);
      for (const entry of plan) {
        io.out(`  • ${entry.agent.id} → ${entry.targetKey} (kind=${entry.targetConfig.kind})\n`);
      }
      io.out('(dry-run — no adapters invoked, no history written)\n');
    }
    return 0;
  }

  // Resolve adapters for every target in the plan.
  let adapters: Map<string, FleetDeployTarget>;
  try {
    adapters = resolveAdapters(plan, deps);
  } catch (err) {
    if (err instanceof FleetDeployError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const executeOpts: ExecuteDeployOptions = {
    strategy,
    fleet,
    fleetVersion,
    logger: io,
  };
  if (args.canaryWaitMs !== undefined) {
    (executeOpts as { canaryWaitMs?: number }).canaryWaitMs = args.canaryWaitMs;
  }
  if (deps.sleep !== undefined) {
    (executeOpts as { sleep?: (ms: number) => Promise<void> }).sleep = deps.sleep;
  }
  const result = await executeDeploy(plan, adapters, executeOpts);

  const now = (deps.now ?? (() => new Date()))();
  const record: FleetDeployRecord = {
    fleetVersion,
    timestamp: now.toISOString(),
    strategy,
    agents: result.outcomes,
    status: result.failed !== undefined ? 'rolled-back' : 'deployed',
  };
  appendDeployRecord(root, record, fs);

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          ok: result.ok,
          strategy,
          fleetVersion,
          deployed: result.deployed,
          failed: result.failed ?? null,
          rolledBack: result.rolledBack,
          status: record.status,
        },
        null,
        2,
      )}\n`,
    );
  } else if (result.failed !== undefined) {
    io.err(`✗ fleet deploy failed on agent "${result.failed}".\n`);
    if (result.rolledBack.length > 0) {
      io.err(`  rolled back: ${result.rolledBack.join(', ')}\n`);
    }
  } else {
    io.out(
      `✓ fleet deploy ${fleetVersion} succeeded (${result.deployed.length} agent${
        result.deployed.length === 1 ? '' : 's'
      }, strategy=${strategy})\n`,
    );
    for (const id of result.deployed) {
      const artifact = result.outcomes[id]?.artifact ?? '(no artifact)';
      io.out(`  • ${id} → ${artifact}\n`);
    }
  }

  return result.ok ? 0 : 1;
}

function resolveAdapters(
  plan: readonly PlanEntry[],
  deps: FleetDeployDeps,
): Map<string, FleetDeployTarget> {
  const adapters = new Map<string, FleetDeployTarget>();
  for (const entry of plan) {
    if (adapters.has(entry.targetKey)) continue;
    const explicit = deps.targets?.get(entry.targetKey);
    if (explicit) {
      adapters.set(entry.targetKey, explicit);
      continue;
    }
    const byKind = deps.targetFactory?.(entry.targetConfig.kind);
    if (byKind) {
      adapters.set(entry.targetKey, byKind);
      continue;
    }
    throw new FleetDeployError(
      `no adapter registered for target "${entry.targetKey}" (kind=${entry.targetConfig.kind}). Supply one via deps.targets or deps.targetFactory.`,
    );
  }
  return adapters;
}

async function runRollback(
  fleet: LoadedFleet,
  deps: FleetDeployDeps & { io: FleetCliIO; fs: FleetFS },
  args: FleetDeployArgs,
): Promise<number> {
  const { io, fs } = deps;
  const history = readDeployHistory(fleet.root, fs);
  const previous = history
    .slice()
    .reverse()
    .find((r) => r.status === 'deployed');
  if (!previous) {
    io.err('✗ no previous successful deploy found in history to roll back to.\n');
    return 1;
  }

  const planOpts: PlanDeployOptions = {};
  if (args.agents) planOpts.agents = args.agents;
  // Rollback uses the previous record's per-agent targets so a later
  // `--target` override doesn't inadvertently switch targets mid-rollback.
  let plan: PlanEntry[];
  try {
    plan = planDeploy(fleet, planOpts).map((entry) => {
      const prior = previous.agents[entry.agent.id];
      if (prior) {
        return { ...entry, targetKey: prior.target };
      }
      return entry;
    });
  } catch (err) {
    if (err instanceof FleetDeployError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  let adapters: Map<string, FleetDeployTarget>;
  try {
    adapters = resolveAdapters(plan, deps);
  } catch (err) {
    if (err instanceof FleetDeployError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const result = await executeDeploy(plan, adapters, {
    strategy: 'rolling',
    fleet,
    fleetVersion: previous.fleetVersion,
    logger: io,
    previousRecord: previous,
  });

  const now = (deps.now ?? (() => new Date()))();
  const record: FleetDeployRecord = {
    fleetVersion: previous.fleetVersion,
    timestamp: now.toISOString(),
    strategy: 'rolling',
    agents: result.outcomes,
    status: 'rolled-back',
  };
  appendDeployRecord(fleet.root, record, fs);

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          ok: result.ok,
          rollback: true,
          strategy: 'rolling',
          fleetVersion: previous.fleetVersion,
          deployed: result.deployed,
          failed: result.failed ?? null,
          rolledBack: result.rolledBack,
          status: record.status,
        },
        null,
        2,
      )}\n`,
    );
  } else if (result.failed !== undefined) {
    io.err(`✗ rollback failed on agent "${result.failed}".\n`);
  } else {
    io.out(
      `✓ rolled back to ${previous.fleetVersion} (${result.deployed.length} agent${
        result.deployed.length === 1 ? '' : 's'
      })\n`,
    );
  }

  return result.ok ? 0 : 1;
}
