/**
 * MCP server supervisor — auto-recovery for crashed stdio servers.
 *
 * The stdio client (`createMCPClient`) already restarts itself on
 * transport close with a default 500ms exponential backoff. That is
 * good for transient JSON-RPC framing glitches but is not enough for an
 * enterprise operator: they want
 *
 *   1. A ping-based health check that catches a hung-but-still-attached
 *      server (the transport is alive, but the server stopped answering).
 *   2. A longer, more conservative backoff (1s → 2s → 4s → ... → 60s cap).
 *   3. A circuit breaker: after N give-ups, stop trying, fire an alert,
 *      and fail tool calls fast with a typed error until a probe
 *      succeeds.
 *   4. Tool-catalog re-registration after a respawn, so callers that
 *      cached `listTools()` see the fresh set.
 *
 * The supervisor owns all four. It wraps a user-supplied
 * {@link MCPClientFactory}, disables the inner restart loop (by
 * configuring the client with `maxConsecutiveFailures: 1` and zero
 * inner backoff), and drives the full lifecycle externally. When a
 * crash is detected it discards the dead client, runs its own backoff
 * sleep, and asks the factory for a fresh one. On success it re-issues
 * `initialize` + `listTools` and notifies the caller.
 *
 * Metrics: three Prometheus series, registered through the shared
 * {@link MetricsRegistry}:
 *
 *   - `mcp_server_restarts_total{server_id, reason}`  counter
 *   - `mcp_server_circuit_state{server_id}`           gauge (0/1/2)
 *   - `mcp_server_circuit_open_total{server_id}`      counter
 *
 * The `circuit_open_total` counter is a dedicated companion to the
 * labeled `circuit_state` gauge: alertmanager rules stay simple
 * (`increase(mcp_server_circuit_open_total[5m]) > 0`) without having
 * to compare a gauge against a constant label value. It increments
 * exactly once per `closed|half-open → open` transition.
 *
 * @since 0.7.0
 */

import { CircuitBreaker, type CircuitBreakerState } from '../events/circuit-breaker.js';
import type { Counter, Gauge, MetricsRegistry } from '../events/types.js';
import type { Logger } from '../types/logger.js';
import type { MCPLifecycleExitReason, MCPLifecycleHandlers } from './stdio-client.js';
import type { MCPClient, MCPServerInfo, MCPTool, MCPToolResult } from './types.js';

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when a supervised client call races with a crash / is rejected
 * because the circuit is open. Carries a structured `code` so the tool
 * adapter can translate it into an `EMCPCRASH` error without losing
 * the reason.
 */
