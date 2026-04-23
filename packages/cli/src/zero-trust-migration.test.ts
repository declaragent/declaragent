/**
 * 0.8.0 zero-trust default-flip migration tests (0.7.6 preview mode).
 *
 * Each test covers one migration scenario described in
 * `docs/ZERO_TRUST_DEFAULT_MIGRATION.md`:
 *
 *   1. Fleet with NO explicit auth on any agent.
 *   2. Fleet with FULL explicit auth on every agent.
 *   3. Fleet with PARTIAL auth (some explicit, some absent).
 *   4. Fleet with explicit OPT-OUT (`rpc.auth.enabled: false`).
 *   5. Fleet using MEMORY-ONLY transport (no rpc-peers.yaml).
 *
 * For each scenario we verify:
 *
 *   - `evaluateZeroTrustPreview({ forceFlagOn: false })` matches
 *     today's behaviour (no agent fails).
 *   - `evaluateZeroTrustPreview({ forceFlagOn: true })` matches the
 *     0.8.0 flip (agents with peers + absent posture fail).
 *   - `fleet audit-rpc --dry-run-with-flag` produces a report whose
 *     failing-agent list matches the preview result — the inspector
 *     and the boot gate must agree.
 *
 * @since 0.7.6 — POST_ENTERPRISE_BACKLOG.md #5b prep
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetAuditRpcIO } from './fleet-audit-rpc-cli.js';
import { fleetAuditRpc } from './fleet-audit-rpc-cli.js';
import { evaluateZeroTrustPreview } from './zero-trust-preview.js';

interface Harness {
  root: string;
  write(relative: string, contents: string): void;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-zt-migration-'));
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

/** Fleet manifest boilerplate for a 2-agent fleet with root peers. */
function writeFleetManifest(h: Harness, agentIds: readonly string[]): void {
  const agentsBlock = agentIds
    .map((id) => `  - id: ${id}\n    path: ./agents/${id}\n    env: shared`)
    .join('\n');
  h.write(
    'fleet.yaml',
    `version: 1
name: zt-migration
agents:
${agentsBlock}
environments:
  shared:
    peersRef: ./rpc-peers.yaml
`,
  );
}

function writeRootPeersYaml(h: Harness, agentIds: readonly string[]): void {
  const peers = agentIds
    .map(
      (id) => `  - agent: agent://${id}
    transports:
      - kind: memory
        topics: { requests: agents.${id}.requests }
    auth:
      provider: oidc
      issuer: https://idp.example.com
      audience: declaragent-fleet`,
    )
    .join('\n');
  h.write('rpc-peers.yaml', `version: 1\npeers:\n${peers}\n`);
}

function captureIo(): { io: FleetAuditRpcIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    out,
    err,
  };
}

