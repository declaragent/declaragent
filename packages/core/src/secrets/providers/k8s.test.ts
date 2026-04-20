import { describe, expect, it } from 'bun:test';
import { DEFAULT_TENANT_CONTEXT } from '../../tenancy/types.js';
import type { SecretResolveContext } from '../types.js';
import { createK8sProvider } from './k8s.js';

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

describe('createK8sProvider', () => {
  it('resolves a base64-decoded field from a Secret', async () => {
    const provider = createK8sProvider({
      apiUrl: 'https://kube.test:443',
      tokenProvider: async () => 'sa-token',
      fetch: fakeFetch((url, init) => {
        expect(url).toBe('https://kube.test:443/api/v1/namespaces/acme/secrets/kafka');
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sa-token');
        return new Response(
          JSON.stringify({
            metadata: {
              name: 'kafka',
              namespace: 'acme',
              creationTimestamp: '2026-02-01T00:00:00Z',
              resourceVersion: '41',
            },
            data: { password: btoa('hunter2') },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    });
    expect(await provider.resolve('acme/kafka/password', ctx)).toBe('hunter2');
  });

  it('throws EDENIED on 403', async () => {
    const provider = createK8sProvider({
      apiUrl: 'https://kube.test:443',
      tokenProvider: async () => 'sa-token',
      fetch: fakeFetch(() => new Response('forbidden', { status: 403 })),
    });
    try {
      await provider.resolve('ns/sec/fld', ctx);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('EDENIED');
    }
  });

  it('rejects malformed refs', async () => {
    const provider = createK8sProvider({
      apiUrl: 'https://kube.test:443',
      tokenProvider: async () => 'sa-token',
      fetch: fakeFetch(() => new Response('should not be called', { status: 500 })),
    });
    await expect(provider.resolve('onlyone', ctx)).rejects.toThrow(/path must be/);
    await expect(provider.resolve('a/b', ctx)).rejects.toThrow(/path must be/);
  });

  it('reports metadata from creationTimestamp + resourceVersion', async () => {
    const provider = createK8sProvider({
      apiUrl: 'https://kube.test:443',
      tokenProvider: async () => 'sa-token',
      fetch: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              metadata: {
                creationTimestamp: '2026-03-01T00:00:00Z',
                resourceVersion: '99',
              },
              data: { foo: btoa('bar') },
            }),
            { status: 200 },
          ),
      ),
    });
    const meta = await provider.metadata?.('acme/kafka/foo', ctx);
    expect(meta?.version).toBe('99');
    expect(meta?.lastRotatedAt).toBe(Date.parse('2026-03-01T00:00:00Z'));
  });

  it('caches the full Secret so multiple field reads do one HTTP call', async () => {
    let calls = 0;
    const provider = createK8sProvider({
      apiUrl: 'https://kube.test:443',
      tokenProvider: async () => 'sa-token',
      fetch: fakeFetch(() => {
        calls += 1;
        return new Response(
          JSON.stringify({
            metadata: { name: 'creds' },
            data: { user: btoa('alice'), password: btoa('secret') },
          }),
          { status: 200 },
        );
      }),
    });
    expect(await provider.resolve('ns/creds/user', ctx)).toBe('alice');
    expect(await provider.resolve('ns/creds/password', ctx)).toBe('secret');
    expect(calls).toBe(1);
  });
});