export class MCPServerCrashedError extends Error {
  readonly code = 'EMCPCRASHED';
  readonly serverId: string;
  /** Supervisor circuit state at the time of rejection. */
  readonly circuitState: CircuitBreakerState;
  constructor(serverId: string, circuitState: CircuitBreakerState, message?: string) {
    super(
      message ??
        `MCP server "${serverId}" crashed and its supervisor circuit is ${circuitState}; retry after the circuit half-opens`,
    );
    this.name = 'MCPServerCrashedError';
    this.serverId = serverId;
    this.circuitState = circuitState;
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

export type MCPSupervisorState =
  | 'starting'
  | 'ready'
  | 'reconnecting'
  /** Circuit open: will not try again until the reset timeout elapses. */
  | 'circuit-open'
  /** Operator called `shutdown()`. Terminal. */
  | 'stopped';

export interface MCPSupervisorStateSnapshot {
  state: MCPSupervisorState;
  circuit: CircuitBreakerState;
  consecutiveGiveUps: number;
  restarts: number;
}

/**
 * Builds a fresh {@link MCPClient}. Called on initial boot and again on
 * every respawn. The returned client should be configured with the
 * inner auto-restart disabled — the supervisor configures this via the
 * `clientOverrides` parameter when using {@link buildSupervisorClient},
 * but if the factory ignores it, the supervisor will still observe the
 * inner restart transitions and correct the bookkeeping.
 */
export type MCPClientFactory = (
  /** Lifecycle hooks the factory must wire into `createMCPClient`. */
  lifecycle: MCPLifecycleHandlers,
  /** Sensible inner-config overrides: disable inner auto-restart. */
  clientOverrides: {
    readonly maxConsecutiveFailures: number;
    readonly backoffMs: (attempt: number) => number;
  },
) => MCPClient;

/**
 * Why a restart was triggered. Used as the `reason` label on
 * `mcp_server_restarts_total`.
 */
export type MCPRestartReason =
  | 'initial'
  | 'transport-closed'
  | 'ping-failed'
  | 'init-failed'
  | 'probe';

export interface CreateMCPSupervisorOptions {
  /** Server id; namespaces tool names, labels metrics. */
  serverId: string;
  /** Protocol version to advertise on each (re)initialize. */
  protocolVersion: string;
  /** Builds a fresh underlying client. */
  factory: MCPClientFactory;
  /** Shared metrics registry; supervisor will register counters/gauges. */
  metrics?: MetricsRegistry;
  /** Logger. Defaults to a no-op. */
  logger?: Logger;
  /** Health-check ping interval. Default: 10_000ms. */
  pingIntervalMs?: number;
  /** Consecutive ping failures before we declare the server dead. Default: 2. */
  pingFailureThreshold?: number;
  /** Per-ping timeout. Default: 5_000ms. */
  pingTimeoutMs?: number;
  /**
   * Backoff schedule in ms. Default: `defaultSupervisorBackoff` which
   * produces 1s → 2s → 4s → ... capped at 60s. `attempt` is 0-based.
   */
  backoffMs?: (attempt: number) => number;
  /**
   * Consecutive "gave up a backoff-exhausted respawn" events that open
   * the circuit. Default: 5.
   */
  circuitThreshold?: number;
  /** Ms spent in `open` before flipping to `half-open`. Default: 30_000. */
  circuitResetMs?: number;
  /**
   * Called after a respawn succeeds + the fresh tool catalog has been
   * fetched. Consumers use this to re-register tools in their registry.
   * Errors are caught.
   */
  onToolsRegistered?: (
    tools: readonly MCPTool[],
    ctx: { serverId: string; serverInfo: MCPServerInfo },
  ) => void;
  /**
   * Called whenever the circuit state changes. Consumers use this to
   * fire external alerts (PagerDuty, Slack). Errors are caught.
   */
  onCircuitTransition?: (event: {
    from: CircuitBreakerState;
    to: CircuitBreakerState;
    serverId: string;
  }) => void;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

export interface MCPSupervisor {
  readonly serverId: string;
  /** Snapshot of supervisor + circuit state. */
  snapshot(): MCPSupervisorStateSnapshot;
  /** Kick off the initial connect + health-check loop. Idempotent. */
  start(): Promise<void>;
  /** Graceful stop: kill ping loop + current client. Idempotent. */
  stop(): Promise<void>;
  /**
   * Wrapped tool call. Fails fast with {@link MCPServerCrashedError}
   * when the circuit is open; otherwise delegates to the live client.
   * In-flight calls that race a crash resolve with the same error.
   */
  callTool(name: string, input: unknown, signal?: AbortSignal): ReturnType<MCPClient['callTool']>;
  /** Re-export the last-fetched tool catalog. */
  currentTools(): readonly MCPTool[];
  /** Observer for tests. */
  onTransition(listener: (to: MCPSupervisorState) => void): () => void;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_PING_TIMEOUT_MS = 5_000;
const DEFAULT_PING_FAILURE_THRESHOLD = 2;
const DEFAULT_CIRCUIT_THRESHOLD = 5;
const DEFAULT_CIRCUIT_RESET_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/**
 * The inner-client give-up threshold when driven by the supervisor.
 * We want the inner client to never retry on its own — we retry from
 * the supervisor with the authoritative backoff schedule. Setting this
 * to 1 means "one init failure → the inner client marks itself failed
 * and surfaces the error, which is exactly what the supervisor wants
 * to observe".
 */
const INNER_MAX_FAILURES = 1;

/**
 * Supervisor backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, ... . Matches
 * the enterprise plan §3 #8 spec ("1s → 2s → 4s → ... → 60s cap").
 */
export function defaultSupervisorBackoff(attempt: number): number {
  const ms = BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(ms, BACKOFF_CAP_MS);
}

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

// Gauge values for `mcp_server_circuit_state`:
//   closed = 0 (healthy), half-open = 1, open = 2.
const CIRCUIT_GAUGE_VALUE: Record<CircuitBreakerState, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

// ── Factory ───────────────────────────────────────────────────────────────

export function createMCPSupervisor(opts: CreateMCPSupervisorOptions): MCPSupervisor {
  const logger = (opts.logger ?? NOOP_LOGGER).child({ mcp: opts.serverId });
  const pingInterval = Math.max(10, opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
  const pingTimeout = Math.max(10, opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS);
  const pingThreshold = Math.max(1, opts.pingFailureThreshold ?? DEFAULT_PING_FAILURE_THRESHOLD);
  const backoff = opts.backoffMs ?? defaultSupervisorBackoff;
  const circuitThreshold = Math.max(1, opts.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? defaultTimer;

  // Metrics registration. The supervisor can still run without metrics
  // — the counter/gauge stubs below become no-ops. This lets tests
  // instantiate the supervisor without wiring a fake registry every
  // time.
  const restartsCounter: Counter = opts.metrics
    ? opts.metrics.counter(
        'mcp_server_restarts_total',
        'Count of MCP server respawn attempts, labeled by server_id and trigger reason.',
      )
    : { inc() {} };
  const circuitGauge: Gauge = opts.metrics
    ? opts.metrics.gauge(
        'mcp_server_circuit_state',
        'MCP supervisor circuit state per server (0=closed, 1=half-open, 2=open).',
      )
    : {
        set() {},
        inc() {},
        dec() {},
      };
  // Dedicated counter for circuit-open transitions. Alertmanager rules
  // are much simpler with a counter (`increase(...[5m]) > 0`) than a
  // gauge-plus-label comparison — see Post-Enterprise Backlog #14.
  const circuitOpenCounter: Counter = opts.metrics
    ? opts.metrics.counter(
        'mcp_server_circuit_open_total',
        'Count of MCP supervisor circuit-open transitions per server.',
      )
    : { inc() {} };

  const serverLabels: Readonly<Record<string, string>> = { server_id: opts.serverId };

  const circuit = new CircuitBreaker({
    failureThreshold: circuitThreshold,
    resetTimeoutMs: opts.circuitResetMs ?? DEFAULT_CIRCUIT_RESET_MS,
    successThreshold: 1,
    now,
  });

  let state: MCPSupervisorState = 'starting';
  let client: MCPClient | undefined;
  let latestTools: readonly MCPTool[] = [];
  let restartCount = 0;
  let consecutiveGiveUps = 0; // backoff-exhausted sequences
  let pingFailures = 0;
  let started = false;
  let stopped = false;
  let pingHandle: (() => void) | undefined;
  let restartLoopPromise: Promise<void> | undefined;
  /**
   * Generation counter — incremented every time we tear down the
   * current client. Lets async callbacks (lifecycle events arriving
   * late from a dead client) know they should stop participating.
   */
  let generation = 0;
  /**
   * Resolves whenever the current generation ends (crash, teardown,
   * shutdown). Every `callTool` races the tool promise against this so
   * an in-flight call never hangs past a crash.
   */
  let generationEnded: Promise<void>;
  let signalGenerationEnd: () => void;
  const resetGenerationEndSignal = (): void => {
    generationEnded = new Promise<void>((resolve) => {
      signalGenerationEnd = resolve;
    });
  };
  // Seed the pair so `signalGenerationEnd` is defined for the strict
  // TS compiler. The first respawn will reset it anyway.
  generationEnded = Promise.resolve();
  signalGenerationEnd = () => {};
  resetGenerationEndSignal();
  const stateListeners = new Set<(to: MCPSupervisorState) => void>();

  circuitGauge.set(CIRCUIT_GAUGE_VALUE.closed, serverLabels);

  circuit.onTransition(({ from, to }) => {
    circuitGauge.set(CIRCUIT_GAUGE_VALUE[to], serverLabels);
    if (to === 'open') {
      circuitOpenCounter.inc(1, serverLabels);
    }
    logger.warn('mcp.supervisor.circuit.transition', {
      serverId: opts.serverId,
      from,
      to,
    });
    if (opts.onCircuitTransition) {
      try {
        opts.onCircuitTransition({ from, to, serverId: opts.serverId });
      } catch (err) {
        logger.warn('mcp.supervisor.circuit.listener.error', { err: String(err) });
      }
    }
    if (to === 'open') {
      setState('circuit-open');
    } else if (to === 'half-open') {
      // We'll proactively schedule a probe respawn.
      scheduleProbe();
    }
    // `closed` ⇒ handled when the probe succeeds.
  });

  function setState(next: MCPSupervisorState): void {
    if (state === next) return;
    logger.debug('mcp.supervisor.state', { from: state, to: next });
    state = next;
    for (const l of stateListeners) {
      try {
        l(next);
      } catch {
        // swallow
      }
    }
  }

  function recordRestart(reason: MCPRestartReason): void {
    restartCount += 1;
    restartsCounter.inc(1, { server_id: opts.serverId, reason });
  }

  function teardownClient(current: MCPClient | undefined): Promise<void> {
    if (!current) return Promise.resolve();
    return current.shutdown().catch((err) => {
      logger.warn('mcp.supervisor.teardown.error', { err: String(err) });
    });
  }

  function stopPingLoop(): void {
    if (pingHandle) {
      pingHandle();
      pingHandle = undefined;
    }
  }

  function schedulePingLoop(): void {
    stopPingLoop();
    if (stopped) return;
    pingHandle = setTimer(() => {
      void runPing();
    }, pingInterval);
  }

  async function runPing(): Promise<void> {
    if (stopped) return;
    pingHandle = undefined;
    const active = client;
    if (!active || state !== 'ready') {
      schedulePingLoop();
      return;
    }
    const currentGen = generation;
    let ok = false;
    try {
      ok = await pingWithTimeout(active, pingTimeout);
    } catch (err) {
      logger.debug('mcp.supervisor.ping.error', { err: String(err) });
      ok = false;
    }
    if (stopped || currentGen !== generation) return;
    if (ok) {
      pingFailures = 0;
      schedulePingLoop();
      return;
    }
    pingFailures += 1;
    logger.warn('mcp.supervisor.ping.failed', {
      serverId: opts.serverId,
      consecutive: pingFailures,
      threshold: pingThreshold,
    });
    if (pingFailures >= pingThreshold) {
      logger.warn('mcp.supervisor.ping.dead', { serverId: opts.serverId });
      pingFailures = 0;
      triggerRestart('ping-failed');
      return;
    }
    schedulePingLoop();
  }

  async function pingWithTimeout(c: MCPClient, timeoutMs: number): Promise<boolean> {
    // `listTools` is the cheapest no-side-effect round trip the MCP
    // surface gives us. Servers that refresh the cache via
    // `notifications/tools/list_changed` will have the response cached
    // — that still proves the transport is alive because the cache is
    // invalidated when the connection closes. For a cache-hit, we fall
    // through to a 0-arg `initialize` request which every MCP server
    // answers idempotently.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Use `initialize` as the liveness probe — MCP servers MUST answer
      // it even post-handshake (it is idempotent per the 2024-11-05
      // spec). This avoids depending on server implementations that
      // treat `tools/list` as stateful.
      await c.initialize();
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function triggerRestart(reason: MCPRestartReason): void {
    if (stopped) return;
    if (state === 'reconnecting') return;
    if (!circuit.allow()) {
      setState('circuit-open');
      return;
    }
    generation += 1;
    const dying = client;
    client = undefined;
    latestTools = [];
    stopPingLoop();
    // Unblock every in-flight `callTool` waiting on the old generation.
    signalGenerationEnd();
    resetGenerationEndSignal();
    setState('reconnecting');
    restartLoopPromise = runRestartLoop(reason, dying);
  }

  function scheduleProbe(): void {
    if (stopped) return;
    if (state === 'reconnecting') return;
    // Half-open admits a single probe respawn — kick it off async so
    // callers of `circuit.onTransition` return immediately.
    queueMicrotask(() => {
      if (stopped) return;
      if (!circuit.allow()) return;
      if (state === 'reconnecting') return;
      triggerRestart('probe');
    });
  }

  async function runRestartLoop(
    initialReason: MCPRestartReason,
    dying: MCPClient | undefined,
  ): Promise<void> {
    await teardownClient(dying);
    let attempt = 0;
    let reason = initialReason;
    while (!stopped) {
      const delayMs = backoff(attempt);
      logger.info('mcp.supervisor.respawn.attempt', {
        serverId: opts.serverId,
        attempt,
        delayMs,
        reason,
      });
      await sleep(delayMs);
      if (stopped) return;
      recordRestart(reason);
      try {
        await bootFreshClient();
        consecutiveGiveUps = 0;
        circuit.record(true);
        setState('ready');
        schedulePingLoop();
        return;
      } catch (err) {
        logger.warn('mcp.supervisor.respawn.failed', {
          serverId: opts.serverId,
          attempt,
          err: err instanceof Error ? err.message : String(err),
        });
        attempt += 1;
        reason = 'init-failed';
        // Track the attempts-per-give-up as inner — we don't let the
        // backoff grow unbounded. After `circuitThreshold` give-ups
        // (one per backoff exhaustion) the circuit opens.
        if (attempt >= circuitThreshold) {
          consecutiveGiveUps += 1;
          circuit.record(false);
          if (!circuit.allow()) {
            // Circuit just opened. Stop respawning until half-open.
            setState('circuit-open');
            return;
          }
          attempt = 0;
        }
      }
    }
  }

  async function bootFreshClient(): Promise<void> {
    const myGen = generation;
    const lifecycle: MCPLifecycleHandlers = {
      onExit: (exitReason: MCPLifecycleExitReason) => {
        if (stopped) return;
        if (myGen !== generation) return; // stale
        if (exitReason === 'shutdown') return;
        // Inner client has died. Escalate to a supervisor-managed
        // restart with the correct reason.
        const supReason: MCPRestartReason =
          exitReason === 'transport-closed' ? 'transport-closed' : 'init-failed';
        logger.warn('mcp.supervisor.innerExit', {
          serverId: opts.serverId,
          reason: exitReason,
        });
        queueMicrotask(() => {
          if (myGen !== generation) return;
          triggerRestart(supReason);
        });
      },
    };
    const fresh = opts.factory(lifecycle, {
      maxConsecutiveFailures: INNER_MAX_FAILURES,
      backoffMs: () => 0,
    });
    // Handshake + tool catalog fetch. Errors propagate to the restart
    // loop so backoff can kick in.
    const info = await fresh.initialize();
    const tools = await fresh.listTools();
    if (myGen !== generation) {
      await teardownClient(fresh);
      throw new Error('generation changed during boot');
    }
    client = fresh;
    latestTools = tools;
    if (opts.onToolsRegistered) {
      try {
        opts.onToolsRegistered(tools, { serverId: opts.serverId, serverInfo: info });
      } catch (err) {
        logger.warn('mcp.supervisor.tools.listener.error', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    serverId: opts.serverId,
    snapshot() {
      return {
        state,
        circuit: circuit.state,
        consecutiveGiveUps,
        restarts: restartCount,
      };
    },
    async start() {
      if (stopped) throw new Error(`supervisor ${opts.serverId}: already stopped`);
      if (started) return;
      started = true;
      setState('starting');
      // Treat the initial connect as the first respawn — runs through
      // the same backoff machinery so a flaky IdP / stdio handshake at
      // boot-time doesn't crash-loop instantly.
      restartLoopPromise = runRestartLoop('initial', undefined);
      await restartLoopPromise.catch(() => {});
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      stopPingLoop();
      setState('stopped');
      const dying = client;
      client = undefined;
      // Unblock in-flight calls so they don't hang past shutdown.
      signalGenerationEnd();
      await teardownClient(dying);
      await restartLoopPromise?.catch(() => {});
    },
    async callTool(name, input, signal) {
      if (stopped) {
        throw new MCPServerCrashedError(opts.serverId, circuit.state, 'supervisor stopped');
      }
      if (!circuit.allow()) {
        throw new MCPServerCrashedError(opts.serverId, circuit.state);
      }
      const active = client;
      if (!active || state !== 'ready') {
        throw new MCPServerCrashedError(
          opts.serverId,
          circuit.state,
          `MCP server "${opts.serverId}" is ${state}; tool call rejected`,
        );
      }
      const callGen = generation;
      // Race the underlying call against the current generation's
      // "ended" signal. If the client crashes / the supervisor
      // tears it down mid-call, the race resolves first and we
      // surface a typed `EMCPCRASHED` rather than hanging.
      const endSignal = generationEnded;
      const crashSentinel = Symbol('crashed');
      const result = await Promise.race([
        active.callTool(name, input, signal).catch((err: unknown) => ({
          __callError: true,
          err,
        })),
        endSignal.then(() => crashSentinel),
      ]);
      if (result === crashSentinel || callGen !== generation || stopped) {
        throw new MCPServerCrashedError(
          opts.serverId,
          circuit.state,
          `MCP server "${opts.serverId}" crashed during tool call "${name}"`,
        );
      }
      if (
        typeof result === 'object' &&
        result !== null &&
        '__callError' in result &&
        (result as { __callError: true }).__callError === true
      ) {
        throw (result as { err: unknown }).err;
      }
      return result as MCPToolResult;
    },
    currentTools() {
      return latestTools;
    },
    onTransition(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
}
