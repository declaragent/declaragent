import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMCPOAuthTokenStore,
  discoverAuthServer,
  refreshMCPOAuthToken,
  registerDynamicClient,
} from './mcp-oauth.js';

describe('createMCPOAuthTokenStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-mcp-oauth-'));
    path = join(dir, 'mcp-oauth.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('empty store reports no tokens', async () => {
    const store = createMCPOAuthTokenStore(path);
    expect(await store.get('any')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  test('save persists + survives a fresh handle', async () => {
    const store = createMCPOAuthTokenStore(path);
    await store.save('github', {
      access_token: 'abc',
      token_type: 'Bearer',
      refresh_token: 'refreshy',
      expires_at: 1234567890,
    });
    const fresh = createMCPOAuthTokenStore(path);
    const got = await fresh.get('github');
    expect(got?.access_token).toBe('abc');
    expect(got?.refresh_token).toBe('refreshy');
  });

  test('file is created with mode 0600', async () => {
    const store = createMCPOAuthTokenStore(path);
    await store.save('s', { access_token: 'x', token_type: 'Bearer' });
    const stat = statSync(path);
    // Mask filesystem flag bits; compare owner+group+other perms only.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('remove deletes the entry', async () => {
    const store = createMCPOAuthTokenStore(path);
    await store.save('a', { access_token: 'x', token_type: 'Bearer' });
    expect(await store.remove('a')).toBe(true);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.remove('a')).toBe(false);
  });

  test('rejects unsupported version', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify({ version: 2, entries: {} }));
    const store = createMCPOAuthTokenStore(path);
    await expect(store.get('x')).rejects.toThrow(/unsupported mcp-oauth version/);
  });
});

describe('discoverAuthServer', () => {
  test('follows protected-resource metadata to the auth server', async () => {
    const fetches: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetches.push(url);
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(
          JSON.stringify({
            authorization_servers: ['https://auth.example.test/'],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://auth.example.test/.well-known/oauth-authorization-server') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.example.test',
            authorization_endpoint: 'https://auth.example.test/authorize',
            token_endpoint: 'https://auth.example.test/token',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const meta = await discoverAuthServer('https://mcp.example.test/v1', fetchImpl);
    expect(meta.token_endpoint).toBe('https://auth.example.test/token');
    expect(fetches[0]).toContain('oauth-protected-resource');
  });

  test('falls back to resource URL when protected-resource doc is absent', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response('not found', { status: 404 });
      }
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://mcp.example.test/authorize',
            token_endpoint: 'https://mcp.example.test/token',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const meta = await discoverAuthServer('https://mcp.example.test/v1', fetchImpl);
    expect(meta.token_endpoint).toBe('https://mcp.example.test/token');
  });

  test('throws a helpful error when no discovery doc responds', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(discoverAuthServer('https://mcp.example.test/v1', fetchImpl)).rejects.toThrow(
      /could not discover OAuth metadata/,
    );
  });
});

describe('registerDynamicClient', () => {
  test('POSTs client metadata + returns client_id', async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ client_id: 'client-123' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const reg = await registerDynamicClient(
      {
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
        registration_endpoint: 'https://auth.example/register',
      },
      'http://localhost:38700/callback',
      fetchImpl,
    );
    expect(reg?.client_id).toBe('client-123');
    const body = capturedBody as { redirect_uris: string[]; grant_types: string[] };
    expect(body.redirect_uris).toEqual(['http://localhost:38700/callback']);
    expect(body.grant_types).toContain('authorization_code');
  });

  test('returns undefined when the server has no registration_endpoint', async () => {
    const reg = await registerDynamicClient(
      {
        authorization_endpoint: 'https://a',
        token_endpoint: 'https://t',
      },
      'http://localhost:38700/callback',
      (() => new Response('unreachable')) as unknown as typeof fetch,
    );
    expect(reg).toBeUndefined();
  });
});

describe('refreshMCPOAuthToken', () => {
  test('exchanges refresh_token for a new access_token; preserves refresh_token if not rotated', async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('r-old');
      expect(body.get('client_id')).toBe('c-1');
      return new Response(
        JSON.stringify({
          access_token: 'a-new',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const refreshed = await refreshMCPOAuthToken(
      {
        access_token: 'a-old',
        token_type: 'Bearer',
        refresh_token: 'r-old',
        client_id: 'c-1',
        token_endpoint: 'https://auth/token',
      },
      fetchImpl,
    );
    expect(refreshed?.access_token).toBe('a-new');
    // Server didn't rotate → old refresh_token persists.
    expect(refreshed?.refresh_token).toBe('r-old');
    expect(refreshed?.expires_at).toBeGreaterThan(Date.now());
  });

  test('returns undefined when there is no refresh_token / client_id / endpoint', async () => {
    const never = (() => {
      throw new Error('should not fetch');
    }) as unknown as typeof fetch;
    expect(
      await refreshMCPOAuthToken({ access_token: 'a', token_type: 'Bearer' }, never),
    ).toBeUndefined();
  });

  test('throws when the server rejects the refresh', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 400 })) as unknown as typeof fetch;
    await expect(
      refreshMCPOAuthToken(
        {
          access_token: 'a',
          token_type: 'Bearer',
          refresh_token: 'r',
          client_id: 'c',
          token_endpoint: 'https://auth/token',
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/refresh failed/);
  });
});

// Just to keep the file import cited — node fs import for mode test above.
test('_typecheck_only', () => {
  expect(typeof readFileSync).toBe('function');
});
