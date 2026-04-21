/**
 * `declaragent fleet run` — single-process dev loop hosting N agents.
 *
 * Boots one daemon per agent sharing a single in-memory RPC bus, so
 * inter-agent RPC round-trips in one process. Each agent's
 * `capabilities.yaml` → `memory` transport is wired to the shared bus;
 * capability requests reach a caller-supplied handler which publishes
 * the response back over `envelope.replyTo`.
 *
 * Phase A.2 of USABILITY_PLAN.md (0.3.6) wired the real engine behind
 * the default `makeHandler` — see `fleet-run-llm-handler.ts`. Tests
 * that want a deterministic no-LLM path inject `deps.makeHandler =
 * () => defaultHandler`, which still echoes the envelope payload.
 *
 * Hot-reload, file-watch, and per-agent sources from `event-sources.yaml`
 * remain tracked for a follow-up (Phase A.3).
 *
 * @since 1.2.0
 */

import type {
  AgentRpcEnvelope,
  CapabilityTransport,
  LoadedAgentEntry,
  LoadedFleet,
  RpcError,
  RpcRespondResult,
} from '@declaragent/core';
import {
  FleetConfigError,
  FleetManifestError,
  RPC_ERROR_CODES,
  checkFleetVersionSkew,
  createSqliteSessionStore,
  findFleetRoot,
  loadFleet,
  readFleetVersionFromEnv,
  readFleetVersionHeader,
} from '@declaragent/core';
import {
  type MemoryBus,
  type MemoryTransport,
  createMemoryBus,
  createMemoryTransport,
  createRespondHook,
} from '@declaragent/plugin-agent-rpc';
import {
  type ResolvedCredentials,
  resolveCredentials as defaultResolveCredentials,
  loadConfig,
} from './auth.js';
import { createLLMHandlerFactory } from './fleet-run-llm-handler.js';
import { sessionsDbPath } from './paths.js';
import { createProviderFromCreds } from './provider-factory.js';
import { getPreset } from './providers-registry.js';

export interface FleetRunIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetRunIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

// ── Public surface ─────────────────────────────────────────────────────

export interface FleetAgentRequestContext {
  readonly agentId: string;
  readonly capability: string;
  readonly envelope: AgentRpcEnvelope;
  /**
   * Reply helper — wraps {@link createRespondHook}. Writes a response
   * envelope back to `envelope.replyTo` (a no-op when the caller used
   * fire-and-forget).
   */
  respond(result: RpcRespondResult): Promise<void>;
}

export type FleetAgentHandler = (ctx: FleetAgentRequestContext) => Promise<void>;

export interface FleetAgentWorkerMetrics {
  received: number;
  responded: number;
  errored: number;
  /**
   * Requests rejected with `EVERSION_SKEW` because the caller's
   * `x-fleet-version` header was older than `minFleetVersion` (§14.8).
   */
  versionRejected: number;
  /**
   * Requests accepted after detecting a newer-than-self caller. A
   * sustained count here should alert operators that a newer fleet
   * version is calling pinned-old receivers.
   */
  versionSkewNewer: number;
  lastMessageAt: number | null;
}

export interface FleetAgentWorker {
  readonly id: string;
  readonly capabilities: readonly string[];
  /** Topics this worker is subscribed to on the shared memory bus. */
  readonly topics: readonly string[];
  metrics(): FleetAgentWorkerMetrics;
  stop(): Promise<void>;
}

export interface FleetDaemon {
  readonly agents: ReadonlyMap<string, FleetAgentWorker>;
  readonly bus: MemoryBus;
  shutdown(): Promise<void>;
  waitForShutdown(): Promise<void>;
}

export interface StartFleetDaemonOptions {
  fleet: LoadedFleet;
  /**
   * Shared in-memory bus. Supply your own when stitching multiple
   * fleets into a single test; omit to let the daemon create one.
   */
  bus?: MemoryBus;
  /**
   * Factory that returns the request handler for each agent. May be
   * async so implementations can do per-agent disk reads (load skills,
   * build extension registries) before returning the handler.
   *
   * Defaults to {@link defaultHandler} — a stub that responds
   * `{ ok: true, data: { echoed: envelope.payload } }`. Production
   * callers plug the engine loop here; tests override with narrower
   * stubs.
   */
  makeHandler?(agent: LoadedAgentEntry): FleetAgentHandler | Promise<FleetAgentHandler>;
  /**
   * Override this daemon's own `DECLARAGENT_FLEET_VERSION`. Production
   * callers let it default to `readFleetVersionFromEnv(process.env)`;
   * tests inject an explicit value so they don't depend on ambient env.
   * @since 1.2.0
   */
  selfFleetVersion?: string;
  io?: FleetRunIO;
}

