/**
 * `declaragent up` — Docker-Compose-style lifecycle verb.
 *
 * Happy path:
 *   1. Resolve manifest (cwd `fleet.yaml` > cwd `agent.yaml` > `-f <path>`).
 *   2. If something's already up, SIGTERM + reap (reload semantics).
 *   3. Detach branch: re-exec self with `--__detached` sentinel + exit
 *      with the child pid printed. The detached child loops back here
 *      without the `-d` flag and takes the foreground path.
 *   4. Foreground branch: load each agent via {@link loadAgent}, start
 *      its in-process sources via {@link startAgentSources}, write an
 *      up-state.json snapshot, and stream bus events to per-agent log
 *      files (plus a prefixed tail to stdout).
 *   5. SIGINT / SIGTERM → graceful shutdown (stop sources, close logs,
 *      clear state).
 *
 * Scope for 0.4.1 (matches USABILITY_PLAN commitments):
 *   - Single-agent `agent.yaml` manifest → full support.
 *   - Fleet `fleet.yaml` manifest → walks each agent, starts its per-
 *     agent sources independently. Cross-agent RPC still ships through
 *     `declaragent fleet run` (separate bus topology).
 *   - External-broker sources (kafka/nats/etc.) pass through to the
 *     same `unknown type` warning `declaragent run` emits.
 *
 * @since 0.4.1
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AgentConfigError,
  type AgentEvent,
  type LoadedAgent,
  loadAgent,
  loadFleet,
} from '@declaragent/core';
import { type StartAgentSourcesResult, startAgentSources } from './run-agent-sources.js';
import {
  type AgentLogger,
  DETACHED_SENTINEL,
  type UpAgentSummary,
  type UpSourceSummary,
  type UpState,
  clearUpState,
  detachSelf,
  isAlive,
  openAgentLog,
  readUpState,
  reapStaleState,
  writeUpState,
} from './up-lifecycle.js';

export interface UpIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: UpIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface UpArgs {
  /** Explicit manifest path. Overrides cwd discovery. */
  manifestPath?: string;
  /** Detach mode — spawn self, print pid, exit. */
  detach?: boolean;
  /** Set by the CLI dispatcher when the detached child re-enters `up`. */
  __detached?: boolean;
}

export interface UpDeps {
  io?: UpIO;
  cwd?: string;
  /**
   * Override for {@link startAgentSources}. Tests stub it so they
   * don't bind real webhook ports; production uses the default which
   * wires webhook / cron / file-watch.
   */
  startSources?: typeof startAgentSources;
  /**
   * Override for process signal install. Tests skip signal wiring so
   * a mis-behaved up loop can't crash the harness.
   */
  installSignals?: (onShutdown: () => Promise<void>) => () => void;
  /** Override for `process.exit` — tests want to assert the exit code. */
  exit?: (code: number) => never;
}

// ── Public entry ────────────────────────────────────────────────────────

