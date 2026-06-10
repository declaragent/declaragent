/**
 * Multi-process fleet harness for the Kafka soak.
 *
 * Spec: `docs/ENTERPRISE_PRODUCTION_PLAN.md` §3 #1 · "Finish Kafka soak"
 * + `docs/POST_ENTERPRISE_BACKLOG.md` §1 Item #26 — "literal
 * declaragent fleet run subprocess spawn".
 *
 * Goal: satisfy Acceptance #1 — `bun test --preload fleet-integration`
 * passes across **two** processes talking over a shared Redpanda (not
 * just one process round-tripping). The existing
 * `kafka-rpc.test.ts` does the single-process case; this harness boots
 * two genuinely separate Bun subprocesses, each owning its own kafkajs
 * client + consumer group, so rebalance + producer-acks + broker
 * partition assignment are all exercised against a real cluster.
 *
 * ## How it works
 *   1. `startTwoAgentFleet()` writes a real `fleet.yaml` +
 *      `capabilities.yaml` + `agent.yaml` tree to a tempdir — the same
 *      layout a user would ship on disk.
 *   2. `startAgent()` spawns `fleet-run-subprocess.ts` as a Bun
 *      subprocess pointing at that tempdir. The subprocess loads the
 *      manifest via `@declaragent/core`'s `loadFleet`, wires a kafka
 *      transport via `@declaragent/plugin-agent-rpc`, and subscribes
 *      on the declared requests topic.
 *   3. The worker reports `{event:"ready"}` on stdout once the kafka
 *      producer has connected and the subscription is live.
 *   4. Later lines feed per-agent counters so tests can assert on
 *      `received` + `responded` counts.
 *   5. `createClientTransport()` returns a plain `RpcTransport` bound
 *      to the same brokers. The **test** side uses this to drive the
 *      mixed-traffic workload + observe response latency.
 *   6. `stopAll()` sends SIGTERM to each worker, waits for the
 *      `{event:"stopped"}` marker, then gives up + SIGKILLs after a
 *      grace window. Transport close is the worker's job.
 *
 * ## Fidelity vs. true `declaragent fleet run`
 *
 * Pre-#26 the subprocess ran an inline subscribe→publish loop — lower
 * fidelity than production. Now the subprocess runs the real manifest
 * loader + capabilities parser and walks the agent's declared
 * transports, matching what `startFleetDaemon` → `startAgentWorker`
 * does end-to-end, minus the LLM handler (mocked — see the
 * `fleet-run-subprocess` docstring) and minus the memory-bound respond
 * hook (see same docstring for why the respond path must come from the
 * kafka transport, not memory).
 *
 * If / when `startFleetDaemon` grows per-transport respond hooks
 * (today's memory-only hardwire is an upstream limitation), the
 * subprocess body can flip to a bare `startFleetDaemon(...)` call
 * without changing this harness's public API.
 *
 * @since 0.6.1 · rev 0.7.1 — backlog #26 real-manifest subprocess
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RpcTransport } from '@declaragent/core';
import { createKafkaTransport } from '@declaragent/plugin-agent-rpc';
import { resolveKafkaJsModule } from './kafkajs-resolver.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface AgentProcessHandle {
  readonly agentId: string;
  readonly requestTopic: string;
  readonly responseTopic: string;
  readonly pid: number | null;
  /** Count of `{event:"received"}` lines observed from the worker. */
  receivedCount(): number;
  /** Count of `{event:"responded"}` lines observed from the worker. */
  respondedCount(): number;
  /** Count of `{event:"error"}` lines observed from the worker. */
  errorCount(): number;
  /** Resolves when the worker's `exit` event fires. */
  exited(): Promise<number | null>;
  /** SIGTERM + grace window. Safe to call multiple times. */
  stop(graceMs?: number): Promise<void>;
}

export interface MultiProcessHarness {
  readonly brokers: readonly string[];
  readonly agents: ReadonlyMap<string, AgentProcessHandle>;
  /**
   * Returns a fresh transport for the **test driver** side. Callers own
   * the returned transport and must call `.close()` themselves.
   */
  createClientTransport(clientId: string): Promise<RpcTransport>;
  /** SIGTERMs every agent + waits for exit. */
  stopAll(graceMs?: number): Promise<void>;
}

