import { describe, expect, it } from 'bun:test';
import {
  type ControlPlaneAuth,
  type ControlPlanePrincipal,
  type ControlPlaneTokenVerifier,
  applyControlPlaneAuth,
  extractBearerToken,
  isLoopbackRequest,
} from './control-plane-auth.js';
import {
  type ControlPlaneServerInstance,
  type ControlPlaneServerListenOptions,
  metricsRoute,
  startControlPlaneServer,
} from './control-plane-server.js';
import { createPrometheusRegistry } from './prometheus.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const REMOTE_HEADERS = {
  host: 'fleet.internal:9464',
  authorization: 'Bearer token.value.here',
} as const;

const LOCAL_HEADERS = { host: '127.0.0.1:9464' } as const;

function mkPrincipal(overrides: Partial<ControlPlanePrincipal> = {}): ControlPlanePrincipal {
  return {
    subject: 'user:42',
    issuer: 'https://dex.example.com',
    audience: 'declaragent-control-plane',
    scopes: ['control:read'],
    claims: { sub: 'user:42' },
    provider: 'oidc',
    ...overrides,
  };
}

/**
 * Build a verifier that returns the supplied result for any token it
 * sees. Captures the most recent token so tests can assert the header
 * was parsed correctly.
 */
function stubVerifier(
  result: ReturnType<ControlPlaneTokenVerifier> extends Promise<infer R> ? R : never,
): {
  verify: ControlPlaneTokenVerifier;
  lastToken: () => string | undefined;
  callCount: () => number;
} {
  let lastToken: string | undefined;
  let calls = 0;
  return {
    verify: async (token) => {
      lastToken = token;
      calls += 1;
      return result;
    },
    lastToken: () => lastToken,
    callCount: () => calls,
  };
}

// ── extractBearerToken ─────────────────────────────────────────────────────

