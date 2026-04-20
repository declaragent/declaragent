import { describe, expect, test } from 'bun:test';
import {
  buildAuthorizeUrl,
  exchangeCodeForKey,
  generateCodeChallenge,
  generateCodeVerifier,
  startCallbackServer,
} from './openrouter-oauth.js';

describe('PKCE helpers', () => {
  test('verifier is 43+ chars and base64url-only', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(v)).toBe(true);
  });

  test('verifiers are unique', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  test('challenge is the base64url SHA-256 of verifier', async () => {
    // RFC 7636 §4.2 example.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('buildAuthorizeUrl encodes params', () => {
    const url = buildAuthorizeUrl('http://localhost:1234', 'CHALLENGE');
    expect(url).toContain('callback_url=http%3A%2F%2Flocalhost%3A1234');
    expect(url).toContain('code_challenge=CHALLENGE');
    expect(url).toContain('code_challenge_method=S256');
  });
});

describe('exchangeCodeForKey', () => {
  test('POSTs code + verifier and returns key on success', async () => {
    let captured: { url?: string; body?: unknown } = {};
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')) };
      return new Response(JSON.stringify({ key: 'sk-or-v1-fake' }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await exchangeCodeForKey('AUTHCODE', 'VERIFIER', fakeFetch);
    expect(out.key).toBe('sk-or-v1-fake');
    expect(captured.url).toContain('/api/v1/auth/keys');
    expect(captured.body).toEqual({
      code: 'AUTHCODE',
      code_verifier: 'VERIFIER',
      code_challenge_method: 'S256',
    });
  });

  test('throws on non-2xx', async () => {
    const fakeFetch = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(exchangeCodeForKey('c', 'v', fakeFetch)).rejects.toThrow(/401/);
  });

  test('throws when response is missing key', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeCodeForKey('c', 'v', fakeFetch)).rejects.toThrow(/missing key/);
  });
});

describe('startCallbackServer', () => {
  test('resolves with code from query string and cleans up', async () => {
    const server = startCallbackServer();
    try {
      const codePromise = server.waitForCode(2_000);
      const [response, code] = await Promise.all([fetch(`${server.url}?code=ABC123`), codePromise]);
      expect(response.status).toBe(200);
      expect(code).toBe('ABC123');
    } finally {
      server.stop();
    }
  });

  test('rejects on timeout', async () => {
    const server = startCallbackServer();
    try {
      await expect(server.waitForCode(50)).rejects.toThrow(/timeout/);
    } finally {
      server.stop();
    }
  });

  test('rejects when callback carries error param', async () => {
    const server = startCallbackServer();
    try {
      const codePromise = server.waitForCode(2_000);
      codePromise.catch(() => {
        // Suppress unhandled rejection warning while we drive the request.
      });
      const response = await fetch(`${server.url}?error=access_denied`);
      expect(response.status).toBe(400);
      await expect(codePromise).rejects.toThrow(/access_denied/);
    } finally {
      server.stop();
    }
  });
});
