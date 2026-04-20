import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetCliDeps, FleetCliIO } from './fleet-cli.js';
import { fleetCapabilities, fleetList, fleetValidate } from './fleet-cli.js';

interface Capture {
  io: FleetCliIO;
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
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-cli-'));
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

function simpleFleet(): Harness {
  const h = mkHarness();
  h.write(
    'fleet.yaml',
    `version: 1
name: acme-fleet
description: test
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

function deps(h: Harness): FleetCliDeps & { out: string[]; err: string[] } {
  const cap = captureIo();
  return { io: cap.io, root: h.root, out: cap.out, err: cap.err };
}

describe('fleet-cli / fleetList', () => {
  test('prints human-readable agent table', async () => {
    const h = simpleFleet();
    try {
      const d = deps(h);
      const code = await fleetList({}, d);
      expect(code).toBe(0);
      const out = d.out.join('');
      expect(out).toContain('fleet: acme-fleet');
      expect(out).toContain('concierge');
      expect(out).toContain('pr-reviewer');
      expect(out).toContain('capabilities=1');
      expect(out).toContain('(client-only)');
      expect(d.err.join('')).toBe('');
    } finally {
      h.cleanup();
    }
  });

  test('--json emits structured output', async () => {
    const h = simpleFleet();
    try {
      const d = deps(h);
      const code = await fleetList({ json: true }, d);
      expect(code).toBe(0);
      const parsed = JSON.parse(d.out.join(''));
      expect(parsed.manifest.name).toBe('acme-fleet');
      expect(parsed.agents).toHaveLength(2);
      expect(parsed.agents[1].capabilities).toEqual(['review-pr']);
    } finally {
      h.cleanup();
    }
  });

  test('errors when no fleet.yaml found', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetList({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml found');
    } finally {
      h.cleanup();
    }
  });

  test('reports loader errors through stderr', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', 'version: 1\nname: bad\n'); // missing agents
      const d = deps(h);
      const code = await fleetList({}, d);
      expect(code).toBe(1);
      expect(d.err.join('')).toContain('✗');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-cli / fleetCapabilities', () => {
  test('prints aggregated capability table grouped by agent', async () => {
    const h = simpleFleet();
    try {
      const d = deps(h);
      const code = await fleetCapabilities({}, d);
      expect(code).toBe(0);
      const out = d.out.join('');
      expect(out).toContain('agent://pr-reviewer');
      expect(out).toContain('review-pr');
      expect(out).toContain('timeoutMs=60000');
      expect(out).toContain('agent://concierge');
      expect(out).toContain('client-only');
    } finally {
      h.cleanup();
    }
  });

  test('--json emits per-agent capability arrays', async () => {
    const h = simpleFleet();
    try {
      const d = deps(h);
      const code = await fleetCapabilities({ json: true }, d);
      expect(code).toBe(0);
      const parsed = JSON.parse(d.out.join(''));
      expect(parsed.agents['agent://pr-reviewer']).toHaveLength(1);
      expect(parsed.agents['agent://pr-reviewer'][0].name).toBe('review-pr');
      expect(parsed.clientOnly).toEqual(['concierge']);
    } finally {
      h.cleanup();
    }
  });

  test('empty table → friendly message', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: empty-fleet
agents:
  - id: a
    path: ./agents/a
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      const d = deps(h);
      const code = await fleetCapabilities({}, d);
      expect(code).toBe(0);
      expect(d.out.join('')).toContain('no capabilities declared');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-cli / fleetValidate', () => {
  test('clean fleet → exit 0 + success message', async () => {
    const h = simpleFleet();
    try {
      const d = deps(h);
      const code = await fleetValidate({}, d);
      expect(code).toBe(0);
      expect(d.out.join('')).toContain('✓ fleet validates clean');
    } finally {
      h.cleanup();
    }
  });

  test('dangling in-fleet peer → error finding + exit 1', async () => {
    const h = simpleFleet();
    try {
      // Overwrite peers with a dangling entry.
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://ghost
    transports:
      - kind: memory
        topics: { requests: x }
`,
      );
      const d = deps(h);
      const code = await fleetValidate({}, d);
      expect(code).toBe(1);
      const out = d.out.join('');
      expect(out).toContain('peer.dangling');
      expect(out).toContain('agent://ghost');
    } finally {
      h.cleanup();
    }
  });

  test('duplicate capability names across agents → warning only (exit 0)', async () => {
    const h = simpleFleet();
    try {
      h.write(
        'agents/concierge/capabilities.yaml',
        `version: 1
agent: agent://concierge
transports:
  - kind: memory
    topics: { requests: agents.concierge.requests }
capabilities:
  - name: review-pr
`,
      );
      const d = deps(h);
      const code = await fleetValidate({}, d);
      expect(code).toBe(0);
      const out = d.out.join('');
      expect(out).toContain('capability.duplicate');
    } finally {
      h.cleanup();
    }
  });

  test('in-fleet peer with no capabilities.yaml → warning finding', async () => {
    const h = simpleFleet();
    try {
      // Overwrite peers to point at the concierge (which is client-only).
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://concierge
    transports:
      - kind: memory
        topics: { requests: x }
`,
      );
      const d = deps(h);
      const code = await fleetValidate({}, d);
      // Warning-only → exit 0.
      expect(code).toBe(0);
      expect(d.out.join('')).toContain('peer.client-only');
    } finally {
      h.cleanup();
    }
  });

  test('--json emits structured findings', async () => {
    const h = simpleFleet();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://ghost
    transports:
      - kind: memory
        topics: { requests: x }
`,
      );
      const d = deps(h);
      const code = await fleetValidate({ json: true }, d);
      expect(code).toBe(1);
      const parsed = JSON.parse(d.out.join(''));
      expect(parsed.ok).toBe(false);
      expect(parsed.findings.some((f: { code: string }) => f.code === 'peer.dangling')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('errors when no fleet.yaml is found', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetValidate({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml found');
    } finally {
      h.cleanup();
    }
  });
});
