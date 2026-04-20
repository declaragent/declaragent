import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetInit } from '../fleet-init-cli.js';
import { createFleetStatusTool, runFleetStatus } from './fleet-status.js';
import { BuilderValidationError } from './types.js';

async function scaffoldFleet(root: string): Promise<string> {
  await fleetInit({ name: 'demo' }, { cwd: root, io: { out: () => {}, err: () => {} } });
  return join(root, 'demo');
}

describe('runFleetStatus', () => {
  let root: string;
  let fleetRoot: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'declara-fleet-status-'));
    fleetRoot = await scaffoldFleet(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns a report for a valid fleet', async () => {
    const out = await runFleetStatus({}, { scopeRoot: fleetRoot });
    expect(out.ok).toBe(true);
    const report = out.report as {
      fleet: { name: string; root: string };
      agents: unknown[];
      peers: unknown;
    };
    expect(report.fleet.name).toBe('demo');
    expect(report.fleet.root).toBe(fleetRoot);
    expect(Array.isArray(report.agents)).toBe(true);
    expect(report.peers).toBeDefined();
  });

  test('rejects when scopeRoot is not a fleet', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'declara-no-fleet-'));
    try {
      await expect(runFleetStatus({}, { scopeRoot: empty })).rejects.toBeInstanceOf(
        BuilderValidationError,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('history toggle includes a history key (possibly empty)', async () => {
    const out = await runFleetStatus({ history: true, historyLimit: 3 }, { scopeRoot: fleetRoot });
    const report = out.report as { history?: unknown[] };
    expect(report.history).toBeDefined();
  });
});

describe('createFleetStatusTool', () => {
  test('readonly + parallelSafe', () => {
    const tool = createFleetStatusTool({ scopeRoot: '/tmp' });
    expect(tool.readonly).toBe(true);
    expect(tool.parallelSafe).toBe(true);
  });

  test('permissionKey reflects history flag', () => {
    const tool = createFleetStatusTool({ scopeRoot: '/tmp' });
    expect(tool.permissionKey({})).toBe('fleet-status');
    expect(tool.permissionKey({ history: true })).toBe('fleet-status:history');
  });
});
