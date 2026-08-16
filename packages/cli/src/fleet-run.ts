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

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentAddress,
  AgentRpcEnvelope,
  AuthCheckAuditRecord,
  CapabilitySchemaViolationAuditRecord,
  CapabilityTransport,
  CapabilityValidatorRegistry,
  EventStore,
  LoadedAgentEntry,
  LoadedCapabilities,
  LoadedFleet,
  LoadedPeers,
  RpcAuth,
  RpcError,
  RpcRespondResult,
  RpcTransport,
  RpcTransportKind,
  TenantAuditSink,
} from '@declaragent/core';
import {
  FleetConfigError,
  FleetManifestError,
  type LoadedAgent,
  RPC_ERROR_CODES,
  checkFleetVersionSkew,
  createCapabilityValidatorRegistry,
  createDefaultSecretResolver,
  createEventStore,
  createSqliteSessionStore,
  findFleetRoot,
  isRpcAuthDefaultFlagOn,
  loadAgent,
  loadFleet,
  loadPeersConfig,
  readFleetVersionFromEnv,
  readFleetVersionHeader,
} from '@declaragent/core';
import {
  type AuthVerifyRegistry,
  type CapabilitySchemaViolationEmitter,
  type MemoryBus,
  brokerAddressKind,
  buildAuthVerifyRegistry,
  buildOutboundSigner,
  createMemoryBus,
  createMemoryTransport,
  createRespondHook,
} from '@declaragent/plugin-agent-rpc';
import { acquireTenantAuditSink, releaseTenantAuditSink } from './audit-sink-singleton.js';
import {
  type ResolvedCredentials,
  resolveCredentials as defaultResolveCredentials,
  loadConfig,
} from './auth.js';
import { createLLMHandlerFactory } from './fleet-run-llm-handler.js';
import { auditDbPath, sessionsDbPath } from './paths.js';
import { createProviderFromCreds } from './provider-factory.js';
import { wrapProviderWithRateLimit } from './provider-rate-limit.js';
import { getPreset } from './providers-registry.js';
import { buildTransportFactories } from './transport-factories.js';
import { evaluateZeroTrustPreview, formatZeroTrustBootReject } from './zero-trust-preview.js';

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
  /**
   * Look up the effective auth-verify registry for an agent. Returns
   * the per-agent override when `authRegistryByAgent` carried an entry
   * for `agentId`, otherwise the fleet-wide `authRegistry`, otherwise
   * `undefined` (legacy pass-through).
   *
   * Exposed for cross-host fan-out consumers (control-plane Slice 3)
   * that need to verify an inbound envelope on behalf of a specific
   * agent without re-deriving the per-agent selection.
   *
   * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #18
   */
  authRegistryFor(agentId: string): AuthVerifyRegistry | undefined;
  shutdown(): Promise<void>;
  waitForShutdown(): Promise<void>;
}

/**
 * Factory for a non-memory RPC transport. Returns a `RpcTransport`
 * implementation bound to the config block from `capabilities.yaml`.
 * The `close()` hook on the returned transport will be invoked when
 * the worker shuts down.
 *
 * @since 0.5.0-slice.5
 */
export type FleetTransportFactory = (
  config: CapabilityTransport,
  deps: { logger?: FleetRunIO },
) => Promise<RpcTransport> | RpcTransport;

/**
 * WS2 — outbound envelope signer hook. Same shape as the `signOutbound`
 * option on `createRequestAgentTool` / `createRespondHook`; typically the
 * `hook` of a `buildOutboundSigner` result, which dispatches per destination.
 *
 * @since 0.7.8 — production-readiness WS2
 */
export type SignOutboundHook = (envelope: AgentRpcEnvelope) => Promise<RpcAuth>;

export interface StartFleetDaemonOptions {
  fleet: LoadedFleet;
  /**
   * Shared in-memory bus. Supply your own when stitching multiple
   * fleets into a single test; omit to let the daemon create one.
   */
  bus?: MemoryBus;
  /**
   * Peer table parsed from `rpc-peers.yaml`. When present, handlers
   * constructed via `makeHandler` can build a `RequestAgent` tool on
   * top of the transport map. Absent → the daemon runs without
   * cross-agent RPC from the caller side.
   *
   * @since 0.5.0-slice.5
   */
  peers?: LoadedPeers;
  /**
   * Per-kind transport factory map. The daemon always ships a `memory`
   * factory; additional kinds (kafka/nats/sqs/amqp/mqtt) are supplied
   * by the caller via this option, typically sourced from installed
   * `@declaragent/plugin-agent-rpc-<kind>` packages. Unknown kinds are
   * skipped with a warning — never fatal.
   *
   * @since 0.5.0-slice.5
   */
  transportFactories?: Partial<Record<RpcTransportKind, FleetTransportFactory>>;
  /**
   * Factory that returns the request handler for each agent. May be
   * async so implementations can do per-agent disk reads (load skills,
   * build extension registries) before returning the handler.
   *
   * Defaults to {@link defaultHandler} — a stub that responds
   * `{ ok: true, data: { echoed: envelope.payload } }`. Production
   * callers plug the engine loop here; tests override with narrower
   * stubs.
   *
   * The agent-specific `rpcContext` is constructed by the daemon and
   * passed through so handlers can build a `RequestAgent` tool with
   * the right per-agent address + shared transport map.
   *
   * @since 0.5.0-slice.5 — signature expanded from `(agent)` to
   *   `(agent, rpcContext)` for RequestAgent-capable handlers.
   */
  makeHandler?(
    agent: LoadedAgentEntry,
    rpcContext: FleetAgentRpcContext,
  ): FleetAgentHandler | Promise<FleetAgentHandler>;
  /**
   * Override this daemon's own `DECLARAGENT_FLEET_VERSION`. Production
   * callers let it default to `readFleetVersionFromEnv(process.env)`;
   * tests inject an explicit value so they don't depend on ambient env.
   * @since 1.2.0
   */
  selfFleetVersion?: string;
  io?: FleetRunIO;

