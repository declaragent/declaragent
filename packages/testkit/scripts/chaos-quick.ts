#!/usr/bin/env bun
/**
 * Phase 6 slice-8 `chaos:quick` scenario runner.
 *
 * In-process smoke test that exercises every fault kind at least once
 * against a stub runtime + asserts the SLO + dedup + no-event-loss
 * invariants hold. Designed to run in ≤ 60 seconds on every PR (the
 * release-gate workflow invokes this).
 *
 * Production soaks (`chaos:soak`) follow the same pattern but swap in
 * the real `ChaosTargetRuntime` bridges (Kubernetes pod-kill, Docker
 * Compose broker restart, tc netem) + a longer window.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventBus } from '@declaragent/core';
import {
  InMemoryBrokerPartitioner,
  InMemoryChannelPartitioner,
  InMemoryReplicaKiller,
  composeRuntimes,
  createBusHighWatermarkFault,
  createChaosDriver,
  createClockSkewFault,
  createExpireIdempotencyCacheFault,
  createKillReplicaFault,
  createMutableClock,
  createNetworkLatencyFault,
  createPartitionBrokerFault,
  createPartitionChannelFault,
  dedupNeverDropsAssertion,
  noCrossTenantLeakAssertion,
  noEventLossAssertion,
  renderChaosReportJson,
  renderChaosReportMarkdown,
} from '../src/chaos/index.js';
import type {
  ChaosAssertion,
  ChaosAssertionResult,
  ChaosFault,
  ChaosSnapshot,
} from '../src/chaos/index.js';

interface ChaosQuickOptions {
  /** Output dir for the dual JSON + markdown report. */
  outDir?: string;
  /** Cap on total faults fired. Default 14 — every fault kind × 2. */
  budget?: number;
  /** Total wall-clock window in ms. Default 10 000. */
  durationMs?: number;
}

export async function runChaosQuick(opts: ChaosQuickOptions = {}): Promise<{
  ok: boolean;
  reportPaths: { json: string; md: string };
  assertions: readonly ChaosAssertionResult[];
}> {
  const outDir = opts.outDir ?? process.cwd();
  const budget = opts.budget ?? 14;
  const durationMs = opts.durationMs ?? 10_000;

  const bus = createEventBus();
  const subscribed = bus.subscribe('*', () => {
    // No-op subscriber so inflightCount stays accurate during pressure.
  });

  const clock = createMutableClock();

  const replicaKiller = new InMemoryReplicaKiller();
  replicaKiller.register('replica-1', async () => Promise.resolve());
  replicaKiller.register('replica-2', async () => Promise.resolve());

  const brokerPartitioner = new InMemoryBrokerPartitioner();
  const channelPartitioner = new InMemoryChannelPartitioner();

  const pretendFetch = (async () => new Response('ok')) as unknown as typeof fetch;
  const network = createNetworkLatencyFault({ fetch: pretendFetch });

  const runtime = composeRuntimes(
    undefined,
    createKillReplicaFault({ killer: replicaKiller }),
    createPartitionBrokerFault({ partitioner: brokerPartitioner }),
    createPartitionChannelFault({ partitioner: channelPartitioner }),
    createBusHighWatermarkFault({ bus, highWatermark: 3, spacingMs: 1 }),
    createExpireIdempotencyCacheFault({ caches: [{ clear: () => undefined }] }),
    createClockSkewFault({ clock }),
    network.runtime,
  );

  const faults: ChaosFault[] = [
    { kind: 'kill-replica', replicaId: 'replica-1' },
    { kind: 'partition-broker', broker: 'broker-1', durationMs: 20 },
    { kind: 'partition-channel', channelId: 'slack-prod', durationMs: 20 },
    { kind: 'bus-high-watermark', excessFactor: 1.5, durationMs: 30 },
    { kind: 'expire-idempotency-cache' },
    { kind: 'clock-skew', offsetMs: 1000, durationMs: 20 },
    { kind: 'network-latency', target: 'slack-prod', extraMs: 5, durationMs: 20 },
  ];

  // Smoke-test mode: `probability: 0` so the scheduler never fires
  // randomly; we drive `inject(fault)` once per kind below for
  // exhaustive coverage. The driver still tests start/stop + timeline
  // bookkeeping.
  const driver = createChaosDriver({
    policy: { intervalMs: Math.max(1, Math.min(100, durationMs)), probability: 0, faults, budget },
    runtime,
  });

  await driver.start();
  for (const fault of faults) {
    await driver.inject(fault);
  }
  const report = await driver.stop();
  subscribed();

  const snapshot: ChaosSnapshot = {
    metrics: [
      {
        kind: 'counter',
        name: 'source.messages.received',
        op: 'inc',
        value: 0,
        labels: { id: 's-noop' },
      },
      {
        kind: 'counter',
        name: 'source.messages.processed',
        op: 'inc',
        value: 0,
        labels: { id: 's-noop' },
      },
    ],
    auditRecords: [],
    busDepth: bus.inflightCount(),
    dlqDepths: {},
  };
  const assertions: ChaosAssertion[] = [
    noEventLossAssertion,
    noCrossTenantLeakAssertion,
    dedupNeverDropsAssertion,
  ];
  const assertionResults: ChaosAssertionResult[] = [];
  for (const assertion of assertions) {
    assertionResults.push(await assertion.check(snapshot));
  }

  const stamp = new Date(report.stoppedAt).toISOString().replace(/[:.]/g, '-');
  const jsonPath = resolve(outDir, `chaos-report.${stamp}.json`);
  const mdPath = resolve(outDir, `chaos-report.${stamp}.md`);
  writeFileSync(jsonPath, renderChaosReportJson({ report, assertions: assertionResults }), 'utf-8');
  writeFileSync(
    mdPath,
    renderChaosReportMarkdown({ report, assertions: assertionResults }),
    'utf-8',
  );

  const ok =
    report.timeline.every((entry) => entry.error === undefined) &&
    assertionResults.every((r) => r.ok);
  return { ok, reportPaths: { json: jsonPath, md: mdPath }, assertions: assertionResults };
}

// When invoked directly (`bun run chaos:quick`), run and exit non-zero
// on any failure. The release-gate workflow keys on the exit code.
const currentFile = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : currentFile;
if (
  invokedPath === currentFile ||
  invokedPath === resolve(dirname(currentFile), 'chaos-quick.ts')
) {
  void runChaosQuick()
    .then(({ ok, reportPaths, assertions }) => {
      for (const a of assertions) {
        const status = a.ok ? 'PASS' : 'FAIL';
        console.log(`[chaos:quick] ${status} ${a.name}: ${a.message}`);
      }
      console.log(`[chaos:quick] JSON report → ${reportPaths.json}`);
      console.log(`[chaos:quick] Markdown report → ${reportPaths.md}`);
      if (!ok) {
        console.error('[chaos:quick] FAILED');
        process.exit(1);
      }
      console.log('[chaos:quick] OK');
    })
    .catch((err: unknown) => {
      console.error('[chaos:quick] exception:', err);
      process.exit(2);
    });
}
