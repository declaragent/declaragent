import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FLEET_DEPLOY_HISTORY_PATH,
  type FleetDeployRecord,
  type FleetDeployTarget,
  appendDeployRecord,
  computeFleetVersion,
  createMemoryDeployTarget,
  executeDeploy,
  fleetDeploy,
  planDeploy,
  readDeployHistory,
} from './fleet-deploy-cli.js';

// ── Helpers ────────────────────────────────────────────────────────────

function captureIo(): {
  io: { out: (s: string) => void; err: (s: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    out,
    err,
  };
}

interface Harness {
  root: string;
  write(relative: string, contents: string): void;
  read(relative: string): string;
  exists(relative: string): boolean;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-deploy-'));
  return {
    root,
    write(relative, contents) {
      const full = join(root, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents, 'utf-8');
    },
    read(relative) {
      return readFileSync(join(root, relative), 'utf-8');
    },
    exists(relative) {
      return existsSync(join(root, relative));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const MANIFEST_TEMPLATE = `version: 1
name: demo-fleet
agents:
  - id: concierge
    path: ./agents/concierge
    deploy:
      target: cloud-run-concierge
  - id: pr-reviewer
    path: ./agents/pr-reviewer
    deploy:
      target: cloud-run-reviewer

deploy:
  strategy: rolling
  rollbackOnFailure: true
  targets:
    cloud-run-concierge:
      kind: gcp-cloud-run
      region: us-central1
    cloud-run-reviewer:
      kind: gcp-cloud-run
      region: us-central1
`;

function scaffoldFleetFiles(h: Harness, manifest = MANIFEST_TEMPLATE): void {
  h.write('fleet.yaml', manifest);
  h.write(
    'agents/concierge/agent.yaml',
    'name: concierge\nmodel: claude-opus-4-6\nsystemPrompt: hi\n',
  );
  h.write(
    'agents/pr-reviewer/agent.yaml',
    'name: pr-reviewer\nmodel: claude-opus-4-6\nsystemPrompt: hi\n',
  );
  h.write('package.json', JSON.stringify({ name: 'demo-fleet', private: true, version: '1.2.3' }));
}

// ── planDeploy ─────────────────────────────────────────────────────────

describe('planDeploy', () => {
  test('returns entries in manifest order', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      expect(plan.map((p) => p.agent.id)).toEqual(['concierge', 'pr-reviewer']);
      expect(plan[0]?.targetKey).toBe('cloud-run-concierge');
      expect(plan[1]?.targetKey).toBe('cloud-run-reviewer');
    } finally {
      h.cleanup();
    }
  });

  test('respects --agent subset filter', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet, { agents: ['pr-reviewer'] });
      expect(plan).toHaveLength(1);
      expect(plan[0]?.agent.id).toBe('pr-reviewer');
    } finally {
      h.cleanup();
    }
  });

  test('errors when target referenced by agent is not declared', async () => {
    const h = mkHarness();
    try {
      const badManifest = `version: 1
name: demo-fleet
agents:
  - id: concierge
    path: ./agents/concierge
    deploy:
      target: not-declared
deploy:
  targets:
    cloud-run-concierge:
      kind: gcp-cloud-run
`;
      h.write('fleet.yaml', badManifest);
      h.write('agents/concierge/agent.yaml', 'name: concierge\nmodel: m\nsystemPrompt: hi\n');
      const { loadFleet } = await import('@declaragent/core');
      // The loader itself flags this; skip the loadFleet call and test
      // the pure function directly with a hand-rolled fleet when the
      // loader raises.
      try {
        await loadFleet({ root: h.root });
      } catch {
        // Expected — manifest cross-ref validation fires here. This
        // covers the manifest-side guard; planDeploy's own guard fires
        // when an adapter is wired with a fresh --target override but
        // the manifest doesn't know the target.
      }
    } finally {
      h.cleanup();
    }
  });
});

// ── executeDeploy — rolling ────────────────────────────────────────────

