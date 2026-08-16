/**
 * 0.8.0 strict-mode window drift guard (RELEASE_0_8_0_PLAN.md §3).
 *
 * Always-on (no env gate, no broker): scaffolds the SAME fleet manifest the
 * Kafka soak + nightly round-trips run against, and proves it holds the
 * 0.8.0 zero-trust posture via the real inspector CLI:
 *
 *   - `fleet audit-rpc --strict --json` exits 0 — every agent has
 *     `rpc.auth.enabled: true` AND every peer entry is signable (the WS2
 *     sign-side check; a peer without an `auth:` block fails strict).
 *   - `--dry-run-with-flag` reports the fleet boots cleanly under the
 *     simulated `DECLARAGENT_RPC_AUTH_DEFAULT=on` flip.
 *
 * If someone strips the auth blocks from the harness scaffold, this fails on
 * every PR — the nightly window (which runs the signed round-trips) can't
 * silently degrade back to unsigned traffic.
 */

import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldFleetManifest } from './harness/multi-process.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, '../../../cli/src/index.tsx');

async function runAuditRpc(fleetRoot: string): Promise<{ exitCode: number; json: unknown }> {
  const proc = Bun.spawn(
    ['bun', CLI_ENTRY, 'fleet', 'audit-rpc', '--strict', '--json', '--dry-run-with-flag'],
    { cwd: fleetRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(
      `audit-rpc emitted non-JSON stdout (exit ${exitCode}): ${stdout.slice(0, 400)}`,
    );
  }
  return { exitCode, json };
}

describe('0.8.0 strict-mode window — harness fleet posture', () => {
  test('the soak/nightly fleet passes audit-rpc --strict + the flip dry-run', async () => {
    const fleetRoot = scaffoldFleetManifest({
      alphaRequests: 'ztw-alpha-requests',
      alphaResponses: 'ztw-alpha-responses',
      betaRequests: 'ztw-beta-requests',
      betaResponses: 'ztw-beta-responses',
    });
    try {
      const { exitCode, json } = await runAuditRpc(fleetRoot);
      const report = json as {
        ok: boolean;
        allEnabled: boolean;
        signFindings: Array<{ kind: string; peer: string }>;
        dryRunWithFlag?: { wouldBootCleanly: boolean };
      };
      expect(report.allEnabled).toBe(true);
      expect(report.signFindings.filter((f) => f.kind === 'no-auth-block')).toEqual([]);
      expect(report.dryRunWithFlag?.wouldBootCleanly).toBe(true);
      expect(report.ok).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(fleetRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
