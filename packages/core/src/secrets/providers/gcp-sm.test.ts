import { describe, expect, it } from 'bun:test';
import { DEFAULT_TENANT_CONTEXT } from '../../tenancy/types.js';
import type { SecretResolveContext } from '../types.js';
import { createGcpSmProvider } from './gcp-sm.js';

const ctx: SecretResolveContext = { tenant: DEFAULT_TENANT_CONTEXT, requester: 'test' };

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url, init);
  };
  return impl as unknown as typeof fetch;
}

describe('createGcpSmProvider', () => {
  it('resolves a secret to its base64-decoded payload', async () => {
    const provider = createGcpSmProvider({
      tokenProvider: async () => ({ token: 'oauth2-token' }),
      fetch: fakeFetch((url, init) => {
        expect(url).toBe(
          'https://secretmanager.googleapis.com/v1/projects/acme/secrets/kafka/versions/latest:access',
        );
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer oauth2-token');
        return new Response(
          JSON.stringify({
            name: 'projects/acme/secrets/kafka/versions/1',
            payload: { data: btoa('shhh') },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    expect(await provider.resolve('projects/acme/secrets/kafka', ctx)).toBe('shhh');
  });

  it('honors an explicit /versions/N suffix', async () => {
    const provider = createGcpSmProvider({
      tokenProvider: async () => ({ token: 't' }),
      fetch: fakeFetch((url) => {
        expect(url).toContain('/versions/3:access');
        return new Response(JSON.stringify({ payload: { data: btoa('v3') } }), { status: 200 });
      }),
    });
    expect(await provider.resolve('projects/acme/secrets/kafka/versions/3', ctx)).toBe('v3');
  });

  it('throws EDENIED on 403', async () => {
    const provider = createGcpSmProvider({
      tokenProvider: async () => ({ token: 't' }),
      fetch: fakeFetch(() => new Response('forbidden', { status: 403 })),
    });
    try {
      await provider.resolve('projects/acme/secrets/kafka', ctx);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('EDENIED');
    }
  });

  it('caches tokens until expiry', async () => {
    let tokenCalls = 0;
    let time = 0;
    const provider = createGcpSmProvider({
      tokenProvider: async () => {
        tokenCalls += 1;
        return { token: `t-${tokenCalls}`, expiresAtMs: time + 10_000 };
      },
      now: () => time,
      fetch: fakeFetch(
        () => new Response(JSON.stringify({ payload: { data: btoa('x') } }), { status: 200 }),
      ),
    });
    await provider.resolve('projects/a/secrets/b', ctx);
    await provider.resolve('projects/a/secrets/c', ctx);
    expect(tokenCalls).toBe(1);
    time = 20_000;
    await provider.resolve('projects/a/secrets/d', ctx);
    expect(tokenCalls).toBe(2);
  });

  it('metadata() returns lastRotatedAt from createTime', async () => {
    const provider = createGcpSmProvider({
      tokenProvider: async () => ({ token: 't' }),
      fetch: fakeFetch((url) => {
        expect(url).toBe('https://secretmanager.googleapis.com/v1/projects/acme/secrets/kafka');
        return new Response(
          JSON.stringify({
            name: 'projects/acme/secrets/kafka',
            createTime: '2026-01-10T00:00:00Z',
          }),
          { status: 200 },
        );
      }),
    });
    const meta = await provider.metadata?.('projects/acme/secrets/kafka/versions/latest', ctx);
    expect(meta?.lastRotatedAt).toBe(Date.parse('2026-01-10T00:00:00Z'));
    expect(meta?.version).toBe('projects/acme/secrets/kafka');
  });
});