  // ── #4 Inline verify-auth (Enterprise Production Plan §3) ──────────
  /**
   * Per-peer auth-verify providers, keyed by `agent://` address. When
   * present, {@link startAgentWorker} verifies every inbound envelope
   * against the registered provider BEFORE calling the handler. Peers
   * without an entry (or envelopes from unknown peers) fall through to
   * the legacy `internal`/`hmac` path for back-compat.
   *
   * Tests inject a stub registry so the verify gate fires without
   * standing up a real IdP.
   *
   * This is the FLEET-WIDE default. An agent's entry in
   * {@link authRegistryByAgent} (when present) overrides it on a
   * per-agent basis.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #4
   */
  authRegistry?: AuthVerifyRegistry;
  /**
   * Per-agent auth-verify registries, keyed by `agent.id` (matches
   * `fleet.yaml → agents[].id`). When an agent has an entry here,
   * that registry is used instead of the fleet-wide
   * {@link authRegistry} — letting one fleet host agents that trust
   * disjoint peer sets (e.g. agent A trusts tenant-X signer, agent B
   * trusts tenant-Y signer, with NO cross-trust).
   *
   * Back-compat: agents without a per-agent entry fall back to
   * {@link authRegistry}. Passing neither disables verify (legacy
   * `internal`/`hmac` path — unchanged from 0.7.3).
   *
   * Lifetime: the map + each registry value are owned by the caller
   * (typically {@link fleetRun}). The daemon does not close them;
   * production callers release underlying resources alongside the
   * audit sink on `shutdownDaemon`.
   *
   * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #18
   */
  authRegistryByAgent?: ReadonlyMap<string, AuthVerifyRegistry>;
  /**
   * WS2 — fleet-wide outbound envelope signer (the sign-side counterpart of
   * {@link authRegistry}). Threaded into every handler's `RequestAgent` tool
   * (request leg) and every worker's respond hook (response leg), so both
   * directions of a delegation carry a verifiable `auth` block. Built by
   * `fleetRun` via `buildOutboundSigner` from the same `rpc-peers.yaml` the
   * verify registry reads. Absent → legacy `{kind:'internal'}` stamps.
   *
   * @since 0.7.8 — production-readiness WS2 (RELEASE_0_8_0_PLAN.md §B1)
   */
  signOutbound?: SignOutboundHook;
  /**
   * Per-agent outbound signers, keyed by `agent.id`. Same selection rule as
   * {@link authRegistryByAgent}: a per-agent entry wins over the fleet-wide
   * {@link signOutbound}; absent both → legacy stamps for that agent.
   *
   * @since 0.7.8 — production-readiness WS2
   */
  signOutboundByAgent?: ReadonlyMap<string, SignOutboundHook>;
  /**
   * WS2 — fail CLOSED on unregistered senders. When `true`, an envelope whose
   * `from` has no entry in the effective registry is rejected (`unknown-peer`)
   * instead of falling through to the legacy accept path. `fleetRun` sets this
   * when `fleet.yaml`/agent `rpc.auth.enabled: true`. Becomes the default at
   * the 0.8.0 zero-trust cutover. Default false (legacy back-compat).
   *
   * @since 0.7.6 — production-readiness WS2
   */
  strictAuth?: boolean;
  /**
   * Audit sink used for `auth_check` + `capability_schema_violation`
   * records. Shared across every agent in the fleet — one SQLite handle
   * per fleet-run process. Absent when neither feature is in use so
   * unused fleets pay no disk I/O.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Items #4 + #11
   */
  auditSink?: TenantAuditSink;
  /**
   * Sink for auth-rejected envelopes. Receivers wire this to
   * `EventStore.upsertRejection` so rejects land in `rejected_events`
   * under `kind=auth-rejected`. Called once per rejected envelope.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #4
   */
  authRejectSink?: (entry: {
    envelope: AgentRpcEnvelope;
    reason: string;
    message: string;
  }) => Promise<void> | void;

  // ── #11 Typed-capability validation (Enterprise Production Plan §3) ─
  /**
   * Peer capability tables, keyed by `agent://` address. Threaded into
   * `createRequestAgentTool` so outbound calls are validated against
   * the peer's declared `inputSchema`/`outputSchema`. Absent → legacy
   * loose-JSON behaviour (back-compat for pre-v1.1 fleets).
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #11
   */
  peerCapabilities?: ReadonlyMap<AgentAddress, LoadedCapabilities>;
  /**
   * Shared validator cache. Compiled validators live by schema-hash so
   * every agent shares the same cache entries for a given schema.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #11
   */
  validators?: CapabilityValidatorRegistry;
  /**
   * Audit hook fired per failing envelope on either side. Writes a
   * `capability_schema_violation` record to {@link auditSink} in the
   * production path; tests can inject arbitrary callbacks.
   *
   * PR #23 already REJECTS the call pre-wire (status `schema-violation`,
   * returns early before publish); this emitter is audit-only.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #11
   */
  onSchemaViolation?: CapabilitySchemaViolationEmitter;
}

/**
 * Per-agent RPC context constructed by the daemon for the handler
 * factory. Gives a handler everything it needs to wire `RequestAgent`:
 * its own address, the shared transport map, and the peer table.
 *
 * @since 0.5.0-slice.5
 */
