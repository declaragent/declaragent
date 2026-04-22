import { describe, expect, test } from 'bun:test';
import type {
  RateLimitedAuditRecord,
  StoredAuditEntry,
  TenantAuditRecord,
  TenantAuditSink,
  VerifyReport,
} from '../audit/types.js';
import { createToolRateLimitGate } from './rate-limit-gate.js';

// ── fake clock + sleep (mirrors providers/rate-limit.test.ts) ─────────────

function makeFakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeFakeSleep(clock: { advance: (ms: number) => void }): {
  sleep: (ms: number) => Promise<void>;
  waits: number[];
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock.advance(ms);
    },
  };
}

function makeRecordingSink(): {
  sink: TenantAuditSink;
  recorded: TenantAuditRecord[];
} {
  const recorded: TenantAuditRecord[] = [];
  const sink: TenantAuditSink = {
    async record(r: TenantAuditRecord) {
      recorded.push(r);
    },
    async query(): Promise<readonly StoredAuditEntry[]> {
      return [];
    },
    async erase(): Promise<number> {
      return 0;
    },
    async verify(): Promise<VerifyReport> {
      return { ok: true, totalEntries: 0, verifiedEntries: 0, violations: [] };
    },
    async prune(): Promise<number> {
      return 0;
    },
    async close() {
      /* no-op */
    },
  };
  return { sink, recorded };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ToolRateLimitGate', () => {
  test('under-limit passes immediately', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 10, burst: 5 } },
      now: clock.now,
      sleep: sleep.sleep,
    });
    for (let i = 0; i < 5; i += 1) {
      expect(await gate.acquire('Bash', { tenantId: 't1' })).toBe(0);
    }
    expect(sleep.waits).toHaveLength(0);
  });

  test('unconfigured tool is uncapped (returns 0 without touching state)', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 1 } },
      now: clock.now,
      sleep: sleep.sleep,
    });
    for (let i = 0; i < 100; i += 1) {
      expect(await gate.acquire('Read', { tenantId: 't1' })).toBe(0);
    }
    expect(sleep.waits).toHaveLength(0);
    expect(gate.has('Read')).toBe(false);
    expect(gate.has('Bash')).toBe(true);
  });

  test('over-limit cooperatively sleeps until a token frees', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 2, burst: 1 } },
      now: clock.now,
      sleep: sleep.sleep,
    });
    // First call drains the 1-token burst immediately.
    expect(await gate.acquire('Bash', { tenantId: 't1' })).toBe(0);
    // Second call waits 500ms (1 token at 2 rps = 500ms).
    const waited = await gate.acquire('Bash', { tenantId: 't1' });
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(sleep.waits).toEqual([waited]);
  });

  test('acceptance #1: Bash capped at 1rps, 10 calls take ≥ 9s (deterministic clock)', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 1 } }, // burst defaults to rps (=1)
      now: clock.now,
      sleep: sleep.sleep,
    });

    const start = clock.now();
    for (let i = 0; i < 10; i += 1) {
      await gate.acquire('Bash', { tenantId: 't1' });
    }
    const elapsedMs = clock.now() - start;

    // First call consumes the burst; each of the remaining 9 waits
    // ~1000 ms. Expected total ≈ 9000 ms.
    expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
    expect(sleep.waits).toHaveLength(9);
  });

  test('acceptance #1 (wall-clock variant): real timers, 1rps × 10 takes ≥ 9s', async () => {
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 1 } },
    });

    const started = performance.now();
    for (let i = 0; i < 10; i += 1) {
      await gate.acquire('Bash', { tenantId: 't1' });
    }
    const elapsedMs = performance.now() - started;

    // Token bucket: 1 burst + 9 refill waits at ~1000 ms each.
    // Allow a tiny floor of 8900 ms to absorb setTimeout slop on CI.
    expect(elapsedMs).toBeGreaterThanOrEqual(8_900);
  }, 15_000);

  test('audit record fires only when wait > auditThresholdMs (default 1s)', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const { sink, recorded } = makeRecordingSink();
    const gate = createToolRateLimitGate({
      // rps=1, burst=1 → waits between calls are ~1000 ms which is
      // NOT strictly greater than the default 1000 ms threshold.
      // So drop rps to 0.5 to force 2000 ms waits that clear the bar.
      limits: { Bash: { rps: 0.5, burst: 1 } },
      auditSink: sink,
      now: clock.now,
      sleep: sleep.sleep,
    });

    // Burst absorbs the first call — no audit.
    await gate.acquire('Bash', { tenantId: 't1', sessionId: 's1', correlationId: 'c1' });
    expect(recorded).toHaveLength(0);

    // Second call waits ~2000 ms > 1000 ms threshold → audits.
    await gate.acquire('Bash', { tenantId: 't1', sessionId: 's1', correlationId: 'c1' });
    expect(recorded).toHaveLength(1);
    const rec = recorded[0] as RateLimitedAuditRecord;
    expect(rec.kind).toBe('rate_limited');
    expect(rec.tool).toBe('Bash');
    expect(rec.rps).toBe(0.5);
    expect(rec.burst).toBe(1);
    expect(rec.tenantId).toBe('t1');
    expect(rec.sessionId).toBe('s1');
    expect(rec.correlationId).toBe('c1');
    expect(rec.waitMs).toBeGreaterThan(1_000);
  });

  test('audit record is suppressed when wait ≤ threshold', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const { sink, recorded } = makeRecordingSink();
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 10, burst: 1 } },
      auditSink: sink,
      auditThresholdMs: 1_000,
      now: clock.now,
      sleep: sleep.sleep,
    });

    // Burst + 5 more calls at 10 rps → waits of ~100 ms each, well
    // under the 1000 ms threshold.
    for (let i = 0; i < 6; i += 1) {
      await gate.acquire('Bash', { tenantId: 't1' });
    }
    expect(recorded).toHaveLength(0);
  });

  test('audit persistence errors are swallowed (never block the call)', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const failingSink: TenantAuditSink = {
      async record() {
        throw new Error('sqlite offline');
      },
      async query() {
        return [];
      },
      async erase() {
        return 0;
      },
      async verify() {
        return { ok: true, totalEntries: 0, verifiedEntries: 0, violations: [] };
      },
      async prune() {
        return 0;
      },
      async close() {},
    };
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 0.5, burst: 1 } },
      auditSink: failingSink,
      now: clock.now,
      sleep: sleep.sleep,
    });
    await gate.acquire('Bash', { tenantId: 't1' }); // burst
    await expect(gate.acquire('Bash', { tenantId: 't1' })).resolves.toBeGreaterThan(1_000);
  });

  test('onWait hook fires with observed wait', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const waits: Array<{ tool: string; waitMs: number }> = [];
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 2, burst: 1 } },
      onWait: (ev) => waits.push(ev),
      now: clock.now,
      sleep: sleep.sleep,
    });
    await gate.acquire('Bash', { tenantId: 't1' }); // burst → no onWait
    await gate.acquire('Bash', { tenantId: 't1' });
    expect(waits).toHaveLength(1);
    expect(waits[0]?.tool).toBe('Bash');
    expect(waits[0]?.waitMs).toBeGreaterThanOrEqual(500);
  });

  test('rejects non-positive rps with a helpful message', () => {
    expect(() => createToolRateLimitGate({ limits: { Bash: { rps: 0 } } })).toThrow(
      /Bash.*rps must be > 0/,
    );
    expect(() => createToolRateLimitGate({ limits: { Bash: { rps: -1 } } })).toThrow(
      /Bash.*rps must be > 0/,
    );
  });

  test('burst defaults to rps when omitted', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const gate = createToolRateLimitGate({
      limits: { Bash: { rps: 3 } },
      now: clock.now,
      sleep: sleep.sleep,
    });
    // Without explicit burst, bucket should absorb 3 immediate calls.
    for (let i = 0; i < 3; i += 1) {
      expect(await gate.acquire('Bash', { tenantId: 't1' })).toBe(0);
    }
    expect(sleep.waits).toHaveLength(0);
  });
});
