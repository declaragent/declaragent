import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';
/**
 * The Anthropic SDK appends `/v1/messages` to whatever baseURL it's given,
 * so we drop the `/v1` here. Final URL: `https://openrouter.ai/api/v1/messages`.
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/**
 * OpenRouter's localhost-app guidance recommends a stable callback URL
 * (docs: "test with http://localhost:3000"). Random ports make their backend
 * create a fresh app record per attempt and trip over 409 conflicts.
 */
export const DEFAULT_CALLBACK_PORT = 3000;
export const FALLBACK_CALLBACK_PORTS = [3000, 38765, 38766, 38767];

/**
 * Referrer headers OpenRouter uses for app attribution (see their inference
 * API docs). Sending these on the token exchange keeps the app record stable.
 */
export const DECLARAGENT_REFERRER = 'https://github.com/ssvk/declaragent';
export const DECLARAGENT_TITLE = 'Declaragent CLI';

function base64UrlEncode(buf: Uint8Array): string {
  let binary = '';
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  // 32 random bytes → 43-char base64url string. PKCE spec: 43–128 chars.
  return base64UrlEncode(new Uint8Array(randomBytes(32)));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function buildAuthorizeUrl(callbackUrl: string, challenge: string): string {
  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${OPENROUTER_AUTH_URL}?${params.toString()}`;
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Caller already prints the URL — silent fallback is fine.
  }
}

export interface ExchangeResult {
  key: string;
}

export async function exchangeCodeForKey(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeResult> {
  const response = await fetchImpl(OPENROUTER_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'HTTP-Referer': DECLARAGENT_REFERRER,
      'X-Title': DECLARAGENT_TITLE,
    },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256',
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenRouter token exchange failed (${response.status}): ${text}`);
  }
  const body = (await response.json()) as { key?: string };
  if (!body.key) {
    throw new Error(`OpenRouter response missing key: ${JSON.stringify(body)}`);
  }
  return { key: body.key };
}

export interface CallbackServer {
  port: number;
  url: string;
  waitForCode(timeoutMs?: number): Promise<string>;
  stop(): void;
}

const CALLBACK_HTML = `<!doctype html>
<html><head><title>Declaragent — OpenRouter</title></head>
<body style="font-family:system-ui;padding:2rem">
  <h1>✓ Connected</h1>
  <p>You can close this window and return to the terminal.</p>
</body></html>`;

/**
 * Bind a localhost server for the PKCE callback. Prefers a stable port
 * (3000 by default; OpenRouter docs recommend this for localhost apps),
 * falling back through a small list if taken. A stable port is important
 * because OpenRouter keys its internal app record on the callback URL.
 */
export function startCallbackServer(
  preferredPorts: number[] = FALLBACK_CALLBACK_PORTS,
): CallbackServer {
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) {
      rejectCode?.(new Error(`OAuth error: ${error}`));
      return new Response(`OAuth error: ${error}`, { status: 400 });
    }
    if (code) {
      resolveCode?.(code);
      return new Response(CALLBACK_HTML, {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('Missing ?code', { status: 400 });
  };

  let server: ReturnType<typeof Bun.serve> | null = null;
  const triedPorts: number[] = [];
  for (const candidate of preferredPorts) {
    try {
      server = Bun.serve({ port: candidate, fetch: handler });
      break;
    } catch {
      triedPorts.push(candidate);
    }
  }
  if (!server) {
    throw new Error(
      `Could not bind any OAuth callback port (tried ${triedPorts.join(', ')}). Free one up or pass --callback-port.`,
    );
  }

  const port = server.port ?? 0;
  if (port === 0) {
    server.stop(true);
    throw new Error('Could not bind a local port for OAuth callback');
  }
  return {
    port,
    url: `http://localhost:${port}`,
    async waitForCode(timeoutMs = 5 * 60_000): Promise<string> {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<string>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('OAuth timeout')), timeoutMs);
      });
      try {
        return await Promise.race([codePromise, timer]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        // Note: caller is responsible for `stop()` — stopping here would race
        // the in-flight response flush and yield ECONNRESET to the browser.
      }
    },
    stop(): void {
      server.stop(true);
    },
  };
}

export interface OAuthFlowResult {
  key: string;
}

/**
 * Run the full OpenRouter PKCE flow end-to-end. Returns the issued key.
 * `onUrl` is called once with the URL to visit so the UI can display it
 * before opening the browser.
 */
export async function runOpenRouterOAuth(
  onUrl: (url: string) => void,
  options: { preferredPorts?: number[] } = {},
): Promise<OAuthFlowResult> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const server = startCallbackServer(options.preferredPorts ?? FALLBACK_CALLBACK_PORTS);
  try {
    const authUrl = buildAuthorizeUrl(server.url, challenge);
    onUrl(authUrl);
    openBrowser(authUrl);
    const code = await server.waitForCode();
    return await exchangeCodeForKey(code, verifier);
  } finally {
    server.stop();
  }
}
