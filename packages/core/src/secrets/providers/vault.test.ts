import { describe, expect, it } from 'bun:test';
import { DEFAULT_TENANT_CONTEXT } from '../../tenancy/types.js';
import type { SecretResolveContext } from '../types.js';
import { createVaultProvider } from './vault.js';

const resolveCtx: SecretResolveContext = {
  tenant: DEFAULT_TENANT_CONTEXT,
  requester: 'test',
};

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url, init);
  };
  // Bun's `typeof fetch` includes a `preconnect` helper; tests don't need it.
  return impl as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createVaultProvider', () => {
  it('resolves a single-field KV v2 secret to its value', async () => {
    const provider = createVaultProvider({
      address: 'https://vault.test',
      auth: { kind: 'token', token: 't-root' },
      fetch: fakeFetch((url, init) => {
        expect(url).toBe('https://vault.test/v1/secret/data/acme/kafka');
        expect((init?.headers as Record<string, string>)['x-vault-token']).toBe('t-root');
        return jsonResponse(200, {
          data: {
            data: { password: 'shhh' },
            metadata: { version: 3, created_time: '2026-01-01T00:00:00Z' },
          },
        });
      }),
    });
    expect(await provider.resolve('secret/data/acme/kafka', resolveCtx)).toBe('shhh');
  });

  it('extracts a specific field via #field syntax', async () => {
    const provider = createVaultProvider({
      address: 'https://vault.test',
      auth: { kind: 'token', token: 't-root' },
      fetch: fakeFetch(() =>
        jsonResponse(200, {
          data: {
            data: { password: 'shhh', username: 'admin' },
          },
        }),
      ),
    });
    expect(await provider.resolve('secret/data/acme/kafka#password', resolveCtx)).toBe('shhh');
    expect(await provider.resolve('secret/data/acme/kafka#username', resolveCtx)).toBe('admin');
  });

  it('throws EDENIED on 403', async () => {
    const provider = createVaultProvider({
      address: 'https://vault.test',
      auth: { kind: 'token', token: 't-root' },
      fetch: fakeFetch(() => new Response('forbidden', { status: 403 })),
    });
    try {
      await provider.resolve('secret/data/acme/kafka', resolveCtx);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('EDENIED');
    }
  });

  it('caches resolved values within the TTL window', async () => {
    let calls = 0;
    const provider = createVaultProvider({
      address: 'https://vault.test',
      auth: { kind: 'token', token: 't' },
      defaultTtlMs: 60_000,
      fetch: fakeFetch(() => {
        calls += 1;
        return jsonResponse(200, { data: { data: { v: '42' } } });
      }),
    });
    await provider.resolve('secret/data/acme/x', resolveCtx);
    await provider.resolve('secret/data/acme/x', resolveCtx);
    expect(calls).toBe(1);
  });

  it('exchanges AppRole credentials for a token then caches it', async () => {
    const seenUrls: string[] = [];
    const provider = createVaultProvider({
      address: 'https://vault.test',
      auth: { kind: 'approle', roleId: 'role-1', secretId: 'secret-1' },
      fetch: fakeFetch((url, init) => {
        seenUrls.push(url);
        if (url.endsWith('/v1/auth/approle/login')) {
          expect(init?.method).toBe('POST');
          return jsonResponse(200, {
            auth: { client_token: 'login-token', lease_duration: 3600 },
          });
        }
        return jsonResponse(200, { data: { data: { v: 'ok' } } });
      }),
    });
    expect(await provider.resolve('kv/data/x', resolveCtx)).toBe('ok');
    expect(await provider.resolve('kv/data/y', resolveCtx)).toBe('ok');
    // Only one login call even though two resolves happened.
    expect(seenUrls.filter((u) => u.endsWith('/login')).length).toBe(1);
  });

  it('reports metadata including lastRotatedAt + version', async () => {
    const provider = createVaultProvider({
      address: 'https://vault.test',
      auth: { kind: 'token', token: 't' },
      fetch: fakeFetch(() =>
        jsonResponse(200, {
          data: {
            data: { v: 'x' },
            metadata: { version: 7, created_time: '2026-01-15T12:00:00Z' },
          },
        }),
      ),
    });
    const metadata = await provider.metadata?.('secret/data/acme/x', resolveCtx);
    expect(metadata?.version).toBe('7');
    expect(metadata?.lastRotatedAt).toBe(Date.parse('2026-01-15T12:00:00Z'));
  });

  it('close() clears caches + token', async () => {
    let calls = 0;
    const provider = createVaultProvider({
      address: 'https://vault.test',
      auth: { kind: 'approle', roleId: 'r', secretId: 's' },
      fetch: fakeFetch((url) => {
        calls += 1;
        if (url.endsWith('/login')) {
          return jsonResponse(200, { auth: { client_token: 'tok', lease_duration: 3600 } });
        }
        return jsonResponse(200, { data: { data: { v: 'ok' } } });
      }),
    });
    await provider.resolve('k/v/x', resolveCtx);
    await provider.close?.();
    await provider.resolve('k/v/x', resolveCtx);
    // Both resolve calls trigger (login + read) = 4 total hits.
    expect(calls).toBe(4);
  });
});
