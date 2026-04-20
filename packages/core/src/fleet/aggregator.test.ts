import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateCapabilities, aggregatePeers } from './aggregator.js';
import { loadFleet } from './manifest-loader.js';

interface Harness {
  root: string;
  write(relative: string, contents: string): string;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-agg-'));
  return {
    root,
    write(relative, contents) {
      const full = join(root, relative);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents, 'utf-8');
      return full;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function fixture(): Promise<{ h: Harness; load: () => ReturnType<typeof loadFleet> }> {
  const h = mkHarness();
  h.write(
    'fleet.yaml',
    `version: 1
name: t
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
  - name: summarize-pr
`,
  );
  return { h, load: () => loadFleet({ root: h.root }) };
}

describe('aggregateCapabilities', () => {
  test('indexes capabilities by agent/name and name', async () => {
    const { h, load } = await fixture();
    try {
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
      const fleet = await load();
      const table = aggregateCapabilities(fleet);
      expect(table.byKey.get('pr-reviewer/review-pr')?.capability.timeoutMs).toBe(60000);
      expect(table.byKey.get('pr-reviewer/summarize-pr')).toBeDefined();
      expect(table.byName.get('review-pr')).toHaveLength(1);
      expect(table.clientOnly).toEqual(['concierge']);
    } finally {
      h.cleanup();
    }
  });

  test('empty capabilities → empty table + all agents client-only', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      const fleet = await loadFleet({ root: h.root });
      const table = aggregateCapabilities(fleet);
      expect(table.byKey.size).toBe(0);
      expect(table.clientOnly).toEqual(['a']);
    } finally {
      h.cleanup();
    }
  });
});

describe('aggregatePeers', () => {
  test('marks an in-fleet peer as non-external', async () => {
    const { h, load } = await fixture();
    try {
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
      const fleet = await load();
      const report = aggregatePeers(fleet);
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]?.external).toBe(false);
      expect(report.danglingInFleet).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test('flags a peer with a bare id unknown to the fleet as dangling', async () => {
    const { h, load } = await fixture();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://nowhere
    transports:
      - kind: memory
        topics: { requests: x }
`,
      );
      const fleet = await load();
      const report = aggregatePeers(fleet);
      expect(report.danglingInFleet).toEqual(['agent://nowhere']);
      expect(report.external).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test('treats an fqdn-shaped peer id as external', async () => {
    const { h, load } = await fixture();
    try {
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://partner.co
    transports:
      - kind: memory
        topics: { requests: x }
`,
      );
      const fleet = await load();
      const report = aggregatePeers(fleet);
      expect(report.external).toEqual(['agent://partner.co']);
      expect(report.danglingInFleet).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test('no peers config → empty report', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      const fleet = await loadFleet({ root: h.root });
      const report = aggregatePeers(fleet);
      expect(report.entries).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
