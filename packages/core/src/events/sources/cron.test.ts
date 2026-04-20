import { describe, expect, test } from 'bun:test';
import { createEventBus } from '../bus.js';
import { eventSourceExtension } from '../source.js';
import type { AgentEvent, EventBus } from '../types.js';
import {
  computeNextFire,
  createCronAdapter,
  isDuration,
  parseCron,
  parseDuration,
  validateSchedule,
} from './cron.js';

// ── Fake clock + virtual scheduler ───────────────────────────────────────
// Pending timers are sorted by fire time; advance() jumps to the next
// pending timer, runs its callback (which may schedule more), and repeats
// until no pending timers remain before the target.

interface PendingTimer {
  at: number;
  fn: () => void | Promise<void>;
  cancelled: boolean;
}

class FakeClock {
  nowMs = 0;
  private pending: PendingTimer[] = [];

  now = (): number => this.nowMs;

  scheduleTimer = (delayMs: number, fn: () => void | Promise<void>): (() => void) => {
    const entry: PendingTimer = { at: this.nowMs + delayMs, fn, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      this.pending = this.pending.filter((p) => !p.cancelled);
      this.pending.sort((a, b) => a.at - b.at);
      const next = this.pending[0];
      if (!next || next.at > target) break;
      this.nowMs = next.at;
      this.pending.shift();
      await next.fn();
    }
    this.nowMs = target;
  }

  get pendingCount(): number {
    return this.pending.filter((p) => !p.cancelled).length;
  }
}

async function collect(bus: EventBus): Promise<{ received: AgentEvent[] }> {
  const received: AgentEvent[] = [];
  bus.subscribe('*', (e) => {
    received.push(e);
  });
  return { received };
}

// ── Parser tests ─────────────────────────────────────────────────────────

describe('isDuration', () => {
  test('accepts PT-prefixed strings', () => {
    expect(isDuration('PT5M')).toBe(true);
    expect(isDuration('PT1H30M')).toBe(true);
    expect(isDuration('PT30S')).toBe(true);
    expect(isDuration('pt5m')).toBe(true); // case-insensitive
  });

  test('rejects cron strings', () => {
    expect(isDuration('0 9 * * *')).toBe(false);
    expect(isDuration('* * * * *')).toBe(false);
  });
});

describe('parseDuration', () => {
  test('PT5M → 300_000ms', () => {
    expect(parseDuration('PT5M')).toBe(5 * 60_000);
  });

  test('PT1H → 3_600_000ms', () => {
    expect(parseDuration('PT1H')).toBe(60 * 60_000);
  });

  test('PT30S → 30_000ms', () => {
    expect(parseDuration('PT30S')).toBe(30_000);
  });

  test('PT1H30M combines parts', () => {
    expect(parseDuration('PT1H30M')).toBe(90 * 60_000);
  });

  test('throws on malformed duration', () => {
    expect(() => parseDuration('PT')).toThrow('invalid');
    expect(() => parseDuration('PTX')).toThrow('invalid');
    expect(() => parseDuration('5M')).toThrow('invalid');
  });

  test('throws on zero or negative duration', () => {
    expect(() => parseDuration('PT0M')).toThrow('non-positive');
  });
});

