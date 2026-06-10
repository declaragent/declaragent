/**
 * Kafka soak — Enterprise Production Plan item #1.
 *
 * Spec: `docs/ENTERPRISE_PRODUCTION_PLAN.md` §3 #1 · Acceptance #2:
 *
 *   > A new `packages/testkit/src/fleet-integration/kafka-soak.test.ts`
 *   > runs ≥ 24h in CI weekly with zero dropped envelopes and p99 ≤ 3s
 *   > RTT.
 *
 * Plus Acceptance #1: two genuinely separate processes must both stay
 * up across the window; any worker crash is a drift alarm.
 *
 * ## What this test does
 *
 *   1. Boots two `startFleetDaemon`-shaped processes (see
 *      `harness/multi-process.ts`) against a shared Redpanda.
 *   2. Runs a warm-up phase (30 round trips, untimed) so Kafka
 *      rebalance + topic auto-create settle before we record a p99
 *      baseline.
 *   3. Records a baseline p99 over the first ~60s of timed traffic.
 *   4. Runs the full soak at **~1 req/s** for the configured duration,
 *      cycling through three traffic kinds to imitate a real fleet:
 *        - inter-agent RPC     (alpha → beta → alpha response)
 *        - channel-style sends (fire-and-forget beta → alpha events)
 *        - cron-tick pulses    (alpha self-tick with a response topic)
 *   5. Alarms (fails the test) if:
 *        - any envelope is dropped (response never arrives within
 *          the per-request deadline);
 *        - the rolling p99 RTT exceeds 2× the recorded baseline;
 *        - either worker process exits unexpectedly.
 *
 * ## How to run
 *
 *   # Quick smoke (~30s, CI non-nightly):
 *   KAFKA_SOAK=1 KAFKA_SOAK_DURATION_MS=30000 \
 *     KAFKA_BROKERS=localhost:19092 bun test kafka-soak
 *
 *   # Full 24h weekly (see `.github/workflows/weekly-soak.yml`):
 *   KAFKA_SOAK=1 KAFKA_SOAK_DURATION_MS=86400000 \
 *     KAFKA_BROKERS=localhost:19092 bun test kafka-soak
 *
 * `KAFKA_SOAK=1` is required to opt in — the test is always skipped
 * otherwise so regular `bun test` stays fast. The separate
 * `FLEET_INTEGRATION=1` flag governs `kafka-rpc.test.ts` independently.
 *
 * ## Tuning knobs
 *
 *   - `KAFKA_SOAK_DURATION_MS` — total soak length. Default 30_000.
 *   - `KAFKA_SOAK_RATE_HZ`     — per-second request rate. Default 1.
 *   - `KAFKA_SOAK_BASELINE_MS` — baseline window length. Default 60_000,
 *                                clamped ≤ 1/4 of total duration.
 *   - `KAFKA_BROKERS`          — comma-separated brokers. Default
 *                                `localhost:19092`.
 *
 * @since 0.6.1
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope, RpcTransport } from '@declaragent/core';
import { type MultiProcessHarness, startTwoAgentFleet } from './harness/multi-process.js';

// ── Configuration ────────────────────────────────────────────────────────

const ENABLED = process.env.KAFKA_SOAK === '1';
const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number (got: ${raw})`);
  }
  return n;
}

const DURATION_MS = readNumberEnv('KAFKA_SOAK_DURATION_MS', 30_000);
const RATE_HZ = readNumberEnv('KAFKA_SOAK_RATE_HZ', 1);
const RAW_BASELINE_MS = readNumberEnv('KAFKA_SOAK_BASELINE_MS', 60_000);
const BASELINE_MS = Math.min(RAW_BASELINE_MS, Math.floor(DURATION_MS / 4));

// Per-request deadline. The spec sets the p99 ceiling at 3s RTT. Give
// the deadline 5× headroom before declaring a dropped envelope — the
// soak's alarm for slow-but-not-lost traffic is the p99 comparison, not
// the deadline.
const REQUEST_DEADLINE_MS = 15_000;

// ── Bun skip gate ────────────────────────────────────────────────────────

const describeSoak = ENABLED ? describe : describe.skip;

// ── Metrics ──────────────────────────────────────────────────────────────

interface LatencySample {
  readonly ms: number;
  readonly kind: TrafficKind;
  readonly t: number;
}

function p99(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99)));
  // Non-null assertion: `sorted` is non-empty and idx is clamped in range.
  return sorted[idx] as number;
}

// ── Pending registry (test-side) ─────────────────────────────────────────
//
// We keep a tiny correlation-id → resolver map so the test-driver
// transport's subscribe callback can settle the right promise. This
// avoids pulling in the full `pending-registry` from plugin-agent-rpc
// which expects a deeper Pending abstraction than the soak needs.

interface PendingEntry {
  resolve: (env: AgentRpcEnvelope) => void;
  reject: (err: Error) => void;
  sentAt: number;
  kind: TrafficKind;
}

type TrafficKind = 'rpc-request' | 'channel-send' | 'cron-tick';

describeSoak('Kafka soak (24h-capable)', () => {
  let harness: MultiProcessHarness;
  let driver: RpcTransport;
  const driverResponsesTopic = `declaragent-soak-driver-${Date.now()}-responses`;
  const pending = new Map<string, PendingEntry>();

  beforeAll(async () => {
    harness = await startTwoAgentFleet({ brokers: BROKERS });
    driver = await harness.createClientTransport('declaragent-soak-driver');
    driver.subscribe(driverResponsesTopic, async (envelope) => {
      const entry = pending.get(envelope.correlationId);
      if (entry === undefined) return; // late arrival; already timed out
      pending.delete(envelope.correlationId);
      entry.resolve(envelope);
    });

    // Consumer-group rebalance window. Without this, the first publish
    // can race the subscribe and the response gets auto-committed to
    // the group before our handler sees it.
    await sleep(2_000);
  }, /* timeout (ms) */ 60_000);

  afterAll(async () => {
    try {
      await driver?.close();
    } finally {
      await harness?.stopAll(10_000);
    }
  }, /* timeout (ms) */ 60_000);

  test(
    `soak at ${RATE_HZ}Hz for ${DURATION_MS}ms — no drops, p99 ≤ 2× baseline`,
    async () => {
      const warmupSamples = await runWarmup(driver, harness, pending, driverResponsesTopic);
      expect(warmupSamples.dropped).toBe(0);

      const baseline = await runBaseline({
        driver,
        harness,
        pending,
        driverResponsesTopic,
        windowMs: BASELINE_MS,
        rateHz: RATE_HZ,
      });
      expect(baseline.dropped).toBe(0);
      expect(baseline.samples.length).toBeGreaterThan(0);
      const baselineP99 = p99(baseline.samples.map((s) => s.ms));

      const soak = await runSoak({
        driver,
        harness,
        pending,
        driverResponsesTopic,
        durationMs: DURATION_MS - BASELINE_MS,
        rateHz: RATE_HZ,
        baselineP99,
      });

      // Acceptance #2 — zero dropped envelopes.
      expect(soak.dropped).toBe(0);

      // Acceptance #2 — p99 ≤ 2× baseline (drift alarm).
      const soakP99 = p99(soak.samples.map((s) => s.ms));
      expect(soakP99).toBeLessThanOrEqual(baselineP99 * 2);

      // Acceptance #2 — p99 ≤ 3s absolute.
      expect(soakP99).toBeLessThanOrEqual(3_000);

      // Acceptance #1 — both workers still alive.
      for (const agent of harness.agents.values()) {
        // Reading received > 0 is a decent liveness proxy for workers
        // that were driven, but the crucial check is "process still
        // running" — exposed via agent.pid. A terminated worker's pid
        // goes null after the exit event, so any null here means a
        // mid-soak crash.
        expect(agent.pid).not.toBeNull();
        expect(agent.errorCount()).toBe(0);
      }
    },
    // Test timeout: duration + generous epilogue for teardown.
    DURATION_MS + 120_000,
  );
});

