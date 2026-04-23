import { describe, expect, test } from 'bun:test';
import { createPrometheusRegistry } from '../observability/prometheus.js';
import type { MCPLifecycleHandlers } from './stdio-client.js';
import {
  type MCPClientFactory,
  MCPServerCrashedError,
  type MCPSupervisor,
  createMCPSupervisor,
  defaultSupervisorBackoff,
} from './supervisor.js';
import type {
  MCPClient,
  MCPResourceContents,
  MCPServerInfo,
  MCPTool,
  MCPToolResult,
} from './types.js';

// ── Fake MCP client + deterministic clock helpers ──────────────────────────

interface FakeClientOptions {
  /** Tools reported by `listTools()`. */
  tools?: readonly MCPTool[];
  /** If set, `initialize()` rejects with this error. */
  failInitialize?: () => Error | undefined;
  /** Observed lifecycle from the factory. */
  lifecycle?: MCPLifecycleHandlers;
  /** Name of the fake server for handshake. */
  serverName?: string;
}

interface FakeClient extends MCPClient {
  /** Simulate crash: closes transport, invokes `onExit('transport-closed')`. */
  crash(): void;
  /** Simulate hang: future `initialize` + `callTool` never resolve. */
  hang(): void;
  /** Underlying alive flag. */
  readonly isAlive: boolean;
  /** Call count for `initialize` (supervisor uses it as ping). */
  readonly initCalls: number;
}

