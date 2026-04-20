import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createEventBus } from '../bus.js';
import { eventSourceExtension } from '../source.js';
import type { AgentEvent, EventBus } from '../types.js';
import {
  type WebhookAdapterOptions,
  type WebhookListenOptions,
  type WebhookServerHandle,
  createWebhookAdapter,
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqual,
} from './webhook.js';

// ── Fake listener: capture the fetch handler so tests can call it directly,
// without binding to a real port. Returns a `send(req)` helper per-server.

interface FakeServer {
  handle: WebhookServerHandle;
  send(req: Request): Promise<Response>;
  stopCalls: number;
}

function makeFakeListen(): {
  listen: NonNullable<WebhookAdapterOptions['listen']>;
  servers: FakeServer[];
  /** Throws if no server has been bound yet; otherwise the most-recent one. */
  server(idx?: number): FakeServer;
} {
  const servers: FakeServer[] = [];
  const listen: NonNullable<WebhookAdapterOptions['listen']> = async (
    opts: WebhookListenOptions,
  ) => {
    let stopped = false;
    let stopCalls = 0;
    const server: FakeServer = {
      handle: {
        port: opts.port === 0 ? 54321 : opts.port,
        hostname: opts.hostname,
        async stop() {
          stopped = true;
          stopCalls += 1;
        },
      },
      async send(req: Request) {
        if (stopped) throw new Error('fake server stopped');
        return opts.fetch(req);
      },
      get stopCalls() {
        return stopCalls;
      },
    };
    servers.push(server);
    return server.handle;
  };
  function server(idx = 0): FakeServer {
    const s = servers[idx];
    if (!s) throw new Error(`no fake server bound at index ${idx}`);
    return s;
  }
  return { listen, servers, server };
}

async function collect(bus: EventBus): Promise<AgentEvent[]> {
  const received: AgentEvent[] = [];
  bus.subscribe('*', (e) => {
    received.push(e);
  });
  return received;
}

// ── Auth primitive tests ─────────────────────────────────────────────────