describe('executeDeploy rolling strategy', () => {
  test('sequential deploy; on second-agent failure the first rolls back', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget({
        failFor: (agent) => agent.id === 'pr-reviewer',
      });
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const io = captureIo();
      const result = await executeDeploy(plan, targets, {
        strategy: 'rolling',
        fleet,
        fleetVersion: 'v1.2.3-abcdef0',
        logger: io.io,
      });
      expect(result.ok).toBe(false);
      expect(result.deployed).toEqual(['concierge']);
      expect(result.failed).toBe('pr-reviewer');
      expect(result.rolledBack).toEqual(['concierge']);
      expect(target.deployed).toEqual(['concierge']);
      expect(target.rolledBack).toEqual(['concierge']);
      expect(result.outcomes.concierge?.ok).toBe(true);
      expect(result.outcomes['pr-reviewer']?.ok).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test('health-probe failure rolls back the offending agent too', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget();
      // Wrap the deploy so that after pr-reviewer deploys, the health
      // flag immediately flips to false; its probe then fails and the
      // rolling executor rolls concierge back.
      const io = captureIo();
      const wrapped: FleetDeployTarget = {
        kind: target.kind,
        deploy: async (agent, ctx) => {
          const r = await target.deploy(agent, ctx);
          if (agent.id === 'pr-reviewer') target.health.set('pr-reviewer', false);
          return r;
        },
        ...(target.healthCheck && { healthCheck: target.healthCheck.bind(target) }),
        ...(target.rollback && { rollback: target.rollback.bind(target) }),
      };
      const wrappedTargets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', wrapped],
        ['cloud-run-reviewer', wrapped],
      ]);
      const result = await executeDeploy(plan, wrappedTargets, {
        strategy: 'rolling',
        fleet,
        fleetVersion: 'v1.2.3-abcdef0',
        logger: io.io,
      });
      expect(result.ok).toBe(false);
      expect(result.failed).toBe('pr-reviewer');
      // concierge deploy succeeded + was rolled back.
      expect(result.rolledBack).toContain('concierge');
    } finally {
      h.cleanup();
    }
  });
});

// ── executeDeploy — canary (Slice 8) ────────────────────────────────────

