/**
 * 0.8.0 mixed-version rolling-upgrade rehearsal (RELEASE_0_8_0_PLAN.md §5).
 *
 * Runs a REAL mixed-version fleet over a REAL Kafka broker:
 *
 *   - agent `oldside` — the published `@declaragent/cli` from npm
 *     (`DECLARAGENT_REHEARSAL_OLD_VERSION`, default `latest`), booted via its
 *     shipped `fleet run` verb in its own fleet root + config dir.
 *   - agent `newside` — the working tree's CLI (`packages/cli/src/index.tsx`),
 *     i.e. the 0.8.0 release candidate.
 *
 * Both sides declare `rpc.auth.enabled: true` with hmac auth on every peer.
 * The driver (this test) signs with the shared pair and asserts the
 * mixed-version wire contract:
 *
 *   Leg A — signed request → NEW side: verified, served, response SIGNED.
 *   Leg B — signed request → OLD side: verified, served. Response signed
 *           when the old side is ≥ 0.7.8 (the first version that ships the
 *           outbound signer); 0.7.7 responds `internal` — the documented
 *           reason the migration mandates the 0.7.8 stepping stone before
 *           taking 0.8.0. The assertion is version-aware so this test
 *           FLIPS to requiring a signed response once 0.7.8 is `latest`.
 *   Leg C — unsigned request (registered peer identity) → NEW side:
 *           silently rejected pre-handler (fail-closed strict verify).
 *   Leg D — unsigned request from an UNREGISTERED sender → NEW side:
 *           rejected (`unknown-peer` path).
 *
 * Gated: ROLLING_UPGRADE=1 + KAFKA_BROKERS (network for npm install + broker).
 * Pre-tag gate for 0.8.0; kept dispatchable via rolling-upgrade.yml.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRpcEnvelope, RpcTransport } from '@declaragent/core';
import { createHmacAuthProvider, createKafkaTransport } from '@declaragent/plugin-agent-rpc';
import { resolveKafkaJsModule } from './harness/kafkajs-resolver.js';

const ENABLED = process.env.ROLLING_UPGRADE === '1' && !!process.env.KAFKA_BROKERS;
const describeRehearsal = ENABLED ? describe : describe.skip;

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');
const OLD_VERSION_SPEC = process.env.DECLARAGENT_REHEARSAL_OLD_VERSION ?? 'latest';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEW_CLI_ENTRY = resolve(HERE, '../../../cli/src/index.tsx');

const HMAC_KEY_ID = 'rehearsal-k1';
const HMAC_SECRET_ENV = 'DECLARAGENT_REHEARSAL_HMAC_SECRET';
const HMAC_SECRET = process.env[HMAC_SECRET_ENV] ?? 'rehearsal-shared-hmac-secret';

const RESPONSE_DEADLINE_MS = 20_000;
const REJECT_WINDOW_MS = 6_000;

interface SideProc {
  proc: ReturnType<typeof spawn>;
  logs: string[];
  stopped: Promise<void>;
}

interface Rehearsal {
  root: string;
  driverResponses: string;
  oldRequests: string;
  newRequests: string;
  oldVersion: string;
  oldSigns: boolean;
  old: SideProc;
  fresh: SideProc;
  driver: RpcTransport;
  pending: Map<string, (envelope: AgentRpcEnvelope) => void>;
}

function semverGte(version: string, min: [number, number, number]): boolean {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i += 1) {
    const a = parts[i] as number;
    const b = min[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}

/** One single-agent fleet root whose peer table lists the counterpart + driver. */
function scaffoldSide(opts: {
  base: string;
  self: string;
  selfRequests: string;
  peer: string;
  peerRequests: string;
}): string {
  const root = join(opts.base, `${opts.self}-fleet`);
  const agentDir = join(root, 'agents', opts.self);
  mkdirSync(agentDir, { recursive: true });
  const hmac = `    auth:
      provider: hmac
      keyId: ${HMAC_KEY_ID}
      secretRef: env:${HMAC_SECRET_ENV}`;
  writeFileSync(
    join(root, 'fleet.yaml'),
    `version: 1
name: rehearsal-${opts.self}
agents:
  - id: ${opts.self}
    path: ./agents/${opts.self}
    env: shared
environments:
  shared:
    peersRef: ./rpc-peers.yaml
`,
  );
  writeFileSync(
    join(root, 'rpc-peers.yaml'),
    `version: 1
peers:
  - agent: agent://${opts.peer}
    transports:
      - kind: kafka
        brokers: ["${BROKERS.join('","')}"]
        topics:
          requests: ${opts.peerRequests}
${hmac}
  - agent: agent://driver
    transports:
      - kind: kafka
        brokers: ["${BROKERS.join('","')}"]
        topics:
          requests: rehearsal.driver.requests.unused
${hmac}
`,
  );
  writeFileSync(
    join(agentDir, 'agent.yaml'),
    `name: ${opts.self}
model: claude-haiku-4-5
systemPrompt: |
  Rolling-upgrade rehearsal agent. Declares no skills, so every inbound
  capability resolves to a fast skill-not-found error response — the
  rehearsal measures the signed envelope contract, not engine output.
rpc:
  auth:
    enabled: true
`,
  );
  writeFileSync(
    join(agentDir, 'capabilities.yaml'),
    `version: 1
agent: agent://${opts.self}
transports:
  - kind: kafka
    brokers: ["${BROKERS.join('","')}"]
    topics:
      requests: ${opts.selfRequests}
capabilities:
  - name: ${opts.self}-ping
    description: "Rehearsal echo target for ${opts.self}."
    timeoutMs: 30000
    idempotent: true
`,
  );
  return root;
}