export interface FleetAgentRpcContext {
  selfAddress: `agent://${string}`;
  /** Keyed by transport kind; always contains at least `memory`. */
  transports: ReadonlyMap<RpcTransportKind, RpcTransport>;
  /** Absent when `rpc-peers.yaml` was not supplied. */
  peers?: LoadedPeers;
  /**
   * Peer capability tables keyed by `agent://` address. Present when
   * any agent in the fleet declared capabilities with a schema.
   * Handlers thread this into `createRequestAgentTool` so outbound
   * calls are validated pre-publish. See §3 Item #11.
   *
   * @since 0.7.x
   */
  peerCapabilities?: ReadonlyMap<AgentAddress, LoadedCapabilities>;
  /**
   * Shared validator cache. Paired with {@link peerCapabilities}.
   *
   * @since 0.7.x
   */
  validators?: CapabilityValidatorRegistry;
  /**
   * Audit hook forwarded from `startFleetDaemon` options.
   *
   * @since 0.7.x
   */
  onSchemaViolation?: CapabilitySchemaViolationEmitter;
  /**
   * Effective auth-verify registry for THIS agent. Resolved at daemon
   * boot from `authRegistryByAgent.get(agent.id)` when the caller
   * supplied a per-agent map, falling back to the fleet-root
   * {@link StartFleetDaemonOptions.authRegistry}. Exposed on the rpc
   * context so cross-host fan-out consumers (Control Plane Slice 3)
   * can evaluate auth at the fan-out seam with the same verifier a
   * single-process receiver would use.
   *
   * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #18
   */
  authRegistry?: AuthVerifyRegistry;
  /**
   * WS2 — effective outbound signer for THIS agent. Resolved at daemon boot
   * (per-agent entry wins over fleet-wide, mirroring {@link authRegistry}).
   * Handlers thread it into `createRequestAgentTool` so every outbound
   * request carries a verifiable `auth` block; the worker's respond hook uses
   * the same signer for the response leg.
   *
   * @since 0.7.8 — production-readiness WS2
   */
  signOutbound?: SignOutboundHook;
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

