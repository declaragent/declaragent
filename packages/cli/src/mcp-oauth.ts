/**
 * OAuth 2.1 + PKCE for remote MCP servers.
 *
 * Flow mirrors Claude Code's MCP auth story:
 *   1. Client hits a protected resource and gets a 401 with
 *      `WWW-Authenticate: Bearer resource_metadata="…"` OR the user
 *      runs `declaragent mcp login <name>` explicitly.
 *   2. Discovery: GET the `/.well-known/oauth-authorization-server`
 *      document, or the older `/.well-known/oauth-protected-resource`
 *      → follow to the auth server metadata.
 *   3. If the server advertises a `registration_endpoint`, POST a
 *      dynamic client registration (RFC 7591) so the user doesn't
 *      have to hand-register a client.
 *   4. Run the PKCE S256 flow against the advertised
 *      `authorization_endpoint` + `token_endpoint`. Local callback on
 *      one of {@link MCP_CALLBACK_PORTS}.
 *   5. Persist the resulting token set (access_token + optional
 *      refresh_token) keyed by server name in
 *      `~/.declaragent/mcp-oauth.json` (mode 0600).
 *
 * The HTTP/SSE/streamable transports hold a `getAuthHeader` callback
 * that reads the latest token from the store on every request. When a
 * request fails with 401 and the token store has a refresh_token, the
 * transport calls `onAuthError` → this module tries a refresh grant
 * and returns `true` so the transport retries. A bigger slice could
 * add automatic re-login on refresh failure; today the user re-runs
 * `declaragent mcp login <name>` instead.
 *
 * @since 0.5.0-slice.2d
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
  MCP_CALLBACK_PORTS,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  openBrowser,
  startCallbackServer,
} from './oauth-pkce.js';

const STORE_VERSION = 1 as const;

export interface MCPOAuthToken {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  /** Absolute ms-epoch the access token expires. Absent when server gave none. */
  expires_at?: number;
  scope?: string;
  /** Persisted client_id so refresh keeps working across CLI restarts. */
  client_id?: string;
  /** Persisted token endpoint so refresh doesn't need re-discovery. */
  token_endpoint?: string;
}

export interface MCPOAuthTokenStore {
  get(serverName: string): Promise<MCPOAuthToken | undefined>;
  save(serverName: string, token: MCPOAuthToken): Promise<void>;
  remove(serverName: string): Promise<boolean>;
  list(): Promise<readonly { name: string; token: MCPOAuthToken }[]>;
}

interface MCPOAuthStoreShape {
  version: 1;
  /** Map from server name → token. */
  entries: Record<string, MCPOAuthToken>;
}

export function createMCPOAuthTokenStore(filePath: string): MCPOAuthTokenStore {
  async function read(): Promise<MCPOAuthStoreShape> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as MCPOAuthStoreShape;
      if (parsed.version !== STORE_VERSION) {
        throw new Error(
          `${filePath}: unsupported mcp-oauth version ${parsed.version}; expected ${STORE_VERSION}`,
        );
      }
      return { version: STORE_VERSION, entries: parsed.entries ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: STORE_VERSION, entries: {} };
      }
      throw err;
    }
  }

  async function write(state: MCPOAuthStoreShape): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf-8',
      // Token file — owner read/write only.
      mode: 0o600,
    });
  }

  return {
    async get(name) {
      const state = await read();
      return state.entries[name];
    },
    async save(name, token) {
      const state = await read();
      state.entries[name] = token;
      await write(state);
    },
    async remove(name) {
      const state = await read();
      if (!(name in state.entries)) return false;
      delete state.entries[name];
      await write(state);
      return true;
    },
    async list() {
      const state = await read();
      return Object.entries(state.entries).map(([name, token]) => ({ name, token }));
    },
  };
}

// ── Discovery + registration + token flow ────────────────────────────────

