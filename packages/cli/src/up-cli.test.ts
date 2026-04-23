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
});