export interface StartAgentOptions {
  agentId: string;
  brokers: readonly string[];
  requestTopic: string;
  responseTopic: string;
  /**
   * Directory containing the fleet manifest the subprocess should load.
   * Produced by {@link scaffoldFleetManifest} when callers boot via
   * {@link startTwoAgentFleet}; direct `startAgent` callers must supply
   * one themselves.
   *
   * @since 0.7.1 — required by the literal-fleet-run subprocess.
   */
  fleetRoot: string;
  clientId?: string;
  groupId?: string;
  readyTimeoutMs?: number;
}

export interface StartTwoAgentFleetOptions {
  brokers: readonly string[];
  /** Prefix for auto-generated topics — keeps cross-run dirty state out. */
  topicPrefix?: string;
  readyTimeoutMs?: number;
}

// ── Worker resolution ────────────────────────────────────────────────────

// Bun supports `import.meta.url` natively. Resolving the worker path
// through the module URL lets the harness work whether the caller runs
// `bun test` from the repo root or from `packages/testkit`.
const HERE = dirname(fileURLToPath(import.meta.url));
// The literal-fleet-run subprocess — loads `fleet.yaml` + capabilities
// via `@declaragent/core` before wiring kafka. See #26 rationale in
// `fleet-run-subprocess.ts`.
const WORKER_PATH = resolve(HERE, 'fleet-run-subprocess.ts');

// ── Public API ───────────────────────────────────────────────────────────

export async function startAgent(opts: StartAgentOptions): Promise<AgentProcessHandle> {
  const clientId = opts.clientId ?? `declaragent-soak-${opts.agentId}`;
  const groupId = opts.groupId ?? `declaragent-soak-${opts.agentId}-${Date.now()}`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

  const child: ChildProcess = spawn(
    'bun',
    [
      'run',
      WORKER_PATH,
      `--fleet-root=${opts.fleetRoot}`,
      `--agent-id=${opts.agentId}`,
      `--brokers=${opts.brokers.join(',')}`,
      `--client-id=${clientId}`,
      `--group-id=${groupId}`,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  let received = 0;
  let responded = 0;
  let errors = 0;
  let ready = false;
  let readyResolve: () => void = () => {};
  let readyReject: (err: Error) => void = () => {};
  const readyPromise = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  let stoppedResolve: () => void = () => {};
  const stoppedPromise = new Promise<void>((res) => {
    stoppedResolve = res;
  });
  let exitCode: number | null = null;
  let exited = false;
  let exitResolve: (code: number | null) => void = () => {};
  const exitPromise = new Promise<number | null>((res) => {
    exitResolve = res;
  });

  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error(`startAgent(${opts.agentId}): spawned child has no stdout`);
  }
  const stderr = child.stderr;

  let buf = '';
  stdout.setEncoding('utf-8');
  stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
      if (line.length === 0) continue;
      handleLine(line);
    }
  });

  if (stderr !== null) {
    stderr.setEncoding('utf-8');
    stderr.on('data', (chunk: string) => {
      // Forward stderr to the parent test's stderr so a failing worker
      // is debuggable. Quiet the common "ready for fatal" noise by
      // prefixing with the agent id.
      process.stderr.write(`[worker:${opts.agentId}] ${chunk}`);
    });
  }

  function handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON worker output (e.g. kafkajs logs) — forward verbatim.
      process.stderr.write(`[worker:${opts.agentId}] ${line}\n`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const rec = parsed as { event?: unknown };
    switch (rec.event) {
      case 'ready':
        ready = true;
        readyResolve();
        break;
      case 'received':
        received += 1;
        break;
      case 'responded':
        responded += 1;
        break;
      case 'error':
        errors += 1;
        break;
      case 'stopped':
        stoppedResolve();
        break;
      case 'fatal': {
        const err = new Error(`worker ${opts.agentId} reported fatal: ${JSON.stringify(rec)}`);
        if (!ready) readyReject(err);
        errors += 1;
        break;
      }
      default:
        // Unknown event — forward for debuggability but don't fail.
        process.stderr.write(`[worker:${opts.agentId}] ${line}\n`);
    }
  }

  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
    stoppedResolve();
    exitResolve(code);
    if (!ready) {
      readyReject(new Error(`worker ${opts.agentId} exited before ready (code=${code})`));
    }
  });

  child.on('error', (err) => {
    if (!ready) readyReject(err);
  });

  const readyTimer = setTimeout(() => {
    if (!ready) {
      readyReject(
        new Error(`worker ${opts.agentId} did not reach ready within ${readyTimeoutMs}ms`),
      );
    }
  }, readyTimeoutMs);
  readyTimer.unref?.();

  try {
    await readyPromise;
  } catch (err) {
    // Ensure the child is reaped if ready fails.
    try {
      child.kill('SIGKILL');
    } catch {
      // child may already be dead
    }
    throw err;
  } finally {
    clearTimeout(readyTimer);
  }

  const handle: AgentProcessHandle = {
    agentId: opts.agentId,
    requestTopic: opts.requestTopic,
    responseTopic: opts.responseTopic,
    get pid() {
      return child.pid ?? null;
    },
    receivedCount: () => received,
    respondedCount: () => responded,
    errorCount: () => errors,
    exited: () => exitPromise,
    async stop(graceMs = 5_000): Promise<void> {
      if (exited) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
      const graceWinner = await Promise.race([
        stoppedPromise.then(() => 'stopped' as const),
        new Promise<'timeout'>((res) => {
          const t = setTimeout(() => res('timeout'), graceMs);
          t.unref?.();
        }),
      ]);
      if (graceWinner === 'timeout' && !exited) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
      await exitPromise;
      // Reference exitCode so linters don't flag it as unused; callers
      // consume it via `exited()`.
      void exitCode;
    },
  };
  return handle;
}

