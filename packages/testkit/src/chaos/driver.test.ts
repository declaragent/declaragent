import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createChaosDriver } from './driver.js';
import type { ChaosEvent, ChaosFault, ChaosPolicy, ChaosTargetRuntime } from './types.js';

interface CapturedFault {
  kind: ChaosFault['kind'];
  args: unknown[];
}

function captureRuntime(captured: CapturedFault[]): ChaosTargetRuntime {
  return {
    async killReplica(id) {
      captured.push({ kind: 'kill-replica', args: [id] });
    },
    async partitionBroker(broker, duration) {
      captured.push({ kind: 'partition-broker', args: [broker, duration] });
    },
    async partitionChannel(id, duration) {
      captured.push({ kind: 'partition-channel', args: [id, duration] });
    },
    async pressureBus(factor, duration) {
      captured.push({ kind: 'bus-high-watermark', args: [factor, duration] });
    },
    async expireIdempotencyCache() {
      captured.push({ kind: 'expire-idempotency-cache', args: [] });
    },
    async clockSkew(offset, duration) {
      captured.push({ kind: 'clock-skew', args: [offset, duration] });
    },
    async networkLatency(target, extra, duration) {
      captured.push({ kind: 'network-latency', args: [target, extra, duration] });
    },
  };
}

interface Scheduler {
  fn?: () => void;
  fire(): void;
  cleared: boolean;
}

function makeScheduler(): Scheduler {
  const s: Scheduler = {
    cleared: false,
    fire() {
      s.fn?.();
    },
  };
  return s;
}

let schedulers: Scheduler[];

beforeEach(() => {
  schedulers = [];
});

afterEach(() => {
  schedulers = [];
});

function newScheduler(): Scheduler {
  const s = makeScheduler();
  schedulers.push(s);
  return s;
}

function driverWithScheduler(policy: ChaosPolicy, runtime: ChaosTargetRuntime, seed = 0.0) {
  const scheduler = newScheduler();
  let clock = 0;
  const now = (): number => clock;
  let rngCursor = seed;
  const random = (): number => {
    const r = rngCursor;
    rngCursor = (rngCursor + 0.17) % 1; // deterministic rotation
    return r;
  };
  const driver = createChaosDriver({
    policy,
    runtime,
    clock: now,
    random,
    setInterval: ((fn: () => void) => {
      scheduler.fn = fn;
      return scheduler;
    }) as unknown as typeof setInterval,
    clearInterval: ((h: unknown) => {
      (h as Scheduler).cleared = true;
    }) as unknown as typeof clearInterval,
  });
  return {
    driver,
    scheduler,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('createChaosDriver — schedule semantics', () => {
  it('fires a fault when the RNG roll ≤ probability', async () => {
    const captured: CapturedFault[] = [];
    const runtime = captureRuntime(captured);
    const policy: ChaosPolicy = {
      intervalMs: 1000,
      probability: 1,
      faults: [{ kind: 'expire-idempotency-cache' }],
    };
    const { driver, scheduler } = driverWithScheduler(policy, runtime);
    await driver.start();
    scheduler.fire();
    // Allow the fire-and-forget dispatch to complete.
    await new Promise((r) => setTimeout(r, 5));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('expire-idempotency-cache');
    await driver.stop();
    expect(scheduler.cleared).toBe(true);
  });

  it('skips firing when RNG roll > probability', async () => {
    const captured: CapturedFault[] = [];
    const policy: ChaosPolicy = {
      intervalMs: 1000,
      probability: 0,
      faults: [{ kind: 'expire-idempotency-cache' }],
    };
    const { driver, scheduler } = driverWithScheduler(policy, captureRuntime(captured));
    await driver.start();
    scheduler.fire();
    await new Promise((r) => setTimeout(r, 5));
    expect(captured).toHaveLength(0);
    await driver.stop();
  });

  it('emits budget-exhausted once the cap is reached', async () => {
    const captured: CapturedFault[] = [];
    const policy: ChaosPolicy = {
      intervalMs: 1000,
      probability: 1,
      faults: [{ kind: 'expire-idempotency-cache' }],
      budget: 2,
    };
    const { driver, scheduler } = driverWithScheduler(policy, captureRuntime(captured));
    const events: ChaosEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start();
    scheduler.fire();
    scheduler.fire();
    scheduler.fire();
    await new Promise((r) => setTimeout(r, 5));
    expect(captured).toHaveLength(2);
    const exhausted = events.find((e) => e.kind === 'budget-exhausted');
    expect(exhausted).toBeDefined();
    await driver.stop();
  });

  it('inject() fires regardless of policy + never counts against budget', async () => {
    const captured: CapturedFault[] = [];
    const policy: ChaosPolicy = {
      intervalMs: 1000,
      probability: 0,
      faults: [{ kind: 'expire-idempotency-cache' }],
      budget: 1,
    };
    const { driver } = driverWithScheduler(policy, captureRuntime(captured));
    await driver.start();
    await driver.inject({ kind: 'clock-skew', offsetMs: 1000, durationMs: 10 });
    await driver.inject({ kind: 'expire-idempotency-cache' });
    await driver.stop();
    expect(captured.map((c) => c.kind)).toEqual(['clock-skew', 'expire-idempotency-cache']);
  });

  it('rejects invalid policy', () => {
    const runtime: ChaosTargetRuntime = {};
    expect(() =>
      createChaosDriver({
        policy: { intervalMs: 0, probability: 1, faults: [{ kind: 'expire-idempotency-cache' }] },
        runtime,
      }),
    ).toThrow(/intervalMs/);
    expect(() =>
      createChaosDriver({
        policy: { intervalMs: 1, probability: 1.5, faults: [{ kind: 'expire-idempotency-cache' }] },
        runtime,
      }),
    ).toThrow(/probability/);
    expect(() =>
      createChaosDriver({
        policy: { intervalMs: 1, probability: 1, faults: [] },
        runtime,
      }),
    ).toThrow(/faults/);
  });

  it('surfaces fault.error when the runtime throws', async () => {
    const runtime: ChaosTargetRuntime = {
      async expireIdempotencyCache() {
        throw new Error('cache service down');
      },
    };
    const policy: ChaosPolicy = {
      intervalMs: 1000,
      probability: 1,
      faults: [{ kind: 'expire-idempotency-cache' }],
    };
    const { driver, scheduler } = driverWithScheduler(policy, runtime);
    const events: ChaosEvent[] = [];
    driver.onEvent((e) => events.push(e));
    await driver.start();
    scheduler.fire();
    await new Promise((r) => setTimeout(r, 10));
    const report = await driver.stop();
    const errEvent = events.find((e) => e.kind === 'fault.error');
    expect(errEvent).toBeDefined();
    expect(report.timeline[0]?.error?.message).toBe('cache service down');
  });

  it('surfaces "not implemented" errors as fault.error', async () => {
    const runtime: ChaosTargetRuntime = {};
    const policy: ChaosPolicy = {
      intervalMs: 1000,
      probability: 1,
      faults: [{ kind: 'kill-replica', replicaId: 'r-1' }],
    };
    const { driver } = driverWithScheduler(policy, runtime);
    await driver.start();
    await driver.inject({ kind: 'kill-replica', replicaId: 'r-1' });
    const report = await driver.stop();
    expect(report.timeline[0]?.error?.message).toContain('killReplica not implemented');
  });
});
