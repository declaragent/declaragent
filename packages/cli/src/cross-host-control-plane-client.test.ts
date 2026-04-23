/**
 * Cross-host control-plane client tests. Covers the three call
 * primitives (`getStatus`, `getEvents`, `getDlq`), bearer resolution
 * across `env:` / `file:` / literal forms, and the `fanOut` error-
 * isolation contract.
 */

import { describe, expect, it } from 'bun:test';
import type { FleetHost, UpStatusSnapshot } from '@declaragent/core';
import {
  type HostTaggedResult,
  createCrossHostControlPlaneClient,
  fanOut,
  partitionResults,
  resolveBearerToken,
} from './cross-host-control-plane-client.js';

const BASE_STATUS: UpStatusSnapshot = {
  version: 1,
  cliVersion: '0.7.4',
  pid: 1234,
  startedAt: '2026-04-22T08:00:00Z',
  manifestPath: '/tmp/fleet.yaml',
  agents: [],
};

function makeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  };
  // Bun's typeof fetch includes a `preconnect` method our mock doesn't need.
  return impl as unknown as typeof fetch;
}

describe('resolveBearerToken', () => {
  it('returns the literal when no prefix', () => {
    expect(resolveBearerToken('abc123')).toBe('abc123');
  });

  it('reads env: references', () => {
    expect(resolveBearerToken('env:MY_TOKEN', { env: { MY_TOKEN: 'secret' } })).toBe('secret');
  });

  it('throws on missing env var', () => {
    expect(() => resolveBearerToken('env:ABSENT', { env: {} })).toThrow(/ABSENT/);
  });

  it('reads file: references and trims', () => {
    const readFile = (p: string) => (p === '/tokens/prod' ? 'tok\n' : '');
    expect(resolveBearerToken('file:/tokens/prod', { readFile })).toBe('tok');
  });

  it('throws on unreadable file', () => {
    const readFile = () => {
      throw new Error('ENOENT');
    };
    expect(() => resolveBearerToken('file:/missing', { readFile })).toThrow(/ENOENT/);
  });
});

