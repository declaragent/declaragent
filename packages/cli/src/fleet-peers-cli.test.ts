import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFleet } from '@declaragent/core';
import { type FleetPeersIO, buildPeersReport, fleetPeers } from './fleet-peers-cli.js';

interface Capture {
  io: FleetPeersIO;
  out: string[];
  err: string[];
}

function captureIo(): Capture {
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
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-peers-'));
  return {
    root,
    write(relative, contents) {
      const full = join(root, relative);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents, 'utf-8');
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function cleanFleet(): Harness {
  const h = mkHarness();
  h.write(
    'fleet.yaml',
    `version: 1
name: acme-fleet
agents:
  - id: concierge
    path: ./agents/concierge
    env: shared
  - id: pr-reviewer
    path: ./agents/pr-reviewer
    env: shared
environments:
  shared:
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
    timeoutMs: 60000
    idempotent: true
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
  return h;
}

describe('fleet-peers-cli / buildPeersReport', () => {
  test('clean fleet reports reachable for memory peers on verify', async () => {
    const h = cleanFleet();
    try {
      const fleet = await loadFleet({ root: h.root });
      const report = buildPeersReport(fleet, { verify: true });
      expect(report.peers).toHaveLength(1);
      expect(report.peers[0]?.agent).toBe('agent://pr-reviewer');
      expect(report.peers[0]?.worstStatus).toBe('reachable');
      expect(report.okInFleet).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('dangling peer is unreachable', async () => {
    const h = cleanFleet();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://ghost
    transports:
      - kind: memory
        topics: { requests: agents.ghost.requests }
`,
      );
      const fleet = await loadFleet({ root: h.root });
      const report = buildPeersReport(fleet, { verify: true });
      expect(report.peers[0]?.dangling).toBe(true);
      expect(report.peers[0]?.worstStatus).toBe('unreachable');
      expect(report.okInFleet).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test('non-memory peer to in-fleet agent is not-yet-probed', async () => {
    const h = cleanFleet();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://pr-reviewer
    transports:
      - kind: kafka
        brokers: [broker:9092]
        topics: { requests: agents.pr-reviewer.requests }
`,
      );
      const fleet = await loadFleet({ root: h.root });
      const report = buildPeersReport(fleet, { verify: true });
      const transport = report.peers[0]?.transports[0];
      expect(transport?.status).toBe('not-yet-probed');
      // Does not fail verify.
      expect(report.okInFleet).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('external peer is classified external, not unreachable', async () => {
    const h = cleanFleet();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://svc.acme.com
    transports:
      - kind: kafka
        brokers: [b:9092]
        topics: { requests: external.requests }
`,
      );
      const fleet = await loadFleet({ root: h.root });
      const report = buildPeersReport(fleet, { verify: true });
      expect(report.peers[0]?.external).toBe(true);
      expect(report.peers[0]?.worstStatus).toBe('external');
      expect(report.okInFleet).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-peers-cli / fleetPeers verb', () => {
  test('prints reachable section for a clean fleet with --verify and exits 0', async () => {
    const h = cleanFleet();
    try {
      const cap = captureIo();
      const code = await fleetPeers({ verify: true }, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const out = cap.out.join('');
      expect(out).toContain('reachable:');
      expect(out).toContain('agent://pr-reviewer');
      expect(out).toContain('memory');
    } finally {
      h.cleanup();
    }
  });

  test('--verify exits 1 when a peer references a missing agent', async () => {
    const h = cleanFleet();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://ghost
    transports:
      - kind: memory
        topics: { requests: ghost.requests }
`,
      );
      const cap = captureIo();
      const code = await fleetPeers({ verify: true }, { io: cap.io, root: h.root });
      expect(code).toBe(1);
      const out = cap.out.join('');
      expect(out).toContain('unreachable:');
      expect(out).toContain('agent://ghost');
    } finally {
      h.cleanup();
    }
  });

  test('without --verify, memory peers render as in-fleet and exit is 0', async () => {
    const h = cleanFleet();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://ghost
    transports:
      - kind: memory
        topics: { requests: ghost.requests }
`,
      );
      const cap = captureIo();
      const code = await fleetPeers({}, { io: cap.io, root: h.root });
      // Without --verify we don't gate exit on dangling. Printed-only view.
      expect(code).toBe(0);
      expect(cap.out.join('')).toContain('agent://ghost');
    } finally {
      h.cleanup();
    }
  });

  test('prints external section when a peer points outside the fleet', async () => {
    const h = cleanFleet();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://pr-reviewer
    transports:
      - kind: memory
        topics: { requests: agents.pr-reviewer.requests }
  - agent: agent://svc.acme.com
    transports:
      - kind: kafka
        brokers: [b:9092]
        topics: { requests: ext.requests }
`,
      );
      const cap = captureIo();
      const code = await fleetPeers({ verify: true }, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const out = cap.out.join('');
      expect(out).toContain('external:');
      expect(out).toContain('agent://svc.acme.com');
    } finally {
      h.cleanup();
    }
  });

  test('--json emits a parseable structure with consistent keys', async () => {
    const h = cleanFleet();
    try {
      const cap = captureIo();
      const code = await fleetPeers({ verify: true, json: true }, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out.join(''));
      expect(parsed.verify).toBe(true);
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.peers)).toBe(true);
      expect(parsed.peers[0].agent).toBe('agent://pr-reviewer');
      expect(parsed.peers[0].status).toBe('reachable');
      expect(parsed.peers[0].transports[0].kind).toBe('memory');
      expect(parsed.peers[0].transports[0].status).toBe('reachable');
    } finally {
      h.cleanup();
    }
  });

  test('errors when no fleet.yaml found', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetPeers({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml found');
    } finally {
      h.cleanup();
    }
  });
});
