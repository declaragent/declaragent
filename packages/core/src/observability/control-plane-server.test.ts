import { describe, expect, it } from 'bun:test';
import {
  type ControlPlaneServerInstance,
  type ControlPlaneServerListenOptions,
  type UpStatusSnapshot,
  metricsRoute,
  startControlPlaneServer,
  statusRoute,
} from './control-plane-server.js';
import { createPrometheusRegistry } from './prometheus.js';

interface FakeServer extends ControlPlaneServerInstance {
  readonly fetch: ControlPlaneServerListenOptions['fetch'];
}

async function startFake(
  routes: Parameters<typeof startControlPlaneServer>[0]['routes'],
  options: { allowRemote?: boolean } = {},
): Promise<{
  handle: Awaited<ReturnType<typeof startControlPlaneServer>>;
  server: FakeServer;
}> {
  let captured: FakeServer | null = null;
  const listen: NonNullable<Parameters<typeof startControlPlaneServer>[0]['listen']> = async ({
    port,
    hostname,
    fetch,
  }) => {
    const server: FakeServer = {
      port,
      hostname,
      fetch,
      stop() {},
    };
    captured = server;
    return server;
  };
  const handle = await startControlPlaneServer({
    routes,
    listen,
    ...(options.allowRemote !== undefined && {
      allowRemote: options.allowRemote,
    }),
  });
  if (!captured) throw new Error('listen stub did not run');
  return { handle, server: captured };
}

const LOCAL_HEADERS = { host: '127.0.0.1:9464' } as const;

describe('startControlPlaneServer — router dispatch', () => {
  it('dispatches to the matching route by exact pathname', async () => {
    const reg = createPrometheusRegistry();
    reg.counter('hits').inc(2);
    const { handle, server } = await startFake([metricsRoute(reg)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/metrics', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('hits 2');
    await handle.close();
  });

  it('returns 404 when no route matches', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake([metricsRoute(reg)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/nope', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(404);
    await handle.close();
  });

  it('rejects non-localhost Host headers by default with 403', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake([metricsRoute(reg)]);
    const res = await server.fetch(
      new Request('http://external.tld:9464/metrics', {
        headers: { host: 'external.tld:9464' },
      }),
    );
    expect(res.status).toBe(403);
    await handle.close();
  });

  it('accepts remote Host headers when allowRemote is true', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake([metricsRoute(reg)], {
      allowRemote: true,
    });
    const res = await server.fetch(
      new Request('http://external.tld:9464/metrics', {
        headers: { host: 'external.tld:9464' },
      }),
    );
    expect(res.status).toBe(200);
    await handle.close();
  });

  it('rejects duplicate route paths at construction time', async () => {
    const reg = createPrometheusRegistry();
    await expect(startFake([metricsRoute(reg), metricsRoute(reg)])).rejects.toThrow(
      /duplicate route "\/metrics"/,
    );
  });

  it('exposes registered route paths on the handle', async () => {
    const reg = createPrometheusRegistry();
    const snapshot: UpStatusSnapshot = {
      version: 1,
      cliVersion: 'test',
      pid: 42,
      startedAt: new Date(0).toISOString(),
      manifestPath: '/tmp/agent.yaml',
      agents: [],
    };
    const { handle } = await startFake([metricsRoute(reg), statusRoute(() => snapshot)]);
    expect(handle.routes).toEqual(['/metrics', '/status']);
    await handle.close();
  });
});

describe('metricsRoute', () => {
  it('returns 405 on POST', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake([metricsRoute(reg)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/metrics', {
        method: 'POST',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    await handle.close();
  });

  it('serves an empty body on HEAD', async () => {
    const reg = createPrometheusRegistry();
    reg.counter('whatever').inc(1);
    const { handle, server } = await startFake([metricsRoute(reg)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/metrics', {
        method: 'HEAD',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    await handle.close();
  });
});

describe('statusRoute', () => {
  const snapshot: UpStatusSnapshot = {
    version: 1,
    cliVersion: '0.7.0-test',
    pid: 12345,
    startedAt: '2026-04-22T00:00:00.000Z',
    manifestPath: '/opt/declaragent/agent.yaml',
    agents: [
      {
        id: 'classifier',
        path: '/opt/declaragent/classifier',
        uptimeMs: 360_000,
        sources: [{ type: 'webhook', id: 'gh', summary: 'webhook on :8080/gh' }],
        channels: [{ type: 'slack', id: 'slack-main', ready: true }],
        metrics: {
          eventsDispatched: 10,
          eventsRejected: 1,
          breakerOpen: 0,
        },
      },
    ],
  };

  it('serves the snapshot as JSON with the right content-type', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake([metricsRoute(reg), statusRoute(() => snapshot)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/status', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as UpStatusSnapshot;
    expect(body.version).toBe(1);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]?.id).toBe('classifier');
    expect(body.agents[0]?.metrics.eventsDispatched).toBe(10);
    await handle.close();
  });

  it('supports async providers', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake([
      metricsRoute(reg),
      statusRoute(async () => snapshot),
    ]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/status', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as UpStatusSnapshot;
    expect(body.pid).toBe(12345);
    await handle.close();
  });

  it('returns 405 on non-GET/HEAD', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake([metricsRoute(reg), statusRoute(() => snapshot)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/status', {
        method: 'DELETE',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(405);
    await handle.close();
  });

  it('translates provider errors into 500 without leaking stacks', async () => {
    const reg = createPrometheusRegistry();
    const { handle, server } = await startFake([
      metricsRoute(reg),
      statusRoute(() => {
        throw new Error('boom');
      }),
    ]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/status', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('boom');
    await handle.close();
  });

  it('rejects providers that return a bogus version number', async () => {
    const { handle, server } = await startFake([
      statusRoute(() => ({ ...snapshot, version: 99 as unknown as 1 })),
    ]);
    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/status', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(500);
    await handle.close();
  });
});