describe('parseCron', () => {
  test('basic fields "0 9 * * 1-5"', () => {
    const f = parseCron('0 9 * * 1-5');
    expect([...f.minute]).toEqual([0]);
    expect([...f.hour]).toEqual([9]);
    expect([...f.dayOfMonth].length).toBe(31);
    expect([...f.month].length).toBe(12);
    expect([...f.dayOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(f.hasDomRestriction).toBe(false);
    expect(f.hasDowRestriction).toBe(true);
  });

  test('step syntax "*/5 * * * *"', () => {
    const f = parseCron('*/5 * * * *');
    expect([...f.minute].sort((a, b) => a - b)).toEqual([
      0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
    ]);
  });

  test('list "0 12 1,15 * *"', () => {
    const f = parseCron('0 12 1,15 * *');
    expect([...f.dayOfMonth].sort((a, b) => a - b)).toEqual([1, 15]);
  });

  test('named months/days case-insensitive', () => {
    const f = parseCron('0 0 * jan-mar mon-fri');
    expect([...f.month].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...f.dayOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('7 is Sunday in dayOfWeek', () => {
    const f = parseCron('0 0 * * 7');
    expect([...f.dayOfWeek]).toEqual([0]);
  });

  test('throws on wrong field count', () => {
    expect(() => parseCron('0 9 * *')).toThrow('5 fields');
    expect(() => parseCron('0 9 * * * *')).toThrow('5 fields');
  });

  test('throws on out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow('out of range');
    expect(() => parseCron('* 24 * * *')).toThrow('out of range');
  });

  test('throws on bad step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow('invalid step');
  });
});

describe('validateSchedule', () => {
  test('accepts valid cron + duration; throws on garbage', () => {
    validateSchedule('0 9 * * 1-5');
    validateSchedule('PT5M');
    expect(() => validateSchedule('bad')).toThrow();
  });
});

// ── Next-fire math ───────────────────────────────────────────────────────

describe('computeNextFire', () => {
  test('PT5M adds exactly 5 minutes', () => {
    const t0 = Date.parse('2026-04-16T10:00:00Z');
    expect(computeNextFire('PT5M', t0, 'UTC')).toBe(t0 + 5 * 60_000);
  });

  test('cron "0 9 * * *" in UTC advances to next 9:00 UTC', () => {
    // 2026-04-16 08:59Z → next fire is 2026-04-16 09:00Z
    const t0 = Date.parse('2026-04-16T08:59:00Z');
    expect(computeNextFire('0 9 * * *', t0, 'UTC')).toBe(Date.parse('2026-04-16T09:00:00Z'));
  });

  test("cron already past today's fire rolls to tomorrow", () => {
    const t0 = Date.parse('2026-04-16T09:00:00Z');
    // After 09:00 exactly → next fire is tomorrow 09:00 (strict "after").
    expect(computeNextFire('0 9 * * *', t0, 'UTC')).toBe(Date.parse('2026-04-17T09:00:00Z'));
  });

  test('weekday-only schedule skips weekend', () => {
    // 2026-04-17 is Friday; 08:59Z is before 09:00. Next fire should be Fri 09:00.
    const friMorning = Date.parse('2026-04-17T08:59:00Z');
    expect(computeNextFire('0 9 * * 1-5', friMorning, 'UTC')).toBe(
      Date.parse('2026-04-17T09:00:00Z'),
    );
    // 2026-04-17 09:00Z exactly → next fire must be Monday 09:00 (weekend skipped).
    const friFired = Date.parse('2026-04-17T09:00:00Z');
    expect(computeNextFire('0 9 * * 1-5', friFired, 'UTC')).toBe(
      Date.parse('2026-04-20T09:00:00Z'),
    );
  });

  test('timezone-aware: 09:00 LA is 16:00 or 17:00 UTC depending on DST', () => {
    // 2026-07-01 is PDT (UTC-7). 09:00 PDT = 16:00 UTC.
    const preLA = Date.parse('2026-07-01T15:00:00Z');
    const nextLA = computeNextFire('0 9 * * *', preLA, 'America/Los_Angeles');
    expect(nextLA).toBe(Date.parse('2026-07-01T16:00:00Z'));

    // 2026-01-15 is PST (UTC-8). 09:00 PST = 17:00 UTC.
    const preLAPst = Date.parse('2026-01-15T15:00:00Z');
    const nextLAPst = computeNextFire('0 9 * * *', preLAPst, 'America/Los_Angeles');
    expect(nextLAPst).toBe(Date.parse('2026-01-15T17:00:00Z'));
  });
});

// ── Adapter lifecycle with fake clock ────────────────────────────────────

describe('createCronAdapter', () => {
  test('validateConfig rejects missing required fields', async () => {
    const bus = createEventBus();
    const adapter = createCronAdapter();
    await expect(
      eventSourceExtension(adapter, {
        config: { id: '', schedule: 'PT5M', target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('non-empty "id"');

    await expect(
      eventSourceExtension(adapter, {
        config: { id: 'x', schedule: 'bad-schedule', target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow();
  });

  test('fires once per interval under a PT duration schedule', async () => {
    const clock = new FakeClock();
    clock.nowMs = Date.parse('2026-04-16T10:00:00Z');
    const bus = createEventBus();
    const { received } = await collect(bus);

    const ext = await eventSourceExtension(
      createCronAdapter({ now: clock.now, scheduleTimer: clock.scheduleTimer }),
      {
        config: {
          id: 'every-5-min',
          schedule: 'PT5M',
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();

    // Advance 25 minutes → 5 fires expected.
    await clock.advance(25 * 60_000);
    expect(received.length).toBe(5);
    expect(received.every((e) => e.source.type === 'cron')).toBe(true);
    expect(received[0]?.source).toEqual({
      type: 'cron',
      triggerId: 'every-5-min',
      schedule: 'PT5M',
    });

    await ext.payload.stop();
  });

  test('fires on matching minute for a 5-field cron', async () => {
    const clock = new FakeClock();
    // Set clock to 08:59:30 UTC, one daily fire at 09:00Z expected within 1 min.
    clock.nowMs = Date.parse('2026-04-16T08:59:30Z');
    const bus = createEventBus();
    const { received } = await collect(bus);

    const ext = await eventSourceExtension(
      createCronAdapter({ now: clock.now, scheduleTimer: clock.scheduleTimer }),
      {
        config: {
          id: 'daily-9am',
          schedule: '0 9 * * *',
          timezone: 'UTC',
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();
    await clock.advance(40_000); // 08:59:30 → 09:00:10; fire lands at 09:00:00
    expect(received.length).toBe(1);
    expect(received[0]?.timestamp).toBe(Date.parse('2026-04-16T09:00:00Z'));

    // Advance 24h → one more fire.
    await clock.advance(24 * 60 * 60_000);
    expect(received.length).toBe(2);

    await ext.payload.stop();
  });

  test('stop cancels pending timers', async () => {
    const clock = new FakeClock();
    clock.nowMs = 0;
    const bus = createEventBus();
    const { received } = await collect(bus);

    const ext = await eventSourceExtension(
      createCronAdapter({ now: clock.now, scheduleTimer: clock.scheduleTimer }),
      {
        config: { id: 'x', schedule: 'PT1M', target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();
    await clock.advance(30_000); // no fire yet (next at 60s)
    expect(received.length).toBe(0);
    expect(clock.pendingCount).toBe(1);

    await ext.payload.stop();
    expect(clock.pendingCount).toBe(0);

    await clock.advance(5 * 60_000);
    expect(received.length).toBe(0);
  });

  test('pause suppresses publishes but keeps scheduling', async () => {
    const clock = new FakeClock();
    clock.nowMs = 0;
    const bus = createEventBus();
    const { received } = await collect(bus);

    const ext = await eventSourceExtension(
      createCronAdapter({ now: clock.now, scheduleTimer: clock.scheduleTimer }),
      {
        config: { id: 'x', schedule: 'PT1M', target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();
    await clock.advance(90_000); // 1 fire at t=60s
    expect(received.length).toBe(1);

    await ext.payload.pause();
    await clock.advance(5 * 60_000); // next 5 ticks skipped
    expect(received.length).toBe(1);

    await ext.payload.resume();
    await clock.advance(2 * 60_000); // 2 more fires
    expect(received.length).toBeGreaterThanOrEqual(2);

    await ext.payload.stop();
  });

  test('metrics report eventsPublished and lastEventAt', async () => {
    const clock = new FakeClock();
    clock.nowMs = Date.parse('2026-04-16T10:00:00Z');
    const bus = createEventBus();
    await collect(bus);

    const ext = await eventSourceExtension(
      createCronAdapter({ now: clock.now, scheduleTimer: clock.scheduleTimer }),
      {
        config: { id: 'm', schedule: 'PT1M', target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();
    await clock.advance(3 * 60_000);

    const m = ext.payload.metrics();
    expect(m.eventsPublished).toBe(3);
    expect(m.lastEventAt).toBe(clock.nowMs);

    await ext.payload.stop();
  });

  test('emitted event carries the configured target', async () => {
    const clock = new FakeClock();
    clock.nowMs = 0;
    const bus = createEventBus();
    const { received } = await collect(bus);

    const target = {
      type: 'skill' as const,
      name: 'pr-summary',
      inputs: { window: '24h' },
    };
    const ext = await eventSourceExtension(
      createCronAdapter({ now: clock.now, scheduleTimer: clock.scheduleTimer }),
      {
        config: { id: 'pr', schedule: 'PT1M', target },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();
    await clock.advance(60_000);

    expect(received[0]?.target).toEqual(target);
    expect(received[0]?.auth).toEqual({ kind: 'trigger', triggerId: 'pr' });

    await ext.payload.stop();
  });
});
