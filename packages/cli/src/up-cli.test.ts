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
import { up } from './up-cli.js';

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
      // Loopback bypass — /status served without a token.
      expect(loopbackStatus).toBe(200);
      // Remote without token — 401.
      expect(remoteMissingStatus).toBe(401);
      // Remote with a good token — 200.
      expect(remoteValidStatus).toBe(200);
      // Remote with a bad-audience token — 401.
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
      const otelActive = cap.out.join('').includes('otel: tracing enabled');
      if (!otelActive) {
        expect(errText).toContain('tracing could not start');
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