export async function up(args: UpArgs, deps: UpDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const cwd = deps.cwd ?? process.cwd();

  const manifest = resolveManifest(args.manifestPath, cwd);
  if (!manifest.ok) {
    io.err(`✗ ${manifest.reason}\n`);
    return 1;
  }

  // Reload semantics when something's already up.
  const prior = reapStaleState();
  if (prior !== null && isAlive(prior.pid)) {
    io.out(`reloading — stopping existing up (pid ${prior.pid})…\n`);
    await gracefulStop(prior.pid, io);
  }

  // Detach path: re-exec without `-d` + sentinel appended. The child
  // owns the workload; the parent just reports the pid.
  if (args.detach && !args.__detached) {
    try {
      const childPid = detachSelf({
        launcher: process.argv[0] ?? 'declaragent',
        args: buildDetachedArgs(args),
      });
      io.out(`✓ up (detached), pid ${childPid}\n`);
      io.out('  tail logs with: declaragent logs -f\n');
      return 0;
    } catch (err) {
      io.err(`✗ failed to detach: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  // Foreground / detached-child path.
  return runForeground(manifest.path, manifest.kind, args, deps);
}

// ── Manifest resolution ─────────────────────────────────────────────────

type ManifestKind = 'agent' | 'fleet';

interface ManifestResolution {
  ok: true;
  kind: ManifestKind;
  /** Absolute path to the fleet.yaml or agent.yaml. */
  path: string;
}

interface ManifestError {
  ok: false;
  reason: string;
}

function resolveManifest(
  override: string | undefined,
  cwd: string,
): ManifestResolution | ManifestError {
  if (override !== undefined) {
    const abs = isAbsolute(override) ? override : resolve(cwd, override);
    if (!existsSync(abs)) return { ok: false, reason: `manifest not found at ${abs}` };
    const kind = abs.endsWith('fleet.yaml') || abs.endsWith('fleet.yml') ? 'fleet' : 'agent';
    return { ok: true, kind, path: abs };
  }
  for (const name of ['fleet.yaml', 'fleet.yml']) {
    const p = join(cwd, name);
    if (existsSync(p)) return { ok: true, kind: 'fleet', path: p };
  }
  for (const name of ['agent.yaml', 'agent.yml']) {
    const p = join(cwd, name);
    if (existsSync(p)) return { ok: true, kind: 'agent', path: p };
  }
  return {
    ok: false,
    reason:
      'no agent.yaml or fleet.yaml in this directory. Run `declaragent init` to scaffold one, or pass `-f <path>`.',
  };
}

// ── Foreground loop ─────────────────────────────────────────────────────

interface RunningAgent {
  summary: UpAgentSummary;
  sources: StartAgentSourcesResult;
  logger: AgentLogger;
}

async function runForeground(
  manifestPath: string,
  kind: ManifestKind,
  _args: UpArgs,
  deps: UpDeps,
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const startSources = deps.startSources ?? startAgentSources;

  let agentDirs: string[];
  try {
    agentDirs =
      kind === 'fleet' ? await loadFleetAgentDirs(manifestPath) : [manifestDir(manifestPath)];
  } catch (err) {
    io.err(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const running: RunningAgent[] = [];
  let anyFailed = false;

  for (const agentDir of agentDirs) {
    try {
      const started = await bringUp(agentDir, startSources, io);
      running.push(started);
      printBanner(io, started);
    } catch (err) {
      io.err(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
      anyFailed = true;
      break;
    }
  }

  if (anyFailed) {
    // Partial boot — clean up whatever we started before returning.
    await stopAll(running);
    return 1;
  }

  // Persist the snapshot for `ps` / `logs` + future `down`.
  const state: UpState = {
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    manifestPath,
    agents: running.map((r) => r.summary),
  };
  writeUpState(state);

  io.out(`\n✓ up — ${running.length} agent${running.length === 1 ? '' : 's'} bound.\n`);
  io.out('  Ctrl+C to stop.\n\n');

  // Signal wiring. Default is process-global; tests inject a no-op so
  // they can simulate shutdown explicitly.
  let shutdownPromise: Promise<void> | null = null;
  const doShutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      io.out('\nshutting down…\n');
      await stopAll(running);
      clearUpState();
      io.out('✓ down\n');
    })();
    await shutdownPromise;
  };

  const uninstall = deps.installSignals?.(doShutdown) ?? installDefaultSignalHandlers(doShutdown);

  // Block until shutdown fires. We don't want to busy-loop — a pending
  // promise that resolves on shutdown is all we need.
  await new Promise<void>((resolveExit) => {
    const tick = setInterval(() => {
      if (shutdownPromise !== null) {
        clearInterval(tick);
        resolveExit();
      }
    }, 500);
    // Node keeps the loop alive as long as `tick` is active.
  });

  await shutdownPromise;
  uninstall();
  return 0;
}

async function bringUp(
  agentDir: string,
  startSources: typeof startAgentSources,
  io: UpIO,
): Promise<RunningAgent> {
  let loaded: LoadedAgent;
  try {
    loaded = await loadAgent({ agentDir });
  } catch (err) {
    if (err instanceof AgentConfigError) {
      throw new Error(`${agentDir}: ${err.message}`);
    }
    throw err;
  }
  const agentId = loaded.spec.name;
  const logger = openAgentLog(agentId);

  const eventSourcesPath = findEventSourcesConfig(agentDir);
  if (eventSourcesPath === undefined) {
    // Agent has no sources — still report it as up so `ps` lists it.
    io.out(`  ${agentId}: no event-sources.yaml (skill-only)\n`);
    return {
      summary: { id: agentId, path: agentDir, sources: [] },
      sources: {
        started: [],
        unknownTypes: [],
        validationErrors: [],
        stop: async () => {
          /* nothing to stop */
        },
      },
      logger,
    };
  }

  const sources = await startSources({
    configPath: eventSourcesPath,
    onEvent: (ev: AgentEvent) => {
      logger.write({
        kind: ev.kind,
        sourceId: (ev.source as { sourceId?: unknown } | undefined)?.sourceId,
        correlationId: ev.meta?.correlationId,
      });
    },
  });

  const summary: UpSourceSummary[] = sources.started.map((s) => ({
    type: s.type,
    id: s.id,
    summary: s.summary,
  }));

  return {
    summary: { id: agentId, path: agentDir, sources: summary },
    sources,
    logger,
  };
}

function printBanner(io: UpIO, agent: RunningAgent): void {
  io.out(`  ${agent.summary.id}:\n`);
  if (agent.summary.sources.length === 0) {
    io.out('    (no active sources)\n');
  } else {
    for (const s of agent.summary.sources) {
      io.out(`    • ${s.summary}\n`);
    }
  }
  if (agent.sources.unknownTypes.length > 0) {
    const listing = agent.sources.unknownTypes.map((u) => u.type).join(', ');
    io.out(`    note: skipped external source types (install adapters): ${listing}\n`);
  }
}

async function stopAll(running: RunningAgent[]): Promise<void> {
  for (const r of running) {
    try {
      await r.sources.stop();
    } catch {
      // swallow — best-effort shutdown
    }
    r.logger.close();
  }
}

async function gracefulStop(pid: number, io: UpIO): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may have exited between isAlive() and now.
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      clearUpState();
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    io.out(`  pid ${pid} didn't exit within 5s — sending SIGKILL\n`);
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone
  }
  clearUpState();
}

// ── Helpers ─────────────────────────────────────────────────────────────

function buildDetachedArgs(args: UpArgs): string[] {
  const out: string[] = ['up'];
  if (args.manifestPath !== undefined) {
    out.push('-f', args.manifestPath);
  }
  return out;
}

function findEventSourcesConfig(agentDir: string): string | undefined {
  for (const name of ['event-sources.yaml', 'event-sources.yml', 'event-sources.json']) {
    const p = join(agentDir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function manifestDir(manifestPath: string): string {
  return manifestPath.replace(/\/[^/]*$/, '');
}

async function loadFleetAgentDirs(fleetPath: string): Promise<string[]> {
  const root = manifestDir(fleetPath);
  const fleet = await loadFleet({ root });
  return fleet.agents.map((a) => a.path);
}

function installDefaultSignalHandlers(onShutdown: () => Promise<void>): () => void {
  const onSigint = (): void => {
    void onShutdown();
  };
  const onSigterm = (): void => {
    void onShutdown();
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

// Re-export the sentinel so the CLI dispatcher can detect it without
// duplicating the constant.
export { DETACHED_SENTINEL };

// Re-export state probes for down / ps / logs consumers.
export { readUpState };
