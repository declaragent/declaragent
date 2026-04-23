import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetAuditRpcDeps, FleetAuditRpcIO } from './fleet-audit-rpc-cli.js';
import { buildAuditRpcReport, fleetAuditRpc, suggestRpcAuthYaml } from './fleet-audit-rpc-cli.js';

interface Capture {
  io: FleetAuditRpcIO;
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
  const root = mkdtempSync(join(tmpdir(), 'declaragent-audit-rpc-'));
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

/**
 * Three-agent fleet: `fully-on` has `rpc.auth.enabled: true`;
 * `partial` has the block but `enabled: false`; `absent` has no `rpc:`
 * block at all. rpc-peers.yaml references `fully-on` with an OIDC
 * auth block so the suggestion path has a provider to echo.
 */
function threeCaseFleet(): Harness {
  const h = mkHarness();
  h.write(
    'fleet.yaml',
    `version: 1
name: three-case
agents:
  - id: fully-on
    path: ./agents/fully-on
    env: shared
  - id: partial
    path: ./agents/partial
    env: shared
  - id: absent
    path: ./agents/absent
    env: shared
environments:
  shared:
    peersRef: ./rpc-peers.yaml
`,
  );
  h.write(
    'agents/fully-on/agent.yaml',
    `name: fully-on
rpc:
  auth:
    enabled: true
`,
  );
  h.write(
    'agents/partial/agent.yaml',
    `name: partial
rpc:
  auth:
    enabled: false
`,
  );
  h.write('agents/absent/agent.yaml', 'name: absent\n');
  h.write(
    'rpc-peers.yaml',
    `version: 1
peers:
  - agent: agent://fully-on
    transports:
      - kind: memory
        topics: { requests: agents.fully-on.requests }
    auth:
      provider: oidc
      issuer: https://idp.example.com
      audience: declaragent-fleet
`,
  );
  return h;
}

function deps(h: Harness): FleetAuditRpcDeps & { out: string[]; err: string[] } {
  const cap = captureIo();
  return { io: cap.io, root: h.root, out: cap.out, err: cap.err };
}

describe('fleet-audit-rpc / buildAuditRpcReport', () => {
  test('classifies each of the three cases correctly', async () => {
    const h = threeCaseFleet();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const report = await buildAuditRpcReport(fleet);

      const byId = Object.fromEntries(report.agents.map((a) => [a.agentId, a]));
      expect(byId['fully-on']?.state).toBe('enabled');
      expect(byId.partial?.state).toBe('disabled');
      expect(byId.absent?.state).toBe('absent');
      expect(report.allEnabled).toBe(false);

      // fully-on is referenced in rpc-peers.yaml with auth → snapshot it.
      expect(byId['fully-on']?.suggestedFromPeer?.provider).toBe('oidc');
      // partial + absent have no peer entry → no suggestion hint.
      expect(byId.partial?.suggestedFromPeer).toBeUndefined();
      expect(byId.absent?.suggestedFromPeer).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test('state overrides bypass disk reads', async () => {
    const h = threeCaseFleet();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const overrides = new Map([
        ['fully-on', { state: 'enabled' as const }],
        ['partial', { state: 'enabled' as const }],
        ['absent', { state: 'enabled' as const }],
      ]);
      const report = await buildAuditRpcReport(fleet, { stateOverrides: overrides });
      expect(report.allEnabled).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-audit-rpc / suggestRpcAuthYaml', () => {
  test('echoes peer provider when a peer entry is present', () => {
    const yaml = suggestRpcAuthYaml({
      agentId: 'fully-on',
      agentYamlPath: '/tmp/a.yaml',
      state: 'absent',
      suggestedFromPeer: {
        provider: 'oidc',
        issuer: 'https://idp.example.com',
        audience: 'declaragent-fleet',
      },
    });
    expect(yaml).toContain('rpc:');
    expect(yaml).toContain('auth:');
    expect(yaml).toContain('enabled: true');
    expect(yaml).toContain('provider=oidc');
    expect(yaml).toContain('fully-on');
  });

  test('prints a "add peer first" note when no peer entry exists', () => {
    const yaml = suggestRpcAuthYaml({
      agentId: 'absent',
      agentYamlPath: '/tmp/a.yaml',
      state: 'absent',
    });
    expect(yaml).toContain('rpc:');
    expect(yaml).toContain('enabled: true');
    expect(yaml).toContain('rpc-peers.yaml');
  });
});

describe('fleet-audit-rpc / fleetAuditRpc', () => {
  test('plain run reports each state + exits 0 without --strict', async () => {
    const h = threeCaseFleet();
    try {
      const d = deps(h);
      const code = await fleetAuditRpc({}, d);
      expect(code).toBe(0);
      const out = d.out.join('');
      expect(out).toContain('fully-on');
      expect(out).toContain('partial');
      expect(out).toContain('absent');
      expect(out).toContain('enabled');
      expect(out).toContain('not configured');
      expect(out).toContain('disabled (explicit)');
      // Default run hints at --suggest-enable but does not emit the diff.
      expect(out).toContain('--suggest-enable');
      expect(out).not.toContain('rpc:\n  auth:\n    enabled: true');
    } finally {
      h.cleanup();
    }
  });

  test('--suggest-enable emits copy-pasteable YAML for each gap', async () => {
    const h = threeCaseFleet();
    try {
      const d = deps(h);
      const code = await fleetAuditRpc({ suggestEnable: true }, d);
      expect(code).toBe(0);
      const out = d.out.join('');
      expect(out).toContain('rpc:\n  auth:\n    enabled: true');
      // We print a snippet per gap agent (partial + absent).
      const snippetCount = out.split('enabled: true').length - 1;
      expect(snippetCount).toBeGreaterThanOrEqual(2);
      expect(out).toContain('partial');
      expect(out).toContain('absent');
      expect(out).toContain('fleet validate');
    } finally {
      h.cleanup();
    }
  });

  test('--strict with gaps → exit 1', async () => {
    const h = threeCaseFleet();
    try {
      const d = deps(h);
      const code = await fleetAuditRpc({ strict: true }, d);
      expect(code).toBe(1);
      const out = d.out.join('');
      expect(out).toContain('--strict');
      expect(out).toContain('non-zero');
    } finally {
      h.cleanup();
    }
  });

  test('fully-enabled fleet → exit 0 even under --strict', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: clean
agents:
  - id: one
    path: ./agents/one
    env: shared
environments:
  shared: {}
`,
      );
      h.write(
        'agents/one/agent.yaml',
        `name: one
rpc:
  auth:
    enabled: true
`,
      );
      const d = deps(h);
      const code = await fleetAuditRpc({ strict: true }, d);
      expect(code).toBe(0);
      expect(d.out.join('')).toContain('every agent has rpc.auth.enabled: true');
    } finally {
      h.cleanup();
    }
  });

  test('--json emits structured report with per-agent state + suggestion when asked', async () => {
    const h = threeCaseFleet();
    try {
      const d = deps(h);
      const code = await fleetAuditRpc({ suggestEnable: true, json: true, strict: true }, d);
      expect(code).toBe(1);
      interface JsonAgent {
        agentId: string;
        state: string;
        suggestion?: string;
        peerAuthProvider?: string;
      }
      const parsed = JSON.parse(d.out.join('')) as {
        allEnabled: boolean;
        ok: boolean;
        agents: JsonAgent[];
      };
      expect(parsed.allEnabled).toBe(false);
      expect(parsed.ok).toBe(false);
      const byId = Object.fromEntries(parsed.agents.map((a) => [a.agentId, a]));
      expect(byId['fully-on']?.state).toBe('enabled');
      expect(byId['fully-on']?.suggestion).toBeUndefined();
      expect(byId.partial?.state).toBe('disabled');
      expect(byId.partial?.suggestion).toContain('enabled: true');
      expect(byId.absent?.state).toBe('absent');
      expect(byId.absent?.suggestion).toContain('enabled: true');
      expect(byId['fully-on']?.peerAuthProvider).toBe('oidc');
    } finally {
      h.cleanup();
    }
  });

  test('no fleet.yaml → stderr + exit 1', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetAuditRpc({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml found');
    } finally {
      h.cleanup();
    }
  });

  test('unreadable agent.yaml is reported, does not crash', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: borked
agents:
  - id: one
    path: ./agents/one
    env: shared
environments:
  shared: {}
`,
      );
      h.write('agents/one/agent.yaml', 'name: one\n');
      // Override the reader to simulate an EACCES-like failure.
      const d = deps(h);
      const code = await fleetAuditRpc(
        {},
        {
          ...d,
          readStateForAgent: async () => ({ state: 'unreadable', reason: 'boom' }),
        },
      );
      expect(code).toBe(0); // not strict
      expect(d.out.join('')).toContain('unreadable');
      expect(d.out.join('')).toContain('boom');
    } finally {
      h.cleanup();
    }
  });
});