/** Subset of RFC 8414 `OAuth 2.0 Authorization Server Metadata` we rely on. */
export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: readonly string[];
  scopes_supported?: readonly string[];
}

/** Subset of RFC 9728 `OAuth 2.0 Protected Resource Metadata` we consume. */
export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: readonly string[];
  scopes_supported?: readonly string[];
}

export type FetchFn = typeof fetch;

function joinWellKnown(base: string, suffix: string): string {
  // Spec: replace the path with `/.well-known/<suffix>`, preserving scheme + host.
  const u = new URL(base);
  u.pathname = `/.well-known/${suffix}`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** Tries the newer + older discovery shapes. Returns the first hit. */
export async function discoverAuthServer(
  resourceUrl: string,
  fetchImpl: FetchFn = fetch,
): Promise<AuthServerMetadata> {
  // 1) Try protected-resource metadata → authorization_servers[0] → server metadata.
  const prmUrl = joinWellKnown(resourceUrl, 'oauth-protected-resource');
  try {
    const res = await fetchImpl(prmUrl, { method: 'GET' });
    if (res.ok) {
      const prm = (await res.json()) as ProtectedResourceMetadata;
      const authBase = prm.authorization_servers?.[0];
      if (authBase !== undefined) {
        return await fetchAuthServerMetadata(authBase, fetchImpl);
      }
    }
  } catch {
    // fall through to direct discovery
  }
  // 2) Fall back to querying the resource URL itself as an auth server.
  return fetchAuthServerMetadata(resourceUrl, fetchImpl);
}

async function fetchAuthServerMetadata(
  base: string,
  fetchImpl: FetchFn,
): Promise<AuthServerMetadata> {
  const candidates = [
    joinWellKnown(base, 'oauth-authorization-server'),
    joinWellKnown(base, 'openid-configuration'),
  ];
  let lastErr: Error | undefined;
  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, { method: 'GET' });
      if (!res.ok) continue;
      const json = (await res.json()) as AuthServerMetadata;
      if (
        typeof json.authorization_endpoint !== 'string' ||
        typeof json.token_endpoint !== 'string'
      ) {
        continue;
      }
      return json;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new Error(
    `could not discover OAuth metadata at ${base}${lastErr ? `: ${lastErr.message}` : ''}`,
  );
}

export interface DynamicClientRegistration {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
}

/**
 * RFC 7591 dynamic client registration. Most hosted MCP servers expose
 * this so users don't need to pre-register an app. Returns undefined if
 * the server doesn't advertise a `registration_endpoint`.
 */
export async function registerDynamicClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  fetchImpl: FetchFn = fetch,
): Promise<DynamicClientRegistration | undefined> {
  if (metadata.registration_endpoint === undefined) return undefined;
  const res = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Declaragent',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`dynamic client registration failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as DynamicClientRegistration;
  if (typeof body.client_id !== 'string') {
    throw new Error('dynamic client registration response missing client_id');
  }
  return body;
}

export interface RunOAuthFlowOptions {
  resourceUrl: string;
  /** Hand-registered client_id. If absent, attempts dynamic registration. */
  clientId?: string;
  scopes?: readonly string[];
  fetch?: FetchFn;
  onUrl?: (authorizeUrl: string) => void;
  preferredCallbackPorts?: readonly number[];
}