export async function startTwoAgentFleet(
  opts: StartTwoAgentFleetOptions,
): Promise<MultiProcessHarness> {
  const prefix = opts.topicPrefix ?? `declaragent-soak-${Date.now()}-${randomSuffix()}`;
  const alphaRequests = `${prefix}-alpha-requests`;
  const alphaResponses = `${prefix}-alpha-responses`;
  const betaRequests = `${prefix}-beta-requests`;
  const betaResponses = `${prefix}-beta-responses`;

  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

  // #26 — real fleet manifest on disk. The subprocess loads this via
  // `loadFleet`, so any regression in the manifest parser, capabilities
  // validator, or per-agent loader surfaces in soak CI.
  const fleetRoot = scaffoldFleetManifest({
    alphaRequests,
    alphaResponses,
    betaRequests,
    betaResponses,
  });

  // Start in parallel; if either fails, reap the other + remove tempdir.
  const alphaP = startAgent({
    agentId: 'alpha',
    brokers: opts.brokers,
    requestTopic: alphaRequests,
    responseTopic: alphaResponses,
    fleetRoot,
    readyTimeoutMs,
  });
  const betaP = startAgent({
    agentId: 'beta',
    brokers: opts.brokers,
    requestTopic: betaRequests,
    responseTopic: betaResponses,
    fleetRoot,
    readyTimeoutMs,
  });

  const [alphaResult, betaResult] = await Promise.allSettled([alphaP, betaP]);

  if (alphaResult.status === 'rejected' || betaResult.status === 'rejected') {
    // Best-effort cleanup of whichever side booted.
    if (alphaResult.status === 'fulfilled') await alphaResult.value.stop(2_000);
    if (betaResult.status === 'fulfilled') await betaResult.value.stop(2_000);
    try {
      rmSync(fleetRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    const why =
      alphaResult.status === 'rejected'
        ? alphaResult.reason
        : betaResult.status === 'rejected'
          ? betaResult.reason
          : new Error('unknown');
    throw why instanceof Error ? why : new Error(String(why));
  }

  const alpha = alphaResult.value;
  const beta = betaResult.value;

  const agents = new Map<string, AgentProcessHandle>([
    ['alpha', alpha],
    ['beta', beta],
  ]);

  return {
    brokers: opts.brokers,
    agents,
    async createClientTransport(clientId: string): Promise<RpcTransport> {
      return createKafkaTransport({
        brokers: opts.brokers,
        clientId,
        groupId: `${clientId}-${Date.now()}-${randomSuffix()}`,
        kafkajsModule: resolveKafkaJsModule(),
      });
    },
    async stopAll(graceMs = 5_000): Promise<void> {
      await Promise.allSettled(Array.from(agents.values()).map((a) => a.stop(graceMs)));
      try {
        rmSync(fleetRoot, { recursive: true, force: true });
      } catch {
        // best-effort — tempdir leak is not worth a loud teardown error.
      }
    },
  };
}

// ── Manifest scaffolding (item #26) ──────────────────────────────────────

interface ScaffoldOptions {
  alphaRequests: string;
  alphaResponses: string;
  betaRequests: string;
  betaResponses: string;
}

/**
 * Writes a minimal-but-real two-agent fleet layout into a fresh tempdir:
 *
 *     <tmp>/
 *       fleet.yaml
 *       rpc-peers.yaml
 *       agents/
 *         alpha/
 *           agent.yaml
 *           capabilities.yaml
 *         beta/
 *           agent.yaml
 *           capabilities.yaml
 *
 * The manifest declares a `kind: kafka` transport block on each agent
 * pointed at the caller-supplied topic names — so `createKafkaTransport`
 * inside the subprocess picks up the same topics the driver produces
 * to. The `agent.yaml` blocks are intentionally minimal (no skills, no
 * event sources) — this harness isn't testing the engine turn, only the
 * manifest loader + kafka subscribe path.
 *
 * Returns the absolute path to the tempdir; caller owns teardown.
 */
function scaffoldFleetManifest(opts: ScaffoldOptions): string {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-soak-fleet-'));
  const agentsDir = join(root, 'agents');
  const alphaDir = join(agentsDir, 'alpha');
  const betaDir = join(agentsDir, 'beta');
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });

  writeFileSync(
    join(root, 'fleet.yaml'),
    `version: 1
name: declaragent-kafka-soak
description: Ephemeral fleet scaffolded by the kafka soak harness (#26).
agents:
  - id: alpha
    path: ./agents/alpha
    env: shared
  - id: beta
    path: ./agents/beta
    env: shared
environments:
  shared:
    peersRef: ./rpc-peers.yaml
`,
  );

  writeFileSync(
    join(root, 'rpc-peers.yaml'),
    `version: 1
peers:
  - agent: agent://alpha
    transports:
      - kind: kafka
        brokers: ["ignored-at-subscribe-time"]
        topics:
          requests: ${opts.alphaRequests}
  - agent: agent://beta
    transports:
      - kind: kafka
        brokers: ["ignored-at-subscribe-time"]
        topics:
          requests: ${opts.betaRequests}
`,
  );

  writeAgentFiles({
    dir: alphaDir,
    agentId: 'alpha',
    requestsTopic: opts.alphaRequests,
    responsesTopic: opts.alphaResponses,
  });
  writeAgentFiles({
    dir: betaDir,
    agentId: 'beta',
    requestsTopic: opts.betaRequests,
    responsesTopic: opts.betaResponses,
  });

  return root;
}