describe('extractBearerToken', () => {
  it('parses `Authorization: Bearer <token>`', () => {
    const req = new Request('http://remote/status', {
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    expect(extractBearerToken(req)).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme', () => {
    const req = new Request('http://remote/status', {
      headers: { authorization: 'bearer lowercase.token.value' },
    });
    expect(extractBearerToken(req)).toBe('lowercase.token.value');
  });

  it('returns undefined when no header is present', () => {
    const req = new Request('http://remote/status');
    expect(extractBearerToken(req)).toBeUndefined();
  });

  it('returns undefined on non-Bearer schemes', () => {
    const req = new Request('http://remote/status', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(extractBearerToken(req)).toBeUndefined();
  });

  it('returns undefined on malformed Bearer headers', () => {
    const req = new Request('http://remote/status', {
      headers: { authorization: 'Bearer ' },
    });
    expect(extractBearerToken(req)).toBeUndefined();
  });
});

// ── isLoopbackRequest ──────────────────────────────────────────────────────

describe('isLoopbackRequest', () => {
  it('recognises 127.0.0.1', () => {
    const req = new Request('http://127.0.0.1:9464/status', {
      headers: { host: '127.0.0.1:9464' },
    });
    expect(isLoopbackRequest(req)).toBe(true);
  });

  it('recognises localhost', () => {
    expect(
      isLoopbackRequest(
        new Request('http://localhost:9464/status', { headers: { host: 'localhost:9464' } }),
      ),
    ).toBe(true);
  });

  it('rejects external hosts', () => {
    const req = new Request('http://fleet.internal:9464/status', {
      headers: { host: 'fleet.internal:9464' },
    });
    expect(isLoopbackRequest(req)).toBe(false);
  });

  it('defaults to loopback when no Host header is present', () => {
    // `Request` always exposes a Host — but a fetch handler receiving a
    // malformed request can observe this path. Defaulting loopback matches
    // the `control-plane-server` sibling helper.
    const req = new Request('http://somewhere/status');
    req.headers.delete('host');
    expect(isLoopbackRequest(req)).toBe(true);
  });
});

// ── applyControlPlaneAuth ──────────────────────────────────────────────────

describe('applyControlPlaneAuth', () => {
  it('bypasses verification on loopback when allowLoopback is default (true)', async () => {
    const stub = stubVerifier({ ok: false, reason: 'bad-signature', message: 'unused' });
    const auth: ControlPlaneAuth = { verifyToken: stub.verify };
    const req = new Request('http://127.0.0.1:9464/status', { headers: LOCAL_HEADERS });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bypassed).toBe(true);
      expect(result.principal).toBeUndefined();
    }
    expect(stub.callCount()).toBe(0);
  });

  it('still requires a token on loopback when allowLoopback is false', async () => {
    const stub = stubVerifier({ ok: true, principal: mkPrincipal() });
    const auth: ControlPlaneAuth = { verifyToken: stub.verify, allowLoopback: false };
    const req = new Request('http://127.0.0.1:9464/status', { headers: LOCAL_HEADERS });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing-token');
      expect(result.response.status).toBe(401);
    }
  });

  it('returns 401 missing-token when no Authorization header is present', async () => {
    const stub = stubVerifier({ ok: true, principal: mkPrincipal() });
    const auth: ControlPlaneAuth = { verifyToken: stub.verify };
    const req = new Request('http://fleet.internal:9464/status', {
      headers: { host: 'fleet.internal:9464' },
    });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing-token');
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get('www-authenticate')).toBe('Bearer');
      const body = (await result.response.json()) as { error: string; reason: string };
      expect(body.reason).toBe('missing-token');
    }
    expect(stub.callCount()).toBe(0);
  });

  it('returns 401 malformed-token when the verifier reports malformed', async () => {
    const stub = stubVerifier({ ok: false, reason: 'malformed-token', message: 'bad JWT' });
    const auth: ControlPlaneAuth = { verifyToken: stub.verify };
    const req = new Request('http://fleet.internal:9464/status', {
      headers: { host: 'fleet.internal:9464', authorization: 'Bearer not.a.jwt' },
    });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed-token');
      expect(result.response.status).toBe(401);
    }
    expect(stub.lastToken()).toBe('not.a.jwt');
  });

  it('returns 401 expired when the verifier reports expired', async () => {
    const stub = stubVerifier({ ok: false, reason: 'expired', message: 'exp < now' });
    const auth: ControlPlaneAuth = { verifyToken: stub.verify };
    const req = new Request('http://fleet.internal:9464/status', {
      headers: REMOTE_HEADERS,
    });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { error: string; reason: string };
      expect(body.reason).toBe('expired');
    }
  });

  it('returns 401 wrong-audience when the verifier reports audience mismatch', async () => {
    const stub = stubVerifier({
      ok: false,
      reason: 'wrong-audience',
      message: 'aud "foo" ≠ expected',
    });
    const auth: ControlPlaneAuth = { verifyToken: stub.verify };
    const req = new Request('http://fleet.internal:9464/status', {
      headers: REMOTE_HEADERS,
    });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('wrong-audience');
    }
  });

  it('returns 401 insufficient-scope when the verifier reports missing scope', async () => {
    const stub = stubVerifier({
      ok: false,
      reason: 'insufficient-scope',
      message: 'missing "control:read"',
    });
    const auth: ControlPlaneAuth = { verifyToken: stub.verify };
    const req = new Request('http://fleet.internal:9464/status', {
      headers: REMOTE_HEADERS,
    });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('insufficient-scope');
      expect(result.response.status).toBe(401);
    }
  });

  it('accepts a valid token and surfaces the principal', async () => {
    const principal = mkPrincipal({ subject: 'svc:prom' });
    const stub = stubVerifier({ ok: true, principal });
    const auth: ControlPlaneAuth = { verifyToken: stub.verify };
    const req = new Request('http://fleet.internal:9464/status', {
      headers: REMOTE_HEADERS,
    });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bypassed).toBe(false);
      expect(result.principal?.subject).toBe('svc:prom');
    }
    expect(stub.lastToken()).toBe('token.value.here');
  });

  it('surfaces a thrown verifier as provider-failed (never 500)', async () => {
    const auth: ControlPlaneAuth = {
      verifyToken: async () => {
        throw new Error('JWKS fetch timed out');
      },
    };
    const req = new Request('http://fleet.internal:9464/status', {
      headers: REMOTE_HEADERS,
    });

    const result = await applyControlPlaneAuth(auth, req);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('provider-failed');
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as { error: string; reason: string };
      expect(body.error).toContain('JWKS fetch timed out');
    }
  });
});