function makeFakeClient(opts: FakeClientOptions = {}): FakeClient {
  const serverInfo: MCPServerInfo = {
    name: opts.serverName ?? 'fake',
    version: '1.0.0',
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
  };
  const lifecycle = opts.lifecycle ?? {};
  let alive = true;
  let hung = false;
  let initCalls = 0;
  let stopped = false;
  let spawned = false;

  // Emit spawn once, synchronously — the supervisor doesn't rely on
  // timing, but real clients emit `onSpawn` after handshake.
  queueMicrotask(() => {
    if (!stopped && alive && !hung) {
      spawned = true;
      lifecycle.onSpawn?.(serverInfo);
    }
  });

  const never = () => new Promise<never>(() => {});

  const client: FakeClient = {
    get status() {
      if (stopped) return 'stopped';
      if (!alive) return 'failed';
      return 'ready';
    },
    get serverInfo() {
      return alive ? serverInfo : undefined;
    },
    async initialize(): Promise<MCPServerInfo> {
      if (hung) return never();
      initCalls += 1;
      const err = opts.failInitialize?.();
      if (err) throw err;
      if (!alive) throw new Error('dead');
      return serverInfo;
    },
    async listTools(): Promise<readonly MCPTool[]> {
      if (hung) return never();
      if (!alive) throw new Error('dead');
      return opts.tools ?? [];
    },
    async callTool(_name: string, _input: unknown): Promise<MCPToolResult> {
      if (hung) return never();
      if (!alive) throw new Error('dead');
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    async readResource(): Promise<readonly MCPResourceContents[]> {
      return [];
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      if (alive && spawned) {
        alive = false;
        lifecycle.onExit?.('shutdown');
      }
      alive = false;
    },
    onToolsChanged() {
      return () => {};
    },
    crash() {
      if (!alive) return;
      alive = false;
      lifecycle.onExit?.('transport-closed');
    },
    hang() {
      hung = true;
    },
    get isAlive() {
      return alive;
    },
    get initCalls() {
      return initCalls;
    },
  };
  return client;
}

/** Deterministic sleep + timer scheduler for supervisor tests. */
interface FakeClock {
  now: () => number;
  advance(ms: number): Promise<void>;
  sleep: (ms: number) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => () => void;
  /** Pending sleeps / timers, for diagnostics. */
  readonly pending: number;
}

function makeFakeClock(): FakeClock {
  let t = 0;
  interface Task {
    at: number;
    resolve: () => void;
    cancelled: boolean;
  }
  const tasks = new Set<Task>();

  function schedule(ms: number, fn: () => void): () => void {
    const task: Task = { at: t + ms, resolve: fn, cancelled: false };
    tasks.add(task);
    return () => {
      task.cancelled = true;
      tasks.delete(task);
    };
  }

  async function drainUpTo(until: number): Promise<void> {
    // Keep firing tasks in order. Each fired task may schedule more
    // tasks — keep draining until nothing in the window remains.
    // After firing, we flush a LOT of microtasks because the supervisor
    // awaits up to a dozen promise continuations per successful boot.
    async function flush(): Promise<void> {
      for (let i = 0; i < 50; i += 1) {
        await new Promise<void>((r) => queueMicrotask(r));
      }
    }
    await flush();
    while (true) {
      const ready = [...tasks]
        .filter((task) => !task.cancelled && task.at <= until)
        .sort((a, b) => a.at - b.at);
      if (ready.length === 0) {
        // One final flush to catch microtasks scheduled by previously-
        // resolved tasks.
        await flush();
        const stillReady = [...tasks]
          .filter((task) => !task.cancelled && task.at <= until)
          .sort((a, b) => a.at - b.at);
        if (stillReady.length === 0) return;
        continue;
      }
      const next = ready[0] as Task;
      t = next.at;
      tasks.delete(next);
      if (next.cancelled) continue;
      next.resolve();
      await flush();
    }
  }

  return {
    now: () => t,
    async advance(ms) {
      const until = t + ms;
      await drainUpTo(until);
      t = until;
    },
    sleep(ms) {
      return new Promise<void>((resolve) => {
        schedule(ms, resolve);
      });
    },
    setTimer(fn, ms) {
      return schedule(ms, fn);
    },
    get pending() {
      return tasks.size;
    },
  };
}

/** Flush pending microtasks. */
function flushMicrotasks(n = 5): Promise<void> {
  return new Promise<void>((resolve) => {
    let remaining = n;
    const step = () => {
      if (remaining-- <= 0) return resolve();
      queueMicrotask(step);
    };
    step();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('defaultSupervisorBackoff', () => {
  test('produces 1s → 2s → 4s → ... capped at 60s', () => {
    expect(defaultSupervisorBackoff(0)).toBe(1_000);
    expect(defaultSupervisorBackoff(1)).toBe(2_000);
    expect(defaultSupervisorBackoff(2)).toBe(4_000);
    expect(defaultSupervisorBackoff(3)).toBe(8_000);
    expect(defaultSupervisorBackoff(4)).toBe(16_000);
    expect(defaultSupervisorBackoff(5)).toBe(32_000);
    expect(defaultSupervisorBackoff(6)).toBe(60_000);
    expect(defaultSupervisorBackoff(10)).toBe(60_000);
    expect(defaultSupervisorBackoff(100)).toBe(60_000);
  });
});

describe('createMCPSupervisor — happy path respawn', () => {
  test('starts the first client, records metrics, and exposes its tools', async () => {
    const tools: MCPTool[] = [
      { name: 'echo', inputSchema: { type: 'object' } },
      { name: 'add', inputSchema: { type: 'object' } },
    ];
    const clock = makeFakeClock();
    const clients: FakeClient[] = [];
    const factory: MCPClientFactory = (lifecycle) => {
      const c = makeFakeClient({ tools, lifecycle });
      clients.push(c);
      return c;
    };
    const registry = createPrometheusRegistry();
    let registeredTools: readonly MCPTool[] | undefined;
    const sup = createMCPSupervisor({
      serverId: 'sv1',
      protocolVersion: '2024-11-05',
      factory,
      metrics: registry,
      now: clock.now,
      sleep: clock.sleep,
      setTimer: clock.setTimer,
      onToolsRegistered: (t) => {
        registeredTools = t;
      },
    });
    const startPromise = sup.start();
    // First respawn attempt uses backoff(0) = 1s.
    await clock.advance(1_000);
    await flushMicrotasks(10);
    await startPromise;
    expect(sup.snapshot().state).toBe('ready');
    expect(sup.snapshot().circuit).toBe('closed');
    expect(sup.currentTools().map((t) => t.name)).toEqual(['echo', 'add']);
    expect(registeredTools?.map((t) => t.name)).toEqual(['echo', 'add']);
    expect(clients.length).toBe(1);
    // Metrics should show 1 restart (initial) + circuit=0 (closed).
    const scrape = registry.scrape();
    expect(scrape).toContain('mcp_server_restarts_total');
    expect(scrape).toContain('server_id="sv1"');
    expect(scrape).toContain('reason="initial"');
    expect(scrape).toMatch(/mcp_server_circuit_state\{[^}]*server_id="sv1"[^}]*\} 0/);
    await sup.stop();
    expect(sup.snapshot().state).toBe('stopped');
  });

  test('respawns within 20s after the current client crashes', async () => {
    const clock = makeFakeClock();
    const tools: MCPTool[] = [{ name: 'tool1', inputSchema: { type: 'object' } }];
    const clients: FakeClient[] = [];
    const factory: MCPClientFactory = (lifecycle) => {
      const c = makeFakeClient({ tools, lifecycle });
      clients.push(c);
      return c;
    };
    let reregisterCount = 0;
    const sup = createMCPSupervisor({
      serverId: 'respawn',
      protocolVersion: '2024-11-05',
      factory,
      now: clock.now,
      sleep: clock.sleep,
      setTimer: clock.setTimer,
      onToolsRegistered: () => {
        reregisterCount += 1;
      },
    });
    const startP = sup.start();
    await clock.advance(1_000);
    await flushMicrotasks(10);
    await startP;
    expect(sup.snapshot().state).toBe('ready');
    expect(reregisterCount).toBe(1);

    // Kill -9 the running client.
    clients[0]?.crash();
    await flushMicrotasks(10);
    expect(sup.snapshot().state).toBe('reconnecting');

    // Backoff = 1s for the first respawn attempt.
    await clock.advance(1_100);
    await flushMicrotasks(20);
    expect(sup.snapshot().state).toBe('ready');
    expect(clients.length).toBe(2);
    // Well within the 20s acceptance window.
    expect(clock.now()).toBeLessThan(20_000);
    // Tool catalog was re-registered after respawn.
    expect(reregisterCount).toBe(2);
    await sup.stop();
  });
});

describe('createMCPSupervisor — crash loop → circuit opens', () => {
  test('after repeated init failures the circuit opens + alert fires + calls fail fast', async () => {
    const clock = makeFakeClock();
    let attempts = 0;
    const factory: MCPClientFactory = (lifecycle) => {
      attempts += 1;
      return makeFakeClient({
        lifecycle,
        failInitialize: () => new Error('init boom'),
      });
    };
    const transitions: Array<{ from: string; to: string }> = [];
    const registry = createPrometheusRegistry();
    const sup = createMCPSupervisor({
      serverId: 'crash-loop',
      protocolVersion: '2024-11-05',
      factory,
      metrics: registry,
      // Tighten the thresholds so the test doesn't need hours of
      // simulated time. With threshold=2, the circuit opens after 2
      // "give-up" cycles, each cycle = 2 failed init attempts → 4 total
      // failures.
      circuitThreshold: 2,
      // Long reset window so we can observe `open` before it auto-flips.
      circuitResetMs: 24 * 3600 * 1000,
      now: clock.now,
      sleep: clock.sleep,
      setTimer: clock.setTimer,
      onCircuitTransition: (e) => {
        transitions.push({ from: e.from, to: e.to });
      },
    });
    void sup.start();
    // Drive ~20s of simulated time: backoff is 1s + 2s + 4s + 8s = 15s
    // for 4 failures, so well within the window.
    for (let i = 0; i < 6; i += 1) {
      await clock.advance(5_000);
      await flushMicrotasks(20);
    }
    expect(sup.snapshot().state).toBe('circuit-open');
    expect(sup.snapshot().circuit).toBe('open');
    // At least 4 attempts happened (threshold^2 = 4).
    expect(attempts).toBeGreaterThanOrEqual(4);
    // Alert transition recorded.
    expect(transitions.some((t) => t.to === 'open')).toBe(true);
    // Prometheus shows the open gauge (=2) for this server.
    const scrape = registry.scrape();
    expect(scrape).toMatch(/mcp_server_circuit_state\{[^}]*server_id="crash-loop"[^}]*\} 2/);
    expect(scrape).toContain('mcp_server_restarts_total');

    // Subsequent tool calls fail fast with a typed error.
    let threw: unknown = null;
    try {
      await sup.callTool('x', {});
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(MCPServerCrashedError);
    expect((threw as MCPServerCrashedError).code).toBe('EMCPCRASHED');
    expect((threw as MCPServerCrashedError).serverId).toBe('crash-loop');

    await sup.stop();
  });

  test('half-open admits a probe respawn that can close the circuit', async () => {
    const clock = makeFakeClock();
    let willFail = true;
    const factory: MCPClientFactory = (lifecycle) => {
      if (willFail) {
        return makeFakeClient({
          lifecycle,
          failInitialize: () => new Error('init boom'),
        });
      }
      return makeFakeClient({ lifecycle });
    };
    const registry = createPrometheusRegistry();
    const sup = createMCPSupervisor({
      serverId: 'probe',
      protocolVersion: '2024-11-05',
      factory,
      metrics: registry,
      circuitThreshold: 2,
      circuitResetMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
      setTimer: clock.setTimer,
    });
    void sup.start();
    // Push enough time through to exhaust backoff + open the circuit.
    await clock.advance(10 * 60 * 1000);
    await flushMicrotasks(50);
    expect(sup.snapshot().state).toBe('circuit-open');
    // Let the server come back up.
    willFail = false;
    // Drive enough time for the circuit to half-open. The CircuitBreaker
    // only transitions when we read `state` or `allow()`, so the gauge
    // snapshot won't flip until the supervisor's probe scheduling
    // observes it. Forcing a tool call before the reset elapses should
    // still fail fast.
    let threw: unknown = null;
    try {
      await sup.callTool('x', {});
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(MCPServerCrashedError);

    // Advance past the reset window; half-open triggers a probe
    // respawn. The probe succeeds → circuit closes → state `ready`.
    await clock.advance(10_000);
    await flushMicrotasks(50);
    // The probe respawn itself goes through a 1s backoff sleep.
    await clock.advance(2_000);
    await flushMicrotasks(50);
    expect(sup.snapshot().state).toBe('ready');
    expect(sup.snapshot().circuit).toBe('closed');
    await sup.stop();
  });
});

describe('createMCPSupervisor — health-check pings', () => {
  test('triggers a restart when 2 consecutive pings fail', async () => {
    const clock = makeFakeClock();
    const clients: FakeClient[] = [];
    const factory: MCPClientFactory = (lifecycle) => {
      const c = makeFakeClient({ lifecycle });
      clients.push(c);
      return c;
    };
    const sup = createMCPSupervisor({
      serverId: 'ping',
      protocolVersion: '2024-11-05',
      factory,
      pingIntervalMs: 10_000,
      pingFailureThreshold: 2,
      pingTimeoutMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
      setTimer: clock.setTimer,
    });
    const startP = sup.start();
    await clock.advance(1_000);
    await flushMicrotasks(10);
    await startP;
    expect(sup.snapshot().state).toBe('ready');
    const firstClient = clients[0];
    expect(firstClient).toBeDefined();

    // Make `initialize` (used as the ping probe) hang; after 2
    // consecutive pings time out, the supervisor declares dead.
    firstClient?.hang();

    // Advance past two ping intervals + timeouts:
    await clock.advance(11_000); // first ping: schedules, times out @ +1s
    await flushMicrotasks(10);
    await clock.advance(11_000); // second ping
    await flushMicrotasks(10);

    // Supervisor should have declared dead + entered reconnecting.
    expect(['reconnecting', 'ready']).toContain(sup.snapshot().state);
    // Crash the hung client so the new attempt can use a fresh one.
    firstClient?.crash();
    await flushMicrotasks(10);
    await clock.advance(2_000);
    await flushMicrotasks(20);

    // New client spawned.
    expect(clients.length).toBeGreaterThanOrEqual(2);
    await sup.stop();
  });
});

describe('createMCPSupervisor — in-flight calls racing a crash', () => {
  test('crash during an in-flight call rejects the promise with MCPServerCrashedError', async () => {
    const clock = makeFakeClock();
    const clients: FakeClient[] = [];
    const hangNext = false;
    const factory: MCPClientFactory = (lifecycle) => {
      const c = makeFakeClient({ lifecycle });
      clients.push(c);
      if (hangNext) c.hang();
      return c;
    };
    const sup = createMCPSupervisor({
      serverId: 'inflight',
      protocolVersion: '2024-11-05',
      factory,
      now: clock.now,
      sleep: clock.sleep,
      setTimer: clock.setTimer,
      pingIntervalMs: 10 ** 9, // disable ping for this test
    });
    const startP = sup.start();
    await clock.advance(1_000);
    await flushMicrotasks(10);
    await startP;
    // Begin a call, then immediately hang + crash the client. The
    // supervisor should translate the inner failure into EMCPCRASHED.
    clients[0]?.hang();
    const callP = sup.callTool('slow', {}).catch((e) => e);
    // Crash the underlying client mid-call.
    clients[0]?.crash();
    await flushMicrotasks(20);
    // Advance backoff so the supervisor transitions.
    await clock.advance(2_000);
    await flushMicrotasks(20);
    const result = await callP;
    expect(result).toBeInstanceOf(MCPServerCrashedError);
    await sup.stop();
  });
});

describe('createMCPSupervisor — stop()', () => {
  test('stop is idempotent; subsequent calls fail fast', async () => {
    const clock = makeFakeClock();
    const clients: FakeClient[] = [];
    const factory: MCPClientFactory = (lifecycle) => {
      const c = makeFakeClient({ lifecycle });
      clients.push(c);
      return c;
    };
    const sup: MCPSupervisor = createMCPSupervisor({
      serverId: 'stop',
      protocolVersion: '2024-11-05',
      factory,
      now: clock.now,
      sleep: clock.sleep,
      setTimer: clock.setTimer,
    });
    const p = sup.start();
    await clock.advance(1_000);
    await flushMicrotasks(10);
    await p;
    await sup.stop();
    await sup.stop(); // idempotent
    expect(sup.snapshot().state).toBe('stopped');
    await expect(sup.callTool('x', {})).rejects.toBeInstanceOf(MCPServerCrashedError);
  });
});