interface TokenEndpointResponse {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Run the full PKCE login flow against an MCP server. Discovers the
 * auth server, dynamically registers a client if one wasn't supplied,
 * opens the browser, exchanges the code, and returns the token record
 * ready to persist via `MCPOAuthTokenStore.save`.
 */
export async function runMCPOAuthFlow(options: RunOAuthFlowOptions): Promise<MCPOAuthToken> {
  const fetchImpl = options.fetch ?? fetch;
  const metadata = await discoverAuthServer(options.resourceUrl, fetchImpl);

  const callback = startCallbackServer(options.preferredCallbackPorts ?? MCP_CALLBACK_PORTS);
  try {
    // Resolve client_id: explicit > dynamic-registration > fail.
    let clientId = options.clientId;
    if (clientId === undefined) {
      const reg = await registerDynamicClient(metadata, callback.url, fetchImpl);
      if (reg === undefined) {
        throw new Error(
          `MCP server at ${options.resourceUrl} does not advertise a registration_endpoint — pass a pre-registered client_id via config`,
        );
      }
      clientId = reg.client_id;
    }

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();

    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: callback.url,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    if (options.scopes && options.scopes.length > 0) {
      authParams.set('scope', options.scopes.join(' '));
    }
    const authorizeUrl = `${metadata.authorization_endpoint}?${authParams.toString()}`;
    options.onUrl?.(authorizeUrl);
    openBrowser(authorizeUrl);

    const cb = await callback.waitForCallback();
    if (cb.state !== state) {
      throw new Error('OAuth state mismatch — request may have been intercepted');
    }
    if (cb.code === undefined) {
      throw new Error('OAuth callback arrived without an authorization code');
    }

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: cb.code,
      client_id: clientId,
      redirect_uri: callback.url,
      code_verifier: verifier,
    });
    const tokenRes = await fetchImpl(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      throw new Error(`token exchange failed (${tokenRes.status}): ${text.slice(0, 200)}`);
    }
    const body = (await tokenRes.json()) as TokenEndpointResponse;
    if (body.error !== undefined || typeof body.access_token !== 'string') {
      throw new Error(
        `token exchange failed: ${body.error ?? 'missing access_token'} ${body.error_description ?? ''}`.trim(),
      );
    }

    const token: MCPOAuthToken = {
      access_token: body.access_token,
      token_type: body.token_type ?? 'Bearer',
      client_id: clientId,
      token_endpoint: metadata.token_endpoint,
    };
    if (body.refresh_token !== undefined) token.refresh_token = body.refresh_token;
    if (typeof body.expires_in === 'number') {
      token.expires_at = Date.now() + body.expires_in * 1000;
    }
    if (body.scope !== undefined) token.scope = body.scope;
    return token;
  } finally {
    callback.stop();
  }
}

/**
 * Refresh an access token using the stored refresh_token. Returns the
 * new token record on success; undefined when no refresh_token is on
 * file (caller should fall back to re-login); throws when the provider
 * rejects the refresh (e.g. token revoked).
 */
export async function refreshMCPOAuthToken(
  existing: MCPOAuthToken,
  fetchImpl: FetchFn = fetch,
): Promise<MCPOAuthToken | undefined> {
  if (existing.refresh_token === undefined) return undefined;
  if (existing.token_endpoint === undefined) return undefined;
  if (existing.client_id === undefined) return undefined;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: existing.refresh_token,
    client_id: existing.client_id,
  });
  const res = await fetchImpl(existing.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as TokenEndpointResponse;
  if (json.error !== undefined || typeof json.access_token !== 'string') {
    throw new Error(
      `refresh failed: ${json.error ?? 'missing access_token'} ${json.error_description ?? ''}`.trim(),
    );
  }
  const token: MCPOAuthToken = {
    access_token: json.access_token,
    token_type: json.token_type ?? existing.token_type,
    client_id: existing.client_id,
    token_endpoint: existing.token_endpoint,
    // Refresh responses may reuse the old refresh_token — preserve it
    // if the server didn't rotate.
    refresh_token: json.refresh_token ?? existing.refresh_token,
  };
  if (typeof json.expires_in === 'number') {
    token.expires_at = Date.now() + json.expires_in * 1000;
  }
  if (json.scope !== undefined) token.scope = json.scope;
  return token;
}

/** Returns the `Authorization: Bearer …` header for this token. */
export function bearerHeader(token: MCPOAuthToken): Record<string, string> {
  return { authorization: `${token.token_type || 'Bearer'} ${token.access_token}` };
}
