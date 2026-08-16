import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  StartAgentSourcesOptions,
  StartAgentSourcesResult,
  startAgentSources,
} from './run-agent-sources.js';
import { findTenantsConfig, isLoopbackBindAddress, resolveBindAddress, up } from './up-cli.js';

describe('findTenantsConfig (WS8)', () => {
  test('finds tenants.yaml at the agent dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'declaragent-tenants-find-'));
    try {
      writeFileSync(join(root, 'tenants.yaml'), 'version: 1\ntenants: []\n');
      expect(findTenantsConfig(root)).toBe(join(root, 'tenants.yaml'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('walks up to a fleet-root tenants.yaml from <root>/agents/<name>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'declaragent-tenants-find-'));
    try {
      writeFileSync(join(root, 'tenants.yaml'), 'version: 1\ntenants: []\n');
      const agentDir = join(root, 'agents', 'concierge');
      mkdirSync(agentDir, { recursive: true });
      expect(findTenantsConfig(agentDir)).toBe(join(root, 'tenants.yaml'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns undefined when no tenants.yaml exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'declaragent-tenants-find-'));
    try {
      expect(findTenantsConfig(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
import { readUpState } from './up-lifecycle.js';
import { CLI_VERSION } from './version.js';

describe('resolveBindAddress (WS3/WS6)', () => {
  test('defaults to 127.0.0.1 (loopback), full mode, when unset', () => {
    expect(resolveBindAddress({ hasAuth: false, env: {} })).toEqual({
      hostname: '127.0.0.1',
      mode: 'full',
    });
  });
  test('loopback bind never requires auth → full mode', () => {
    expect(
      resolveBindAddress({ hasAuth: false, env: { DECLARAGENT_BIND_ADDRESS: 'localhost' } }),
    ).toEqual({ hostname: 'localhost', mode: 'full' });
  });
  test('non-loopback bind WITHOUT auth → safe-subset (health/metrics only, never refused)', () => {
    const r = resolveBindAddress({ hasAuth: false, env: { DECLARAGENT_BIND_ADDRESS: '0.0.0.0' } });
    expect(r).toEqual({ hostname: '0.0.0.0', mode: 'safe-subset' });
  });
  test('non-loopback bind WITH auth → full mode (sensitive routes authed)', () => {
    expect(
      resolveBindAddress({ hasAuth: true, env: { DECLARAGENT_BIND_ADDRESS: '0.0.0.0' } }),
    ).toEqual({ hostname: '0.0.0.0', mode: 'full' });
  });
  test('isLoopbackBindAddress', () => {
    expect(isLoopbackBindAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackBindAddress('::1')).toBe(true);
    expect(isLoopbackBindAddress('localhost')).toBe(true);
    expect(isLoopbackBindAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackBindAddress('10.0.0.5')).toBe(false);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

type StartSourcesFn = typeof startAgentSources;

interface SourcesStub {
  fn: StartSourcesFn;
  starts: Array<{ configPath: string }>;
  stopCount: () => number;
}

function stubSources(started: StartAgentSourcesResult['started'] = []): SourcesStub {
  const starts: Array<{ configPath: string }> = [];
  let stops = 0;
  const fn: StartSourcesFn = async (opts: StartAgentSourcesOptions) => {
    starts.push({ configPath: opts.configPath });
    return {
      started,
      unknownTypes: [],
      validationErrors: [],
      stop: async () => {
        stops += 1;
      },
    };
  };
  return { fn, starts, stopCount: () => stops };
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

/**
 * Wire a fake signal installer that trips the shutdown callback
 * immediately — the up-loop then returns cleanly without waiting for
 * a real SIGINT / SIGTERM.
 */
function immediateShutdown(): (onShutdown: () => Promise<void>) => () => void {
  return (onShutdown) => {
    void onShutdown();
    return () => {};
  };
}

const AGENT_YAML = `
name: test-up-agent
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

describe('up verb — single agent', () => {
  let dir: string;
  let configOverride: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-up-test-'));
    writeFileSync(join(dir, 'agent.yaml'), AGENT_YAML);
    // Redirect XDG_CONFIG-like paths so the tests don't write into
    // the user's real ~/.declaragent dir. Tests rely on configDir()
    // falling back to HOME; override via an env var.
    configOverride = process.env.HOME;
    process.env.HOME = dir;
  });
  afterEach(() => {
    if (configOverride !== undefined) process.env.HOME = configOverride;
    rmSync(dir, { recursive: true, force: true });
  });

  test('refuses when no manifest is in cwd', async () => {
    const other = mkdtempSync(join(tmpdir(), 'declara-up-empty-'));
    try {
      const cap = captureIo();
      const code = await up({}, { io: cap.io, cwd: other, installSignals: immediateShutdown() });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no agent.yaml or fleet.yaml');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('brings up a skill-only agent (no event-sources.yaml) without calling startSources', async () => {
    const stub = stubSources();
    const cap = captureIo();
    const code = await up(
      {},
      {
        io: cap.io,
        cwd: dir,
        startSources: stub.fn,
        installSignals: immediateShutdown(),
      },
    );
    expect(code).toBe(0);
    expect(stub.starts).toHaveLength(0);
    const text = cap.out.join('');
    expect(text).toContain('test-up-agent');
    expect(text).toContain('skill-only');
    expect(text).toContain('✓ up');
    expect(text).toContain('✓ down');
  });

  // Install a signal handler that inspects `readUpState` AFTER
  // the daemon wrote it but BEFORE the shutdown path clears it.
  // The harness fires `onShutdown` once we've captured the state.
  function captureStateThenShutdown(captured: { value: ReturnType<typeof readUpState> | null }): (
    onShutdown: () => Promise<void>,
  ) => () => void {
    return (onShutdown) => {
      // The up code installs this AFTER writeUpState + the metrics
      // listener — at this point the state file exists on disk.
      captured.value = readUpState();
      void onShutdown();
      return () => {};
    };
  }

  // #44 — cliVersion stamping on UpState at write time.
  test('stamps CLI_VERSION onto UpState at boot (#44)', async () => {
    const captured: { value: ReturnType<typeof readUpState> | null } = {
      value: null,
    };
    const cap = captureIo();
    const code = await up(
      {},
      {
        io: cap.io,
        cwd: dir,
        startSources: stubSources().fn,
        installSignals: captureStateThenShutdown(captured),
      },
    );
    expect(code).toBe(0);
    expect(captured.value).not.toBeNull();
    expect(captured.value?.cliVersion).toBe(CLI_VERSION);
  });

  test('honours DECLARAGENT_CLI_VERSION override (#44)', async () => {
    const originalOverride = process.env.DECLARAGENT_CLI_VERSION;
    process.env.DECLARAGENT_CLI_VERSION = '9.9.9-test';
    try {
      const captured: { value: ReturnType<typeof readUpState> | null } = {
        value: null,
      };
      const cap = captureIo();
      await up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources().fn,
          installSignals: captureStateThenShutdown(captured),
        },
      );
      expect(captured.value?.cliVersion).toBe('9.9.9-test');
    } finally {
      if (originalOverride === undefined) {
        // biome-ignore lint/performance/noDelete: see the metrics tests — `delete` is the canonical way to remove a process.env entry.
        delete process.env.DECLARAGENT_CLI_VERSION;
      } else {
        process.env.DECLARAGENT_CLI_VERSION = originalOverride;
      }
    }
  });

  test('starts event-sources when event-sources.yaml is present', async () => {
    writeFileSync(join(dir, 'event-sources.yaml'), EVENT_SOURCES);
    const stub = stubSources([{ type: 'cron', id: 'every-minute', summary: 'cron "* * * * *"' }]);
    const cap = captureIo();
    const code = await up(
      {},
      {
        io: cap.io,
        cwd: dir,
        startSources: stub.fn,
        installSignals: immediateShutdown(),
      },
    );
    expect(code).toBe(0);
    expect(stub.starts).toHaveLength(1);
    expect(stub.starts[0]?.configPath).toBe(join(dir, 'event-sources.yaml'));
    const text = cap.out.join('');
    expect(text).toContain('cron "* * * * *"');
    expect(text).toContain('1 agent bound');
  });

  test('invokes sources.stop() on shutdown', async () => {
    writeFileSync(join(dir, 'event-sources.yaml'), EVENT_SOURCES);
    const stub = stubSources([{ type: 'cron', id: 'every-minute', summary: 'cron "* * * * *"' }]);
    const cap = captureIo();
    await up(
      {},
      {
        io: cap.io,
        cwd: dir,
        startSources: stub.fn,
        installSignals: immediateShutdown(),
      },
    );
    expect(stub.stopCount()).toBe(1);
  });

  test('bails out cleanly when agent.yaml is invalid', async () => {
    // Write a broken schema.
    writeFileSync(join(dir, 'agent.yaml'), 'name: "unclosed-string\n');
    const cap = captureIo();
    const code = await up({}, { io: cap.io, cwd: dir, installSignals: immediateShutdown() });
    expect(code).toBe(1);
    expect(cap.err.join('')).not.toBe('');
  });

  test('/logs SSE endpoint registers on the control-plane when DECLARAGENT_METRICS_PORT is set', async () => {
    // Deeper stream-behavior assertions live in
    // `packages/core/src/observability/logs-sse-route.test.ts`. This
    // integration test just confirms the route is wired into `up`'s
    // listener — a GET returns 200 `text/event-stream`, an unknown
    // agent returns 400 — so a regression that drops the route from
    // the routes array fails CI here rather than silently in
    // production.
    const port = await freePort();
    const originalPort = process.env.DECLARAGENT_METRICS_PORT;
    process.env.DECLARAGENT_METRICS_PORT = String(port);
    try {
      const cap = captureIo();
      let knownStatus = 0;
      const knownContentType: { value: string | null } = { value: null };
      let unknownStatus = 0;
      let driverErr: unknown = undefined;

      const deferredShutdown: (onShutdown: () => Promise<void>) => () => void = (onShutdown) => {
        void (async () => {
          try {
            for (let i = 0; i < 100; i += 1) {
              if (cap.out.join('').includes('logs: http://')) break;
              await new Promise((r) => setTimeout(r, 20));
            }
            const ac1 = new AbortController();
            const res1 = await fetch(`http://127.0.0.1:${port}/logs?agent=test-up-agent`, {
              signal: ac1.signal,
            });
            knownStatus = res1.status;
            knownContentType.value = res1.headers.get('content-type');
            ac1.abort();
            // Bun rejects the body with an AbortError once we
            // abort — drain to a terminal state so we don't leak
            // the body reader.
            try {
              await res1.body?.cancel();
            } catch {
              // already closed
            }

            const res2 = await fetch(`http://127.0.0.1:${port}/logs?agent=bogus`);
            unknownStatus = res2.status;
            await res2.body?.cancel();
          } catch (err) {
            driverErr = err;
          } finally {
            await onShutdown();
          }
        })();
        return () => {};
      };

      const code = await up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources().fn,
          installSignals: deferredShutdown,
        },
      );
      if (driverErr !== undefined) throw driverErr;
      expect(code).toBe(0);
      expect(cap.out.join('')).toContain(`http://127.0.0.1:${port}/logs`);
      expect(knownStatus).toBe(200);
      expect(knownContentType.value).toBe('text/event-stream; charset=utf-8');
      expect(unknownStatus).toBe(400);
    } finally {
      if (originalPort === undefined) {
        // biome-ignore lint/performance/noDelete: see above.
        delete process.env.DECLARAGENT_METRICS_PORT;
      } else {
        process.env.DECLARAGENT_METRICS_PORT = originalPort;
      }
    }
  });

  test('control-plane auth: rejects unauthenticated remote requests, accepts a valid OIDC token', async () => {
    // End-to-end integration test for Slice 2 of the Managed Control
    // Plane (CONTROL_PLANE_PLAN.md §9 PR 2). We:
    //   1. Spin up a stub OIDC JWKS endpoint on an ephemeral port.
    //   2. Boot `up` with `controlPlane.auth.enabled: true` pointing at
    //      the stub.
    //   3. From the same process, craft requests that masquerade as
    //      remote (Host header != loopback) and assert:
    //        - no token → 401
    //        - valid token → 200
    //        - bad audience token → 401
    //   4. Also assert the default loopback bypass keeps `/metrics`
    //      reachable without a token when the Host header IS loopback.
    const port = await freePort();
    const originalPort = process.env.DECLARAGENT_METRICS_PORT;
    process.env.DECLARAGENT_METRICS_PORT = String(port);

    // ── Stub JWKS server ─────────────────────────────────────────────
    interface SubtleLike {
      generateKey(
        alg: unknown,
        extractable: boolean,
        usages: readonly string[],
      ): Promise<{ publicKey: unknown; privateKey: unknown }>;
      exportKey(format: 'jwk', key: unknown): Promise<Record<string, unknown>>;
      sign(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
    }
    const subtle = (): SubtleLike => (crypto as unknown as { subtle: SubtleLike }).subtle;
    const b64url = (bytes: Uint8Array | string): string => {
      const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
      let s = '';
      for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i] as number);
      return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    };
    const pair = await subtle().generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = {
      ...(await subtle().exportKey('jwk', pair.publicKey)),
      kid: 'test-kid',
      alg: 'RS256',
      use: 'sig',
    };
    const signToken = async (claims: Record<string, unknown>): Promise<string> => {
      const header = { alg: 'RS256', typ: 'JWT', kid: 'test-kid' };
      const hEnc = b64url(JSON.stringify(header));
      const cEnc = b64url(JSON.stringify(claims));
      const signingInput = `${hEnc}.${cEnc}`;
      const sig = await subtle().sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        pair.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${b64url(new Uint8Array(sig))}`;
    };

    const jwksPort = await freePort();
    // biome-ignore lint/suspicious/noExplicitAny: Bun.serve isn't typed here.
    const bun = (globalThis as any).Bun;
    const jwksServer = bun.serve({
      port: jwksPort,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    // Agent yaml with controlPlane.auth.enabled
    writeFileSync(
      join(dir, 'agent.yaml'),
      [
        AGENT_YAML,
        'controlPlane:',
        '  auth:',
        '    enabled: true',
        // WS3: Host-header spoofing can no longer simulate a remote peer (the
        // server now trusts the real connection IP), so exercise the auth path
        // with zero-trust loopback — every request needs a token regardless of
        // origin. Genuine loopback-bypass is unit-tested in control-plane-auth.
        '    allowLoopback: false',
        '    provider: oidc',
        '    issuer: "https://dex.test.local"',
        '    audience: "declaragent-control-plane"',
        `    jwksUri: "http://127.0.0.1:${jwksPort}/"`,
        '    scopes: ["control:read"]',
        '',
      ].join('\n'),
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const goodToken = await signToken({
      iss: 'https://dex.test.local',
      aud: 'declaragent-control-plane',
      sub: 'svc:prom',
      iat: nowSec,
      exp: nowSec + 300,
      scope: 'control:read',
    });
    const badAudToken = await signToken({
      iss: 'https://dex.test.local',
      aud: 'other-audience',
      sub: 'svc:prom',
      iat: nowSec,
      exp: nowSec + 300,
      scope: 'control:read',
    });

    try {
      const cap = captureIo();
      let loopbackStatus = 0;
      let remoteMissingStatus = 0;
      let remoteValidStatus = 0;
      let remoteBadAudStatus = 0;
      let driverErr: unknown = undefined;

      const deferredShutdown: (onShutdown: () => Promise<void>) => () => void = (onShutdown) => {
        void (async () => {
          try {
            for (let i = 0; i < 100; i += 1) {
              if (cap.out.join('').includes('control-plane auth enabled')) break;
              await new Promise((r) => setTimeout(r, 20));
            }
            // Loopback bypass (default) — same-host curl, no token.
            const loopRes = await fetch(`http://127.0.0.1:${port}/status`);
            loopbackStatus = loopRes.status;
            await loopRes.body?.cancel();

            // Remote, no token → 401.
            const missRes = await fetch(`http://127.0.0.1:${port}/status`, {
              headers: { host: 'fleet.internal:9464' },
            });
            remoteMissingStatus = missRes.status;
            await missRes.body?.cancel();

            // Remote, valid token → 200.
            const okRes = await fetch(`http://127.0.0.1:${port}/status`, {
              headers: {
                host: 'fleet.internal:9464',
                authorization: `Bearer ${goodToken}`,
              },
            });
            remoteValidStatus = okRes.status;
            await okRes.body?.cancel();

            // Remote, wrong-audience token → 401.
            const badRes = await fetch(`http://127.0.0.1:${port}/status`, {
              headers: {
                host: 'fleet.internal:9464',
                authorization: `Bearer ${badAudToken}`,
              },
            });
            remoteBadAudStatus = badRes.status;
            await badRes.body?.cancel();
          } catch (err) {
            driverErr = err;
          } finally {
            await onShutdown();
          }
        })();
        return () => {};
      };

      const code = await up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources().fn,
          installSignals: deferredShutdown,
        },
      );
      if (driverErr !== undefined) throw driverErr;
      expect(code).toBe(0);
      expect(cap.out.join('')).toContain('control-plane auth enabled');
      // allowLoopback:false → even a loopback request without a token is 401.
      expect(loopbackStatus).toBe(401);
      // No token — 401.
      expect(remoteMissingStatus).toBe(401);
      // Valid token — 200.
      expect(remoteValidStatus).toBe(200);
      // Wrong-audience token — 401.
      expect(remoteBadAudStatus).toBe(401);
    } finally {
      try {
        jwksServer.stop();
      } catch {
        // best effort
      }
      if (originalPort === undefined) {
        // biome-ignore lint/performance/noDelete: restore pre-test env.
        delete process.env.DECLARAGENT_METRICS_PORT;
      } else {
        process.env.DECLARAGENT_METRICS_PORT = originalPort;
      }
      // Restore the agent yaml so subsequent tests aren't affected.
      writeFileSync(join(dir, 'agent.yaml'), AGENT_YAML);
    }
  });

  test('exposes a Prometheus /metrics endpoint when DECLARAGENT_METRICS_PORT is set', async () => {
    const port = await freePort();
    const originalPort = process.env.DECLARAGENT_METRICS_PORT;
    process.env.DECLARAGENT_METRICS_PORT = String(port);
    try {
      const cap = captureIo();
      const code = await up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources().fn,
          installSignals: immediateShutdown(),
        },
      );
      expect(code).toBe(0);
      const text = cap.out.join('');
      expect(text).toContain(`metrics: http://127.0.0.1:${port}/metrics`);
      expect(text).toContain('✓ down');
    } finally {
      if (originalPort === undefined) {
        // biome-ignore lint/performance/noDelete: `delete` is the canonical way to remove a process.env entry; assigning `undefined` sets the string "undefined" and contaminates later tests.
        delete process.env.DECLARAGENT_METRICS_PORT;
      } else {
        process.env.DECLARAGENT_METRICS_PORT = originalPort;
      }
    }
  });

  test('skips the metrics endpoint in foreground mode when env var is unset', async () => {
    const originalPort = process.env.DECLARAGENT_METRICS_PORT;
    // biome-ignore lint/performance/noDelete: see above — preserve env-var removal.
    delete process.env.DECLARAGENT_METRICS_PORT;
    try {
      const cap = captureIo();
      const code = await up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources().fn,
          installSignals: immediateShutdown(),
        },
      );
      expect(code).toBe(0);
      const text = cap.out.join('');
      expect(text).not.toContain('metrics: http://');
    } finally {
      if (originalPort !== undefined) {
        process.env.DECLARAGENT_METRICS_PORT = originalPort;
      }
    }
  });

  test('skips the metrics endpoint when DECLARAGENT_METRICS_PORT=0 (explicit disable)', async () => {
    const originalPort = process.env.DECLARAGENT_METRICS_PORT;
    process.env.DECLARAGENT_METRICS_PORT = '0';
    try {
      const cap = captureIo();
      await up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources().fn,
          installSignals: immediateShutdown(),
        },
      );
      expect(cap.out.join('')).not.toContain('metrics: http://');
    } finally {
      if (originalPort === undefined) {
        // biome-ignore lint/performance/noDelete: see above.
        delete process.env.DECLARAGENT_METRICS_PORT;
      } else {
        process.env.DECLARAGENT_METRICS_PORT = originalPort;
      }
    }
  });

  test('stays quiet about OTel when OTEL_EXPORTER_OTLP_ENDPOINT is unset', async () => {
    const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    // biome-ignore lint/performance/noDelete: see above.
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      const cap = captureIo();
      const code = await up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources().fn,
          installSignals: immediateShutdown(),
        },
      );
      expect(code).toBe(0);
      const all = cap.out.join('') + cap.err.join('');
      expect(all).not.toContain('otel:');
      expect(all).not.toContain('tracing could not start');
    } finally {
      if (original !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
    }
  });

  test('warns with install hint when OTEL_EXPORTER_OTLP_ENDPOINT is set but peer dep is missing', async () => {
    const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    try {
      const cap = captureIo();
      const code = await up(
        {},
        {
          io: cap.io,
          cwd: dir,
          startSources: stubSources().fn,
          installSignals: immediateShutdown(),
        },
      );
      // Boot still succeeds — the runtime falls back to the noop tracer.
      expect(code).toBe(0);
      const errText = cap.err.join('');
      // The concrete peer-dep-missing message only fires if the host
      // has NOT installed `@opentelemetry/api`. The repo deliberately
      // doesn't declare it, so this assertion holds for CI; if a dev
      // installs it locally the "otel: tracing enabled" stdout banner
      // appears instead and the error stream stays empty.
      const otelActive = cap.out.join('').includes('otel: spans exporting');
      if (!otelActive) {
        // WS7 — the bridge load failed (no @opentelemetry/api in CI); the
        // warning names the missing peer dep and the install command.
        expect(errText).toContain('could not load');
        expect(errText).toContain('npm i @opentelemetry/api');
      }
    } finally {
      if (original === undefined) {
        // biome-ignore lint/performance/noDelete: see above.
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
      }
    }
  });

  test('respects an explicit -f manifest override', async () => {
    // Put the agent in a sibling dir so cwd has nothing.
    const altDir = mkdtempSync(join(tmpdir(), 'declara-up-alt-'));
    try {
      mkdirSync(join(altDir, 'agents/x'), { recursive: true });
      writeFileSync(join(altDir, 'agents/x/agent.yaml'), AGENT_YAML);
      const other = mkdtempSync(join(tmpdir(), 'declara-up-empty2-'));
      try {
        const cap = captureIo();
        const code = await up(
          { manifestPath: join(altDir, 'agents/x/agent.yaml') },
          {
            io: cap.io,
            cwd: other,
            startSources: stubSources().fn,
            installSignals: immediateShutdown(),
          },
        );
        expect(code).toBe(0);
        expect(cap.out.join('')).toContain('test-up-agent');
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });

  test('shared audit sink: rate_limited record lands when the gate fires', async () => {
    // Dynamic imports so we only pull the audit APIs inside this
    // scoped test — the rest of the file uses `up()` as a black box.
    const { createToolRateLimitGate, createSqliteAuditSink } = await import('@declaragent/core');
    // `up` opens its sqlite audit DB at `auditDbPath()` (inside ~/.declaragent,
    // which `beforeEach` overrides via HOME=<tmp>). Run `up` briefly so
    // the file is created, then reuse the on-disk path for our own gate.
    const cap = captureIo();
    const code = await up(
      {},
      { io: cap.io, cwd: dir, startSources: stubSources().fn, installSignals: immediateShutdown() },
    );
    expect(code).toBe(0);

    // Boot created `.declaragent/audit.db` under the overridden HOME.
    const { auditDbPath } = await import('./paths.js');
    const dbPath = auditDbPath();
    const sink = await createSqliteAuditSink({ path: dbPath });
    try {
      let t = 1_000_000;
      const gate = createToolRateLimitGate({
        limits: { Bash: { rps: 1, burst: 1 } },
        auditSink: sink,
        auditThresholdMs: 0,
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      });
      // First call consumes the bucket; second call waits long enough
      // that the threshold fires + the audit sink receives a record.
      await gate.acquire('Bash', { tenantId: 'default' });
      await gate.acquire('Bash', { tenantId: 'default' });
      const entries = await sink.query({ kind: 'rate_limited' });
      const rateRecords = entries.filter((e) => e.record.kind === 'rate_limited');
      expect(rateRecords.length).toBeGreaterThan(0);
      const first = rateRecords[0]?.record;
      if (first?.kind !== 'rate_limited') {
        throw new Error(`expected rate_limited record, got ${String(first?.kind)}`);
      }
      expect(first.tool).toBe('Bash');
      expect(first.rps).toBe(1);
    } finally {
      await sink.close();
    }
  });

  test('audit sink singleton: a second up run reuses the same module handle (#52)', async () => {
    const { __hasSharedAuditSink } = await import('./audit-sink-singleton.js');
    const { auditDbPath } = await import('./paths.js');

    // First up boots + shuts down — the singleton should be released.
    const cap1 = captureIo();
    const code1 = await up(
      {},
      {
        io: cap1.io,
        cwd: dir,
        startSources: stubSources().fn,
        installSignals: immediateShutdown(),
      },
    );
    expect(code1).toBe(0);
    expect(__hasSharedAuditSink(auditDbPath())).toBe(false);

    // Second up boots + shuts down — proves the cache was cleared so the
    // next call re-opens cleanly instead of handing back a closed handle.
    const cap2 = captureIo();
    const code2 = await up(
      {},
      {
        io: cap2.io,
        cwd: dir,
        startSources: stubSources().fn,
        installSignals: immediateShutdown(),
      },
    );
    expect(code2).toBe(0);
    expect(__hasSharedAuditSink(auditDbPath())).toBe(false);
  });

  test('rpc.auth.enabled=false leaves the legacy envelope path (no banner line)', async () => {
    const cap = captureIo();
    const code = await up(
      {},
      { io: cap.io, cwd: dir, startSources: stubSources().fn, installSignals: immediateShutdown() },
    );
    expect(code).toBe(0);
    expect(cap.out.join('')).not.toContain('rpc.auth enabled');
  });

  test('rpc.auth.enabled=true + rpc-peers.yaml present builds the registry at boot', async () => {
    // Overwrite the default scaffold with an opt-in + a peer entry.
    writeFileSync(
      join(dir, 'agent.yaml'),
      [
        'name: test-up-agent',
        'systemPrompt: |',
        '  You are a test agent.',
        'skills: []',
        'rpc:',
        '  auth:',
        '    enabled: true',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'rpc-peers.yaml'),
      [
        'version: 1',
        'peers:',
        '  - agent: agent://peer-a',
        '    transports:',
        '      - kind: memory',
        '        topics:',
        '          requests: agents.peer-a.requests',
        '    auth:',
        '      provider: oidc',
        '      issuer: https://dex.example.com',
        '      audience: peer-b',
        '      jwksUri: https://dex.example.com/keys',
        '',
      ].join('\n'),
    );
    const cap = captureIo();
    const code = await up(
      {},
      { io: cap.io, cwd: dir, startSources: stubSources().fn, installSignals: immediateShutdown() },
    );
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('rpc.auth enabled (1 peer(s) with auth registered)');
  });
});