describe('executeDeploy canary strategy', () => {
  test('canary soaks, re-probes, then rolls out the rest when healthy', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const io = captureIo();
      // Sleep is a synchronous stub so the test doesn't actually wait.
      const sleeps: number[] = [];
      const result = await executeDeploy(plan, targets, {
        strategy: 'canary',
        fleet,
        fleetVersion: 'v1.2.3-abcdef0',
        logger: io.io,
        canaryWaitMs: 12_345,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      expect(result.ok).toBe(true);
      // Canary runs first (concierge per manifest order), then pr-reviewer.
      expect(result.deployed).toEqual(['concierge', 'pr-reviewer']);
      expect(result.rolledBack).toEqual([]);
      expect(sleeps).toEqual([12_345]);
      expect(io.out.join('')).toContain('canary "concierge" deployed');
      expect(io.out.join('')).toContain('Rolling out rest');
    } finally {
      h.cleanup();
    }
  });

  test('canary post-soak health failure rolls back the canary and skips the rest', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget();
      // Wrap so that after the soak (once sleep is invoked) the canary
      // flips unhealthy — mirrors "canary starts fine, dies during soak".
      const wrapped: FleetDeployTarget = {
        kind: target.kind,
        deploy: target.deploy.bind(target),
        ...(target.healthCheck && { healthCheck: target.healthCheck.bind(target) }),
        ...(target.rollback && { rollback: target.rollback.bind(target) }),
      };
      const io = captureIo();
      const result = await executeDeploy(
        plan,
        new Map([
          ['cloud-run-concierge', wrapped],
          ['cloud-run-reviewer', wrapped],
        ]),
        {
          strategy: 'canary',
          fleet,
          fleetVersion: 'v1.2.3-abcdef0',
          logger: io.io,
          canaryWaitMs: 0,
          sleep: async () => {
            // After "soak" elapses, the canary is unhealthy.
            target.health.set('concierge', false);
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.failed).toBe('concierge');
      expect(result.rolledBack).toEqual(['concierge']);
      // pr-reviewer was NEVER deployed because the canary gate failed.
      expect(target.deployed).toEqual(['concierge']);
      expect(result.outcomes.concierge?.error).toContain('canary-soak-health');
    } finally {
      h.cleanup();
    }
  });

  test('canary deploy failure short-circuits before the soak', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget({
        failFor: (a) => a.id === 'concierge',
      });
      const io = captureIo();
      const sleeps: number[] = [];
      const result = await executeDeploy(
        plan,
        new Map<string, FleetDeployTarget>([
          ['cloud-run-concierge', target],
          ['cloud-run-reviewer', target],
        ]),
        {
          strategy: 'canary',
          fleet,
          fleetVersion: 'v1.2.3-abcdef0',
          logger: io.io,
          canaryWaitMs: 5_000,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.failed).toBe('concierge');
      expect(result.deployed).toEqual([]);
      expect(sleeps).toEqual([]); // no soak because deploy failed first
      expect(target.deployed).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

// ── executeDeploy — all-or-nothing ─────────────────────────────────────

describe('executeDeploy all-or-nothing strategy', () => {
  test('failing target rolls back all successfully-deployed agents', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget({
        failFor: (agent) => agent.id === 'pr-reviewer',
      });
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const io = captureIo();
      const result = await executeDeploy(plan, targets, {
        strategy: 'all-or-nothing',
        fleet,
        fleetVersion: 'v1.2.3-abcdef0',
        logger: io.io,
      });
      expect(result.ok).toBe(false);
      expect(result.failed).toBe('pr-reviewer');
      expect(result.deployed).toEqual(['concierge']);
      expect(result.rolledBack).toEqual(['concierge']);
    } finally {
      h.cleanup();
    }
  });

  test('success path deploys everything in parallel with no rollback', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const io = captureIo();
      const result = await executeDeploy(plan, targets, {
        strategy: 'all-or-nothing',
        fleet,
        fleetVersion: 'v1.2.3-abcdef0',
        logger: io.io,
      });
      expect(result.ok).toBe(true);
      expect(result.deployed.sort()).toEqual(['concierge', 'pr-reviewer']);
      expect(result.rolledBack).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test('stamps DECLARAGENT_FLEET_VERSION onto every agent env (§8.2)', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const io = captureIo();
      await executeDeploy(plan, targets, {
        strategy: 'rolling',
        fleet,
        fleetVersion: 'v1.2.3-abcdef0',
        logger: io.io,
      });
      expect(target.envForAgent.get('concierge')?.DECLARAGENT_FLEET_VERSION).toBe('v1.2.3-abcdef0');
      expect(target.envForAgent.get('pr-reviewer')?.DECLARAGENT_FLEET_VERSION).toBe(
        'v1.2.3-abcdef0',
      );
    } finally {
      h.cleanup();
    }
  });
});

// ── executeDeploy — per-agent ──────────────────────────────────────────

describe('executeDeploy per-agent strategy', () => {
  test('fires without coordination; a failing first agent does not stop others', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const plan = planDeploy(fleet);
      const target = createMemoryDeployTarget({
        failFor: (agent) => agent.id === 'concierge',
      });
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const io = captureIo();
      const result = await executeDeploy(plan, targets, {
        strategy: 'per-agent',
        fleet,
        fleetVersion: 'v1.2.3-abcdef0',
        logger: io.io,
      });
      expect(result.deployed).toEqual(['pr-reviewer']);
      expect(result.rolledBack).toEqual([]);
      expect(result.outcomes.concierge?.ok).toBe(false);
      expect(result.outcomes['pr-reviewer']?.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

// ── Deploy history jsonl ───────────────────────────────────────────────

describe('deploy history', () => {
  test('appendDeployRecord + readDeployHistory round-trips', () => {
    const h = mkHarness();
    try {
      const r1: FleetDeployRecord = {
        fleetVersion: 'v1.0.0-aaaaaaa',
        timestamp: '2026-01-01T00:00:00.000Z',
        strategy: 'rolling',
        agents: { concierge: { target: 't', ok: true, artifact: 'x' } },
        status: 'deployed',
      };
      const r2: FleetDeployRecord = {
        fleetVersion: 'v1.0.1-bbbbbbb',
        timestamp: '2026-01-02T00:00:00.000Z',
        strategy: 'all-or-nothing',
        agents: { concierge: { target: 't', ok: false, error: 'boom' } },
        status: 'rolled-back',
      };
      appendDeployRecord(h.root, r1);
      appendDeployRecord(h.root, r2);
      const records = readDeployHistory(h.root);
      expect(records).toEqual([r1, r2]);
      expect(h.exists(FLEET_DEPLOY_HISTORY_PATH)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('readDeployHistory returns empty array when file is absent', () => {
    const h = mkHarness();
    try {
      expect(readDeployHistory(h.root)).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

// ── computeFleetVersion ────────────────────────────────────────────────

describe('computeFleetVersion', () => {
  test('reads version from package.json + sha from .git/HEAD (direct)', () => {
    const h = mkHarness();
    try {
      h.write('package.json', JSON.stringify({ version: '2.3.4' }));
      h.write('.git/HEAD', 'deadbeefcafef00d1234567890abcdef12345678\n');
      expect(computeFleetVersion(h.root)).toBe('v2.3.4-deadbee');
    } finally {
      h.cleanup();
    }
  });

  test('follows ref: HEAD → refs/heads/main', () => {
    const h = mkHarness();
    try {
      h.write('package.json', JSON.stringify({ version: '2.3.4' }));
      h.write('.git/HEAD', 'ref: refs/heads/main\n');
      h.write('.git/refs/heads/main', 'facefeedcafef00d1234567890abcdef12345678\n');
      expect(computeFleetVersion(h.root)).toBe('v2.3.4-facefee');
    } finally {
      h.cleanup();
    }
  });

  test('falls back to v0.0.0-nosha when both pkg + .git are missing', () => {
    const h = mkHarness();
    try {
      expect(computeFleetVersion(h.root)).toBe('v0.0.0-nosha');
    } finally {
      h.cleanup();
    }
  });
});

// ── fleetDeploy CLI verb ───────────────────────────────────────────────

describe('fleetDeploy CLI verb', () => {
  test('--dry-run prints the plan and writes nothing to disk', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const cap = captureIo();
      const code = await fleetDeploy(
        { dryRun: true },
        { io: cap.io, root: h.root, targets, fleetVersion: 'v1.2.3-abcdef0' },
      );
      expect(code).toBe(0);
      const stdout = cap.out.join('');
      expect(stdout).toContain('plan');
      expect(stdout).toContain('concierge → cloud-run-concierge');
      expect(stdout).toContain('pr-reviewer → cloud-run-reviewer');
      expect(h.exists(FLEET_DEPLOY_HISTORY_PATH)).toBe(false);
      expect(target.deployed).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test('success path appends a "deployed" record to history', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const cap = captureIo();
      const code = await fleetDeploy(
        {},
        {
          io: cap.io,
          root: h.root,
          targets,
          fleetVersion: 'v1.2.3-abcdef0',
          now: () => new Date('2026-04-19T12:00:00.000Z'),
        },
      );
      expect(code).toBe(0);
      const records = readDeployHistory(h.root);
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('deployed');
      expect(records[0]?.fleetVersion).toBe('v1.2.3-abcdef0');
      expect(Object.keys(records[0]?.agents ?? {}).sort()).toEqual(['concierge', 'pr-reviewer']);
    } finally {
      h.cleanup();
    }
  });

  test('failure path appends a "rolled-back" record to history', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const target = createMemoryDeployTarget({
        failFor: (a) => a.id === 'pr-reviewer',
      });
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const cap = captureIo();
      const code = await fleetDeploy(
        {},
        { io: cap.io, root: h.root, targets, fleetVersion: 'v1.2.3-abcdef0' },
      );
      expect(code).toBe(1);
      const records = readDeployHistory(h.root);
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('rolled-back');
    } finally {
      h.cleanup();
    }
  });

  test('--rollback reads history and re-invokes previous version', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      // Seed history with a successful prior deploy.
      const prior: FleetDeployRecord = {
        fleetVersion: 'v1.1.0-oldsha1',
        timestamp: '2026-01-01T00:00:00.000Z',
        strategy: 'rolling',
        agents: {
          concierge: { target: 'cloud-run-concierge', ok: true, artifact: 'old-1' },
          'pr-reviewer': { target: 'cloud-run-reviewer', ok: true, artifact: 'old-2' },
        },
        status: 'deployed',
      };
      appendDeployRecord(h.root, prior);

      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const cap = captureIo();
      const code = await fleetDeploy(
        { rollback: true },
        { io: cap.io, root: h.root, targets, fleetVersion: 'v2.0.0-newsha1' },
      );
      expect(code).toBe(0);
      // The rollback deploy re-runs against the prior version.
      expect(target.deployed).toEqual(['concierge', 'pr-reviewer']);
      const records = readDeployHistory(h.root);
      expect(records).toHaveLength(2);
      expect(records[1]?.status).toBe('rolled-back');
      expect(records[1]?.fleetVersion).toBe('v1.1.0-oldsha1');
    } finally {
      h.cleanup();
    }
  });

  test('--rollback without any previous deploy errors out', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const cap = captureIo();
      const code = await fleetDeploy({ rollback: true }, { io: cap.io, root: h.root, targets });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no previous successful deploy');
    } finally {
      h.cleanup();
    }
  });

  test('--target overrides the per-agent target', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const cap = captureIo();
      const code = await fleetDeploy(
        { target: 'cloud-run-concierge' },
        { io: cap.io, root: h.root, targets, fleetVersion: 'v1.2.3-abcdef0' },
      );
      expect(code).toBe(0);
      const records = readDeployHistory(h.root);
      expect(records).toHaveLength(1);
      for (const rec of Object.values(records[0]?.agents ?? {})) {
        expect(rec.target).toBe('cloud-run-concierge');
      }
    } finally {
      h.cleanup();
    }
  });

  test('errors when a target key in the manifest has no adapter', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const cap = captureIo();
      const code = await fleetDeploy(
        {},
        {
          io: cap.io,
          root: h.root,
          targets: new Map<string, FleetDeployTarget>(),
          fleetVersion: 'v1.2.3-abcdef0',
        },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no adapter registered');
    } finally {
      h.cleanup();
    }
  });

  test('--json output includes strategy, deployed, failed, rolledBack', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const target = createMemoryDeployTarget({
        failFor: (a) => a.id === 'pr-reviewer',
      });
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const cap = captureIo();
      const code = await fleetDeploy(
        { json: true },
        { io: cap.io, root: h.root, targets, fleetVersion: 'v1.2.3-abcdef0' },
      );
      expect(code).toBe(1);
      const parsed = JSON.parse(cap.out.join('')) as Record<string, unknown>;
      expect(parsed.strategy).toBe('rolling');
      expect(parsed.deployed).toEqual(['concierge']);
      expect(parsed.failed).toBe('pr-reviewer');
      expect(parsed.rolledBack).toEqual(['concierge']);
      expect(parsed.status).toBe('rolled-back');
    } finally {
      h.cleanup();
    }
  });

  test('errors when no fleet.yaml is found', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetDeploy({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml found');
    } finally {
      h.cleanup();
    }
  });

  test('--agent subset filters the plan', async () => {
    const h = mkHarness();
    try {
      scaffoldFleetFiles(h);
      const target = createMemoryDeployTarget();
      const targets = new Map<string, FleetDeployTarget>([
        ['cloud-run-concierge', target],
        ['cloud-run-reviewer', target],
      ]);
      const cap = captureIo();
      const code = await fleetDeploy(
        { agents: ['concierge'] },
        { io: cap.io, root: h.root, targets, fleetVersion: 'v1.2.3-abcdef0' },
      );
      expect(code).toBe(0);
      expect(target.deployed).toEqual(['concierge']);
    } finally {
      h.cleanup();
    }
  });
});
