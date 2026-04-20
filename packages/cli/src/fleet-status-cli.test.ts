import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFleet } from '@declaragent/core';
import { appendDeployRecord } from './fleet-deploy-cli.js';
import { type FleetStatusIO, buildFleetStatus, fleetStatus } from './fleet-status-cli.js';

interface Harness {
  root: string;
  write(relative: string, contents: string): void;
  mkdir(relative: string): void;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-status-'));
  return {
    root,
    write(relative, contents) {
      const full = join(root, relative);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents, 'utf-8');
    },
    mkdir(relative) {
      mkdirSync(join(root, relative), { recursive: true });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function captureIo(): { io: FleetStatusIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

function writeTwoAgentFleet(h: Harness): void {
  h.write(
    'fleet.yaml',
    `version: 1
name: status-demo
agents:
  - id: concierge
    path: ./agents/concierge
  - id: pr-reviewer
    path: ./agents/pr-reviewer
environments:
  default:
    peersRef: ./rpc-peers.yaml
`,
  );
  h.write('agents/concierge/agent.yaml', 'name: concierge\n');
  h.write('agents/pr-reviewer/agent.yaml', 'name: pr-reviewer\n');
  h.write(
    'agents/pr-reviewer/capabilities.yaml',
    `version: 1
agent: agent://pr-reviewer
transports:
  - kind: memory
    topics: { requests: agents.pr-reviewer.requests }
capabilities:
  - name: review-pr
`,
  );
  h.write(
    'rpc-peers.yaml',
    `version: 1
peers:
  - agent: agent://pr-reviewer
    transports:
      - kind: memory
        topics: { requests: agents.pr-reviewer.requests }
`,
  );
  h.mkdir('agents/pr-reviewer/skills');
  h.write('agents/pr-reviewer/skills/review-pr.md', '# review-pr\n');
}

describe('buildFleetStatus', () => {
  test('reports per-agent config files + capability summary', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const fleet = await loadFleet({ root: h.root });
      const report = buildFleetStatus(fleet);
      expect(report.fleet.name).toBe('status-demo');
      expect(report.agents).toHaveLength(2);
      const reviewer = report.agents.find((a) => a.id === 'pr-reviewer');
      expect(reviewer?.capabilities).toEqual(['review-pr']);
      expect(reviewer?.files.agentYaml).toBe(true);
      expect(reviewer?.files.capabilitiesYaml).toBe(true);
      expect(reviewer?.files.skills).toBe(true);
      const concierge = report.agents.find((a) => a.id === 'concierge');
      expect(concierge?.capabilities).toEqual([]);
      expect(concierge?.files.capabilitiesYaml).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test('peer section mirrors buildPeersReport', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const fleet = await loadFleet({ root: h.root });
      const report = buildFleetStatus(fleet);
      expect(report.peers.peers).toHaveLength(1);
      expect(report.peers.peers[0]?.agent).toBe('agent://pr-reviewer');
    } finally {
      h.cleanup();
    }
  });

  test('history section is absent by default, present when requested', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const fleet = await loadFleet({ root: h.root });
      appendDeployRecord(h.root, {
        fleetVersion: 'v1.2.3-abc1234',
        timestamp: '2026-04-19T00:00:00.000Z',
        strategy: 'rolling',
        agents: {
          concierge: { target: 'cr', ok: true, artifact: 'memory://concierge@v1.2.3-abc1234' },
          'pr-reviewer': {
            target: 'cr',
            ok: true,
            artifact: 'memory://pr-reviewer@v1.2.3-abc1234',
          },
        },
        status: 'deployed',
      });
      const without = buildFleetStatus(fleet);
      expect(without.history).toBeUndefined();
      const withHist = buildFleetStatus(fleet, { history: true });
      expect(withHist.history).toHaveLength(1);
      expect(withHist.history?.[0]?.fleetVersion).toBe('v1.2.3-abc1234');
    } finally {
      h.cleanup();
    }
  });

  test('history respects historyLimit and returns newest-first', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const fleet = await loadFleet({ root: h.root });
      for (let i = 0; i < 8; i += 1) {
        appendDeployRecord(h.root, {
          fleetVersion: `v1.0.${i}-sha${i}abc`,
          timestamp: `2026-04-${10 + i}T00:00:00.000Z`,
          strategy: 'rolling',
          agents: { concierge: { target: 'cr', ok: true } },
          status: 'deployed',
        });
      }
      const report = buildFleetStatus(fleet, { history: true, historyLimit: 3 });
      expect(report.history).toHaveLength(3);
      expect(report.history?.[0]?.fleetVersion).toBe('v1.0.7-sha7abc');
      expect(report.history?.[2]?.fleetVersion).toBe('v1.0.5-sha5abc');
    } finally {
      h.cleanup();
    }
  });

  test('last-deploy is attached to each agent per the newest record that touched it', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const fleet = await loadFleet({ root: h.root });
      // First record deploys both agents.
      appendDeployRecord(h.root, {
        fleetVersion: 'v1.0.0-aaa',
        timestamp: '2026-04-01T00:00:00.000Z',
        strategy: 'rolling',
        agents: {
          concierge: { target: 'cr', ok: true, artifact: 'a/1' },
          'pr-reviewer': { target: 'cr', ok: true, artifact: 'b/1' },
        },
        status: 'deployed',
      });
      // Newer record only touches pr-reviewer.
      appendDeployRecord(h.root, {
        fleetVersion: 'v1.1.0-bbb',
        timestamp: '2026-04-02T00:00:00.000Z',
        strategy: 'rolling',
        agents: { 'pr-reviewer': { target: 'cr', ok: false, error: 'probe-timeout' } },
        status: 'rolled-back',
      });
      const report = buildFleetStatus(fleet);
      const reviewer = report.agents.find((a) => a.id === 'pr-reviewer');
      expect(reviewer?.lastDeploy?.fleetVersion).toBe('v1.1.0-bbb');
      expect(reviewer?.lastDeploy?.ok).toBe(false);
      expect(reviewer?.lastDeploy?.error).toBe('probe-timeout');
      const concierge = report.agents.find((a) => a.id === 'concierge');
      expect(concierge?.lastDeploy?.fleetVersion).toBe('v1.0.0-aaa');
      expect(concierge?.lastDeploy?.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('selfVersion flows into the fleet block when supplied', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const fleet = await loadFleet({ root: h.root });
      const report = buildFleetStatus(fleet, { selfVersion: 'v1.2.3-abc1234' });
      expect(report.fleet.selfVersion).toBe('v1.2.3-abc1234');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleetStatus CLI verb', () => {
  test('human output lists agents + peers + includes the ready header', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const cap = captureIo();
      const code = await fleetStatus({}, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const out = cap.out.join('');
      expect(out).toContain('fleet: status-demo');
      expect(out).toContain('agents (2)');
      expect(out).toContain('pr-reviewer');
      expect(out).toContain('capabilities=1');
      expect(out).toContain('concierge');
      expect(out).toContain('(client-only)');
      expect(out).toContain('peers (1)');
      expect(out).toContain('agent://pr-reviewer');
    } finally {
      h.cleanup();
    }
  });

  test('--json emits a parseable snapshot', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const cap = captureIo();
      const code = await fleetStatus({ json: true }, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out.join(''));
      expect(parsed.fleet.name).toBe('status-demo');
      expect(parsed.agents).toHaveLength(2);
      expect(parsed.peers.peers).toHaveLength(1);
      expect(parsed.history).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test('--history includes the deploy tail in both human + json', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      appendDeployRecord(h.root, {
        fleetVersion: 'v1.0.0-abc1234',
        timestamp: '2026-04-19T00:00:00.000Z',
        strategy: 'rolling',
        agents: { concierge: { target: 'cr', ok: true } },
        status: 'deployed',
      });
      const cap = captureIo();
      const code = await fleetStatus({ history: true }, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const out = cap.out.join('');
      expect(out).toContain('recent deploys');
      expect(out).toContain('v1.0.0-abc1234');

      const capJson = captureIo();
      const codeJson = await fleetStatus(
        { history: true, json: true, historyLimit: 1 },
        { io: capJson.io, root: h.root },
      );
      expect(codeJson).toBe(0);
      const parsed = JSON.parse(capJson.out.join(''));
      expect(parsed.history).toHaveLength(1);
      expect(parsed.history[0].fleetVersion).toBe('v1.0.0-abc1234');
    } finally {
      h.cleanup();
    }
  });

  test('errors when no fleet.yaml is found', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetStatus({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml');
    } finally {
      h.cleanup();
    }
  });

  test('surfaces loader errors on stderr', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', 'version: 1\nname: broken\n'); // missing agents
      const cap = captureIo();
      const code = await fleetStatus({}, { io: cap.io, root: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('✗');
    } finally {
      h.cleanup();
    }
  });

  test('reads DECLARAGENT_FLEET_VERSION from env override', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const cap = captureIo();
      const code = await fleetStatus(
        { json: true },
        { io: cap.io, root: h.root, env: { DECLARAGENT_FLEET_VERSION: 'v9.9.9-fake111' } },
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out.join(''));
      expect(parsed.fleet.selfVersion).toBe('v9.9.9-fake111');
    } finally {
      h.cleanup();
    }
  });

  test('explicit selfVersion dep wins over env', async () => {
    const h = mkHarness();
    try {
      writeTwoAgentFleet(h);
      const cap = captureIo();
      const code = await fleetStatus(
        { json: true },
        {
          io: cap.io,
          root: h.root,
          env: { DECLARAGENT_FLEET_VERSION: 'from-env' },
          selfVersion: 'v1.2.3-forced',
        },
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out.join(''));
      expect(parsed.fleet.selfVersion).toBe('v1.2.3-forced');
    } finally {
      h.cleanup();
    }
  });
});