if (!ENABLED) {
  describe('Kafka soak (skipped)', () => {
    test('set KAFKA_SOAK=1 + KAFKA_BROKERS to run', () => {
      expect(ENABLED).toBe(false);
    });
  });
}

// ── Traffic generators ───────────────────────────────────────────────────

interface SoakStepInputs {
  driver: RpcTransport;
  harness: MultiProcessHarness;
  pending: Map<string, PendingEntry>;
  driverResponsesTopic: string;
}

interface BaselineInputs extends SoakStepInputs {
  windowMs: number;
  rateHz: number;
}

interface SoakInputs extends SoakStepInputs {
  durationMs: number;
  rateHz: number;
  baselineP99: number;
}

interface SoakResult {
  samples: LatencySample[];
  dropped: number;
}

async function runWarmup(
  driver: RpcTransport,
  harness: MultiProcessHarness,
  pending: Map<string, PendingEntry>,
  driverResponsesTopic: string,
): Promise<SoakResult> {
  const samples: LatencySample[] = [];
  let dropped = 0;
  for (let i = 0; i < 30; i++) {
    const kind: TrafficKind = 'rpc-request';
    try {
      const ms = await drive({
        driver,
        harness,
        pending,
        driverResponsesTopic,
        kind,
        seq: i,
      });
      samples.push({ ms, kind, t: Date.now() });
    } catch {
      dropped += 1;
    }
    await sleep(50);
  }
  return { samples, dropped };
}

