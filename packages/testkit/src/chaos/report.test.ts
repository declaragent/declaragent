import { describe, expect, it } from 'bun:test';
import { renderChaosReportJson, renderChaosReportMarkdown } from './report.js';
import type { ChaosReport } from './types.js';

function makeReport(): ChaosReport {
  return {
    startedAt: Date.parse('2026-04-18T00:00:00Z'),
    stoppedAt: Date.parse('2026-04-18T00:01:00Z'),
    totalMs: 60_000,
    policy: {
      intervalMs: 1000,
      probability: 0.5,
      faults: [
        { kind: 'expire-idempotency-cache' },
        { kind: 'clock-skew', offsetMs: 1000, durationMs: 500 },
      ],
      budget: 20,
    },
    timeline: [
      {
        seq: 0,
        fault: { kind: 'expire-idempotency-cache' },
        firedAt: Date.parse('2026-04-18T00:00:30Z'),
        completedAt: Date.parse('2026-04-18T00:00:31Z'),
        durationMs: 1000,
      },
      {
        seq: 1,
        fault: { kind: 'clock-skew', offsetMs: 1000, durationMs: 500 },
        firedAt: Date.parse('2026-04-18T00:00:45Z'),
        error: { message: 'simulated failure' },
      },
    ],
  };
}

describe('chaos report writers', () => {
  it('renders valid JSON with timeline + assertions', () => {
    const json = renderChaosReportJson({
      report: makeReport(),
      assertions: [
        { name: 'no-event-loss', ok: true, message: 'all good' },
        { name: 'dedup-never-drops', ok: false, message: '1 duplicate' },
      ],
    });
    const parsed = JSON.parse(json) as {
      startedAt: number;
      totalMs: number;
      policy: { faultKinds: string[]; probability: number };
      timeline: Array<{ seq: number; fault: { kind: string } }>;
      assertions: Array<{ name: string; ok: boolean }>;
    };
    expect(parsed.totalMs).toBe(60_000);
    expect(parsed.policy.faultKinds).toEqual(['clock-skew', 'expire-idempotency-cache']);
    expect(parsed.policy.probability).toBe(0.5);
    expect(parsed.timeline).toHaveLength(2);
    expect(parsed.timeline[0]?.fault.kind).toBe('expire-idempotency-cache');
    expect(parsed.assertions.map((a) => a.ok)).toEqual([true, false]);
  });

  it('renders markdown with assertion + timeline tables', () => {
    const md = renderChaosReportMarkdown({
      report: makeReport(),
      assertions: [
        { name: 'no-event-loss', ok: true, message: 'balanced' },
        { name: 'slos-held', ok: false, message: 'p99 breached' },
      ],
    });
    expect(md).toContain('# Chaos run report');
    expect(md).toContain('## Policy');
    expect(md).toContain('## Assertions');
    expect(md).toContain('| no-event-loss | PASS | balanced |');
    expect(md).toContain('| slos-held | FAIL | p99 breached |');
    expect(md).toContain('## Fault timeline');
    expect(md).toContain('| 0 | expire-idempotency-cache ');
    expect(md).toContain('ERROR (simulated failure)');
  });
});