/**
 * Boot a fleet in the current process.
 *
 * Returns once every agent's subscriptions are live. Failures stop
 * every partially-started worker before throwing so the caller doesn't
 * need to clean up in error paths.
 */
export async function startFleetDaemon(options: StartFleetDaemonOptions): Promise<FleetDaemon> {
  const bus = options.bus ?? createMemoryBus();
  const io = options.io ?? STDIO_IO;
  const makeHandler = options.makeHandler ?? (() => defaultHandler);
  const selfFleetVersion = options.selfFleetVersion ?? readFleetVersionFromEnv();
  const minFleetVersion = options.fleet.manifest.rpc?.minFleetVersion;

  const agents = new Map<string, FleetAgentWorker>();

  let shutdownPromise: Promise<void> | null = null;
  let resolveShutdownDone: () => void = () => {};
  const shutdownDone = new Promise<void>((resolve) => {
    resolveShutdownDone = resolve;
  });

  async function shutdownAll(): Promise<void> {
    for (const worker of agents.values()) {
      try {
        await worker.stop();
      } catch (err) {
        io.err(
          `warning: agent "${worker.id}" failed to stop cleanly: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
    agents.clear();
    // Only close the bus if we own it — callers who passed their own
    // keep control of its lifecycle.
    if (!options.bus) bus.close();
    resolveShutdownDone();
  }

  try {
    for (const agent of options.fleet.agents) {
      const worker = startAgentWorker({
        agent,
        bus,
        handler: await makeHandler(agent),
        logger: io,
        ...(selfFleetVersion !== undefined && { selfFleetVersion }),
        ...(minFleetVersion !== undefined && { minFleetVersion }),
      });
      agents.set(agent.id, worker);
    }
  } catch (err) {
    // Partial boot: stop whatever we started.
    for (const w of agents.values()) await w.stop().catch(() => {});
    agents.clear();
    if (!options.bus) bus.close();
    throw err;
  }

  return {
    agents,
    bus,
    async shutdown(): Promise<void> {
      if (!shutdownPromise) shutdownPromise = shutdownAll();
      await shutdownPromise;
    },
    async waitForShutdown(): Promise<void> {
      await shutdownDone;
    },
  };
}

// ── Per-agent worker ───────────────────────────────────────────────────

interface StartAgentWorkerOptions {
  agent: LoadedAgentEntry;
  bus: MemoryBus;
  handler: FleetAgentHandler;
  /** Optional logger for version-skew warnings + audit lines. */
  logger?: FleetRunIO;
  /** This receiver's own fleet version (from `DECLARAGENT_FLEET_VERSION`). */
  selfFleetVersion?: string;
  /** Receiver-side floor from `fleet.yaml → rpc.minFleetVersion`. */
  minFleetVersion?: string;
}

function startAgentWorker(opts: StartAgentWorkerOptions): FleetAgentWorker {
  const { agent, bus, handler } = opts;
  const transport: MemoryTransport = createMemoryTransport({ bus });

  const capabilities: string[] = [];
  const topics: string[] = [];
  const detachers: Array<() => void> = [];
  const metricsRef: FleetAgentWorkerMetrics = {
    received: 0,
    responded: 0,
    errored: 0,
    versionRejected: 0,
    versionSkewNewer: 0,
    lastMessageAt: null,
  };

  if (agent.capabilities) {
    for (const cap of agent.capabilities.config.capabilities) {
      capabilities.push(cap.name);
    }
    // One subscription per memory transport that carries a requests topic.
    // Non-memory transports (kafka, nats, etc.) are ignored in slice 3 —
    // the dev loop is memory-only. A warning would clutter tests, so we
    // stay silent.
    for (const t of agent.capabilities.config.transports) {
      const memoryTopic = memoryRequestsTopic(t);
      if (memoryTopic === undefined) continue;
      topics.push(memoryTopic);
      detachers.push(
        transport.subscribe(memoryTopic, async (envelope) => {
          await onRequest(envelope);
        }),
      );
    }
  }

  async function onRequest(envelope: AgentRpcEnvelope): Promise<void> {
    metricsRef.received += 1;
    metricsRef.lastMessageAt = Date.now();
    if (envelope.kind !== 'request') return; // ignore responses/events on requests topic

    const respond = createRespondHook({
      request: envelope,
      transport,
      selfAgent: `agent://${agent.id}`,
    });

    // Fleet-version skew gate (§8.3 / §14.8). Opt-in on both sides:
    // caller stamps `x-fleet-version`, receiver configures `minFleetVersion`.
    const skew = checkFleetVersionSkew({
      callerVersion: readFleetVersionHeader(envelope),
      selfVersion: opts.selfFleetVersion,
      ...(opts.minFleetVersion !== undefined && { minFleetVersion: opts.minFleetVersion }),
    });
    if (skew.status === 'rejected') {
      metricsRef.versionRejected += 1;
      const error: RpcError = {
        code: RPC_ERROR_CODES.VERSION_SKEW,
        message: skew.message ?? 'caller fleet version below minFleetVersion',
      };
      opts.logger?.err(
        `fleet.version.skew.reject agent=${agent.id} correlationId=${envelope.correlationId} ${error.message}\n`,
      );
      try {
        await respond({ ok: false, error });
      } catch {
        // ignore reply failures — caller will time out if transport is dead
      }
      return;
    }
    if (skew.status === 'newer-caller') {
      metricsRef.versionSkewNewer += 1;
      opts.logger?.err(
        `fleet.version.skew agent=${agent.id} caller=${skew.caller?.raw} self=${skew.self?.raw}\n`,
      );
      // Fall through — we still process the request.
    }

    try {
      await handler({
        agentId: agent.id,
        capability: envelope.capability,
        envelope,
        respond: async (result) => {
          await respond(result);
          if (result.ok) metricsRef.responded += 1;
          else metricsRef.errored += 1;
        },
      });
    } catch (err) {
      metricsRef.errored += 1;
      const error: RpcError = {
        code: 'HANDLER_ERROR',
        message: err instanceof Error ? err.message : String(err),
      };
      // Best-effort failure response so a sync caller's timeout doesn't
      // spin; ignore reply failures.
      try {
        await respond({ ok: false, error });
      } catch {
        // ignore
      }
    }
  }

  return {
    id: agent.id,
    capabilities,
    topics,
    metrics: () => ({ ...metricsRef }),
    async stop(): Promise<void> {
      for (const d of detachers.splice(0)) d();
      await transport.close();
    },
  };
}

function memoryRequestsTopic(t: CapabilityTransport): string | undefined {
  if (t.kind !== 'memory') return undefined;
  return t.topics.requests;
}

// ── Default / echo handler ─────────────────────────────────────────────

/**
 * Echo handler preserved as a named export for tests that want a
 * deterministic, no-LLM handler. Phase A.2 of USABILITY_PLAN.md moved
 * the production `fleet run` path to a real engine turn (see
 * {@link createLLMHandlerFactory} in `fleet-run-llm-handler.ts`), but
 * every existing multi-agent wiring test in `fleet-run.test.ts` relies
 * on the echo shape, and it's still the right default for
 * `startFleetDaemon` callers that don't supply `makeHandler`.
 */
export const defaultHandler: FleetAgentHandler = async (ctx) => {
  await ctx.respond({
    ok: true,
    data: {
      agent: ctx.agentId,
      capability: ctx.capability,
      echoed: ctx.envelope.payload,
    },
  });
};

// ── CLI verb ───────────────────────────────────────────────────────────

export interface FleetRunArgs {
  agents?: readonly string[];
}

export interface FleetRunDeps {
  io?: FleetRunIO;
  cwd?: string;
  root?: string;
  /** Block forever by default; tests pass a short window. */
  runForeverMs?: number;
  /** Inject a stop signal for tests that want the verb to return cleanly. */
  onStart?(daemon: FleetDaemon): Promise<void> | void;
  makeHandler?: StartFleetDaemonOptions['makeHandler'];
  /**
   * Credential resolver — production uses `resolveCredentials()` from
   * `auth.ts`, which reads `~/.declaragent/config.json` + env vars.
   * Tests inject a stub so the CLI path is deterministic across
   * machines (and CI boxes that have no creds configured).
   */
  resolveCredentials?: () => ResolvedCredentials | null;
}

export async function fleetRun(args: FleetRunArgs = {}, deps: FleetRunDeps = {}): Promise<number> {
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
    fleet = await loadFleet({ root });
  } catch (err) {
    if (err instanceof FleetConfigError || err instanceof FleetManifestError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // Narrow to selected agents if --agent flags were passed.
  const selected = args.agents?.length
    ? fleet.agents.filter((a) => args.agents?.includes(a.id))
    : fleet.agents;
  if (selected.length === 0) {
    io.err(
      args.agents?.length
        ? `✗ none of --agent ${args.agents.join(',')} match the fleet's declared agents.\n`
        : '✗ fleet has no agents. Run `declaragent fleet add --template <name>` first.\n',
    );
    return 1;
  }

  const filteredFleet: LoadedFleet = {
    ...fleet,
    agents: selected,
    agentsById: new Map(selected.map((a) => [a.id, a])),
  };

  // Resolve the handler factory. Tests inject `deps.makeHandler` — in
  // production we stand up the LLM engine per agent. Missing auth is a
  // hard error: the daemon would otherwise crash mid-request.
  let makeHandler = deps.makeHandler;
  let sessionStore: ReturnType<typeof createSqliteSessionStore> | null = null;
  if (makeHandler === undefined) {
    const resolveCreds = deps.resolveCredentials ?? defaultResolveCredentials;
    const creds = resolveCreds();
    if (!creds) {
      io.err(
        '✗ no provider credentials found. Run `declaragent` and sign in with /auth, or set a provider env var (e.g. ANTHROPIC_API_KEY, OPENROUTER_API_KEY) before `declaragent fleet run`.\n',
      );
      return 1;
    }
    const provider = createProviderFromCreds({ creds });
    sessionStore = createSqliteSessionStore({ path: sessionsDbPath() });
    const defaultModel = resolveDefaultModel(creds.providerId);
    makeHandler = createLLMHandlerFactory({
      provider,
      sessionStore,
      defaultModel,
    });
  }

  const daemon = await startFleetDaemon({
    fleet: filteredFleet,
    ...(makeHandler !== undefined && { makeHandler }),
    io,
  });

  // Close the session DB handle together with the daemon so subsequent
  // invocations don't hit WAL lock contention (sqlite keeps the handle
  // open for the process lifetime otherwise).
  const shutdownDaemon = async (): Promise<void> => {
    await daemon.shutdown();
    sessionStore?.close();
  };

  io.out(`fleet: ${fleet.manifest.name}\n`);
  io.out(`running ${selected.length} agent${selected.length === 1 ? '' : 's'}:\n`);
  for (const agent of selected) {
    const worker = daemon.agents.get(agent.id);
    const caps = worker?.capabilities.length ?? 0;
    const topics = worker?.topics.length ?? 0;
    io.out(
      `  • ${agent.id}  capabilities=${caps} topics=${topics}${
        topics === 0 ? ' (client-only)' : ''
      }\n`,
    );
  }
  io.out('ready. press ctrl-c to stop.\n');

  // Hook lifecycle. Tests override runForeverMs; production blocks on
  // SIGINT/SIGTERM via process signal handlers.
  if (deps.onStart) {
    await deps.onStart(daemon);
    await shutdownDaemon();
    return 0;
  }

  if (deps.runForeverMs !== undefined) {
    await new Promise((r) => setTimeout(r, deps.runForeverMs));
    await shutdownDaemon();
    return 0;
  }

  const stop = async (): Promise<void> => {
    io.out('\nshutting down…\n');
    await shutdownDaemon();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  await daemon.waitForShutdown();
  sessionStore?.close();
  return 0;
}

/**
 * Pick the model agents fall back to when `agent.yaml` omits `model`.
 *
 * Precedence:
 *   1. last-remembered model stored on the active provider
 *   2. provider preset's `defaultModel`
 *   3. hard-coded `claude-sonnet-4-5` so the daemon never falls back
 *      to an unrunnable string
 */
function resolveDefaultModel(providerId: string): string {
  const cfg = loadConfig();
  const stored = cfg?.providers?.[providerId]?.model;
  if (stored) return stored;
  const preset = getPreset(providerId);
  if (preset?.defaultModel) return preset.defaultModel;
  return 'claude-sonnet-4-5';
}