async function runBaseline(inputs: BaselineInputs): Promise<SoakResult> {
  return runTrafficLoop({ ...inputs, durationMs: inputs.windowMs, label: 'baseline' });
}

async function runSoak(inputs: SoakInputs): Promise<SoakResult> {
  return runTrafficLoop({ ...inputs, label: 'soak' });
}

interface TrafficLoopInputs extends SoakStepInputs {
  durationMs: number;
  rateHz: number;
  label: string;
}

async function runTrafficLoop(inputs: TrafficLoopInputs): Promise<SoakResult> {
  const samples: LatencySample[] = [];
  let dropped = 0;
  const deadline = Date.now() + inputs.durationMs;
  const periodMs = 1000 / inputs.rateHz;
  let seq = 0;
  const kinds: TrafficKind[] = ['rpc-request', 'channel-send', 'cron-tick'];
  while (Date.now() < deadline) {
    const tickStart = Date.now();
    const kind = kinds[seq % kinds.length] as TrafficKind;
    try {
      const ms = await drive({
        driver: inputs.driver,
        harness: inputs.harness,
        pending: inputs.pending,
        driverResponsesTopic: inputs.driverResponsesTopic,
        kind,
        seq,
      });
      samples.push({ ms, kind, t: Date.now() });
    } catch {
      dropped += 1;
    }
    seq += 1;
    const elapsed = Date.now() - tickStart;
    const wait = periodMs - elapsed;
    if (wait > 0) await sleep(wait);
  }
  return { samples, dropped };
}

interface DriveInputs {
  driver: RpcTransport;
  harness: MultiProcessHarness;
  pending: Map<string, PendingEntry>;
  driverResponsesTopic: string;
  kind: TrafficKind;
  seq: number;
}

async function drive(inputs: DriveInputs): Promise<number> {
  const alpha = inputs.harness.agents.get('alpha');
  const beta = inputs.harness.agents.get('beta');
  if (alpha === undefined || beta === undefined) {
    throw new Error('soak harness: missing alpha/beta agent handle');
  }
  const correlationId = `corr-${inputs.kind}-${inputs.seq}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  // Choose target + topic per traffic kind.
  //   - rpc-request  → beta handles, response to driver inbox
  //   - channel-send → alpha handles an event-shaped request (still
  //                    needs an ack so we can measure RTT + prove no
  //                    drops)
  //   - cron-tick    → alpha handles, identical shape to rpc-request
  //                    but tagged differently so we can sample by kind
  //                    in post-analysis.
  let targetTopic: string;
  let toAgent: string;
  let capability: string;
  switch (inputs.kind) {
    case 'rpc-request':
      targetTopic = beta.requestTopic;
      toAgent = 'beta';
      capability = 'beta-ping';
      break;
    case 'channel-send':
      targetTopic = alpha.requestTopic;
      toAgent = 'alpha';
      capability = 'alpha-channel-send';
      break;
    case 'cron-tick':
      targetTopic = alpha.requestTopic;
      toAgent = 'alpha';
      capability = 'alpha-cron-tick';
      break;
  }

  const envelope: AgentRpcEnvelope = {
    version: 1,
    kind: 'request',
    messageId: `req-${correlationId}`,
    correlationId,
    from: 'agent://driver',
    to: `agent://${toAgent}`,
    capability,
    replyTo: `kafka://${inputs.driverResponsesTopic}`,
    payload: { kind: inputs.kind, seq: inputs.seq, at: Date.now() },
  };

  const sentAt = Date.now();
  const responsePromise = new Promise<AgentRpcEnvelope>((resolve, reject) => {
    inputs.pending.set(correlationId, {
      resolve,
      reject,
      sentAt,
      kind: inputs.kind,
    });
  });
  await inputs.driver.publish(targetTopic, envelope);
  try {
    await Promise.race([
      responsePromise,
      new Promise<never>((_res, rej) => {
        const t = setTimeout(
          () => rej(new Error(`request deadline ${REQUEST_DEADLINE_MS}ms elapsed`)),
          REQUEST_DEADLINE_MS,
        );
        t.unref?.();
      }),
    ]);
  } catch (err) {
    inputs.pending.delete(correlationId);
    throw err;
  }
  return Date.now() - sentAt;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref?.();
  });
}
