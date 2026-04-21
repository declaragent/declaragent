/**
 * Shared OAuth 2.1 + PKCE primitives.
 *
 * Extracted from `openrouter-oauth.ts` in slice 2d so the same code path
 * powers both the OpenRouter login flow and remote MCP server auth.
 * Keep this module provider-agnostic — OpenRouter-specific headers and
 * URLs live in `openrouter-oauth.ts`; MCP-specific discovery +
 * dynamic-registration live in `mcp-oauth.ts`.
 *
 * @since 0.5.0-slice.2d
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

function base64UrlEncode(buf: Uint8Array): string {
  let binary = '';
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes → 43-char base64url. PKCE spec allows 43–128. */
export function generateCodeVerifier(): string {
  return base64UrlEncode(new Uint8Array(randomBytes(32)));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function generateState(): string {
  return base64UrlEncode(new Uint8Array(randomBytes(16)));
}

/** Best-effort browser open. Silent fallback — caller should print the URL too. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Caller prints the URL.
  }
}

export interface CallbackCapture {
  code?: string;
  state?: string;
  error?: string;
}

export interface CallbackServer {
  port: number;
  url: string;
  waitForCallback(timeoutMs?: number): Promise<CallbackCapture>;
  stop(): void;
}

const CALLBACK_HTML = `<!doctype html>
<html><head><title>Declaragent</title></head>
<body style="font-family:system-ui;padding:2rem">
  <h1>✓ Connected</h1>
  <p>You can close this window and return to the terminal.</p>
</body></html>`;

/**
 * Bind a localhost HTTP server on the first available candidate port.
 * Returns the callback URL + a promise that resolves when the provider
 * redirects the browser back with `?code=…`.
 *
 * Unlike `openrouter-oauth.ts::startCallbackServer`, this surface captures
 * BOTH `code` and `state` so clients can validate the state param against
 * what they sent (MCP OAuth requires it; OpenRouter's flow doesn't use
 * state).
 */
export function startCallbackServer(preferredPorts: readonly number[]): CallbackServer {
  let resolveCb: ((c: CallbackCapture) => void) | null = null;
  let rejectCb: ((err: Error) => void) | null = null;
  const codePromise = new Promise<CallbackCapture>((resolve, reject) => {
    resolveCb = resolve;
    rejectCb = reject;
  });

  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    const code = url.searchParams.get('code') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    const error = url.searchParams.get('error') ?? undefined;
    if (error !== undefined) {
      rejectCb?.(new Error(`OAuth error: ${error}`));
      return new Response(`OAuth error: ${error}`, { status: 400 });
    }
    if (code !== undefined) {
      const cap: CallbackCapture = { code };
      if (state !== undefined) cap.state = state;
      resolveCb?.(cap);
      return new Response(CALLBACK_HTML, { headers: { 'content-type': 'text/html' } });
    }
    return new Response('Missing ?code', { status: 400 });
  };

  let server: ReturnType<typeof Bun.serve> | null = null;
  const tried: number[] = [];
  for (const candidate of preferredPorts) {
    try {
      server = Bun.serve({ port: candidate, fetch: handler });
      break;
    } catch {
      tried.push(candidate);
    }
  }
  if (!server) {
    throw new Error(
      `Could not bind any OAuth callback port (tried ${tried.join(', ')}). Free one up or pass --callback-port.`,
    );
  }

  const port = server.port ?? 0;
  if (port === 0) {
    server.stop(true);
    throw new Error('Could not bind a local port for OAuth callback');
  }

  return {
    port,
    url: `http://localhost:${port}/callback`,
    async waitForCallback(timeoutMs = 5 * 60_000): Promise<CallbackCapture> {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<CallbackCapture>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('OAuth timeout')), timeoutMs);
      });
      try {
        return await Promise.race([codePromise, timer]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/**
 * Default candidate ports for the local OAuth callback. OpenRouter uses
 * 3000 first; MCP OAuth flows use this range so there's no clash when
 * a user has both flows queued.
 */
export const MCP_CALLBACK_PORTS: readonly number[] = [
  38_700, 38_701, 38_702, 38_703, 38_704, 38_705,
];