describe('zero-trust migration / scenario 1 — fleet with NO explicit auth on any agent', () => {
  function fixture(): Harness {
    const h = mkHarness();
    writeFleetManifest(h, ['alpha', 'beta']);
    writeRootPeersYaml(h, ['alpha', 'beta']);
    h.write('agents/alpha/agent.yaml', 'name: alpha\n');
    h.write('agents/beta/agent.yaml', 'name: beta\n');
    return h;
  }

  test('flag off → evaluate passes, every agent legacy-default', async () => {
    const h = fixture();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const result = await evaluateZeroTrustPreview({ fleet, forceFlagOn: false });
      expect(result.flagOn).toBe(false);
      expect(result.failingAgents).toHaveLength(0);
      expect(result.agents.every((a) => a.reason === 'legacy-default')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('flag on → BOTH agents fail the gate with AUTH_REJECTED', async () => {
    const h = fixture();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const result = await evaluateZeroTrustPreview({ fleet, forceFlagOn: true });
      expect(result.flagOn).toBe(true);
      expect(result.failingAgents.map((a) => a.agentId).sort()).toEqual(['alpha', 'beta']);
      expect(result.failingAgents.every((a) => a.reason === 'boot-fail')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('inspector --dry-run-with-flag reports the same failing set, exits 1 under --strict', async () => {
    const h = fixture();
    try {
      const cap = captureIo();
      const code = await fleetAuditRpc(
        { dryRunWithFlag: true, strict: true },
        { io: cap.io, root: h.root },
      );
      expect(code).toBe(1);
      const text = cap.out.join('');
      expect(text).toContain('0.8.0 zero-trust default flip');
      expect(text).toContain('alpha');
      expect(text).toContain('beta');
      expect(text).toContain('AUTH_REJECTED');
    } finally {
      h.cleanup();
    }
  });

  test('inspector --dry-run-with-flag --json emits the same failing set under `dryRunWithFlag`', async () => {
    const h = fixture();
    try {
      const cap = captureIo();
      const code = await fleetAuditRpc(
        { dryRunWithFlag: true, json: true, strict: true },
        { io: cap.io, root: h.root },
      );
      expect(code).toBe(1);
      interface Parsed {
        ok: boolean;
        dryRunWithFlag: {
          flagOn: boolean;
          wouldBootCleanly: boolean;
          failingAgents: { agentId: string }[];
        };
      }
      const parsed = JSON.parse(cap.out.join('')) as Parsed;
      expect(parsed.dryRunWithFlag.flagOn).toBe(true);
      expect(parsed.dryRunWithFlag.wouldBootCleanly).toBe(false);
      expect(parsed.dryRunWithFlag.failingAgents.map((a) => a.agentId).sort()).toEqual([
        'alpha',
        'beta',
      ]);
      expect(parsed.ok).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

describe('zero-trust migration / scenario 2 — fleet with FULL explicit auth on every agent', () => {
  function fixture(): Harness {
    const h = mkHarness();
    writeFleetManifest(h, ['alpha', 'beta']);
    writeRootPeersYaml(h, ['alpha', 'beta']);
    h.write('agents/alpha/agent.yaml', 'name: alpha\nrpc:\n  auth:\n    enabled: true\n');
    h.write('agents/beta/agent.yaml', 'name: beta\nrpc:\n  auth:\n    enabled: true\n');
    return h;
  }

  test('flag off and on both pass — no failing agents in either mode', async () => {
    const h = fixture();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const off = await evaluateZeroTrustPreview({ fleet, forceFlagOn: false });
      const on = await evaluateZeroTrustPreview({ fleet, forceFlagOn: true });
      expect(off.failingAgents).toHaveLength(0);
      expect(on.failingAgents).toHaveLength(0);
      expect(off.agents.every((a) => a.reason === 'explicit')).toBe(true);
      expect(on.agents.every((a) => a.reason === 'explicit')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('inspector --dry-run-with-flag --strict exits 0', async () => {
    const h = fixture();
    try {
      const cap = captureIo();
      const code = await fleetAuditRpc(
        { dryRunWithFlag: true, strict: true },
        { io: cap.io, root: h.root },
      );
      expect(code).toBe(0);
      expect(cap.out.join('')).toContain('no agents would fail');
    } finally {
      h.cleanup();
    }
  });
});

describe('zero-trust migration / scenario 3 — fleet with PARTIAL auth', () => {
  function fixture(): Harness {
    const h = mkHarness();
    writeFleetManifest(h, ['secure', 'legacy']);
    writeRootPeersYaml(h, ['secure', 'legacy']);
    h.write('agents/secure/agent.yaml', 'name: secure\nrpc:\n  auth:\n    enabled: true\n');
    h.write('agents/legacy/agent.yaml', 'name: legacy\n');
    return h;
  }

  test('flag off → zero failures, `legacy` reported as legacy-default', async () => {
    const h = fixture();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const result = await evaluateZeroTrustPreview({ fleet, forceFlagOn: false });
      expect(result.failingAgents).toHaveLength(0);
      const byId = Object.fromEntries(result.agents.map((a) => [a.agentId, a]));
      expect(byId.secure?.reason).toBe('explicit');
      expect(byId.legacy?.reason).toBe('legacy-default');
    } finally {
      h.cleanup();
    }
  });

  test('flag on → only `legacy` fails, `secure` passes', async () => {
    const h = fixture();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const result = await evaluateZeroTrustPreview({ fleet, forceFlagOn: true });
      expect(result.failingAgents).toHaveLength(1);
      expect(result.failingAgents[0]?.agentId).toBe('legacy');
      const byId = Object.fromEntries(result.agents.map((a) => [a.agentId, a]));
      expect(byId.secure?.reason).toBe('explicit');
      expect(byId.legacy?.reason).toBe('boot-fail');
    } finally {
      h.cleanup();
    }
  });

  test('inspector report matches the boot-gate outcome — same agent ids in `failingAgents`', async () => {
    const h = fixture();
    try {
      const cap = captureIo();
      const code = await fleetAuditRpc(
        { dryRunWithFlag: true, json: true, strict: true },
        { io: cap.io, root: h.root },
      );
      expect(code).toBe(1);
      interface Parsed {
        dryRunWithFlag: {
          failingAgents: { agentId: string }[];
        };
      }
      const parsed = JSON.parse(cap.out.join('')) as Parsed;
      expect(parsed.dryRunWithFlag.failingAgents.map((a) => a.agentId)).toEqual(['legacy']);
    } finally {
      h.cleanup();
    }
  });
});

describe('zero-trust migration / scenario 4 — explicit OPT-OUT (Path B)', () => {
  function fixture(): Harness {
    const h = mkHarness();
    writeFleetManifest(h, ['legacy-pilot']);
    writeRootPeersYaml(h, ['legacy-pilot']);
    h.write(
      'agents/legacy-pilot/agent.yaml',
      'name: legacy-pilot\nrpc:\n  auth:\n    enabled: false\n',
    );
    return h;
  }

  test('flag on → no boot-fail, agent is reported as explicit-optout', async () => {
    const h = fixture();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const result = await evaluateZeroTrustPreview({ fleet, forceFlagOn: true });
      expect(result.failingAgents).toHaveLength(0);
      expect(result.intentionalOptOuts).toHaveLength(1);
      expect(result.intentionalOptOuts[0]?.agentId).toBe('legacy-pilot');
    } finally {
      h.cleanup();
    }
  });

  test('inspector --dry-run-with-flag surfaces the opt-out section', async () => {
    const h = fixture();
    try {
      const cap = captureIo();
      const code = await fleetAuditRpc({ dryRunWithFlag: true }, { io: cap.io, root: h.root });
      expect(code).toBe(0);
      const text = cap.out.join('');
      expect(text).toContain('explicitly opt out');
      expect(text).toContain('legacy-pilot');
    } finally {
      h.cleanup();
    }
  });
});

describe('zero-trust migration / scenario 5 — MEMORY-ONLY fleet (no rpc-peers.yaml)', () => {
  function fixture(): Harness {
    const h = mkHarness();
    h.write(
      'fleet.yaml',
      `version: 1
name: memory-only
agents:
  - id: a
    path: ./agents/a
    env: shared
  - id: b
    path: ./agents/b
    env: shared
environments:
  shared: {}
`,
    );
    h.write('agents/a/agent.yaml', 'name: a\n');
    h.write('agents/b/agent.yaml', 'name: b\n');
    return h;
  }

  test('flag on → no boot-fail, every agent reported as no-peers (exempt)', async () => {
    const h = fixture();
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const result = await evaluateZeroTrustPreview({ fleet, forceFlagOn: true });
      expect(result.failingAgents).toHaveLength(0);
      expect(result.agents.every((a) => a.peersDeclared === false)).toBe(true);
      expect(result.agents.every((a) => a.reason === 'no-peers')).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('zero-trust migration / env var flag detection', () => {
  test('DECLARAGENT_RPC_AUTH_DEFAULT=on flips flagOn to true', async () => {
    const h = mkHarness();
    writeFleetManifest(h, ['a']);
    writeRootPeersYaml(h, ['a']);
    h.write('agents/a/agent.yaml', 'name: a\n');
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const result = await evaluateZeroTrustPreview({
        fleet,
        env: { DECLARAGENT_RPC_AUTH_DEFAULT: 'on' },
      });
      expect(result.flagOn).toBe(true);
      expect(result.failingAgents).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test('DECLARAGENT_RPC_AUTH_DEFAULT=off (or absent) keeps flagOn false', async () => {
    const h = mkHarness();
    writeFleetManifest(h, ['a']);
    writeRootPeersYaml(h, ['a']);
    h.write('agents/a/agent.yaml', 'name: a\n');
    try {
      const { loadFleet } = await import('@declaragent/core');
      const fleet = await loadFleet({ root: h.root });
      const off = await evaluateZeroTrustPreview({
        fleet,
        env: { DECLARAGENT_RPC_AUTH_DEFAULT: 'off' },
      });
      const absent = await evaluateZeroTrustPreview({ fleet, env: {} });
      expect(off.flagOn).toBe(false);
      expect(absent.flagOn).toBe(false);
      expect(off.failingAgents).toHaveLength(0);
      expect(absent.failingAgents).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});