// ── Server integration ─────────────────────────────────────────────────────

/** Duplicate of the fake listener used by `control-plane-server.test.ts`. */
interface FakeServer extends ControlPlaneServerInstance {
  readonly fetch: ControlPlaneServerListenOptions['fetch'];
}

async function startFake(
  routes: Parameters<typeof startControlPlaneServer>[0]['routes'],
  options: { auth?: ControlPlaneAuth; allowRemote?: boolean } = {},
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
    ...(options.auth !== undefined && { auth: options.auth }),
    ...(options.allowRemote !== undefined && { allowRemote: options.allowRemote }),
  });
  if (!captured) throw new Error('listen stub did not run');
  return { handle, server: captured };
}

describe('startControlPlaneServer — auth integration', () => {
  it('rejects remote requests without a token (401) before route dispatch', async () => {
    const reg = createPrometheusRegistry();
    reg.counter('hits').inc(1);
    let routeInvocations = 0;
    const countingRoute = {
      path: '/metrics',
      fetch: () => {
        routeInvocations += 1;
        return new Response('nope', { status: 500 });
      },
    };
    const stub = stubVerifier({ ok: true, principal: mkPrincipal() });
    const { handle, server } = await startFake([countingRoute], {
      auth: { verifyToken: stub.verify },
      allowRemote: true,
    });

    const res = await server.fetch(
      new Request('http://fleet.internal:9464/metrics', {
        headers: { host: 'fleet.internal:9464' },
      }),
    );

    expect(res.status).toBe(401);
    expect(routeInvocations).toBe(0);
    expect(stub.callCount()).toBe(0); // missing-token short-circuits
    await handle.close();
  });

  it('serves the route when a valid token is presented', async () => {
    const reg = createPrometheusRegistry();
    reg.counter('hits').inc(7);
    const stub = stubVerifier({ ok: true, principal: mkPrincipal() });
    const { handle, server } = await startFake([metricsRoute(reg)], {
      auth: { verifyToken: stub.verify },
      allowRemote: true,
    });

    const res = await server.fetch(
      new Request('http://fleet.internal:9464/metrics', {
        headers: { host: 'fleet.internal:9464', authorization: 'Bearer good.token.here' },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hits 7');
    expect(stub.callCount()).toBe(1);
    expect(stub.lastToken()).toBe('good.token.here');
    await handle.close();
  });

  it('bypasses auth on loopback by default (allowLoopback: true)', async () => {
    const reg = createPrometheusRegistry();
    reg.counter('hits').inc(3);
    const stub = stubVerifier({ ok: false, reason: 'bad-signature', message: 'unused' });
    const { handle, server } = await startFake([metricsRoute(reg)], {
      auth: { verifyToken: stub.verify },
    });

    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/metrics', { headers: LOCAL_HEADERS }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hits 3');
    expect(stub.callCount()).toBe(0);
    await handle.close();
  });

  it('refuses loopback requests without a token when allowLoopback: false', async () => {
    const reg = createPrometheusRegistry();
    const stub = stubVerifier({ ok: true, principal: mkPrincipal() });
    const { handle, server } = await startFake([metricsRoute(reg)], {
      auth: { verifyToken: stub.verify, allowLoopback: false },
    });

    const res = await server.fetch(
      new Request('http://127.0.0.1:9464/metrics', { headers: LOCAL_HEADERS }),
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe('missing-token');
    await handle.close();
  });

  it('preserves back-compat when no auth middleware is supplied', async () => {
    const reg = createPrometheusRegistry();
    reg.counter('hits').inc(11);
    // No auth block; remote-with-allowRemote should serve like pre-Slice-2.
    const { handle, server } = await startFake([metricsRoute(reg)], { allowRemote: true });

    const res = await server.fetch(
      new Request('http://fleet.internal:9464/metrics', {
        headers: { host: 'fleet.internal:9464' },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hits 11');
    await handle.close();
  });
});
