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
  CircuitBreaker,
  type CircuitBreakerTransitionEvent,
  type EventDispatcher,
  type LLMProvider,
  type LoadedAgent,
  type Logger,
  type PrometheusHandle,
  type PrometheusRegistry,
  type Tracer,
  createEngine,
  createEventDispatcher,
  createExtensionRegistry,
  createHookRegistry,
  createOtelBridge,
  createPermissionGate,
  createPrometheusRegistry,
  createSendMessageTool,
  createSqliteSessionStore,
  defaultRateForProvider,
  loadAgent,
  loadFleet,
  skillExtension,
  startPrometheusExporter,
  withProviderRateLimit,
} from '@declaragent/core';
import { resolveCredentials } from './auth.js';
import { buildRuntimeTools } from './builtin-tools.js';
import { type ChannelRuntime, startChannelRuntime } from './channels-runtime.js';
import {
  type ConsentResolver,
  type MCPRuntime,
  loadScopedMCPServers,
  startMCPServers,
} from './mcp-runtime.js';
import { sessionsDbPath } from './paths.js';
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
  upStartupLogPath,
  waitForUpState,
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
  const runtime: UpRuntime = {
    sessionStore: createSqliteSessionStore({ path: sessionsDbPath() }),
    provider,
    defaultModel: 'claude-sonnet-4-5',
    metrics,
    ...(tracer !== undefined && { tracer }),
    ...(interactive && { mcpConsent: createInteractiveMCPConsent() }),
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

  // Prometheus `/metrics` exporter. Shares `runtime.metrics` with every
  // agent's sources + channels so source/channel counters are scrapable
  // from a single endpoint. Defaults: on in detached mode (port 9464),
  // off in foreground mode unless `DECLARAGENT_METRICS_PORT` is set.
  // Set `DECLARAGENT_METRICS_PORT=0` to disable in detached mode too.
  // @since 0.6.0-slice.1
  const metricsPort = resolveMetricsPort(_args.__detached === true);
  let metricsHandle: PrometheusHandle | null = null;
  if (metricsPort > 0) {
    try {
      metricsHandle = await startPrometheusExporter({
        registry: runtime.metrics,
        port: metricsPort,
        hostname: '127.0.0.1',
      });
      io.out(`  metrics: http://127.0.0.1:${metricsHandle.port}/metrics\n`);
    } catch (err) {
      io.err(
        `⚠ metrics exporter failed to bind on :${metricsPort} — ${err instanceof Error ? err.message : String(err)}. Continuing without /metrics.\n`,
      );
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
      if (metricsHandle) {
        try {
          await metricsHandle.close();
        } catch {
          // best-effort — never block shutdown on a stuck listener
        }
      }
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

  return {
    summary: { id: agentId, path: agentDir, sources: summary },
    sources,
    logger,
    mcp,
    ...(channelsRuntime && { channels: channelsRuntime }),
    ...(plugins && { plugins }),
    ...(detachDispatcher !== undefined && { detachDispatcher }),
  };
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
