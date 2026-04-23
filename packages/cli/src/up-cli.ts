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

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AgentConfigError,
  type AgentEvent,
  type AgentSpec,
  type AuditExportLoopHandle,
  type AuditExporter,
  CircuitBreaker,
  type CircuitBreakerTransitionEvent,
  type ControlPlaneAuth,
  type ControlPlaneRoute,
  type ControlPlaneServerHandle,
  type ControlSocketContext,
  type ControlSocketServer,
  DEFAULT_TENANT_CONTEXT,
  type EventBus,
  type EventDispatcher,
  type EventStore,
  type LLMProvider,
  type LoadedAgent,
  type LoadedAuditExport,
  type LoadedControlPlaneAuth,
  type Logger,
  type PrometheusRegistry,
  type TenantAuditSink,
  type Tracer,
  type UpStatusSnapshot,
  auditRoute,
  createDatadogExporter,
  createDefaultSecretResolver,
  createElasticExporter,
  createEngine,
  createEventDispatcher,
  createExtensionRegistry,
  createHookRegistry,
  createOtelBridge,
  createPermissionGate,
  createPrometheusRegistry,
  createSendMessageTool,
  createSplunkExporter,
  createSqliteSessionStore,
  createToolRateLimitGate,
  defaultRateForProvider,
  dlqRoute,
  eventsRoute,
  loadAgent,
  loadFleet,
  loadPeersConfig,
  logsRoute,
  metricsRoute,
  skillExtension,
  startAuditExportLoop,
  startControlPlaneServer,
  startControlSocket,
  statusRoute,
  withProviderRateLimit,
} from '@declaragent/core';
import type { ResolveLogPaths } from '@declaragent/core';
import { type AuthVerifyRegistry, buildAuthVerifyRegistry } from '@declaragent/plugin-agent-rpc';
import { getOrOpenSharedAuditSink, releaseSharedAuditSink } from './audit-sink-singleton.js';
import { resolveCredentials } from './auth.js';
import { buildRuntimeTools } from './builtin-tools.js';
import { type ChannelRuntime, startChannelRuntime } from './channels-runtime.js';
import { buildControlPlaneAuth } from './control-plane-auth-factory.js';
import {
  type ConsentResolver,
  type MCPRuntime,
  loadScopedMCPServers,
  startMCPServers,
} from './mcp-runtime.js';
import { auditDbPath, sessionsDbPath } from './paths.js';
import { type PluginRuntime, startPluginRuntime } from './plugins-runtime.js';
import { createProviderFromCreds } from './provider-factory.js';
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
  upLogPath,
  upStartupLogPath,
  waitForUpState,
  writeUpState,
} from './up-lifecycle.js';
import { CLI_VERSION } from './version.js';

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
  // owns the workload; the parent waits for it to publish up-state so
  // the "pid X" banner only prints once sources are actually bound.
  // Crashes during the wait surface the tail of the startup log — the
  // silent-failure trap we burned on in 0.4.1.
  if (args.detach && !args.__detached) {
    let childPid: number;
    try {
      childPid = detachSelf({
        // `process.execPath` is the compiled-binary path (Bun sets
        // argv[0] to the interpreter name "bun" for `bun build
        // --compile` outputs, which would make spawn interpret
        // subsequent args as "script to run" → Script not found).
        launcher: process.execPath || process.argv[0] || 'declaragent',
        args: buildDetachedArgs(args),
      });
    } catch (err) {
      io.err(`✗ failed to detach: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const state = await waitForUpState({ pid: childPid, timeoutMs: 8000 });
    if (state === null) {
      io.err(`✗ detached child (pid ${childPid}) never bound. Startup log tail:\n`);
      io.err(indent(tailFile(upStartupLogPath(), 30), '    '));
      io.err(
        '\n  If nothing jumped out, run `declaragent up` in the foreground for the full error.\n',
      );
      // Best-effort: kill the zombie child if it's still around.
      try {
        if (isAlive(childPid)) process.kill(childPid, 'SIGTERM');
      } catch {
        // already gone
      }
      clearUpState();
      return 1;
    }
    io.out(`✓ up (detached), pid ${childPid}\n`);
    for (const agent of state.agents) {
      io.out(`  ${agent.id}: ${agent.sources.length} source(s) bound\n`);
    }
    io.out('  tail logs with: declaragent logs -f\n');
    return 0;
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
  /**
   * RPC auth verify registry, built from `rpc-peers.yaml` when
   * `agent.yaml#rpc.auth.enabled: true`. The `authRegistry` is built
   * here for future agent-inbox consumers; neither `up` nor `fleet-run`
   * today constructs `createAgentInboxAdapter` (that would require a
   * per-agent `EventBus` + `SourceDependencies` shim). `fleet-run`
   * verifies envelopes inline in `startAgentWorker.onRequest` as a
   * pragmatic equivalent — see `packages/cli/src/fleet-run.ts`. `up`
   * holds this field for symmetry + inspection via `/status`.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #4 follow-up
   */
  authRegistry?: AuthVerifyRegistry;
  /**
   * Parsed `controlPlane.auth` block when `enabled: true`. Collected on
   * every RunningAgent; `up` then picks the first opt-in config and
   * installs it as middleware in front of the shared control-plane
   * HTTP listener. Multi-agent fleets that set different blocks are
   * warned at bind time — the listener is process-wide.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #5 Slice 2
   */
  controlPlaneAuthCfg?: LoadedControlPlaneAuth;
  /** MCP servers spawned for this agent; shutdown on stopAll. */
  mcp?: MCPRuntime;
  /** Channel registry + mailbox for this agent; shutdown on stopAll. */
  channels?: ChannelRuntime;
  /** Activated plugins (if any); deactivated on stopAll. */
  plugins?: PluginRuntime;
  /**
   * Detach handle returned by `dispatcher.attach(bus)`. Only present
   * when the agent has an LLM provider configured + at least one
   * source; skill-only / creds-missing agents keep this undefined.
   */
  detachDispatcher?: () => void;
  /**
   * Control socket bound at `~/.declaragent/<agent-id>/control.sock`.
   * Speaks the `ping`/`status`/`dlq.requeue`/`reload`/`shutdown` ops
   * defined in {@link startControlSocket}. Closed during `stopAll`.
   * @since 0.6.x
   */
  controlSocket?: ControlSocketServer;
  /**
   * ms-epoch of the last event the agent's bus observed. Updated by a
   * wildcard subscriber installed when the socket is bound so `status`
   * can report `lastEventAt` without re-reading the event store.
   */
  lastEventAt?: number;
  /** Unsubscribe the lastEventAt-tracker subscriber on shutdown. */
  detachLastEventTracker?: () => void;
  /**
   * SIEM export config from this agent's `agent.yaml#audit.export`. When
   * present, the up-loop starts a {@link AuditExportLoopHandle} for it.
   * @since 0.6.x — Enterprise Production Plan §3 Item #10
   */
  auditExport?: LoadedAuditExport;
}

/**
 * Shared state for the up process. The provider + session store are
 * created once (not per-agent) so N agents in a fleet can reuse the
 * same LLM connection pool + sqlite handle.
 */
interface UpRuntime {
  sessionStore: ReturnType<typeof createSqliteSessionStore>;
  /**
   * `null` when no auth is configured. Skill dispatch is skipped in
   * that case; sources still bind + events still land in the event
   * store (with `outcome: pending`), matching the pre-0.4.11 behavior
   * minus the silent drop. Startup banner surfaces the warning.
   */
  provider: ReturnType<typeof createProviderFromCreds> | null;
  defaultModel: string;
  /**
   * MCP consent resolver. Interactive foreground `up` renders the Ink
   * consent UI; detached + non-TTY boots set this to `undefined` so
   * un-consented servers are skipped with a warning (fail-closed
   * per-server, never blocks boot).
   */
  mcpConsent?: ConsentResolver;
  /**
   * Prometheus registry shared across every agent this up-process
   * hosts. Passed into `startAgentSources` + `startChannelRuntime` as
   * `deps.metrics`, so source + channel adapters produce Prometheus
   * samples for free. An HTTP exporter serves the scrape endpoint
   * when one is active (see {@link runForeground}).
   * @since 0.6.0-slice.1
   */
  metrics: PrometheusRegistry;
  /**
   * OTel-bridged tracer, populated only when `OTEL_EXPORTER_OTLP_ENDPOINT`
   * is set and `@opentelemetry/api` is installed. Threaded into sources
   * + channels via `deps.tracer` so `BaseSourceInstance.getInstruments()`
   * emits real OTel spans. Undefined → adapters keep their noop tracer.
   * @since 0.6.0-slice.2
   */
  tracer?: Tracer;
  /**
   * Shared audit sink opened once per up-process. Passed to
   *   - per-agent `createToolRateLimitGate({ auditSink })` so the
   *     `rate_limited` record lands on the hash chain when a tool
   *     waits > 1s on the token bucket (Item #7 follow-up).
   *   - `/audit` control-plane route (shared instead of a second open).
   *   - `startAuditExportLoop` for SIEM export.
   *
   * `null` when the sink failed to open; downstream consumers skip.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #7 follow-up
   */
  auditSink?: TenantAuditSink;
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

  // Shared across every agent this up-process hosts.
  const creds = resolveCredentials();
  // Detached child is spawned without a controlling TTY + runs the
  // __detached branch below. In both cases consent prompts can't land,
  // so we leave `mcpConsent` undefined → un-consented MCP servers are
  // skipped with a warning rather than blocking boot. The user can
  // pre-consent via `declaragent mcp add` (auto-approves) or a future
  // `mcp approve <name>` verb.
  const interactive = _args.__detached !== true && process.stdin.isTTY === true;
  const tracer = await maybeCreateOtelTracer(io);
  const metrics = createPrometheusRegistry();
  // Wrap the provider (when one is configured) with a per-provider rate
  // limiter (Slice 4). Defaults: Anthropic 50 rps, OpenRouter 20 rps.
  // Env vars:
  //   DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE=1 → skip wrapping entirely
  //   DECLARAGENT_PROVIDER_RATE_LIMIT_RPS=<n>  → override the default
  const provider = creds
    ? wrapProviderWithRateLimit({
        provider: createProviderFromCreds({ creds }),
        providerId: creds.providerId,
        metrics,
        io,
      })
    : null;
  // Shared `TenantAuditSink` — opened ONCE per up-process so every
  // consumer reuses the same SQLite handle (Enterprise Production
  // Plan §3 Item #7 follow-up + #10 sharing note + backlog #52
  // singleton dedup).
  //
  //   - per-agent `createToolRateLimitGate({ auditSink })` writes
  //     `rate_limited` records.
  //   - `/audit` route serves reads.
  //   - `startAuditExportLoop` tails the same file for SIEM export.
  //
  // Routed through {@link getOrOpenSharedAuditSink} so future callers
  // that target the same SQLite file transparently reuse this handle
  // rather than opening a second connection (backlog #52). The
  // singleton's module-scoped cache is released in `doShutdown()`.
  //
  // Best-effort open: a failure here leaves `sharedAuditSink` null and
  // each consumer silently no-ops — daemon still boots. We only log
  // once so the banner doesn't swamp the warning channel.
  const auditSinkPath = auditDbPath();
  let sharedAuditSink: TenantAuditSink | null = null;
  try {
    sharedAuditSink = await getOrOpenSharedAuditSink({ path: auditSinkPath });
  } catch (err) {
    io.err(
      `⚠ audit sink at ${auditSinkPath} failed to open — ${err instanceof Error ? err.message : String(err)}. Rate-limit + /audit + SIEM export disabled.\n`,
    );
  }

  const runtime: UpRuntime = {
    sessionStore: createSqliteSessionStore({ path: sessionsDbPath() }),
    provider,
    defaultModel: 'claude-sonnet-4-5',
    metrics,
    ...(tracer !== undefined && { tracer }),
    ...(interactive && { mcpConsent: createInteractiveMCPConsent() }),
    ...(sharedAuditSink !== null && { auditSink: sharedAuditSink }),
  };
  if (tracer !== undefined) {
    io.out(`  otel: tracing enabled (OTLP endpoint ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT})\n`);
  }
  if (!creds) {
    io.out(
      '⚠ no provider credentials found — sources will bind and events will land in the store, but skill dispatch is skipped until you run `declaragent auth login`.\n\n',
    );
  }

  const running: RunningAgent[] = [];
  let anyFailed = false;

  for (const agentDir of agentDirs) {
    try {
      const started = await bringUp(agentDir, startSources, runtime, io);
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
    // Release the shared audit sink so a retry opens a fresh handle
    // (the singleton cache is module-level).
    if (sharedAuditSink) {
      await releaseSharedAuditSink(auditSinkPath);
    }
    return 1;
  }

  // Persist the snapshot for `ps` / `logs` + future `down`.
  //
  // #44 — pre-0.7.2 `buildUpStatusSnapshot` read `cliVersion` from
  // `DECLARAGENT_CLI_VERSION` per scrape. Stamp it into state once at
  // boot so scrapes reflect the daemon's actual CLI version (env vars
  // on the scrape process — a future in-process HTTP client — are
  // irrelevant). The env var is still honoured for test overrides.
  const cliVersion = process.env.DECLARAGENT_CLI_VERSION ?? CLI_VERSION;
  const state: UpState = {
    version: 1,
    pid: process.pid,
    cliVersion,
    startedAt: new Date().toISOString(),
    manifestPath,
    agents: running.map((r) => r.summary),
  };
  writeUpState(state);

  // Control-plane HTTP listener. Shares `runtime.metrics` with every
  // agent's sources + channels so source/channel counters are scrapable
  // from a single endpoint, AND serves the 0.7.0 `/status` snapshot so
  // `declaragent fleet ps` can aggregate across hosts.
  //
  // Defaults: on in detached mode (port 9464), off in foreground mode
  // unless `DECLARAGENT_METRICS_PORT` is set. Set
  // `DECLARAGENT_METRICS_PORT=0` to disable in detached mode too.
  //
  // Slice 1 serves `/metrics` + `/status`. The Slice 1 *tail* extends
  // the router with `/events`, `/dlq`, and `/audit` when the backing
  // stores are available. Slice 1c adds `/logs` SSE tail.
  // @since 0.6.0-slice.1 (listener), 0.7.0-slice.1 (router + /status),
  //        0.7.0-slice.1-tail (/events + /dlq + /audit),
  //        0.7.0-slice.1c (/logs SSE)
  const metricsPort = resolveMetricsPort(_args.__detached === true);
  let controlPlaneHandle: ControlPlaneServerHandle | null = null;
  if (metricsPort > 0) {
    const routes: ControlPlaneRoute[] = [
      metricsRoute(runtime.metrics),
      statusRoute(() => buildUpStatusSnapshot(state, running)),
    ];
    // Wire `/events` + `/dlq` to the first agent that owns a store.
    // Multi-agent fleets run one SQLite per agent; surfacing the first
    // matches `declaragent events list` / `dlq list` CLI behavior today
    // (single-process view, not cross-agent aggregation). A fleet-wide
    // aggregator lives in the CLI fan-out layer (Slice 3 of
    // CONTROL_PLANE_PLAN.md) and calls this endpoint per host.
    const agentWithStore = running.find((r) => r.sources.eventStore !== undefined);
    const eventStoreForRoutes = agentWithStore?.sources.eventStore;
    if (eventStoreForRoutes) {
      routes.push(eventsRoute(eventStoreForRoutes));
      routes.push(dlqRoute(eventStoreForRoutes));
    }
    // `/audit` reuses the shared sink opened at boot (see §3 Item #7
    // follow-up — single handle per up-process, not one per consumer).
    if (sharedAuditSink) {
      routes.push(auditRoute(sharedAuditSink));
    }

    // `/logs` SSE tail (Slice 1c of CONTROL_PLANE_PLAN.md §9 PR 1.2).
    // Maps `?agent=<id>` (or no-param for the multiplex) to the
    // concrete `~/.declaragent/logs/<id>.log` files the `up` daemon
    // already appends to via {@link openAgentLog}.
    //
    // Unknown agent → 400 (resolver returns null). When no running
    // agents match (e.g. skill-only fleet with zero bound agents),
    // returns an empty paths array; the route emits its `stream-open`
    // frame immediately but never produces a log line. This matches
    // the behavior operators hit when `declaragent logs` is invoked
    // against an idle agent — no output is better than a 404.
    const resolveLogPaths: ResolveLogPaths = (query) => {
      const knownIds = new Set(running.map((r) => r.summary.id));
      if (query.agent !== undefined && query.agent !== '') {
        if (!knownIds.has(query.agent)) return null;
        return {
          paths: [{ path: upLogPath(query.agent), agentId: query.agent }],
          // When `?since=` is set, we replay from byte 0 and let
          // the caller filter by timestamp on the wire.
          fromStart: query.since !== undefined && query.since !== '',
        };
      }
      return {
        paths: running.map((r) => ({
          path: upLogPath(r.summary.id),
          agentId: r.summary.id,
        })),
        fromStart: query.since !== undefined && query.since !== '',
      };
    };
    routes.push(logsRoute({ resolvePaths: resolveLogPaths }));

    // Control-plane auth middleware (§3 Item #5 Slice 2 —
    // CONTROL_PLANE_PLAN.md §9 PR 2). The listener is process-wide, so
    // we pick the first agent whose `agent.yaml#controlPlane.auth.enabled`
    // is true and use that provider block. Multi-agent fleets with
    // conflicting blocks emit a warning (the first wins) — a future
    // slice can promote this to a fleet-level config in `fleet.yaml`.
    const cpAuthCandidates = running
      .map((r) => ({ id: r.summary.id, cfg: r.controlPlaneAuthCfg }))
      .filter((x): x is { id: string; cfg: LoadedControlPlaneAuth } => x.cfg !== undefined);
    let controlPlaneAuth: ControlPlaneAuth | undefined;
    if (cpAuthCandidates.length > 0) {
      const first = cpAuthCandidates[0];
      if (first === undefined) {
        // Unreachable — `length > 0` guarantees the element exists. The
        // guard keeps TypeScript's `noUncheckedIndexedAccess` happy.
      } else {
        if (cpAuthCandidates.length > 1) {
          const others = cpAuthCandidates
            .slice(1)
            .map((x) => x.id)
            .join(', ');
          io.err(
            `⚠ multiple agents set controlPlane.auth.enabled=true (${others}). Using ${first.id}'s config for the process-wide listener.\n`,
          );
        }
        try {
          const resolver = createDefaultSecretResolver({
            fileRoot: agentDirs[0] ?? manifestDir(manifestPath),
          });
          controlPlaneAuth = await buildControlPlaneAuth({
            config: first.cfg,
            secrets: (ref) => resolver.resolve(ref),
          });
          const loopbackDesc = describeAllowLoopback(first.cfg.allowLoopback);
          const routeScopeKeys = first.cfg.routeScopes ? Object.keys(first.cfg.routeScopes) : [];
          const routeScopeSuffix =
            routeScopeKeys.length > 0 ? `, routeScopes: ${routeScopeKeys.join(',')}` : '';
          io.out(
            `  control-plane auth enabled (provider: ${first.cfg.provider}, allowLoopback: ${loopbackDesc}${routeScopeSuffix})\n`,
          );
        } catch (err) {
          io.err(
            `⚠ control-plane auth failed to initialise — ${err instanceof Error ? err.message : String(err)}. Falling back to no-auth (loopback-only bind still protects the port).\n`,
          );
        }
      }
    }

    try {
      controlPlaneHandle = await startControlPlaneServer({
        routes,
        port: metricsPort,
        hostname: '127.0.0.1',
        // Authenticated listener implicitly accepts non-loopback Host
        // headers — otherwise the middleware is unreachable for the
        // remote callers it was installed to protect. Bind remains
        // `127.0.0.1` (kernel-level firewall) until operators flip the
        // future `observability.bindAddress` knob; this only relaxes
        // the in-process Host-header sniff so a reverse-proxied remote
        // request can complete the token handshake.
        ...(controlPlaneAuth !== undefined && {
          auth: controlPlaneAuth,
          allowRemote: true,
        }),
      });
      io.out(`  metrics: http://127.0.0.1:${controlPlaneHandle.port}/metrics\n`);
      io.out(`  status:  http://127.0.0.1:${controlPlaneHandle.port}/status\n`);
      if (eventStoreForRoutes) {
        io.out(`  events:  http://127.0.0.1:${controlPlaneHandle.port}/events\n`);
        io.out(`  dlq:     http://127.0.0.1:${controlPlaneHandle.port}/dlq\n`);
      }
      if (sharedAuditSink) {
        io.out(`  audit:   http://127.0.0.1:${controlPlaneHandle.port}/audit\n`);
      }
      io.out(`  logs:    http://127.0.0.1:${controlPlaneHandle.port}/logs\n`);
    } catch (err) {
      io.err(
        `⚠ control-plane exporter failed to bind on :${metricsPort} — ${err instanceof Error ? err.message : String(err)}. Continuing without HTTP endpoints.\n`,
      );
    }
  }

  // SIEM audit export loop (Enterprise Production Plan §3 Item #10).
  // When any agent in the fleet declares `audit.export.kind: splunk|elastic|datadog`,
  // we start an in-process loop that tails the shared audit SQLite file
  // and forwards new rows to the vendor on a 10s cadence. The cursor
  // lives in the same SQLite DB (`audit_export_cursor` table) so a
  // restart doesn't re-push rows already acked.
  //
  // Lifecycle: reuses `sharedAuditSink` — the SAME handle the `/audit`
  // route serves from and every per-agent rate-limit gate writes to
  // (backlog #52). Stopped during shutdown before the underlying sink
  // closes.
  //
  // @since 0.6.x — sink dedup hardened 0.7.2 via
  //                {@link getOrOpenSharedAuditSink}.
  const auditExports = running
    .map((r) => ({ id: r.summary.id, cfg: r.auditExport }))
    .filter((x): x is { id: string; cfg: LoadedAuditExport } => x.cfg !== undefined);
  const auditExportLoops: AuditExportLoopHandle[] = [];
  if (auditExports.length > 0) {
    if (!sharedAuditSink) {
      io.err(
        `⚠ audit sink unavailable — audit.export disabled for ${auditExports.length} agent(s).\n`,
      );
    } else {
      for (const { id, cfg } of auditExports) {
        const owner = running.find((r) => r.summary.id === id);
        if (!owner) continue;
        try {
          const exporter = buildAuditExporter(cfg);
          const loop = startAuditExportLoop({
            sink: sharedAuditSink,
            exporter,
            ...(cfg.intervalMs !== undefined && { intervalMs: cfg.intervalMs }),
            ...(cfg.batchSize !== undefined && { batchSize: cfg.batchSize }),
            metrics: runtime.metrics,
            logger: agentLoggerToCoreLogger(owner.logger),
          });
          auditExportLoops.push(loop);
          io.out(
            `  ${id}: audit.export → ${cfg.kind} (${exporter.name}) every ${cfg.intervalMs ?? 10_000}ms\n`,
          );
        } catch (err) {
          io.err(
            `⚠ ${id}: audit.export (${cfg.kind}) failed to start — ${err instanceof Error ? err.message : String(err)}. Continuing without export.\n`,
          );
        }
      }
    }
  }

  io.out(`\n✓ up — ${running.length} agent${running.length === 1 ? '' : 's'} bound.\n`);
  io.out('  Ctrl+C to stop.\n\n');

  // Signal wiring. Default is process-global; tests inject a no-op so
  // they can simulate shutdown explicitly.
  let shutdownPromise: Promise<void> | null = null;
  const doShutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      io.out('\nshutting down…\n');
      for (const loop of auditExportLoops) {
        try {
          await loop.stop();
        } catch {
          // best-effort — never block shutdown on a stuck loop
        }
      }
      if (controlPlaneHandle) {
        try {
          await controlPlaneHandle.close();
        } catch {
          // best-effort — never block shutdown on a stuck listener
        }
      }
      await stopAll(running);
      // Close the shared audit sink after every consumer has torn
      // down — exporter loops, /audit route, rate-limit gates. Go
      // through the singleton so the module-level cache is also
      // cleared; otherwise a subsequent `up` in the same process
      // (test runner, nested spawn) would hand out a closed handle.
      if (sharedAuditSink) {
        await releaseSharedAuditSink(auditSinkPath);
      }
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
  runtime: UpRuntime,
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
  const coreLogger = agentLoggerToCoreLogger(logger);

  // Build the RPC auth verify registry when the agent opts in via
  // `agent.yaml#rpc.auth.enabled: true` AND a git-tracked
  // `rpc-peers.yaml` exists with at least one `auth:` block. The
  // registry is constructed with a default secret resolver that
  // supports env:/file:/secret: refs out of the box — operators
  // needing Vault/AWS SM/etc. can extend via the providers list.
  //
  // Default off preserves legacy `internal`/`hmac` envelope behaviour
  // for every fleet that hasn't explicitly opted in. Once the
  // registry is built, future up-wiring that constructs an
  // `agent-inbox` adapter hands it through unchanged.
  //
  // @since 0.7.x — Enterprise Production Plan §3 Item #4 follow-up
  let authRegistry: AuthVerifyRegistry | undefined;
  if (loaded.rpcAuthEnabled) {
    const peersPath = findRpcPeersConfig(agentDir);
    if (peersPath === undefined) {
      io.err(
        `⚠ ${agentId}: rpc.auth.enabled=true but no rpc-peers.yaml found — auth registry is empty (every envelope follows the legacy path).\n`,
      );
    } else {
      try {
        const peers = await loadPeersConfig(peersPath);
        const resolver = createDefaultSecretResolver({ fileRoot: agentDir });
        authRegistry = await buildAuthVerifyRegistry({
          peers,
          secrets: (ref) => resolver.resolve(ref),
        });
        const registeredPeers = peers.config.peers.filter((p) => p.auth !== undefined).length;
        io.out(
          `  ${agentId}: rpc.auth enabled (${registeredPeers} peer(s) with auth registered)\n`,
        );
      } catch (err) {
        io.err(
          `⚠ ${agentId}: rpc.auth.enabled=true but registry build failed — ${err instanceof Error ? err.message : String(err)}. Falling back to legacy envelope auth.\n`,
        );
      }
    }
  }

  // Spawn any MCP servers configured across user/project/local scopes.
  // Happens BEFORE source/dispatcher wiring so the engine gets the full
  // tool list from the start. A failure here is per-server soft-failed
  // inside `startMCPServers` — we never abort the whole agent boot over
  // one misconfigured MCP.
  const scopedMcp = await loadScopedMCPServers({ agentDir });
  const mcp = await startMCPServers({
    servers: scopedMcp,
    logger: coreLogger,
    ...(runtime.mcpConsent !== undefined && { consent: runtime.mcpConsent }),
    // Default-on supervision — see load-agent.ts for the `'all'` rationale.
    // Respect explicit opt-out (`'none'`) or allow-list from agent.yaml.
    supervised: loaded.mcpSupervised,
    metrics: runtime.metrics,
  });
  if (mcp.tools.length > 0) {
    io.out(`  ${agentId}: ${mcp.tools.length} MCP tool(s) loaded\n`);
  }
  for (const s of mcp.skipped) {
    io.out(`    note: MCP server "${s.name}" (${s.scope}) skipped — ${s.reason}\n`);
  }

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
      mcp,
      ...(loaded.auditExport !== undefined && { auditExport: loaded.auditExport }),
      ...(loaded.controlPlaneAuth !== undefined && {
        controlPlaneAuthCfg: loaded.controlPlaneAuth,
      }),
    };
  }

  // When a provider is configured we'll attach a dispatcher that
  // owns event recording (dedup + outcome chain). In that case
  // `startAgentSources` must NOT also record, or the dispatcher's
  // `findDuplicate` will hit the row the sources subscriber just
  // wrote and mark every event as `duplicate`. Without a provider
  // there's no dispatcher, so fall back to the old behavior so
  // events still land in the store for `declaragent events list`.
  const willAttachDispatcher = runtime.provider !== null;

  const sources = await startSources({
    configPath: eventSourcesPath,
    agentDir,
    // Route the bus's internal warnings (including silent
    // `event-store.record-failed` / `source.start-failed`) to the
    // per-agent log so `declaragent logs <agent>` surfaces them.
    // Previously the default NOOP_LOGGER ate these, which is how a
    // YAML target.type typo could drop every webhook event without
    // any visible signal.
    logger: agentLoggerToCoreLogger(logger),
    recordToStore: !willAttachDispatcher,
    metrics: runtime.metrics,
    ...(runtime.tracer !== undefined && { tracer: runtime.tracer }),
    onEvent: (ev: AgentEvent) => {
      logger.write({
        kind: ev.kind,
        sourceId: (ev.source as { sourceId?: unknown } | undefined)?.sourceId,
        correlationId: ev.meta?.correlationId,
      });
    },
  });

  // Bring up channels + mailbox now that the event bus exists. Needed
  // before `attachDispatcherToAgent` so the engine can be built with a
  // `SendMessage` tool whose channel registry is already populated.
  let channelsRuntime: ChannelRuntime | undefined;
  if (sources.bus) {
    channelsRuntime = await startChannelRuntime({
      bus: sources.bus,
      logger: coreLogger,
      agentDir,
      metrics: runtime.metrics,
      ...(runtime.tracer !== undefined && { tracer: runtime.tracer }),
    });
    const channelCount = channelsRuntime.channels.list().length;
    if (channelCount > 0) {
      io.out(`  ${agentId}: ${channelCount} channel(s) ready\n`);
    }
    for (const s of channelsRuntime.skipped) {
      io.out(`    note: channel "${s.type}" skipped — ${s.reason}\n`);
    }
  }

  const summary: UpSourceSummary[] = sources.started.map((s) => ({
    type: s.type,
    id: s.id,
    summary: s.summary,
  }));

  // Wire the dispatcher. Without this step the bus publishes events
  // that only the event store's subscriber consumes — they sit as
  // `outcome: pending` forever and the skill never runs. With it,
  // `target: {type: skill, name: X}` events flow into an engine turn.
  let detachDispatcher: (() => void) | undefined;
  let plugins: PluginRuntime | undefined;
  if (sources.bus && runtime.provider) {
    try {
      const attached = await attachDispatcherToAgent({
        loaded,
        runtime,
        sources,
        logger,
        mcpTools: mcp.tools,
        ...(channelsRuntime && { channelsRuntime }),
      });
      detachDispatcher = attached.detach;
      plugins = attached.plugins;
      if (plugins.activations.length > 0) {
        io.out(
          `  ${agentId}: ${plugins.activations.length} plugin(s) active (${plugins.tools.length} tool(s) contributed)\n`,
        );
      }
      for (const s of plugins.skipped) {
        io.out(`    note: plugin "${s.name}" skipped — ${s.reason}\n`);
      }
    } catch (err) {
      // A dispatcher-attach failure used to manifest as "events sit
      // forever in `pending`" with no signal. Surface the actual
      // error so `declaragent logs <agent>` shows what broke.
      logger.write({
        level: 'error',
        event: 'dispatcher.attach-failed',
        err: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (sources.bus && !runtime.provider) {
    logger.write({
      level: 'warn',
      event: 'dispatcher.skipped',
      reason: 'no-provider',
    });
  }

  const running: RunningAgent = {
    summary: { id: agentId, path: agentDir, sources: summary },
    sources,
    logger,
    mcp,
    ...(channelsRuntime && { channels: channelsRuntime }),
    ...(plugins && { plugins }),
    ...(detachDispatcher !== undefined && { detachDispatcher }),
    ...(loaded.auditExport !== undefined && { auditExport: loaded.auditExport }),
    ...(authRegistry !== undefined && { authRegistry }),
    ...(loaded.controlPlaneAuth !== undefined && {
      controlPlaneAuthCfg: loaded.controlPlaneAuth,
    }),
  };

  // Bind the control socket (§3 item #6 of the Enterprise Production
  // Plan). One socket per agent at `~/.declaragent/<id>/control.sock`;
  // speaks the ping/status/dlq.requeue/reload/shutdown ops.
  //
  // Failure here is non-fatal — we'd rather let `up` run without a
  // socket than refuse to start. A `ps` fall-through still works via
  // the `up-state.json` snapshot.
  try {
    const socket = await bindControlSocket({
      agentId,
      running,
      ...(sources.bus && { bus: sources.bus }),
      ...(sources.eventStore && { eventStore: sources.eventStore }),
      logger,
    });
    if (socket) {
      running.controlSocket = socket.server;
      if (socket.detachLastEventTracker) {
        running.detachLastEventTracker = socket.detachLastEventTracker;
      }
      io.out(`  ${agentId}: control socket ${socket.server.socketPath}\n`);
    }
  } catch (err) {
    io.err(
      `⚠ ${agentId}: control socket failed to bind — ${err instanceof Error ? err.message : String(err)}. Continuing without it.\n`,
    );
  }

  return running;
}

/**
 * Bind the per-agent control socket. Returns `null` when binding
 * silently opts out. The returned server is stored on `RunningAgent`
 * and closed during `stopAll`.
 *
 * Why a helper: `bringUp` already has enough going on, and the
 * closure over `running` / `lastEventAt` is awkward inline.
 *
 * @since 0.6.x
 */
async function bindControlSocket(opts: {
  agentId: string;
  running: RunningAgent;
  bus?: EventBus;
  eventStore?: EventStore;
  logger: AgentLogger;
}): Promise<{
  server: ControlSocketServer;
  detachLastEventTracker?: () => void;
} | null> {
  const { agentId, running, bus, eventStore, logger } = opts;
  const startedAt = Date.now();

  // Install the lastEventAt tracker only when a bus exists. Skill-only
  // agents never see events so the field stays `undefined`.
  let detachLastEventTracker: (() => void) | undefined;
  if (bus) {
    detachLastEventTracker = bus.subscribe('*', () => {
      running.lastEventAt = Date.now();
    });
  }

  const context: ControlSocketContext = {
    agentId,
    pid: process.pid,
    startedAt,
    sources: () => {
      // Map the started summary back to id/type pairs. We don't have
      // direct refs to `EventSourceInstance` objects here (sources.ts
      // doesn't surface them), and the control socket only needs the
      // id+type so the stub below is type-compatible with what the
      // `status` op extracts.
      return running.sources.started.map(
        (s) =>
          ({
            id: s.id,
            type: s.type,
            start: async () => {},
            stop: async () => {},
            pause: async () => {},
            resume: async () => {},
            health: async () => ({ status: 'ok' as const }),
            metrics: () => ({ eventsPublished: 0, lastEventAt: null }),
          }) as unknown as import('@declaragent/core').EventSourceInstance,
      );
    },
    lastEventAt: () => running.lastEventAt,
    ...(bus && { bus }),
    ...(eventStore && { store: eventStore }),
    reload: () => ({
      reloaded: false,
      reason: 'unsupported',
      message:
        'hot reload of sources is not implemented; restart `declaragent up` to apply changes',
    }),
    // shutdown is wired at the top-level `runForeground` so it reaches
    // the whole up process, not just one agent. We leave it undefined
    // here — a later PR (#3 DLQ requeue verb) can add a per-agent
    // shutdown flag if needed.
    logger: agentLoggerToCoreLogger(logger),
  };

  try {
    const server = await startControlSocket({ context });
    const result: {
      server: ControlSocketServer;
      detachLastEventTracker?: () => void;
    } = { server };
    if (detachLastEventTracker) {
      result.detachLastEventTracker = detachLastEventTracker;
    }
    return result;
  } catch (err) {
    // Cleanup the subscriber if we installed one before the bind failed.
    if (detachLastEventTracker) {
      try {
        detachLastEventTracker();
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

/**
 * Build the per-agent extension registry + engine + dispatcher and
 * attach to the agent's event bus. Returns the detach handle so
 * `stopAll` can unwind cleanly on shutdown.
 *
 * Async because the skill registrations MUST complete before the
 * dispatcher subscribes. Before 0.4.13 this was fire-and-forget via
 * `void registry.register(...)`, which left a small window where
 * an event could fire, the dispatcher lookupSkill would miss, and
 * the outcome would quietly stay `null` — the symptom user hit in
 * the fleet test.
 */
interface AttachDispatcherResult {
  detach: () => void;
  plugins: PluginRuntime;
}

async function attachDispatcherToAgent(opts: {
  loaded: LoadedAgent;
  runtime: UpRuntime;
  sources: StartAgentSourcesResult;
  logger: AgentLogger;
  mcpTools?: readonly import('@declaragent/core').Tool[];
  channelsRuntime?: ChannelRuntime;
}): Promise<AttachDispatcherResult> {
  const { loaded, runtime, sources, logger, mcpTools, channelsRuntime } = opts;
  const bus = sources.bus;
  const eventStore = sources.eventStore;
  const emptyPluginRuntime: PluginRuntime = {
    tools: [],
    activations: [],
    skipped: [],
    shutdown: async () => {},
  };
  if (!bus) {
    // Shouldn't happen — caller checks before invoking — but keep
    // the type-narrow explicit.
    return { detach: () => {}, plugins: emptyPluginRuntime };
  }

  const spec: AgentSpec = {
    ...loaded.spec,
    model: loaded.spec.model || runtime.defaultModel,
  };

  // Skill registry scoped to THIS agent.
  const coreLogger = agentLoggerToCoreLogger(logger);
  const registry = createExtensionRegistry({
    logger: coreLogger,
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    configDir: '',
  });
  for (const skill of loaded.skills) {
    await registry.register(skillExtension(skill));
  }

  // Activate every consented plugin BEFORE the engine is constructed so
  // plugin-contributed tools reach the tool array and plugin skills are
  // visible to the dispatcher's skill lookup.
  const hookRegistry = createHookRegistry({ logger: coreLogger });
  const plugins = await startPluginRuntime({
    registry,
    hookRegistry,
    logger: coreLogger,
  });
  if (plugins.activations.length > 0) {
    logger.write({
      level: 'info',
      event: 'plugins.activated',
      count: plugins.activations.length,
      tools: plugins.tools.length,
    });
  }
  for (const s of plugins.skipped) {
    logger.write({ level: 'warn', event: 'plugins.skipped', name: s.name, reason: s.reason });
  }

  const provider = runtime.provider;
  if (!provider) return { detach: () => {}, plugins };

  const extraTools: import('@declaragent/core').Tool[] = [];
  if (channelsRuntime !== undefined) {
    extraTools.push(
      createSendMessageTool({
        mailbox: channelsRuntime.mailbox,
        channels: channelsRuntime.channels,
      }) as import('@declaragent/core').Tool,
    );
  }
  extraTools.push(...plugins.tools);

  // Enterprise Production Plan §3 Item #7 — per-tool token-bucket gate.
  // Built only when `agent.yaml#tools.rateLimit` has at least one entry,
  // to avoid allocating buckets for agents that opt out. `auditSink` is
  // the shared per-process handle opened at up boot — passing it here
  // makes `rate_limited` records land on the hash chain (#7 follow-up).
  const toolRateLimit =
    Object.keys(loaded.toolRateLimits).length > 0
      ? createToolRateLimitGate({
          limits: loaded.toolRateLimits,
          ...(runtime.auditSink !== undefined && { auditSink: runtime.auditSink }),
          onWait: ({ tool, waitMs }) => {
            runtime.metrics
              .counter('declaragent.tool.rate_limit.waits_total', 'Tool rate-limit waits by tool')
              .inc(1, { agent: spec.name, tool });
            runtime.metrics
              .counter('declaragent.tool.rate_limit.wait_ms', 'Cumulative ms waited per tool')
              .inc(waitMs, { agent: spec.name, tool });
          },
        })
      : undefined;

  // Tenant context for the engine loop. Single-process `up` is still
  // one-tenant today — fleet-run's #4 + #11 follow-ups land tenant
  // routing via envelope `tenantId`; up-cli doesn't consume envelopes,
  // so every engine turn inherits the default tenant. Threading this
  // explicitly (rather than relying on `undefined` → default coercion
  // inside the engine) keeps the rate-limit gate's audit records and
  // quota tracking keyed on a stable `tenantId` so downstream SIEM
  // queries can filter by tenant in both topologies.
  //
  // @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #16 (fleet-run wired in
  //                round-5 via `auditSink` plumbing; up-cli mirrors
  //                the pattern here so single-process deployments
  //                emit the same tenant-keyed records).
  const tenant = DEFAULT_TENANT_CONTEXT;

  const engine = createEngine({
    provider,
    tools: [
      ...buildRuntimeTools({
        ...(mcpTools !== undefined && { mcpTools }),
        ...(extraTools.length > 0 && { extra: extraTools }),
      }),
    ],
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    hookRegistry,
    createChildSession: () => runtime.sessionStore.create(spec),
    tenant,
    ...(toolRateLimit !== undefined && { toolRateLimit }),
  });

  // Per-skill circuit breakers (Slice 3 / PR 3.1). A skill that throws
  // N consecutive times trips to `open`, short-circuiting dispatch for
  // the cool-down window. Lazy — breakers are created the first time a
  // target routes, so skills that are never invoked don't allocate.
  //
  // Defaults (failureThreshold: 10, resetTimeoutMs: 30s) are generous
  // enough to absorb typical LLM retry storms without false-positive
  // trips. Operators can tune via `agent.yaml#reliability.circuitBreaker`
  // once that schema lands (PR 3.1 ships the wiring with defaults only).
  const breakers = new Map<string, CircuitBreaker>();
  const getBreaker = (targetName: string): CircuitBreaker => {
    const existing = breakers.get(targetName);
    if (existing) return existing;
    const breaker = new CircuitBreaker({ failureThreshold: 10, resetTimeoutMs: 30_000 });
    const agentId = spec.name;
    breaker.onTransition((ev: CircuitBreakerTransitionEvent) => {
      runtime.metrics
        .counter(
          'declaragent.dispatcher.breaker.transitions',
          'Dispatcher target circuit-breaker transitions',
        )
        .inc(1, { agent: agentId, target: targetName, from: ev.from, to: ev.to });
      runtime.metrics
        .gauge(
          'declaragent.dispatcher.breaker.state',
          'Current breaker state (0=closed, 1=half-open, 2=open)',
        )
        .set(stateToNumeric(ev.to), { agent: agentId, target: targetName });
      logger.write({
        level: ev.to === 'open' ? 'warn' : 'info',
        event: 'dispatcher.breaker-transition',
        target: targetName,
        from: ev.from,
        to: ev.to,
      });
    });
    breakers.set(targetName, breaker);
    return breaker;
  };

  const dispatcher: EventDispatcher = createEventDispatcher({
    registry,
    runAgent: engine.runAgent,
    logger: coreLogger,
    ...(eventStore && { store: eventStore }),
    createSession: () => runtime.sessionStore.create(spec),
    createChildSession: () => runtime.sessionStore.create(spec),
    targetBreaker: getBreaker,
  });

  // Subscribe ourselves + invoke `dispatcher.handle()` explicitly
  // rather than relying on `dispatcher.attach(bus)`. Pre-0.4.14 the
  // attach path silently failed to deliver events to the dispatcher's
  // internal subscriber (outcomes stayed `null` with no log). The
  // explicit-handle variant gives us a visible start/outcome/error
  // life-cycle for every event + keeps the dispatcher fully in play
  // (idempotency, loop detection, target routing, markOutcome).
  const unsub = bus.subscribe('*', async (event) => {
    logger.write({
      level: 'info',
      event: 'dispatcher.handling',
      eventId: event.id,
      kind: event.kind,
      targetType: event.target.type,
      targetName: (event.target as { name?: string }).name,
    });
    try {
      const outcome = await dispatcher.handle(event);
      logger.write({
        level: outcome.kind === 'rejected' ? 'warn' : 'info',
        event: 'dispatcher.outcome',
        eventId: event.id,
        outcome: outcome.kind,
        ...(outcome.kind === 'rejected' && {
          reason: outcome.reason,
          details: outcome.details,
        }),
        ...(outcome.kind === 'dispatched' && { sessionId: outcome.sessionId }),
      });
    } catch (err) {
      logger.write({
        level: 'error',
        event: 'dispatcher.error',
        eventId: event.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.write({
    level: 'info',
    event: 'dispatcher.attached',
    skills: loaded.skills.length,
    skillNames: loaded.skills.map((s) => s.lookupName),
  });
  return { detach: unsub, plugins };
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
    // Close the control socket first so operators sending `shutdown`
    // don't race an already-stopping daemon.
    try {
      r.detachLastEventTracker?.();
    } catch {
      // swallow — best-effort
    }
    try {
      await r.controlSocket?.close();
    } catch {
      // swallow — best-effort shutdown
    }
    try {
      r.detachDispatcher?.();
    } catch {
      // swallow — best-effort
    }
    try {
      await r.plugins?.shutdown();
    } catch {
      // swallow — best-effort shutdown
    }
    try {
      await r.sources.stop();
    } catch {
      // swallow — best-effort shutdown
    }
    try {
      await r.mcp?.shutdown();
    } catch {
      // swallow — best-effort shutdown
    }
    try {
      await r.channels?.shutdown();
    } catch {
      // swallow — best-effort shutdown
    }
    r.logger.close();
  }
}

/**
 * Render the MCP consent Ink UI inline. Dynamic-imports React + Ink so
 * non-TTY code paths (detached, tests) don't pull them in. Returns a
 * resolver the MCP runtime invokes once per un-consented server.
 */
function createInteractiveMCPConsent(): ConsentResolver {
  return async (spec, scope) => {
    const [{ render }, { MCPConsentUI }, React] = await Promise.all([
      import('ink'),
      import('./mcp-consent-ui.js'),
      import('react'),
    ]);
    return new Promise<boolean>((resolveBool) => {
      let decided = false;
      const instance = render(
        React.createElement(MCPConsentUI, {
          spec,
          scope,
          onDecision: (approved: boolean) => {
            decided = true;
            resolveBool(approved);
          },
        }),
      );
      void instance.waitUntilExit().then(() => {
        if (!decided) resolveBool(false);
      });
    });
  };
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

function findRpcPeersConfig(agentDir: string): string | undefined {
  for (const name of ['rpc-peers.yaml', 'rpc-peers.yml', 'rpc-peers.json']) {
    const p = join(agentDir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Resolve the Prometheus exporter port.
 *
 * Priority: `DECLARAGENT_METRICS_PORT` env var (`0` disables) overrides
 * the mode-specific default. In detached mode we default to `9464` (OTel
 * convention) so long-running daemons are scrapable by default. In
 * foreground mode we default to `0` (off) to keep test harnesses and
 * transient `declaragent up` sessions from colliding on the port.
 *
 * @since 0.6.0-slice.1
 */
function resolveMetricsPort(isDetached: boolean): number {
  const raw = process.env.DECLARAGENT_METRICS_PORT;
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535) {
      return parsed;
    }
    // Invalid override → fall through to default; we don't warn here
    // because the caller logs a bind failure if it matters.
  }
  return isDetached ? 9464 : 0;
}

/**
 * Assemble the JSON body served by the control-plane `/status` endpoint.
 *
 * Slice 1 scope: populate identity + source summaries from the already-
 * written {@link UpState}. Channel readiness + live metrics rollups
 * ({@link UpStatusSnapshot.agents}.channels / metrics) are emitted as
 * stubs — the next slice plumbs them once the `RunningAgent` record
 * learns to expose channel/breaker state directly. Consumers MUST
 * tolerate empty channels + zeroed metrics as "not yet instrumented"
 * rather than "none".
 *
 * The `cliVersion` is stamped onto {@link UpState} at boot (see #44 in
 * `docs/POST_ENTERPRISE_BACKLOG.md`) and read from there on every
 * scrape so a rolling upgrade's new version is visible without a
 * restart of the scrape client. The `DECLARAGENT_CLI_VERSION` env is
 * still honoured as a last-resort override for back-compat with state
 * files written by pre-0.7.2 daemons.
 *
 * @since 0.7.0-slice.1
 */
function buildUpStatusSnapshot(state: UpState, running: RunningAgent[]): UpStatusSnapshot {
  const cliVersion = state.cliVersion ?? process.env.DECLARAGENT_CLI_VERSION ?? 'dev';
  const startedAtMs = Date.parse(state.startedAt);
  const nowMs = Date.now();
  const uptimeMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
  return {
    version: 1,
    cliVersion,
    pid: state.pid,
    startedAt: state.startedAt,
    manifestPath: state.manifestPath,
    agents: running.map((r, index) => ({
      id: r.summary.id,
      path: r.summary.path,
      uptimeMs,
      sources: r.summary.sources.map((s) => ({
        type: s.type,
        id: s.id,
        summary: s.summary,
      })),
      channels: [],
      metrics: {
        eventsDispatched: 0,
        eventsRejected: 0,
        breakerOpen: 0,
      },
      // #45 per-agent pid fidelity. Today `up` hosts every agent in one
      // process so `pid` equals `state.pid`; a stable `index` is still
      // useful for correlating with logs. Writing the field explicitly
      // (instead of leaving every agent's top-level pid as the daemon
      // pid) documents the collapsing so operators don't assume per-
      // agent process isolation.
      hostedBy: { pid: state.pid, index },
    })),
  };
}

/**
 * Auto-enable OpenTelemetry tracing when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set. We wrap `createOtelBridge()` — which loads the peer-dep
 * `@opentelemetry/api` at runtime. When the peer dep is missing the
 * bridge throws {@link ObservabilityError}; we catch, warn with a
 * concrete install hint, and return undefined so the runtime falls
 * back to its internal noop tracer.
 *
 * Metrics are NOT routed through the bridge — we keep the dedicated
 * Prometheus registry for pull-based scraping and only use OTel for
 * span export. Operators that want metrics in OTel too can run an
 * OTel collector with a Prometheus scrape receiver (see OTEL_SETUP.md).
 *
 * @since 0.6.0-slice.2
 */
/**
 * Apply the default provider-level rate limiter from Slice 4. Emits
 * wait counters + a histogram through the shared metrics registry so
 * the Prometheus endpoint surfaces the throttle activity. Env var
 * escape hatches:
 *
 *   - `DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE=1` bypasses the wrap
 *     entirely. Useful for load tests + offline backfills.
 *   - `DECLARAGENT_PROVIDER_RATE_LIMIT_RPS=<n>` overrides the preset's
 *     default. Floating-point values accepted.
 *
 * @since 0.6.0-slice.4
 */
function wrapProviderWithRateLimit(opts: {
  provider: LLMProvider;
  providerId: string;
  metrics: PrometheusRegistry;
  io: UpIO;
}): LLMProvider {
  if (process.env.DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE === '1') {
    opts.io.out('  rate-limit: disabled via DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE\n');
    return opts.provider;
  }
  const override = process.env.DECLARAGENT_PROVIDER_RATE_LIMIT_RPS;
  let rate: number;
  if (override !== undefined && override !== '') {
    const parsed = Number.parseFloat(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      rate = parsed;
    } else {
      opts.io.err(
        `⚠ DECLARAGENT_PROVIDER_RATE_LIMIT_RPS="${override}" is not a positive number; using default.\n`,
      );
      rate = defaultRateForProvider(opts.providerId);
    }
  } else {
    rate = defaultRateForProvider(opts.providerId);
  }
  opts.io.out(
    `  rate-limit: ${rate} rps (provider=${opts.providerId}; env DECLARAGENT_PROVIDER_RATE_LIMIT_RPS overrides, DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE=1 opts out)\n`,
  );
  const waitsCounter = opts.metrics.counter(
    'declaragent.provider.rate_limit.waits',
    'Provider rate-limiter wait events',
  );
  const waitMsHistogram = opts.metrics.histogram(
    'declaragent.provider.rate_limit.wait_ms',
    'Provider rate-limiter wait duration in ms',
  );
  return withProviderRateLimit(opts.provider, {
    ratePerSec: rate,
    onWait: (waitMs) => {
      waitsCounter.inc(1, { provider: opts.providerId });
      waitMsHistogram.observe(waitMs, { provider: opts.providerId });
    },
  });
}

/**
 * Map the {@link CircuitBreakerState} to a numeric value so Prometheus
 * gauge panels can render the state as a step chart. Ordering mirrors
 * severity: closed (0) → half-open (1) → open (2) so alert rules can
 * fire on `> 1` without special-casing strings.
 *
 * @since 0.6.0-slice.3
 */
function stateToNumeric(s: 'closed' | 'half-open' | 'open'): number {
  if (s === 'open') return 2;
  if (s === 'half-open') return 1;
  return 0;
}

async function maybeCreateOtelTracer(io: UpIO): Promise<Tracer | undefined> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  try {
    const bridge = await createOtelBridge({
      meterName: '@declaragent/core',
      tracerName: '@declaragent/core',
    });
    return bridge.tracer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(
      `⚠ OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing could not start: ${msg}\n  Install peer deps to enable:\n    npm i @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http\n  Falling back to noop tracer — the up-loop will still work, just without spans.\n`,
    );
    return undefined;
  }
}

function manifestDir(manifestPath: string): string {
  return manifestPath.replace(/\/[^/]*$/, '');
}

/**
 * Render `controlPlane.auth.allowLoopback` for the startup banner. The
 * config now accepts `boolean | { trustedProxies }`
 * (`POST_ENTERPRISE_BACKLOG.md #7`) — print the list inline when the
 * object form is used so operators immediately see which proxies will
 * be honoured.
 */
function describeAllowLoopback(v: LoadedControlPlaneAuth['allowLoopback']): string {
  if (v === undefined) return 'true'; // matches ControlPlaneAuth middleware default
  if (typeof v === 'boolean') return String(v);
  return `trustedProxies=[${v.trustedProxies.join(',')}]`;
}

async function loadFleetAgentDirs(fleetPath: string): Promise<string[]> {
  const root = manifestDir(fleetPath);
  const fleet = await loadFleet({ root });
  return fleet.agents.map((a) => a.path);
}

/**
 * Bridge the per-agent {@link AgentLogger} (JSON-line append) to
 * core's {@link Logger} interface so `startAgentSources` routes its
 * internal warnings into the same file we already tail via
 * `declaragent logs`. Child loggers drop their bindings back into
 * the record payload so filtering by correlationId still works.
 */
function agentLoggerToCoreLogger(agentLogger: AgentLogger): Logger {
  const make =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (event: string, data?: Readonly<Record<string, unknown>>) => {
      agentLogger.write({ level, event, ...(data ?? {}) });
    };
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: () => logger,
  };
  return logger;
}

/** Read the last N lines of a file; returns empty string if absent. */
function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return '(no startup log)';
  const raw = readFileSync(path, 'utf8');
  const arr = raw.split('\n').filter((l) => l.length > 0);
  return arr.slice(-lines).join('\n');
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
}

/**
 * Resolve a {@link LoadedAuditExport} config into a concrete {@link AuditExporter}.
 * Supports the `env:FOO_BAR` prefix on secret fields — operators keep
 * HEC tokens / API keys out of git by writing `token: env:SPLUNK_HEC_TOKEN`
 * in `agent.yaml` and exporting `SPLUNK_HEC_TOKEN` at daemon-boot.
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #10
 */
function buildAuditExporter(cfg: LoadedAuditExport): AuditExporter {
  switch (cfg.kind) {
    case 'splunk':
      return createSplunkExporter({
        hecUrl: resolveSecret(cfg.hecUrl),
        token: resolveSecret(cfg.token),
        ...(cfg.index !== undefined && { index: cfg.index }),
        ...(cfg.source !== undefined && { source: cfg.source }),
        ...(cfg.sourcetype !== undefined && { sourcetype: cfg.sourcetype }),
        ...(cfg.host !== undefined && { host: cfg.host }),
        ...(cfg.name !== undefined && { name: cfg.name }),
      });
    case 'elastic': {
      const auth =
        cfg.auth.kind === 'apiKey'
          ? ({ kind: 'apiKey' as const, apiKey: resolveSecret(cfg.auth.apiKey) } as const)
          : cfg.auth.kind === 'bearer'
            ? ({ kind: 'bearer' as const, token: resolveSecret(cfg.auth.token) } as const)
            : ({
                kind: 'basic' as const,
                username: resolveSecret(cfg.auth.username),
                password: resolveSecret(cfg.auth.password),
              } as const);
      return createElasticExporter({
        baseUrl: cfg.baseUrl,
        auth,
        ...(cfg.index !== undefined && { index: cfg.index }),
        ...(cfg.name !== undefined && { name: cfg.name }),
      });
    }
    case 'datadog':
      return createDatadogExporter({
        apiKey: resolveSecret(cfg.apiKey),
        ...(cfg.site !== undefined && { site: cfg.site }),
        ...(cfg.intakeUrl !== undefined && { intakeUrl: cfg.intakeUrl }),
        ...(cfg.service !== undefined && { service: cfg.service }),
        ...(cfg.source !== undefined && { source: cfg.source }),
        ...(cfg.hostname !== undefined && { hostname: cfg.hostname }),
        ...(cfg.tags !== undefined && { tags: cfg.tags }),
        ...(cfg.name !== undefined && { name: cfg.name }),
      });
  }
}

/**
 * Resolve an `env:FOO` reference to the current `process.env` value, or
 * pass through a literal string. Empty env vars throw — a silently-empty
 * token would look like a misconfigured exporter at runtime and waste a
 * pause cycle.
 */
function resolveSecret(raw: string): string {
  if (!raw.startsWith('env:')) return raw;
  const key = raw.slice(4);
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(
      `audit.export: ${key} is not set in the environment — set it before \`declaragent up\` or inline the secret in agent.yaml`,
    );
  }
  return value;
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
