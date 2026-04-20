import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFleet } from '@declaragent/core';
import {
  type FleetGraphIO,
  buildGraph,
  fleetGraph,
  renderDot,
  renderJson,
  renderMermaid,
} from './fleet-graph-cli.js';

interface Capture {
  io: FleetGraphIO;
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
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-graph-'));
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

describe('fleet-graph-cli / buildGraph', () => {
  test('returns expected node + edge list for a two-agent fleet', async () => {
    const h = simpleFleet();
    try {
      const fleet = await loadFleet({ root: h.root });
      const model = buildGraph(fleet);

      expect(model.nodes).toHaveLength(2);
      const concierge = model.nodes.find((n) => n.id === 'concierge');
      const reviewer = model.nodes.find((n) => n.id === 'pr-reviewer');
      expect(concierge).toBeDefined();
      expect(concierge?.clientOnly).toBe(true);
      expect(concierge?.capabilities).toEqual([]);
      expect(reviewer).toBeDefined();
      expect(reviewer?.clientOnly).toBe(false);
      expect(reviewer?.capabilities).toEqual(['review-pr']);

      // One edge: concierge → pr-reviewer with memory transport.
      expect(model.edges).toHaveLength(1);
      const edge = model.edges[0];
      expect(edge?.from).toBe('concierge');
      expect(edge?.to).toBe('pr-reviewer');
      expect(edge?.transport).toBe('memory');
      expect(edge?.capability).toBe('review-pr');
    } finally {
      h.cleanup();
    }
  });

  test('external peers appear as external nodes', async () => {
    const h = simpleFleet();
    try {
      // External peers are detected by '.' in the id (FQDN-style).
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
        topics: { requests: agents.external.requests }
`,
      );
      const fleet = await loadFleet({ root: h.root });
      const model = buildGraph(fleet);
      const external = model.nodes.find((n) => n.id === 'svc.acme.com');
      expect(external).toBeDefined();
      expect(external?.external).toBe(true);
      // Concierge is still client-only and calls the external peer.
      const externalEdges = model.edges.filter((e) => e.to === 'svc.acme.com');
      expect(externalEdges.length).toBeGreaterThan(0);
      expect(externalEdges[0]?.transport).toBe('kafka');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-graph-cli / renderMermaid', () => {
  test('is well-formed mermaid for the two-agent fleet', async () => {
    const h = simpleFleet();
    try {
      const fleet = await loadFleet({ root: h.root });
      const model = buildGraph(fleet);
      const out = renderMermaid(model);
      expect(out.startsWith('graph LR')).toBe(true);
      expect(out).toContain('agent://concierge');
      expect(out).toContain('agent://pr-reviewer');
      // Edge arrow + label.
      expect(out).toContain('-->');
      expect(out).toContain('review-pr');
      expect(out).toContain('memory');
      // Link style colors every edge.
      expect(out).toContain('linkStyle 0 stroke');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-graph-cli / renderDot', () => {
  test('is well-formed graphviz dot', async () => {
    const h = simpleFleet();
    try {
      const fleet = await loadFleet({ root: h.root });
      const model = buildGraph(fleet);
      const out = renderDot(model);
      expect(out).toContain('digraph fleet {');
      expect(out.trim().endsWith('}')).toBe(true);
      expect(out).toContain('agent://concierge');
      expect(out).toContain('agent://pr-reviewer');
      expect(out).toContain('->');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-graph-cli / renderJson', () => {
  test('produces parseable json with expected shape', async () => {
    const h = simpleFleet();
    try {
      const fleet = await loadFleet({ root: h.root });
      const model = buildGraph(fleet);
      const parsed = JSON.parse(renderJson(model));
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(Array.isArray(parsed.edges)).toBe(true);
      const nodeIds = parsed.nodes.map((n: { id: string }) => n.id).sort();
      expect(nodeIds).toEqual(['concierge', 'pr-reviewer']);
      const edge = parsed.edges[0];
      expect(edge.from).toBe('concierge');
      expect(edge.to).toBe('pr-reviewer');
      expect(edge.transport).toBe('memory');
      expect(edge.capability).toBe('review-pr');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-graph-cli / fleetGraph verb', () => {
  test('default (mermaid) writes to stdout and returns 0', async () => {
    const h = simpleFleet();
    try {
      const cap = captureIo();
      const code = await fleetGraph({}, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const out = cap.out.join('');
      expect(out.startsWith('graph LR')).toBe(true);
      expect(out).toContain('agent://pr-reviewer');
      expect(cap.err.join('')).toBe('');
    } finally {
      h.cleanup();
    }
  });

  test('--format=dot emits graphviz', async () => {
    const h = simpleFleet();
    try {
      const cap = captureIo();
      const code = await fleetGraph({ format: 'dot' }, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      expect(cap.out.join('')).toContain('digraph fleet {');
    } finally {
      h.cleanup();
    }
  });

  test('--format=json emits parseable json', async () => {
    const h = simpleFleet();
    try {
      const cap = captureIo();
      const code = await fleetGraph({ format: 'json' }, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out.join(''));
      expect(parsed.nodes.length).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  test('errors when no fleet.yaml found', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetGraph({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml found');
    } finally {
      h.cleanup();
    }
  });
});