function startSide(opts: {
  label: string;
  argv: string[];
  cwd: string;
  configDir: string;
}): SideProc {
  mkdirSync(opts.configDir, { recursive: true });
  const proc = spawn(opts.argv[0] as string, opts.argv.slice(1), {
    cwd: opts.cwd,
    env: {
      ...process.env,
      DECLARAGENT_CONFIG_DIR: opts.configDir,
      [HMAC_SECRET_ENV]: HMAC_SECRET,
      // Dummy credentials: `fleet run` refuses to boot without a provider,
      // but the rehearsal's capabilities map to no skill, so the handler
      // errors fast and never actually calls the provider.
      ANTHROPIC_API_KEY: 'rehearsal-dummy-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    logs.push(text);
    if (process.env.REHEARSAL_VERBOSE === '1') {
      process.stderr.write(`[${opts.label}] ${text}`);
    }
  };
  proc.stdout?.on('data', capture);
  proc.stderr?.on('data', capture);
  const stopped = new Promise<void>((resolveStop) => {
    proc.on('exit', () => resolveStop());
  });
  return { proc, logs, stopped };
}

async function waitForReady(side: SideProc, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (side.logs.some((l) => l.includes('running 1 agent'))) return;
    if (side.proc.exitCode !== null) {
      throw new Error(
        `${label} exited before ready (code=${side.proc.exitCode}):\n${side.logs.join('')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} not ready within ${timeoutMs}ms:\n${side.logs.join('').slice(-2000)}`);
}

const hmac = createHmacAuthProvider({ secret: HMAC_SECRET, keyId: HMAC_KEY_ID });
let seq = 0;

function buildRequest(opts: {
  to: string;
  capability: string;
  from?: string;
  replyTo: string;
}): AgentRpcEnvelope {
  seq += 1;
  return {
    version: 1,
    kind: 'request',
    messageId: `reh-msg-${Date.now()}-${seq}`,
    correlationId: `reh-corr-${Date.now()}-${seq}`,
    from: (opts.from ?? 'agent://driver') as AgentRpcEnvelope['from'],
    to: opts.to as AgentRpcEnvelope['to'],
    capability: opts.capability,
    replyTo: `kafka://${opts.replyTo}` as NonNullable<AgentRpcEnvelope['replyTo']>,
    payload: { rehearsal: true, seq },
    auth: { kind: 'internal' },
  };
}

async function sendAndAwait(
  r: Rehearsal,
  envelope: AgentRpcEnvelope,
  topic: string,
  deadlineMs: number,
): Promise<AgentRpcEnvelope | null> {
  const response = new Promise<AgentRpcEnvelope | null>((resolveResponse) => {
    r.pending.set(envelope.correlationId, resolveResponse);
    setTimeout(() => {
      if (r.pending.delete(envelope.correlationId)) resolveResponse(null);
    }, deadlineMs).unref?.();
  });
  await r.driver.publish(topic, envelope);
  return response;
}

describeRehearsal('0.8.0 rolling-upgrade rehearsal (mixed-version fleet over Kafka)', () => {
  let r: Rehearsal;

  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), 'declaragent-rehearsal-'));

    // Install the published "old" CLI into an isolated package.
    const npmDir = join(base, 'old-cli');
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(npmDir, 'package.json'), '{ "name": "rehearsal-old-cli", "private": true }');
    // kafkajs is an optional peer of plugin-agent-rpc — the published CLI
    // warn-skips kafka transports without it, so install it alongside.
    const install = Bun.spawnSync(
      ['bun', 'add', `@declaragent/cli@${OLD_VERSION_SPEC}`, 'kafkajs@^2.2.4'],
      { cwd: npmDir },
    );
    if (install.exitCode !== 0) {
      throw new Error(
        `npm install of @declaragent/cli@${OLD_VERSION_SPEC} failed: ${install.stderr.toString()}`,
      );
    }
    const oldPkg = JSON.parse(
      readFileSync(join(npmDir, 'node_modules', '@declaragent', 'cli', 'package.json'), 'utf8'),
    ) as { version: string };
    const oldVersion = oldPkg.version;
    const oldSigns = semverGte(oldVersion, [0, 7, 8]);
    const oldBin = join(npmDir, 'node_modules', '@declaragent', 'cli', 'bin', 'declaragent.js');

    const stamp = `${Date.now()}`;
    const oldRequests = `rehearsal-${stamp}-old-requests`;
    const newRequests = `rehearsal-${stamp}-new-requests`;
    const driverResponses = `rehearsal-${stamp}-driver-responses`;

    const oldRoot = scaffoldSide({
      base,
      self: 'oldside',
      selfRequests: oldRequests,
      peer: 'newside',
      peerRequests: newRequests,
    });
    const newRoot = scaffoldSide({
      base,
      self: 'newside',
      selfRequests: newRequests,
      peer: 'oldside',
      peerRequests: oldRequests,
    });

    const old = startSide({
      label: `old@${oldVersion}`,
      argv: ['bun', oldBin, 'fleet', 'run'],
      cwd: oldRoot,
      configDir: join(base, 'old-home'),
    });
    const fresh = startSide({
      label: 'new@worktree',
      argv: ['bun', NEW_CLI_ENTRY, 'fleet', 'run'],
      cwd: newRoot,
      configDir: join(base, 'new-home'),
    });
    await Promise.all([
      waitForReady(old, `old@${oldVersion}`, 60_000),
      waitForReady(fresh, 'new@worktree', 60_000),
    ]);

    const driver = await createKafkaTransport({
      brokers: BROKERS,
      clientId: 'declaragent-rehearsal-driver',
      groupId: `declaragent-rehearsal-driver-${stamp}`,
      kafkajsModule: resolveKafkaJsModule(),
    });
    const pending = new Map<string, (envelope: AgentRpcEnvelope) => void>();
    driver.subscribe(driverResponses, async (envelope) => {
      if (envelope.kind !== 'response') return;
      const settle = pending.get(envelope.correlationId);
      if (settle === undefined) return;
      pending.delete(envelope.correlationId);
      settle(envelope);
    });

    // Consumer-group join window (same reasoning as the soak harness).
    await new Promise((res) => setTimeout(res, 4_000));

    r = {
      root: base,
      driverResponses,
      oldRequests,
      newRequests,
      oldVersion,
      oldSigns,
      old,
      fresh,
      driver,
      pending,
    };
  }, 240_000);

  afterAll(async () => {
    try {
      await r?.driver?.close();
    } finally {
      for (const side of [r?.old, r?.fresh]) {
        if (!side) continue;
        side.proc.kill('SIGTERM');
        await Promise.race([side.stopped, new Promise((res) => setTimeout(res, 8_000))]);
        if (side.proc.exitCode === null) side.proc.kill('SIGKILL');
      }
      if (r?.root) rmSync(r.root, { recursive: true, force: true });
    }
  }, 60_000);

  test('leg A — signed request to the NEW side round-trips with a SIGNED response', async () => {
    const envelope = buildRequest({
      to: 'agent://newside',
      capability: 'newside-ping',
      replyTo: r.driverResponses,
    });
    envelope.auth = await hmac.sign(envelope);
    const response = await sendAndAwait(r, envelope, r.newRequests, RESPONSE_DEADLINE_MS);
    if (response === null)
      throw new Error(`no response from new side; logs:\n${r.fresh.logs.join('').slice(-2000)}`);
    expect(response.auth?.kind).toBe('hmac');
  }, 60_000);

  test('leg B — signed request to the OLD side round-trips (response signing is version-aware)', async () => {
    const envelope = buildRequest({
      to: 'agent://oldside',
      capability: 'oldside-ping',
      replyTo: r.driverResponses,
    });
    envelope.auth = await hmac.sign(envelope);
    const response = await sendAndAwait(r, envelope, r.oldRequests, RESPONSE_DEADLINE_MS);
    if (response === null)
      throw new Error(
        `no response from old@${r.oldVersion}; logs:\n${r.old.logs.join('').slice(-2000)}`,
      );
    if (r.oldSigns) {
      // ≥ 0.7.8 ships the outbound signer — the response leg MUST be signed.
      expect(response.auth?.kind).toBe('hmac');
    } else {
      // 0.7.7 verifies but cannot sign: the documented stepping-stone gap.
      expect(response.auth?.kind).toBe('internal');
    }
  }, 60_000);

  test('leg C — UNSIGNED request (registered identity) gets AUTH_REJECTED from the NEW side', async () => {
    const envelope = buildRequest({
      to: 'agent://newside',
      capability: 'newside-ping',
      from: 'agent://oldside',
      replyTo: r.driverResponses,
    });
    // Deliberately NOT signed — this is what a 0.7.7 caller emits. The
    // fail-closed verify rejects it BEFORE the handler and answers with an
    // explicit AUTH_REJECTED error (not a silent drop), so the legacy
    // caller times out with a diagnosable error instead of a mystery.
    const response = await sendAndAwait(r, envelope, r.newRequests, REJECT_WINDOW_MS);
    if (response === null) throw new Error('expected an AUTH_REJECTED error response');
    const payload = response.payload as { ok: boolean; error?: { code: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('AUTH_REJECTED');
    // The rejection is addressed to a REGISTERED peer → the response leg
    // itself is signed.
    expect(response.auth?.kind).toBe('hmac');
  }, 30_000);

  test('leg D — request from an UNREGISTERED sender gets AUTH_REJECTED (unknown-peer) from the NEW side', async () => {
    const envelope = buildRequest({
      to: 'agent://newside',
      capability: 'newside-ping',
      from: 'agent://intruder',
      replyTo: r.driverResponses,
    });
    envelope.auth = await hmac.sign(envelope);
    const response = await sendAndAwait(r, envelope, r.newRequests, REJECT_WINDOW_MS);
    if (response === null) throw new Error('expected an AUTH_REJECTED error response');
    const payload = response.payload as { ok: boolean; error?: { code: string; message?: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('AUTH_REJECTED');
    expect(payload.error?.message ?? '').toContain('unknown peer');
    // Unknown destination → no shared key → the rejection carries the
    // legacy internal stamp (nothing to sign it with, by design).
    expect(response.auth?.kind).toBe('internal');
  }, 30_000);
});

if (!ENABLED) {
  describe('0.8.0 rolling-upgrade rehearsal (skipped)', () => {
    test('set ROLLING_UPGRADE=1 + KAFKA_BROKERS to run', () => {
      expect(ENABLED).toBe(false);
    });
  });
}
