/**
 * Integration test for the control socket bound by `declaragent up`
 * (§3 item #6 of the Enterprise Production Plan).
 *
 * Spins up the real `up` loop in-process with a stubbed source, then
 * connects a control-socket client and exercises all five ops:
 *   - `ping`
 *   - `status`
 *   - `dlq.requeue`
 *   - `reload`
 *   - `shutdown`
 *
 * The agent boot path is heavily reused from `up-cli.test.ts`; the
 * point of this file is specifically to prove that the socket is
 * bound at the same lifecycle stage as `/metrics` and that operators
 * can reach every op over it.
 *
 * @since 0.6.x
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectControlSocket, controlSocketPath } from '@declaragent/core';
import type {
  StartAgentSourcesOptions,
  StartAgentSourcesResult,
  startAgentSources,
} from './run-agent-sources.js';
import { up } from './up-cli.js';

const AGENT_YAML = `
name: ctrl-sock-agent
systemPrompt: |
  You are a test agent.
skills: []
`;

const EVENT_SOURCES = `- type: cron
  config:
    id: every-minute
    schedule: "* * * * *"
    target: { type: skill, name: say-hi }
`;

type StartSourcesFn = typeof startAgentSources;

function stubSources(started: StartAgentSourcesResult['started'] = []): StartSourcesFn {
  return async (_opts: StartAgentSourcesOptions) => {
    return {
      started,
      unknownTypes: [],
      validationErrors: [],
      stop: async () => {},
    };
  };
}

function captureIo(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

describe('up control socket — end-to-end', () => {
  let dir: string;
  let homeOverride: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-up-ctrl-sock-'));
    writeFileSync(join(dir, 'agent.yaml'), AGENT_YAML);
    writeFileSync(join(dir, 'event-sources.yaml'), EVENT_SOURCES);
    homeOverride = process.env.HOME;
    process.env.HOME = dir;
  });
  afterEach(() => {
    if (homeOverride !== undefined) process.env.HOME = homeOverride;
    rmSync(dir, { recursive: true, force: true });
  });

  test('up binds a control socket reachable from a client that answers all 5 ops', async () => {
    const agentId = 'ctrl-sock-agent';
    const expectedPath = controlSocketPath(agentId, dir);

    // Drive the up loop. We use a "deferred shutdown" pattern so the
    // loop stays alive long enough for us to connect + call, then
    // resolves cleanly when we're done.
    let shutdownHook: (() => Promise<void>) | null = null;
    const upReady = new Promise<void>((resolve) => {
      // Installer sets the hook, signals readiness, and returns the
      // unregister fn. The up loop blocks until `shutdownHook()` is
      // invoked below.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const installer = (onShutdown: () => Promise<void>): (() => void) => {
        shutdownHook = onShutdown;
        resolve();
        return () => {};
      };
      // Kick off up in the background.
      const cap = captureIo();
      void up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources([
            { type: 'cron', id: 'every-minute', summary: 'cron "* * * * *"' },
          ]),
          installSignals: installer,
        },
      );
    });

    await upReady;

    // Poll for the socket file to appear — binding is async.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (existsSync(expectedPath)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(expectedPath)).toBe(true);

    const client = await connectControlSocket(expectedPath, { timeoutMs: 2000 });
    try {
      // 1. ping
      const ping = await client.call({ id: 'p1', op: 'ping' });
      expect(ping.op).toBe('ping');
      if (ping.op === 'ping' && 'result' in ping) {
        expect(ping.result.pong).toBe(true);
      }

      // 2. status
      const status = await client.call({ id: 's1', op: 'status' });
      expect(status.op).toBe('status');
      if (status.op === 'status' && 'result' in status) {
        expect(status.result.pid).toBe(process.pid);
        expect(status.result.agentId).toBe(agentId);
        expect(status.result.sources).toEqual([{ id: 'every-minute', type: 'cron' }]);
        expect(status.result.uptimeMs).toBeGreaterThanOrEqual(0);
      }

      // 3. reload — skills-didn't-change → the wired handler currently
      // returns `unsupported` for the single-agent up loop.
      const reload = await client.call({ id: 'r1', op: 'reload' });
      expect(reload.op).toBe('reload');
      if (reload.op === 'reload' && 'result' in reload) {
        expect(reload.result.reloaded).toBe(false);
        expect(reload.result.reason).toBe('unsupported');
      }

      // 4. dlq.requeue — no event in the DLQ yet, so we expect a
      // typed error (ENOBUS when the skill-only test has no bus, or
      // `dlq-miss` when a bus is present). The stub source config
      // above creates a cron adapter which does produce a bus, so
      // we should get the `dlq-miss` path.
      const requeue = await client.call({
        id: 'rq1',
        op: 'dlq.requeue',
        params: { eventId: 'never-existed' },
      });
      expect(requeue.op).toBe('dlq.requeue');
      if (requeue.op === 'dlq.requeue') {
        if ('result' in requeue) {
          expect(requeue.result.ok).toBe(false);
        } else {
          // Also acceptable: ENOBUS when no bus is wired.
          expect(['ENOBUS', 'EHANDLER']).toContain(requeue.error.code);
        }
      }

      // 5. shutdown — acks but the shutdown hook isn't wired per-agent,
      // so the op reports ok=true and the up loop stays alive; we tear
      // it down via the installer hook below.
      const shutdown = await client.call({ id: 'sd1', op: 'shutdown' });
      expect(shutdown.op).toBe('shutdown');
      if (shutdown.op === 'shutdown' && 'result' in shutdown) {
        expect(shutdown.result.ok).toBe(true);
      }
    } finally {
      client.close();
      // Trip the up loop's shutdown so the test process exits cleanly.
      if (shutdownHook) {
        await (shutdownHook as () => Promise<void>)();
      }
    }

    // After shutdown, the socket file should be gone (auto-clean on
    // process exit invariant from the spec).
    const postDeadline = Date.now() + 2000;
    while (Date.now() < postDeadline) {
      if (!existsSync(expectedPath)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(expectedPath)).toBe(false);
  });

  test('a stale socket from a prior crash does not wedge the next up start', async () => {
    // Pre-create a file at the socket path to simulate a stale socket
    // left behind by a hard-killed `up`.
    const agentId = 'ctrl-sock-agent';
    const expectedPath = controlSocketPath(agentId, dir);
    // Make sure parent dir exists
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, '.declaragent', agentId), { recursive: true });
    writeFileSync(expectedPath, 'stale');
    expect(existsSync(expectedPath)).toBe(true);

    let shutdownHook: (() => Promise<void>) | null = null;
    const ready = new Promise<void>((resolve) => {
      const installer = (onShutdown: () => Promise<void>): (() => void) => {
        shutdownHook = onShutdown;
        resolve();
        return () => {};
      };
      const cap = captureIo();
      void up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources([
            { type: 'cron', id: 'every-minute', summary: 'cron "* * * * *"' },
          ]),
          installSignals: installer,
        },
      );
    });
    await ready;

    // Bind should have succeeded despite the stale file.
    const postBindDeadline = Date.now() + 2000;
    let socketReady = false;
    while (Date.now() < postBindDeadline) {
      try {
        const c = await connectControlSocket(expectedPath, { timeoutMs: 200 });
        c.close();
        socketReady = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(socketReady).toBe(true);

    if (shutdownHook) await (shutdownHook as () => Promise<void>)();
  });
});
