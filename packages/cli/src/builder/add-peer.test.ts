import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPeerEntry, createAddPeerTool, runAddPeer } from './add-peer.js';
import { BuilderScopeError, BuilderValidationError } from './types.js';

const BASE_PEERS = `# existing peers
version: 1
peers:
  - agent: agent://concierge
    transports:
      - kind: memory
        topics:
          requests: agents.concierge.requests
`;

describe('runAddPeer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-add-peer-'));
    writeFileSync(join(dir, 'fleet.yaml'), 'version: 1\nname: demo\nagents: []\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates rpc-peers.yaml from scratch when absent', async () => {
    const out = await runAddPeer(
      {
        agent: 'agent://pr-reviewer',
        transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
      },
      { scopeRoot: dir },
    );
    expect(out.ok).toBe(true);
    expect(out.merged).toBe(false);
    const contents = readFileSync(join(dir, 'rpc-peers.yaml'), 'utf-8');
    expect(contents).toMatch(/version:\s*1/);
    expect(contents).toContain('agent://pr-reviewer');
    expect(contents).toContain('agents.pr-reviewer.requests');
  });

  test('appends to an existing rpc-peers.yaml preserving the pre-existing peer', async () => {
    writeFileSync(join(dir, 'rpc-peers.yaml'), BASE_PEERS);
    const out = await runAddPeer(
      {
        agent: 'agent://pr-reviewer',
        transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
      },
      { scopeRoot: dir },
    );
    expect(out.merged).toBe(false);
    const contents = readFileSync(join(dir, 'rpc-peers.yaml'), 'utf-8');
    // Comment survives.
    expect(contents).toContain('# existing peers');
    expect(contents).toContain('agent://concierge');
    expect(contents).toContain('agent://pr-reviewer');
  });

  test('merges a new transport into an existing peer entry', async () => {
    writeFileSync(join(dir, 'rpc-peers.yaml'), BASE_PEERS);
    const out = await runAddPeer(
      {
        agent: 'agent://concierge',
        transports: [
          {
            kind: 'kafka',
            brokers: ['${env:KAFKA_BROKERS}'],
            topics: { requests: 'agents.concierge.requests' },
          },
        ],
      },
      { scopeRoot: dir },
    );
    expect(out.merged).toBe(true);
    const contents = readFileSync(join(dir, 'rpc-peers.yaml'), 'utf-8');
    expect(contents).toContain('- kind: memory');
    expect(contents).toContain('- kind: kafka');
  });

  test('is idempotent when the exact transport already exists', async () => {
    writeFileSync(join(dir, 'rpc-peers.yaml'), BASE_PEERS);
    const before = readFileSync(join(dir, 'rpc-peers.yaml'), 'utf-8');
    const out = await runAddPeer(
      {
        agent: 'agent://concierge',
        transports: [{ kind: 'memory', topics: { requests: 'agents.concierge.requests' } }],
      },
      { scopeRoot: dir },
    );
    // merged is true (existing entry), but no new transport line was added.
    expect(out.merged).toBe(true);
    const after = readFileSync(join(dir, 'rpc-peers.yaml'), 'utf-8');
    // Count memory transports — should still be 1.
    expect((after.match(/- kind: memory/g) ?? []).length).toBe(1);
    // Pre-existing comment still present.
    expect(after).toContain('# existing peers');
    // File may be byte-equal or whitespace-altered; what matters is we
    // didn't duplicate the memory entry.
    expect(after.length).toBeGreaterThanOrEqual(before.length - 5);
  });

  test('rejects invalid transport kind via core peersConfigSchema', async () => {
    await expect(
      runAddPeer(
        {
          agent: 'agent://pr-reviewer',
          // biome-ignore lint/suspicious/noExplicitAny: exercising schema rejection
          transports: [{ kind: 'mail' as any }],
        },
        { scopeRoot: dir },
      ),
    ).rejects.toThrow();
  });

  test('rejects an out-of-scope fleetRoot without confirmOutsideScope', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'declara-peer-sibling-'));
    try {
      writeFileSync(join(sibling, 'fleet.yaml'), 'version: 1\nname: x\nagents: []\n');
      await expect(
        runAddPeer(
          {
            agent: 'agent://pr-reviewer',
            transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
            fleetRoot: sibling,
          },
          { scopeRoot: dir },
        ),
      ).rejects.toBeInstanceOf(BuilderScopeError);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('rejects malformed YAML in an existing rpc-peers.yaml', async () => {
    writeFileSync(join(dir, 'rpc-peers.yaml'), ':\nthis is: not: valid\n  - also:: bad\n');
    await expect(
      runAddPeer(
        {
          agent: 'agent://pr-reviewer',
          transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
        },
        { scopeRoot: dir },
      ),
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });
});

describe('appendPeerEntry helper', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-peer-helper-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns merged: false for a fresh entry', async () => {
    const p = join(dir, 'rpc-peers.yaml');
    const { merged } = await appendPeerEntry(p, {
      agent: 'agent://a',
      transports: [{ kind: 'memory', topics: { requests: 'agents.a.requests' } }],
    });
    expect(merged).toBe(false);
    expect(existsSync(p)).toBe(true);
  });
});

describe('createAddPeerTool', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-peer-tool-'));
    writeFileSync(join(dir, 'fleet.yaml'), 'version: 1\nname: demo\nagents: []\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('tool metadata', () => {
    const tool = createAddPeerTool({ scopeRoot: dir });
    expect(tool.name).toBe('DeclaraAddPeer');
    expect(tool.readonly).toBe(false);
  });

  test('permissionKey includes the agent uri', () => {
    const tool = createAddPeerTool({ scopeRoot: dir });
    expect(
      tool.permissionKey({
        agent: 'agent://pr-reviewer',
        transports: [{ kind: 'memory', topics: { requests: 'x' } }],
      }),
    ).toBe('.:agent://pr-reviewer');
  });
});