describe('hmacSha256Hex', () => {
  test('matches RFC 4231 test case 1 vector', async () => {
    // Key: 0x0b × 20, Data: "Hi There"
    // Expected: b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
    const key = String.fromCharCode(...new Array(20).fill(0x0b));
    const hex = await hmacSha256Hex(key, 'Hi There');
    expect(hex).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  test('produces 64 hex chars', async () => {
    const hex = await hmacSha256Hex('secret', 'body');
    expect(hex).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(hex)).toBe(true);
  });
});

describe('sha256Hex', () => {
  test('matches a known vector', async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('timingSafeEqual', () => {
  test('returns true on equal strings', () => {
    expect(timingSafeEqual('abcd', 'abcd')).toBe(true);
  });
  test('returns false on different strings', () => {
    expect(timingSafeEqual('abcd', 'abce')).toBe(false);
  });
  test('length mismatch short-circuits false', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

// ── Adapter tests ────────────────────────────────────────────────────────

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('createWebhookAdapter', () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    // Reset env between tests to avoid bleed from other suites.
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIG_ENV);
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIG_ENV);
  });

  test('validateConfig rejects missing id and bad auth', async () => {
    const bus = createEventBus();
    const adapter = createWebhookAdapter();

    await expect(
      eventSourceExtension(adapter, {
        config: { id: '', target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('non-empty "id"');

    await expect(
      eventSourceExtension(adapter, {
        config: {
          id: 'x',
          auth: { kind: 'hmac', algorithm: 'md5', secretEnv: 'X', headerName: 'X' },
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('sha256');
  });

  test('unknown path returns 404', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'gh',
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const res = await server().send(jsonRequest('http://localhost/webhook/nope', { hello: 1 }));
    expect(res.status).toBe(404);

    await ext.payload.stop();
  });

  test('happy path: publishes event and returns 200 { eventId, accepted: true }', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'gh-pr',
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const res = await server().send(
      jsonRequest(
        'http://localhost/webhook/gh-pr?a=1&b=two',
        { action: 'opened', number: 42 },
        {
          'x-custom': 'header-value',
        },
      ),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { eventId: string; accepted: boolean };
    expect(json.accepted).toBe(true);
    expect(typeof json.eventId).toBe('string');

    expect(received).toHaveLength(1);
    const event = received[0] as AgentEvent<{
      headers: Record<string, string>;
      body: { action: string; number: number };
      query: Record<string, string>;
    }>;
    expect(event.kind).toBe('webhook.received');
    expect(event.source).toEqual({ type: 'webhook', triggerId: 'gh-pr' });
    expect(event.payload.body).toEqual({ action: 'opened', number: 42 });
    expect(event.payload.query).toEqual({ a: '1', b: 'two' });
    expect(event.payload.headers['x-custom']).toBe('header-value');

    await ext.payload.stop();
  });

  test('malformed JSON body returns 400 and no event', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: { id: 'j', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const res = await server().send(
      new Request('http://localhost/webhook/j', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      }),
    );
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);

    await ext.payload.stop();
  });

  test('bodyAs: "string" keeps the raw body unparsed', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: { id: 'raw', bodyAs: 'string', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    await server().send(
      new Request('http://localhost/webhook/raw', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello world',
      }),
    );

    const event = received[0] as AgentEvent<{ body: unknown }>;
    expect(event.payload.body).toBe('hello world');

    await ext.payload.stop();
  });

  // ── Auth ──────────────────────────────────────────────────────────────

  test('bearer auth: happy + wrong token + missing header', async () => {
    process.env.TEST_WEBHOOK_TOKEN = 'supersecret';
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'b',
        auth: {
          kind: 'bearer',
          tokenEnv: 'TEST_WEBHOOK_TOKEN',
          headerName: 'Authorization',
        },
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    // Happy
    const ok = await server().send(
      jsonRequest('http://localhost/webhook/b', { x: 1 }, { authorization: 'Bearer supersecret' }),
    );
    expect(ok.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.auth.kind).toBe('bearer');

    // Missing
    const missing = await server().send(jsonRequest('http://localhost/webhook/b', { x: 2 }));
    expect(missing.status).toBe(401);

    // Wrong token
    const wrong = await server().send(
      jsonRequest('http://localhost/webhook/b', { x: 3 }, { authorization: 'Bearer not-it' }),
    );
    expect(wrong.status).toBe(401);

    // Still only the happy-path event was published.
    expect(received).toHaveLength(1);

    await ext.payload.stop();
  });

  test('hmac auth: happy + bad signature + missing header', async () => {
    process.env.TEST_WEBHOOK_SECRET = 'shh';
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'h',
        auth: {
          kind: 'hmac',
          algorithm: 'sha256',
          secretEnv: 'TEST_WEBHOOK_SECRET',
          headerName: 'X-Hub-Signature-256',
        },
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const bodyStr = JSON.stringify({ action: 'opened' });
    const sigHex = await hmacSha256Hex('shh', bodyStr);

    // Happy
    const ok = await server().send(
      new Request('http://localhost/webhook/h', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${sigHex}`,
        },
        body: bodyStr,
      }),
    );
    expect(ok.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.auth).toEqual({ kind: 'hmac', signatureHash: sigHex });

    // Wrong signature
    const wrong = await server().send(
      new Request('http://localhost/webhook/h', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
        },
        body: bodyStr,
      }),
    );
    expect(wrong.status).toBe(401);

    // Missing header
    const missing = await server().send(
      new Request('http://localhost/webhook/h', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyStr,
      }),
    );
    expect(missing.status).toBe(401);

    expect(received).toHaveLength(1);
    await ext.payload.stop();
  });

  // ── Idempotency + rate limit ──────────────────────────────────────────

  test('idempotencyKeyHeader is copied into event.meta.idempotencyKey', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'idemp',
        idempotencyKeyHeader: 'X-GitHub-Delivery',
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    await server().send(
      jsonRequest('http://localhost/webhook/idemp', { x: 1 }, { 'x-github-delivery': 'abc-123' }),
    );
    expect(received[0]?.meta?.idempotencyKey).toBe('abc-123');

    // Missing header → no idempotencyKey attached.
    await server().send(jsonRequest('http://localhost/webhook/idemp', { x: 2 }));
    expect(received[1]?.meta?.idempotencyKey).toBeUndefined();

    await ext.payload.stop();
  });

  test('rate limit: exceeds max returns 429 and no publish', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'rl',
        rateLimit: { max: 2, windowMs: 60_000 },
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const a = await server().send(jsonRequest('http://localhost/webhook/rl', { n: 1 }));
    const b = await server().send(jsonRequest('http://localhost/webhook/rl', { n: 2 }));
    const c = await server().send(jsonRequest('http://localhost/webhook/rl', { n: 3 }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(429);
    expect(received).toHaveLength(2);

    await ext.payload.stop();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────

  test('paused trigger returns 503 and does not publish', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: { id: 'p', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();
    await ext.payload.pause();

    const res = await server().send(jsonRequest('http://localhost/webhook/p', { x: 1 }));
    expect(res.status).toBe(503);
    expect(received).toHaveLength(0);

    await ext.payload.resume();
    const ok = await server().send(jsonRequest('http://localhost/webhook/p', { x: 2 }));
    expect(ok.status).toBe(200);
    expect(received).toHaveLength(1);

    await ext.payload.stop();
  });

  test('two triggers share one server; routed by path', async () => {
    const { listen, servers, server } = makeFakeListen();
    const bus = createEventBus();
    const received = await collect(bus);
    const adapter = createWebhookAdapter({ listen });

    const a = await eventSourceExtension(adapter, {
      config: { id: 'a', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    const b = await eventSourceExtension(adapter, {
      config: { id: 'b', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    await a.payload.start();
    await b.payload.start();
    expect(servers).toHaveLength(1); // single shared server

    await server().send(jsonRequest('http://localhost/webhook/a', { who: 'a' }));
    await server().send(jsonRequest('http://localhost/webhook/b', { who: 'b' }));
    expect(received).toHaveLength(2);
    expect((received[0] as AgentEvent<{ body: { who: string } }>).payload.body.who).toBe('a');
    expect((received[1] as AgentEvent<{ body: { who: string } }>).payload.body.who).toBe('b');

    // Stop one — server still up for the other.
    await a.payload.stop();
    expect(server().stopCalls).toBe(0);

    // Stop the last — server shuts down.
    await b.payload.stop();
    expect(server().stopCalls).toBe(1);
  });

  test('path conflict on second start throws', async () => {
    const { listen } = makeFakeListen();
    const bus = createEventBus();
    const adapter = createWebhookAdapter({ listen });

    const a = await eventSourceExtension(adapter, {
      config: { id: 'dup', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    const b = await eventSourceExtension(adapter, {
      config: { id: 'dup', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    await a.payload.start();
    await expect(b.payload.start()).rejects.toThrow('path conflict');
    await a.payload.stop();
  });

  test('metrics track events published and lastEventAt', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    await collect(bus);
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: { id: 'm', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();
    expect(ext.payload.metrics()).toEqual({ eventsPublished: 0, lastEventAt: null });

    const before = Date.now();
    await server().send(jsonRequest('http://localhost/webhook/m', { x: 1 }));
    await server().send(jsonRequest('http://localhost/webhook/m', { x: 2 }));
    const m = ext.payload.metrics();
    expect(m.eventsPublished).toBe(2);
    expect(m.lastEventAt).not.toBeNull();
    expect(m.lastEventAt ?? 0).toBeGreaterThanOrEqual(before);

    await ext.payload.stop();
  });

  test('health transitions across lifecycle', async () => {
    const { listen } = makeFakeListen();
    const bus = createEventBus();
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: { id: 'hc', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    expect((await ext.payload.health()).status).toBe('degraded'); // not started
    await ext.payload.start();
    expect((await ext.payload.health()).status).toBe('ok');
    await ext.payload.pause();
    expect((await ext.payload.health()).status).toBe('degraded');
    await ext.payload.resume();
    expect((await ext.payload.health()).status).toBe('ok');
    await ext.payload.stop();
    expect((await ext.payload.health()).status).toBe('degraded');
  });
});

// ── End-to-end over a real Bun.serve port ───────────────────────────────
// Uses the real Bun.serve but wraps it so the test can observe the bound
// port. Proves the default listener actually speaks HTTP.

describe('Phase 6 slice-4 hardening', () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIG_ENV);
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG_ENV)) delete process.env[k];
    }
    Object.assign(process.env, ORIG_ENV);
  });

  test('rejects requests whose Content-Length exceeds maxBodyBytes (413, no detail)', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'capped',
        maxBodyBytes: 100,
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const big = { data: 'x'.repeat(500) };
    const req = new Request('http://localhost/webhook/capped', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '600' },
      body: JSON.stringify(big),
    });
    const res = await server().send(req);
    expect(res.status).toBe(413);
    const body = await res.text();
    expect(body).toBe('request too large');
    await ext.payload.stop();
  });

  test('rejects oversized bodies even when Content-Length is missing', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: { id: 'chunk', maxBodyBytes: 20, target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    // Send a request with no content-length header — simulating chunked.
    const req = new Request('http://localhost/webhook/chunk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oversized: 'x'.repeat(100) }),
    });
    const res = await server().send(req);
    expect(res.status).toBe(413);
    await ext.payload.stop();
  });

  test('400 bodies do not leak server-side detail', async () => {
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: { id: 'sanitized', target: { type: 'broadcast' } },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const res = await server().send(
      new Request('http://localhost/webhook/sanitized', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-valid-json',
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toBe('bad request');
    // Make sure nothing leaked about the parse error.
    expect(body).not.toContain('JSON');
    expect(body).not.toContain('position');
    await ext.payload.stop();
  });

  test('HMAC replay window rejects stale timestamps', async () => {
    process.env.WEBHOOK_SECRET = 'shh';
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'replay',
        auth: {
          kind: 'hmac',
          algorithm: 'sha256',
          secretEnv: 'WEBHOOK_SECRET',
          headerName: 'x-signature',
          timestampHeader: 'x-timestamp',
          replayWindowSec: 60,
        },
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const nowSec = Math.floor(Date.now() / 1000);
    const stale = String(nowSec - 5 * 60); // 5 minutes ago
    const bodyText = '{"hello":"world"}';
    const sig = `sha256=${await hmacSha256Hex('shh', bodyText)}`;
    const res = await server().send(
      new Request('http://localhost/webhook/replay', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature': sig,
          'x-timestamp': stale,
        },
        body: bodyText,
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');

    // Fresh timestamp is accepted.
    const freshReq = new Request('http://localhost/webhook/replay', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': sig,
        'x-timestamp': String(nowSec),
      },
      body: bodyText,
    });
    const ok = await server().send(freshReq);
    expect(ok.status).toBe(200);

    await ext.payload.stop();
  });

  test('HMAC config without timestampHeader stays back-compat (no replay check)', async () => {
    process.env.WEBHOOK_SECRET = 'shh';
    const { listen, server } = makeFakeListen();
    const bus = createEventBus();
    const ext = await eventSourceExtension(createWebhookAdapter({ listen }), {
      config: {
        id: 'no-replay',
        auth: {
          kind: 'hmac',
          algorithm: 'sha256',
          secretEnv: 'WEBHOOK_SECRET',
          headerName: 'x-signature',
        },
        target: { type: 'broadcast' },
      },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();

    const body = '{}';
    const sig = `sha256=${await hmacSha256Hex('shh', body)}`;
    const res = await server().send(
      new Request('http://localhost/webhook/no-replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': sig },
        body,
      }),
    );
    expect(res.status).toBe(200);
    await ext.payload.stop();
  });

  test('replayWindowSec validation: non-positive throws', async () => {
    const bus = createEventBus();
    const adapter = createWebhookAdapter();
    await expect(
      eventSourceExtension(adapter, {
        config: {
          id: 'x',
          auth: {
            kind: 'hmac',
            algorithm: 'sha256',
            secretEnv: 'S',
            headerName: 'H',
            replayWindowSec: -1,
          },
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('replayWindowSec');
  });
});

describe('createWebhookAdapter (real Bun.serve)', () => {
  test('round-trips a real HTTP POST through localhost', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Bun global is not typed.
    const bun = (globalThis as any).Bun;
    if (!bun || typeof bun.serve !== 'function') {
      // Bun is always present in our test runner; this guard keeps the
      // file loadable under non-Bun typecheckers.
      return;
    }

    let boundPort = 0;
    const capturingListen: NonNullable<WebhookAdapterOptions['listen']> = async (opts) => {
      const server = bun.serve({
        port: opts.port,
        hostname: opts.hostname,
        fetch: (req: Request) => opts.fetch(req),
      });
      boundPort = server.port;
      return {
        port: server.port,
        hostname: server.hostname ?? opts.hostname,
        async stop() {
          await server.stop();
        },
      };
    };

    const bus = createEventBus();
    const received = await collect(bus);
    const ext = await eventSourceExtension(
      createWebhookAdapter({ port: 0, hostname: '127.0.0.1', listen: capturingListen }),
      {
        config: { id: 'live', target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();
    expect(boundPort).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${boundPort}/webhook/live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pong: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: boolean };
    expect(json.accepted).toBe(true);

    expect(received).toHaveLength(1);
    expect(received[0]?.source.type).toBe('webhook');

    await ext.payload.stop();
  });
});