  // Build the shared transport map once. Memory is always built-in;
  // other kinds come from `transportFactories`. The memory transport
  // also services the caller side of `RequestAgent` for in-process
  // peer-to-peer round trips.
  const transports = new Map<RpcTransportKind, RpcTransport>();
  const memoryTransport = createMemoryTransport({ bus });
  transports.set('memory', memoryTransport);
  const externalFactories = options.transportFactories ?? {};
  const kindsSeen = new Set<RpcTransportKind>();
  for (const agent of options.fleet.agents) {
    if (!agent.capabilities) continue;
    for (const t of agent.capabilities.config.transports) {
      kindsSeen.add(t.kind);
    }
  }
  for (const kind of kindsSeen) {
    if (kind === 'memory') continue;
    const factory = externalFactories[kind];
    if (factory === undefined) {
      io.err(
        `warning: transport kind "${kind}" is declared in capabilities but no factory is wired. Install @declaragent/plugin-agent-rpc-${kind} or pass transportFactories.${kind} to enable it. Skipping.\n`,
      );
      continue;
    }
    // Factories are called once per kind, with a representative config
    // block (first agent's entry). Factories that need per-agent config
    // can read the shared transport's config internally.
    let sampleConfig: CapabilityTransport | undefined;
    outer: for (const agent of options.fleet.agents) {
      if (!agent.capabilities) continue;
      for (const t of agent.capabilities.config.transports) {
        if (t.kind === kind) {
          sampleConfig = t;
          break outer;
        }
      }
    }
    if (sampleConfig === undefined) continue; // defensive; kindsSeen guarantees one
    try {
      const t = await factory(sampleConfig, { logger: io });
      transports.set(kind, t);
    } catch (err) {
      io.err(
        `warning: transport kind "${kind}" factory failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

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
    // Close external transports explicitly (memory is tied to bus lifecycle).
    for (const [kind, t] of transports) {
      if (kind === 'memory') continue;
      try {
        await t.close();
      } catch (err) {
        io.err(
          `warning: transport "${kind}" failed to close cleanly: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
    // Only close the bus if we own it — callers who passed their own
    // keep control of its lifecycle.
    if (!options.bus) bus.close();
    resolveShutdownDone();
  }

  try {
    for (const agent of options.fleet.agents) {
      // #18 per-agent registry selection. When the caller supplied a
      // per-agent map AND this agent has an entry, use that registry;
      // otherwise fall back to the fleet-wide `authRegistry`. Absent
      // both → worker runs in legacy pass-through mode for this agent.
      const perAgentRegistry = options.authRegistryByAgent?.get(agent.id);
      const effectiveAuthRegistry: AuthVerifyRegistry | undefined =
        perAgentRegistry ?? options.authRegistry;
      // WS2 — same per-agent-wins selection for the outbound signer.
      const effectiveSignOutbound: SignOutboundHook | undefined =
        options.signOutboundByAgent?.get(agent.id) ?? options.signOutbound;

      const rpcContext: FleetAgentRpcContext = {
        selfAddress: `agent://${agent.id}`,
        transports,
        ...(options.peers !== undefined && { peers: options.peers }),
        // #11 typed-capability wiring — threaded into the handler so
        // `createRequestAgentTool` can validate outbound payloads.
        ...(options.peerCapabilities !== undefined && {
          peerCapabilities: options.peerCapabilities,
        }),
        ...(options.validators !== undefined && { validators: options.validators }),
        ...(options.onSchemaViolation !== undefined && {
          onSchemaViolation: options.onSchemaViolation,
        }),
        // #18 expose the effective registry for this agent on the
        // rpc context so cross-host fan-out consumers (control-plane
        // Slice 3) can evaluate auth at the fan-out seam without
        // re-deriving the per-agent selection.
        ...(effectiveAuthRegistry !== undefined && { authRegistry: effectiveAuthRegistry }),
        // WS2 — request-leg signer for this agent's RequestAgent tool.
        ...(effectiveSignOutbound !== undefined && { signOutbound: effectiveSignOutbound }),
      };
      const worker = startAgentWorker({
        agent,
        transports,
        handler: await makeHandler(agent, rpcContext),
        logger: io,
        ...(selfFleetVersion !== undefined && { selfFleetVersion }),
        ...(minFleetVersion !== undefined && { minFleetVersion }),
        // #4 inline verify-auth — now per-agent (#18). Each worker
        // binds to the registry resolved above; sinks remain shared.
        ...(effectiveAuthRegistry !== undefined && { authRegistry: effectiveAuthRegistry }),
        // WS2 — fail closed on unregistered senders only when a registry is in
        // play (strict has no meaning without one) and the operator opted in.
        ...(effectiveAuthRegistry !== undefined &&
          options.strictAuth === true && { strictAuth: true }),
        // WS2 — response-leg signer: replies to a signed request are signed
        // with the same per-agent signer the request leg uses.
        ...(effectiveSignOutbound !== undefined && { signOutbound: effectiveSignOutbound }),
        ...(options.auditSink !== undefined && { auditSink: options.auditSink }),
        ...(options.authRejectSink !== undefined && {
          authRejectSink: options.authRejectSink,
        }),
      });
      agents.set(agent.id, worker);
    }
  } catch (err) {
    // Partial boot: stop whatever we started.
    for (const w of agents.values()) await w.stop().catch(() => {});
    agents.clear();
    if (!options.bus) bus.close();
    // Close external transports; memory transport is closed by bus.close()
    // for bus-owned daemons, so skip it here.
    for (const [kind, t] of transports) {
      if (kind === 'memory') continue;
      try {
        await t.close();
      } catch {
        // best-effort
      }
    }
    throw err;
  }

  // Snapshot the per-agent registry selection at boot so the accessor
  // returns stable answers across the daemon's lifetime — mutation of
  // the caller-supplied map post-boot should NOT retroactively swap
  // what a running worker verifies against.
  const resolvedAuthByAgent = new Map<string, AuthVerifyRegistry>();
  for (const agent of options.fleet.agents) {
    const perAgent = options.authRegistryByAgent?.get(agent.id);
    const effective = perAgent ?? options.authRegistry;
    if (effective !== undefined) resolvedAuthByAgent.set(agent.id, effective);
  }

  return {
    agents,
    bus,
    authRegistryFor(agentId: string): AuthVerifyRegistry | undefined {
      return resolvedAuthByAgent.get(agentId);
    },
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
  transports: ReadonlyMap<RpcTransportKind, RpcTransport>;
  handler: FleetAgentHandler;
  /** Optional logger for version-skew warnings + audit lines. */
  logger?: FleetRunIO;
  /** This receiver's own fleet version (from `DECLARAGENT_FLEET_VERSION`). */
  selfFleetVersion?: string;
  /** Receiver-side floor from `fleet.yaml → rpc.minFleetVersion`. */
  minFleetVersion?: string;
  // ── #4 inline verify-auth ─────────────────────────────────────────
  authRegistry?: AuthVerifyRegistry;
  /**
   * WS2 — fail CLOSED on an unregistered sender. When `true` and an
   * `authRegistry` is present, an envelope whose `from` has no registry entry
   * is rejected (`unknown-peer`) instead of falling through to dispatch. Set
   * by `fleetRun` when `rpc.auth.enabled: true`. Default false (legacy).
   */
  strictAuth?: boolean;
  /**
   * WS2 — response-leg signer. Threaded into `createRespondHook` so replies
   * carry a verifiable `auth` block the original caller's strict verify
   * accepts. Absent → legacy `{kind:'internal'}` responses.
   */
  signOutbound?: SignOutboundHook;
  auditSink?: TenantAuditSink;
  authRejectSink?: (entry: {
    envelope: AgentRpcEnvelope;
    reason: string;
    message: string;
  }) => Promise<void> | void;
}

function startAgentWorker(opts: StartAgentWorkerOptions): FleetAgentWorker {
  const { agent, transports, handler } = opts;

  const capabilities: string[] = [];
  const topics: string[] = [];
  const detachers: Array<() => void> = [];
  // Memory is the always-present fallback transport. The ACTUAL respond
  // transport is chosen per-envelope from the inbound `replyTo` scheme (see
  // `selectRespondTransport`) so a request that arrived over Kafka/NATS/… is
  // answered on that same broker — the WS4 fix for the memory-pinned respond
  // path that made every cross-host sync round-trip time out.
  const maybeRespond = transports.get('memory');
  if (maybeRespond === undefined) {
    throw new Error('fleet-run requires a memory transport to be wired (internal invariant)');
  }
  const respondFallback: RpcTransport = maybeRespond;
  const selectRespondTransport = (envelope: AgentRpcEnvelope): RpcTransport => {
    const kind = envelope.replyTo ? brokerAddressKind(envelope.replyTo) : undefined;
    if (kind !== undefined) {
      const t = transports.get(kind);
      if (t !== undefined) return t;
    }
    return respondFallback;
  };
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
    // Subscribe each declared transport to its requests topic. Unknown
    // kinds are skipped silently — the daemon already warned in
    // `startFleetDaemon` when the transport was first seen.
    for (const t of agent.capabilities.config.transports) {
      const topic = requestsTopicFor(t);
      if (topic === undefined) continue;
      const transport = transports.get(t.kind);
      if (transport === undefined) continue;
      topics.push(topic);
      detachers.push(
        transport.subscribe(topic, async (envelope) => {
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
      transport: selectRespondTransport(envelope),
      selfAgent: `agent://${agent.id}`,
      // WS2 — sign the response leg with this agent's signer.
      ...(opts.signOutbound !== undefined && { signOutbound: opts.signOutbound }),
    });

    // ── #4 Inline verify-auth (Enterprise Production Plan §3) ──────
    // Pragmatic equivalent of `createAgentInboxAdapter`'s verify path:
    // when an `AuthVerifyRegistry` is wired AND the envelope's peer has
    // a registered provider, verify the auth block before handing off
    // to the handler. Peers without a registered provider fall through
    // to the legacy `internal`/`hmac` path — no change for fleets that
    // haven't opted in to `rpc.auth.enabled: true`.
    if (opts.authRegistry !== undefined) {
      const entry = opts.authRegistry.resolve(envelope.from);
      if (entry !== undefined) {
        const { config, provider } = entry;
        try {
          const result = await provider.verify(
            envelope,
            config as unknown as Parameters<typeof provider.verify>[1],
          );
          if (!result.ok) {
            await writeAuthCheck(
              opts,
              envelope,
              agent.id,
              'reject',
              provider.name,
              undefined,
              result.reason,
            );
            if (opts.authRejectSink !== undefined) {
              try {
                await opts.authRejectSink({
                  envelope,
                  reason: 'auth-rejected',
                  message: result.message,
                });
              } catch (err) {
                opts.logger?.err(
                  `fleet.auth.reject-sink-error agent=${agent.id} ${
                    err instanceof Error ? err.message : String(err)
                  }\n`,
                );
              }
            }
            // Short-circuit: never dispatch to handler, but still emit
            // a best-effort failure response so sync callers don't spin.
            const error: RpcError = {
              code: RPC_ERROR_CODES.AUTH_REJECTED,
              message: result.message,
            };
            try {
              await respond({ ok: false, error });
            } catch {
              // ignore — caller will time out if transport is dead
            }
            return;
          }
          await writeAuthCheck(
            opts,
            envelope,
            agent.id,
            'accept',
            provider.name,
            result.principal.subject,
            undefined,
          );
          // Intentionally do NOT mutate envelope — the `principal` is
          // available for future context threading; today the handler
          // only needs capability + payload, both already on envelope.
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await writeAuthCheck(
            opts,
            envelope,
            agent.id,
            'reject',
            provider.name,
            undefined,
            'idp-unreachable',
          );
          if (opts.authRejectSink !== undefined) {
            try {
              await opts.authRejectSink({ envelope, reason: 'auth-rejected', message });
            } catch {
              // already logged on the upstream sink path
            }
          }
          const error: RpcError = {
            code: RPC_ERROR_CODES.AUTH_REJECTED,
            message,
          };
          try {
            await respond({ ok: false, error });
          } catch {
            // ignore
          }
          return;
        }
      } else if (opts.strictAuth) {
        // WS2 — fail closed: the sender has no registry entry, so it cannot be
        // verified. Reject rather than fall through to dispatch (closes the
        // `from: agent://not-in-registry` spoof).
        await writeAuthCheck(opts, envelope, agent.id, 'reject', 'none', undefined, 'unknown-peer');
        if (opts.authRejectSink !== undefined) {
          try {
            await opts.authRejectSink({
              envelope,
              reason: 'auth-rejected',
              message: `sender ${envelope.from} is not in the auth registry (strict mode)`,
            });
          } catch (err) {
            opts.logger?.err(
              `fleet.auth.reject-sink-error agent=${agent.id} ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
        }
        const error: RpcError = {
          code: RPC_ERROR_CODES.AUTH_REJECTED,
          message: `unknown peer ${envelope.from}`,
        };
        try {
          await respond({ ok: false, error });
        } catch {
          // ignore — caller times out if transport is dead
        }
        return;
      }
    }

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
      // Transports are shared across workers — they're closed once at
      // daemon shutdown, not per-worker.
    },
  };
}

/**
 * Emit an `auth_check` audit record for an inbound envelope. Best-effort:
 * sink failures log once + continue so audit I/O never blocks the
 * critical path.
 *
 * @since 0.7.x — Enterprise Production Plan §3 Item #4
 */
async function writeAuthCheck(
  opts: StartAgentWorkerOptions,
  envelope: AgentRpcEnvelope,
  agentId: string,
  decision: 'accept' | 'reject',
  providerName: AuthCheckAuditRecord['provider'],
  subject: string | undefined,
  reason: string | undefined,
): Promise<void> {
  if (opts.auditSink === undefined) return;
  const record: AuthCheckAuditRecord = {
    kind: 'auth_check',
    ts: Date.now(),
    tenantId: envelope.tenantId ?? 'default',
    peerId: envelope.from,
    provider: providerName,
    decision,
    correlationId: envelope.correlationId,
  };
  if (reason !== undefined) record.reason = reason;
  if (subject !== undefined && subject.length > 0) record.subject = subject;
  try {
    await opts.auditSink.record(record);
  } catch (err) {
    opts.logger?.err(
      `fleet.auth.audit-sink-error agent=${agentId} ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

/**
 * Requests-topic accessor for every supported transport kind. Returns
 * the topic name a worker should subscribe its onRequest handler to.
 * Returns undefined for kinds whose config block doesn't carry an
 * explicit requests topic — the loader fills these in per kind so the
 * null case is rare.
 */
function requestsTopicFor(t: CapabilityTransport): string | undefined {
  switch (t.kind) {
    case 'memory':
      return t.topics.requests;
    case 'kafka':
      return t.topics.requests;
    case 'nats':
      return t.subjects.requests;
    case 'sqs':
      return t.queues.requests;
    case 'amqp':
      return t.queues.requests;
    case 'mqtt':
      return t.topics.requests;
    default: {
      const _exhausted: never = t;
      void _exhausted;
      return undefined;
    }
  }
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

  const loadAgentMemoized = createMemoizedLoadAgent();

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
    // Same token-bucket policy as `up` (docs-truth Wave 1: the docs'
    // "token bucket wraps every provider" claim previously held for
    // `up` only — fleet-run built a bare provider).
    const provider = wrapProviderWithRateLimit({
      provider: createProviderFromCreds({ creds }),
      providerId: creds.providerId,
      io,
    });
    sessionStore = createSqliteSessionStore({ path: sessionsDbPath() });
    const defaultModel = resolveDefaultModel(creds.providerId);
    makeHandler = createLLMHandlerFactory({
      provider,
      sessionStore,
      defaultModel,
      loadAgentFn: loadAgentMemoized,
    });
  }

  // Load `rpc-peers.yaml` from the fleet root if present. Its absence
  // is silently fine — fleets without cross-agent RPC never need it;
  // the `RequestAgent` tool just won't be wired into handlers.
  const peersPath = join(root, 'rpc-peers.yaml');
  let peers: LoadedPeers | undefined;
  if (existsSync(peersPath)) {
    try {
      peers = await loadPeersConfig(peersPath);
      io.out(`  rpc-peers: ${peers.config.peers.length} peer(s) loaded from ${peersPath}\n`);
    } catch (err) {
      io.err(
        `warning: could not load rpc-peers.yaml — ${err instanceof Error ? err.message : String(err)}. RequestAgent will be disabled.\n`,
      );
    }
  }

  // ── #4 + #11 fleet-wide runtime wiring ────────────────────────────
  // Mirrors the `up-cli.ts` pattern: open ONE audit sink per fleet-run
  // process when either `rpc.auth.enabled` opts in OR any loaded
  // capability declares a schema. Absent both — we skip the SQLite
  // handle entirely so legacy fleets pay zero disk I/O.
  //
  // Why a separate sink from `up` even though the DB path is the same:
  // `fleet run` and `up` are independent entry points that never
  // co-exist in a single process. A future refactor can unify both
  // under a shared platform struct — tracked in §"open decisions".
  // ── 0.8.0 zero-trust preview gate (POST_ENTERPRISE_BACKLOG.md #5b) ──
  // When `DECLARAGENT_RPC_AUTH_DEFAULT=on` is set, simulate the 0.8.0
  // default flip: any agent with `rpc-peers.yaml` and no explicit
  // `rpc.auth.enabled` value fails boot with AUTH_REJECTED. Agents
  // with an explicit `true` or `false` value are honoured. Evaluated
  // BEFORE any sink / socket / broker is opened so a failure aborts
  // cleanly with no orphan resources.
  if (isRpcAuthDefaultFlagOn()) {
    const preview = await evaluateZeroTrustPreview({
      fleet: filteredFleet,
      forceFlagOn: true,
      loader: async (agent) => {
        const a = await loadAgentMemoized(agent);
        return { posture: a.rpcAuthPosture };
      },
    });
    if (preview.failingAgents.length > 0) {
      io.err(`${formatZeroTrustBootReject(preview.failingAgents)}\n`);
      throw new Error(
        `AUTH_REJECTED: ${preview.failingAgents.length} agent(s) fail the 0.8.0 zero-trust preview gate. See stderr for remediation and docs/ZERO_TRUST_DEFAULT_MIGRATION.md.`,
      );
    }
    for (const a of preview.agents) {
      if (a.reason === 'flag-default') {
        io.out(
          `  ${a.agentId}: DECLARAGENT_RPC_AUTH_DEFAULT=on → promoting absent rpc.auth.enabled to true (0.8.0 preview).\n`,
        );
      }
      if (a.reason === 'explicit-optout') {
        io.err(
          `⚠ ${a.agentId}: rpc.auth.enabled=false explicitly set. Accepts unauthenticated envelopes — see docs/ZERO_TRUST_DEFAULT_MIGRATION.md §4 Path B.\n`,
        );
      }
    }
  }

  let anyAgentHasRpcAuth = false;
  for (const agent of filteredFleet.agents) {
    try {
      const a = await loadAgentMemoized(agent);
      // Under the 0.7.6 preview flag, an `absent` posture with peers
      // declared was either rejected above OR promoted to `enabled`
      // here. Re-resolve to match the runtime behaviour the rest of
      // this function expects.
      if (a.rpcAuthEnabled) {
        anyAgentHasRpcAuth = true;
        break;
      }
      if (isRpcAuthDefaultFlagOn() && a.rpcAuthPosture === 'absent') {
        // Fleet-root OR per-agent peers → the gate promoted this agent.
        const perAgentPeers = existsSync(join(agent.path, 'rpc-peers.yaml'));
        if (filteredFleet.peers !== undefined || perAgentPeers) {
          anyAgentHasRpcAuth = true;
          break;
        }
      }
    } catch {
      // A broken agent.yaml still fails downstream during engine boot;
      // we don't want the auth-detection probe to crash fleet-run.
      // The failed promise stays in the cache so a later call surfaces
      // the same error rather than re-reading a known-bad disk path.
    }
  }

  // #11 schema presence check — walk each agent's already-loaded
  // capabilities (the fleet loader populated them when validating
  // capabilities.yaml against the memory-transport topology).
  let anyCapabilityHasSchemas = false;
  for (const agent of filteredFleet.agents) {
    if (!agent.capabilities) continue;
    for (const cap of agent.capabilities.config.capabilities) {
      if (cap.inputSchema !== undefined || cap.outputSchema !== undefined) {
        anyCapabilityHasSchemas = true;
        break;
      }
    }
    if (anyCapabilityHasSchemas) break;
  }

  const needsAuditSink = anyAgentHasRpcAuth || anyCapabilityHasSchemas;
  let auditSink: TenantAuditSink | undefined;
  // Shared via the ref-counted singleton so a co-resident `up`
  // process (e.g. an in-process test runner holding both verbs at
  // once) reuses the same SQLite handle rather than opening a
  // second connection on the same file. The lease is dropped in
  // `shutdownDaemon` — only the LAST release actually closes the
  // underlying sink (POST_ENTERPRISE_BACKLOG.md #40).
  const auditSinkPath = auditDbPath();
  if (needsAuditSink) {
    try {
      auditSink = await acquireTenantAuditSink({ path: auditSinkPath, owner: 'fleet-run' });
    } catch (err) {
      io.err(
        `warning: audit sink at ${auditSinkPath} failed to open — ${err instanceof Error ? err.message : String(err)}. auth_check + capability_schema_violation records disabled.\n`,
      );
    }
  }

  // #4 AuthVerifyRegistry build. Requires peers; when the opt-in flag
  // is set but no peers exist we log a warning and proceed — legacy
  // envelopes still flow through unchanged.
  //
  // #18 (POST_ENTERPRISE_BACKLOG.md) per-agent registries. For each
  // agent, if `<agentPath>/rpc-peers.yaml` exists, build a registry
  // from that file and key it by `agent.id`. Agents without a per-
  // agent file fall back to the fleet-root registry. This lets one
  // fleet host agents with disjoint peer sets (e.g. tenant-scoped
  // signers) without any cross-trust.
  let authRegistry: AuthVerifyRegistry | undefined;
  const authRegistryByAgent = new Map<string, AuthVerifyRegistry>();
  // WS2 — sign-side counterparts. Unlike the verify registries (which warn +
  // fall back so a broken registry degrades to legacy-accept), a signer that
  // cannot be built under rpc.auth is a BOOT ERROR: outbound calls would go
  // out unsigned and be rejected by every strict peer — a fleet that looks
  // up but cannot delegate. Fail loud at boot instead (RELEASE_0_8_0_PLAN §B1).
  let outboundSigner: SignOutboundHook | undefined;
  const outboundSignerByAgent = new Map<string, SignOutboundHook>();
  let authEventStore: EventStore | undefined;
  let authEventStoreDb: Database | undefined;
  let authRejectSink:
    | ((entry: { envelope: AgentRpcEnvelope; reason: string; message: string }) => Promise<void>)
    | undefined;
  if (anyAgentHasRpcAuth) {
    const resolver = createDefaultSecretResolver({ fileRoot: root });
    if (peers === undefined) {
      io.err(
        'warning: rpc.auth.enabled=true but no fleet-root rpc-peers.yaml found — fleet-wide auth registry is empty. Per-agent rpc-peers.yaml files (if any) will still be loaded.\n',
      );
    } else {
      try {
        authRegistry = await buildAuthVerifyRegistry({
          peers,
          secrets: (ref) => resolver.resolve(ref),
        });
        const registeredPeers = peers.config.peers.filter((p) => p.auth !== undefined).length;
        io.out(
          `  rpc.auth enabled (${registeredPeers} peer(s) with verify providers registered at fleet root)\n`,
        );
      } catch (err) {
        io.err(
          `warning: rpc.auth.enabled=true but fleet-root registry build failed — ${
            err instanceof Error ? err.message : String(err)
          }. Falling back to legacy envelope auth for agents without a per-agent override.\n`,
        );
      }
      // WS2 — fleet-root outbound signer from the same peer table. Build
      // failure (typically an unresolvable secretRef) aborts boot: an
      // rpc.auth fleet that cannot sign would have every delegation
      // rejected by its strict peers at runtime.
      try {
        const signer = await buildOutboundSigner({
          peers,
          secrets: (ref) => resolver.resolve(ref),
        });
        if (signer.signablePeers > 0) {
          outboundSigner = signer.hook;
          io.out(
            `  rpc.auth signer: ${signer.signablePeers} peer(s) signable from fleet-root rpc-peers.yaml\n`,
          );
        }
      } catch (err) {
        throw new Error(
          `rpc.auth.enabled=true but the fleet-root outbound signer could not be built — ${
            err instanceof Error ? err.message : String(err)
          }. Fix the auth block (e.g. the secretRef) in ${peersPath} or disable rpc.auth. Outbound delegations would be sent unsigned and rejected by strict peers.`,
        );
      }
    }

    // Per-agent registries: walk every agent and build a dedicated
    // registry when `<agentPath>/rpc-peers.yaml` is present. This is
    // orthogonal to `rpc.auth.enabled` on the agent: the per-agent
    // file's presence alone is the opt-in signal. Failures on one
    // agent never poison the others.
    for (const agent of filteredFleet.agents) {
      const agentPeersPath = join(agent.path, 'rpc-peers.yaml');
      if (!existsSync(agentPeersPath)) continue;
      try {
        const agentPeers = await loadPeersConfig(agentPeersPath);
        const registry = await buildAuthVerifyRegistry({
          peers: agentPeers,
          secrets: (ref) => resolver.resolve(ref),
        });
        authRegistryByAgent.set(agent.id, registry);
        const registered = agentPeers.config.peers.filter((p) => p.auth !== undefined).length;
        io.out(
          `  rpc.auth per-agent: ${agent.id} → ${registered} peer(s) from ${agentPeersPath}\n`,
        );
        // WS2 — per-agent signer from the same file. Registry built above,
        // so secrets resolve; a sign-side failure here is a real config
        // error and aborts boot (see the fleet-root rationale).
        const signer = await buildOutboundSigner({
          peers: agentPeers,
          secrets: (ref) => resolver.resolve(ref),
        });
        if (signer.signablePeers > 0) {
          outboundSignerByAgent.set(agent.id, signer.hook);
        }
      } catch (err) {
        io.err(
          `warning: failed to load per-agent rpc-peers.yaml for ${agent.id} at ${agentPeersPath} — ${
            err instanceof Error ? err.message : String(err)
          }. Falling back to fleet-root registry for this agent.\n`,
        );
      }
    }

    // Open an event store so rejected envelopes land in `rejected_events`
    // under `kind=auth-rejected` — same contract agent-inbox honours.
    try {
      authEventStoreDb = new Database(sessionsDbPath(), { create: true });
      authEventStoreDb.exec('PRAGMA journal_mode = WAL;');
      authEventStore = createEventStore({ db: authEventStoreDb });
      const store = authEventStore;
      authRejectSink = async (entry) => {
        try {
          await store.upsertRejection(
            entry.envelope.messageId,
            'auth-rejected',
            entry.message,
            Date.now(),
          );
        } catch (err) {
          io.err(
            `warning: rejected_events upsert failed — ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
      };
    } catch (err) {
      io.err(
        `warning: could not open rejected_events store at ${sessionsDbPath()} — ${
          err instanceof Error ? err.message : String(err)
        }. Auth rejects will not be persisted.\n`,
      );
    }
  }

  // #11 Capability-validator registry + per-peer capabilities map. One
  // registry per fleet-run process — compiled validators are keyed by
  // `(capabilityName, schemaHash)` so a second agent that calls the
  // same capability reuses the cached compiled form.
  let validators: CapabilityValidatorRegistry | undefined;
  let peerCapabilities: ReadonlyMap<AgentAddress, LoadedCapabilities> | undefined;
  let onSchemaViolation: CapabilitySchemaViolationEmitter | undefined;
  if (anyCapabilityHasSchemas) {
    validators = createCapabilityValidatorRegistry();
    const peerCapMap = new Map<AgentAddress, LoadedCapabilities>();
    for (const agent of filteredFleet.agents) {
      if (agent.capabilities !== undefined) {
        peerCapMap.set(`agent://${agent.id}` as AgentAddress, agent.capabilities);
      }
    }
    peerCapabilities = peerCapMap;
    if (auditSink !== undefined) {
      const sink = auditSink;
      onSchemaViolation = async (event) => {
        const record: CapabilitySchemaViolationAuditRecord = {
          kind: 'capability_schema_violation',
          ts: Date.now(),
          tenantId: event.tenantId ?? 'default',
          capabilityName: event.capabilityName,
          peerId: event.peerId,
          side: event.side,
          violations: event.violations,
          correlationId: event.correlationId,
        };
        if (event.sessionId !== undefined) record.sessionId = event.sessionId;
        try {
          await sink.record(record);
        } catch (err) {
          io.err(
            `warning: capability_schema_violation audit-sink error — ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
      };
    }
  }

  // WS4 — supply broker transport factories so declared kafka/nats transports
  // actually instantiate (previously every non-memory kind warn-skipped because
  // the CLI passed no factories). Config→constructor mapping lives in
  // buildTransportFactories (unit-tested); the live connection is exercised by
  // the integration soak. WS11 — a secret resolver lets a kafka transport's
  // `sasl.passwordRef` resolve to real broker credentials (TLS via `ssl`).
  const transportSecretResolver = createDefaultSecretResolver({ fileRoot: root });
  const transportFactories = buildTransportFactories({
    fleetName: filteredFleet.manifest.name,
    resolveSecret: (ref) => transportSecretResolver.resolve(ref),
  });

  const daemon = await startFleetDaemon({
    fleet: filteredFleet,
    ...(makeHandler !== undefined && { makeHandler }),
    ...(peers !== undefined && { peers }),
    transportFactories,
    io,
    ...(authRegistry !== undefined && { authRegistry }),
    ...(authRegistryByAgent.size > 0 && { authRegistryByAgent }),
    // WS2 — outbound signers (request + response legs), same per-agent-wins
    // selection as the verify registries.
    ...(outboundSigner !== undefined && { signOutbound: outboundSigner }),
    ...(outboundSignerByAgent.size > 0 && { signOutboundByAgent: outboundSignerByAgent }),
    // WS2 — when the operator enabled rpc.auth, fail closed on unregistered
    // senders (an opted-in fleet should not silently accept unknown peers).
    ...(anyAgentHasRpcAuth && { strictAuth: true }),
    ...(auditSink !== undefined && { auditSink }),
    ...(authRejectSink !== undefined && { authRejectSink }),
    ...(peerCapabilities !== undefined && { peerCapabilities }),
    ...(validators !== undefined && { validators }),
    ...(onSchemaViolation !== undefined && { onSchemaViolation }),
  });

  // Close the session DB handle together with the daemon so subsequent
  // invocations don't hit WAL lock contention (sqlite keeps the handle
  // open for the process lifetime otherwise). The audit sink + optional
  // event-store handle are closed on the same boundary.
  //
  // Idempotent: the SIGINT path triggers `stop()` which calls
  // `shutdownDaemon`, then `daemon.waitForShutdown()` resolves and the
  // outer code would otherwise close again.
  let shutdownRan = false;
  const shutdownDaemon = async (): Promise<void> => {
    if (shutdownRan) return;
    shutdownRan = true;
    await daemon.shutdown();
    sessionStore?.close();
    if (auditSink !== undefined) {
      // Release our ref on the shared singleton rather than closing
      // directly — another in-process caller (e.g. `up`) may still
      // hold a lease on the same path.
      try {
        await releaseTenantAuditSink({ path: auditSinkPath, owner: 'fleet-run' });
      } catch {
        // best-effort
      }
    }
    if (authEventStoreDb !== undefined) {
      try {
        authEventStoreDb.close();
      } catch {
        // best-effort
      }
    }
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
  await shutdownDaemon();
  return 0;
}

/**
 * Build a memoized `loadAgent` closure keyed by `agent.path`. Used by
 * {@link fleetRun} to avoid reading `agent.yaml` + walking `skills/`
 * twice per agent — once in the `rpcAuthEnabled` probe, once in the
 * LLM handler factory. Failures land in the cache as a rejected
 * Promise so the probe's `try/catch` behaves identically to pre-
 * memoization, while a later call doesn't re-read a known-bad path.
 *
 * Exported for unit-testing the cache contract directly; production
 * callers should just pass the result into
 * {@link createLLMHandlerFactory}'s `loadAgentFn` option.
 *
 * See: docs/POST_ENTERPRISE_BACKLOG.md #43.
 *
 * @since 0.7.2
 */
export function createMemoizedLoadAgent(
  loader: (agent: LoadedAgentEntry) => Promise<LoadedAgent> = (a) =>
    loadAgent({ agentDir: a.path }),
): (agent: LoadedAgentEntry) => Promise<LoadedAgent> {
  const cache = new Map<string, Promise<LoadedAgent>>();
  return (agent) => {
    const cached = cache.get(agent.path);
    if (cached !== undefined) return cached;
    const fresh = loader(agent);
    cache.set(agent.path, fresh);
    return fresh;
  };
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