describe('createCrossHostControlPlaneClient', () => {
  it('hits /status with bearer header', async () => {
    let seenUrl = '';
    let seenAuth: string | undefined;
    const client = createCrossHostControlPlaneClient({
      env: { TOKEN_A: 'tokA' },
      fetchImpl: makeFetch((url, init) => {
        seenUrl = url;
        seenAuth = (init?.headers as Record<string, string>)?.authorization;
        return new Response(JSON.stringify(BASE_STATUS), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    const host: FleetHost = {
      name: 'a',
      url: 'http://1.2.3.4:9464',
      auth: { bearer: 'env:TOKEN_A' },
    };
    const res = await client.getStatus(host);
    expect(res.cliVersion).toBe('0.7.4');
    expect(seenUrl).toBe('http://1.2.3.4:9464/status');
    expect(seenAuth).toBe('Bearer tokA');
  });

  it('strips trailing slashes from host url', async () => {
    let seenUrl = '';
    const client = createCrossHostControlPlaneClient({
      fetchImpl: makeFetch((url) => {
        seenUrl = url;
        return new Response(JSON.stringify(BASE_STATUS), { status: 200 });
      }),
    });
    await client.getStatus({ name: 'a', url: 'http://h/' });
    expect(seenUrl).toBe('http://h/status');
  });

  it('serialises /events query params', async () => {
    let seenUrl = '';
    const client = createCrossHostControlPlaneClient({
      fetchImpl: makeFetch((url) => {
        seenUrl = url;
        return new Response(JSON.stringify({ events: [], nextCursor: null }), { status: 200 });
      }),
    });
    await client.getEvents(
      { name: 'a', url: 'http://h' },
      { kind: 'webhook.received', limit: 50, all: true, state: 'circuit-open' },
    );
    expect(seenUrl).toContain('/events?');
    expect(seenUrl).toContain('kind=webhook.received');
    expect(seenUrl).toContain('limit=50');
    expect(seenUrl).toContain('all=1');
    expect(seenUrl).toContain('state=circuit-open');
  });

  it('throws a tagged error on 401', async () => {
    const client = createCrossHostControlPlaneClient({
      fetchImpl: makeFetch(() => new Response('nope', { status: 401 })),
    });
    let caught: unknown;
    try {
      await client.getStatus({ name: 'a', url: 'http://h' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { status?: number }).status).toBe(401);
    expect((caught as Error).message).toMatch(/401/);
  });

  it('aborts on timeout', async () => {
    const hangingFetch = (async (_url: unknown, init: RequestInit | undefined) => {
      await new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const client = createCrossHostControlPlaneClient({ fetchImpl: hangingFetch });
    const host: FleetHost = { name: 'a', url: 'http://h', timeoutMs: 10 };
    let caught: unknown;
    try {
      await client.getStatus(host);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('fanOut', () => {
  it('returns per-host results preserving input order', async () => {
    const hosts: FleetHost[] = [
      { name: 'a', url: 'http://a' },
      { name: 'b', url: 'http://b' },
      { name: 'c', url: 'http://c' },
    ];
    const results = await fanOut(hosts, async (h) => h.name.toUpperCase());
    expect(results.map((r) => r.host)).toEqual(['a', 'b', 'c']);
    for (const r of results) {
      expect('ok' in r.result).toBe(true);
    }
  });

  it('isolates one host error from the rest', async () => {
    const hosts: FleetHost[] = [
      { name: 'good', url: 'http://a' },
      { name: 'bad', url: 'http://b' },
    ];
    const results = await fanOut(hosts, async (h) => {
      if (h.name === 'bad') throw new Error('boom');
      return 'ok';
    });
    const errors = results.filter(
      (r): r is HostTaggedResult<string> & { result: { err: unknown } } => 'err' in r.result,
    );
    const oks = results.filter((r) => 'ok' in r.result);
    expect(oks.length).toBe(1);
    expect(errors.length).toBe(1);
    expect((errors[0]?.result as { err: { host: string; message: string } }).err.host).toBe('bad');
    expect((errors[0]?.result as { err: { host: string; message: string } }).err.message).toMatch(
      /boom/,
    );
  });

  it('partitionResults splits success / failure arrays', async () => {
    const hosts: FleetHost[] = [
      { name: 'a', url: 'http://a' },
      { name: 'b', url: 'http://b' },
    ];
    const results = await fanOut(hosts, async (h) => {
      if (h.name === 'b') throw new Error('x');
      return 42;
    });
    const { successes, failures } = partitionResults(results);
    expect(successes).toEqual([{ host: 'a', value: 42 }]);
    expect(failures.length).toBe(1);
    expect(failures[0]?.host).toBe('b');
  });
});

// ── Mutation methods (Slice 6b) ────────────────────────────────────────

describe('dropDlqEntry / requeueDlqEntry', () => {
  it('POSTs /dlq/drop with kind + id query params and initiator header', async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenHeaders: Record<string, string> = {};
    const client = createCrossHostControlPlaneClient({
      fetchImpl: makeFetch((url, init) => {
        seenUrl = url;
        seenMethod = init?.method ?? '';
        seenHeaders = (init?.headers as Record<string, string>) ?? {};
        return new Response(
          JSON.stringify({ ok: true, op: 'drop', eventId: 'x-1', attemptsBeforeOp: 2 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const res = await client.dropDlqEntry(
      { name: 'a', url: 'http://h' },
      { kind: 'dispatch', id: 'x-1', initiator: 'alice' },
    );
    expect(seenMethod).toBe('POST');
    expect(seenUrl).toBe('http://h/dlq/drop?kind=dispatch&id=x-1');
    expect(seenHeaders['x-declaragent-initiator']).toBe('alice');
    expect(res.ok).toBe(true);
    expect(res.attemptsBeforeOp).toBe(2);
  });

  it('accepts 404 as a typed miss (no throw)', async () => {
    const client = createCrossHostControlPlaneClient({
      fetchImpl: makeFetch(
        () =>
          new Response(
            JSON.stringify({ ok: false, op: 'drop', eventId: 'x', reason: 'not-found' }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          ),
      ),
    });
    const res = await client.dropDlqEntry(
      { name: 'a', url: 'http://h' },
      { kind: 'dispatch', id: 'x' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not-found');
  });

  it('throws on 5xx', async () => {
    const client = createCrossHostControlPlaneClient({
      fetchImpl: makeFetch(() => new Response('boom', { status: 500 })),
    });
    let caught: unknown;
    try {
      await client.requeueDlqEntry({ name: 'a', url: 'http://h' }, { kind: 'dispatch', id: 'x' });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error & { status?: number }).status).toBe(500);
  });

  it('POSTs /dlq/requeue and returns ok body', async () => {
    let seenUrl = '';
    const client = createCrossHostControlPlaneClient({
      fetchImpl: makeFetch((url) => {
        seenUrl = url;
        return new Response(
          JSON.stringify({ ok: true, op: 'requeue', eventId: 'x', attemptsBeforeOp: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    const res = await client.requeueDlqEntry(
      { name: 'a', url: 'http://h' },
      { kind: 'dispatch', id: 'x' },
    );
    expect(seenUrl).toBe('http://h/dlq/requeue?kind=dispatch&id=x');
    expect(res.ok).toBe(true);
    expect(res.op).toBe('requeue');
  });
});