interface AgentFilesOptions {
  dir: string;
  agentId: string;
  requestsTopic: string;
  responsesTopic: string;
}

function writeAgentFiles(o: AgentFilesOptions): void {
  writeFileSync(
    join(o.dir, 'agent.yaml'),
    `name: ${o.agentId}
model: claude-haiku-4-5
systemPrompt: |
  Soak-harness mock agent; never actually invoked since the subprocess
  uses the echo handler in fleet-run-subprocess.ts.
`,
  );
  writeFileSync(
    join(o.dir, 'capabilities.yaml'),
    `version: 1
agent: agent://${o.agentId}
transports:
  - kind: kafka
    brokers: ["ignored-at-subscribe-time"]
    topics:
      requests: ${o.requestsTopic}
      responses: ${o.responsesTopic}
capabilities:
  - name: ${o.agentId}.ping
    description: "Soak-harness echo capability for agent ${o.agentId}."
    timeoutMs: 30000
    idempotent: true
  - name: ${o.agentId}.channel-send
    description: "Soak-harness channel-style echo for agent ${o.agentId}."
    timeoutMs: 30000
    idempotent: true
  - name: ${o.agentId}.cron-tick
    description: "Soak-harness cron-tick echo for agent ${o.agentId}."
    timeoutMs: 30000
    idempotent: true
`,
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
