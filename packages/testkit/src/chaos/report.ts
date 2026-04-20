import type { ChaosAssertionResult, ChaosFault, ChaosReport, FaultTimelineEntry } from './types.js';

/**
 * Phase 6 slice-7 chaos-report writers.
 *
 * The driver's `stop()` returns a `ChaosReport` struct; these
 * helpers render it to the dual JSON + markdown format the plan's
 * §7.4 specifies.
 *
 * JSON is diff-friendly across runs (deterministic key order via the
 * default stringifier). Markdown is human-scan-first + includes every
 * assertion + the fault timeline.
 */

export interface RenderReportOptions {
  report: ChaosReport;
  assertions?: readonly ChaosAssertionResult[];
}

export function renderChaosReportJson(options: RenderReportOptions): string {
  const { report, assertions } = options;
  const payload: Record<string, unknown> = {
    startedAt: report.startedAt,
    stoppedAt: report.stoppedAt,
    totalMs: report.totalMs,
    policy: {
      intervalMs: report.policy.intervalMs,
      probability: report.policy.probability,
      budget: report.policy.budget ?? null,
      faultKinds: [...new Set(report.policy.faults.map((f) => f.kind))].sort(),
    },
    timeline: report.timeline.map(summarizeTimelineEntry),
  };
  if (assertions && assertions.length > 0) {
    payload.assertions = assertions.map((a) => ({
      name: a.name,
      ok: a.ok,
      message: a.message,
      ...(a.details !== undefined && { details: a.details }),
    }));
  }
  return JSON.stringify(payload, null, 2);
}

export function renderChaosReportMarkdown(options: RenderReportOptions): string {
  const { report, assertions } = options;
  const lines: string[] = [];
  lines.push('# Chaos run report');
  lines.push('');
  lines.push(`- Start: ${new Date(report.startedAt).toISOString()}`);
  lines.push(`- Stop : ${new Date(report.stoppedAt).toISOString()}`);
  lines.push(`- Duration: ${report.totalMs} ms`);
  lines.push(`- Faults fired: ${report.timeline.length}`);
  lines.push('');

  lines.push('## Policy');
  lines.push('');
  lines.push(`- intervalMs: ${report.policy.intervalMs}`);
  lines.push(`- probability: ${report.policy.probability}`);
  lines.push(`- budget: ${report.policy.budget ?? 'unlimited'}`);
  lines.push(
    `- faults: ${[...new Set(report.policy.faults.map((f) => f.kind))].sort().join(', ')}`,
  );
  lines.push('');

  lines.push('## Assertions');
  if (!assertions || assertions.length === 0) {
    lines.push('');
    lines.push('_No assertions registered._');
  } else {
    lines.push('');
    lines.push('| Assertion | Status | Message |');
    lines.push('| --------- | ------ | ------- |');
    for (const a of assertions) {
      lines.push(`| ${a.name} | ${a.ok ? 'PASS' : 'FAIL'} | ${escapeCell(a.message)} |`);
    }
  }
  lines.push('');

  lines.push('## Fault timeline');
  if (report.timeline.length === 0) {
    lines.push('');
    lines.push('_No faults fired._');
  } else {
    lines.push('');
    lines.push('| seq | kind | fired at | duration | status |');
    lines.push('| --- | ---- | -------- | -------- | ------ |');
    for (const entry of report.timeline) {
      const firedAt = new Date(entry.firedAt).toISOString();
      const duration = entry.durationMs !== undefined ? `${entry.durationMs} ms` : 'n/a';
      const status = entry.error
        ? `ERROR (${entry.error.message})`
        : entry.completedAt !== undefined
          ? 'OK'
          : 'INCOMPLETE';
      lines.push(`| ${entry.seq} | ${entry.fault.kind} | ${firedAt} | ${duration} | ${status} |`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function summarizeTimelineEntry(entry: FaultTimelineEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: entry.seq,
    fault: summarizeFault(entry.fault),
    firedAt: entry.firedAt,
  };
  if (entry.completedAt !== undefined) out.completedAt = entry.completedAt;
  if (entry.durationMs !== undefined) out.durationMs = entry.durationMs;
  if (entry.error !== undefined) out.error = entry.error;
  return out;
}

function summarizeFault(fault: ChaosFault): Record<string, unknown> {
  // Kind first so the JSON is easy to diff.
  return { kind: fault.kind, ...(fault as unknown as Record<string, unknown>) };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
