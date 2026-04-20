import { stampTenantId } from '../../tenancy/stamp.js';
import type {
  AgentEvent,
  EventAuth,
  EventSourceAdapter,
  EventSourceInstance,
  EventTarget,
  SourceDependencies,
} from '../types.js';

// ── Public types ─────────────────────────────────────────────────────────

export type WebhookAuth =
  | {
      kind: 'hmac';
      algorithm: 'sha256';
      /** Name of the env var holding the shared secret. */
      secretEnv: string;
      /** Header carrying the signature, e.g. `X-Hub-Signature-256`. */
      headerName: string;
      /**
       * Phase 6 slice 4 addition. Header carrying the signed request
       * timestamp (e.g. `X-Request-Timestamp`, `X-GitHub-Hook-Installation-Target-Created`).
       * When set together with {@link replayWindowSec}, the verifier
       * rejects requests whose timestamp drifts outside the window.
       */
      timestampHeader?: string;
      /**
       * Max delta between `timestampHeader` and the server clock, in
       * seconds. Default 300 (5 minutes), matching the Slack + GitHub
       * webhook convention. Only enforced when `timestampHeader` is set.
       */
      replayWindowSec?: number;
    }
  | {
      kind: 'bearer';
      /** Name of the env var holding the bearer token. */
      tokenEnv: string;
      /** Header carrying the token, e.g. `Authorization`. */
      headerName: string;
    };

export interface WebhookRateLimit {
  /** Max requests per `windowMs`. */
  max: number;
  /** Rolling window length in ms. */
  windowMs: number;
}

export interface WebhookTriggerConfig {
  id: string;
  /** HTTP path. Defaults to `/webhook/<id>`. */
  path?: string;
  auth?: WebhookAuth;
  /** Body parsing. Defaults to `json`. */
  bodyAs?: 'json' | 'string';
  /** Header to copy into `event.meta.idempotencyKey` (e.g. `X-GitHub-Delivery`). */
  idempotencyKeyHeader?: string;
  rateLimit?: WebhookRateLimit;
  /**
   * Phase 6 slice 4 addition. Max request body size in bytes. Requests
   * whose `Content-Length` exceeds this limit are rejected with 413
   * before any auth check runs. Default {@link DEFAULT_WEBHOOK_MAX_BODY_BYTES}
   * (1 MiB).
   */
  maxBodyBytes?: number;
  target: EventTarget;
}

/** Default webhook body-size limit: 1 MiB. */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/** Default replay window for HMAC-signed webhooks with a timestamp header: 5 minutes. */
export const DEFAULT_WEBHOOK_REPLAY_WINDOW_SEC = 300;

export interface WebhookServerHandle {
  readonly port: number;
  readonly hostname: string;
  stop(): Promise<void>;
}

export interface WebhookListenOptions {
  port: number;
  hostname: string;
  fetch: (req: Request) => Promise<Response>;
}

export interface WebhookAdapterOptions {
  /** Port to bind. Default 7777. Pass 0 for OS-assigned (useful in tests). */
  port?: number;
  /** Host to bind. Default `127.0.0.1`. */
  hostname?: string;
  /** Test override. Replace Bun.serve with a fake listener. */
  listen?(opts: WebhookListenOptions): Promise<WebhookServerHandle>;
}

// ── Auth helpers ─────────────────────────────────────────────────────────

const HEX_CHARS = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += HEX_CHARS[b >> 4];
    out += HEX_CHARS[b & 0xf];
  }
  return out;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return bytesToHex(new Uint8Array(sig));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Constant-time string compare. Both strings must be the same length
 * for the check to be safe; we short-circuit on length mismatch (which
 * already leaks length but that's fine — hex signatures have fixed length).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

interface AuthCheckResult {
  ok: boolean;
  reason?: string;
  eventAuth: EventAuth;
}

async function verifyAuth(
  auth: WebhookAuth | undefined,
  headers: Headers,
  rawBody: string,
): Promise<AuthCheckResult> {
  if (!auth) return { ok: true, eventAuth: { kind: 'internal' } };

  if (auth.kind === 'bearer') {
    const expected = process.env[auth.tokenEnv];
    if (!expected) {
      return {
        ok: false,
        reason: `token env "${auth.tokenEnv}" not set`,
        eventAuth: { kind: 'internal' },
      };
    }
    const raw = headers.get(auth.headerName);
    if (!raw) return { ok: false, reason: 'missing auth header', eventAuth: { kind: 'internal' } };
    const match = raw.match(/^\s*Bearer\s+(.+?)\s*$/i);
    if (!match) {
      return { ok: false, reason: 'malformed auth header', eventAuth: { kind: 'internal' } };
    }
    const presented = match[1] as string;
    if (!timingSafeEqual(presented, expected)) {
      return { ok: false, reason: 'bad token', eventAuth: { kind: 'internal' } };
    }
    const tokenHash = (await sha256Hex(presented)).slice(0, 16);
    return { ok: true, eventAuth: { kind: 'bearer', tokenHash } };
  }

  // HMAC
  const secret = process.env[auth.secretEnv];
  if (!secret) {
    return {
      ok: false,
      reason: `secret env "${auth.secretEnv}" not set`,
      eventAuth: { kind: 'internal' },
    };
  }
  // Phase 6 slice-4 replay-window check. When the HMAC config declares
  // a `timestampHeader`, the presented timestamp must fall within the
  // configured window. This blocks captured-+-replayed webhook bodies
  // even when the attacker has a valid signature.
  if (auth.timestampHeader) {
    const tsHeader = headers.get(auth.timestampHeader);
    if (!tsHeader) {
      return { ok: false, reason: 'missing timestamp header', eventAuth: { kind: 'internal' } };
    }
    const tsSec = parseTimestamp(tsHeader);
    if (tsSec === null) {
      return { ok: false, reason: 'malformed timestamp header', eventAuth: { kind: 'internal' } };
    }
    const windowSec = auth.replayWindowSec ?? DEFAULT_WEBHOOK_REPLAY_WINDOW_SEC;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsSec) > windowSec) {
      return { ok: false, reason: 'stale timestamp', eventAuth: { kind: 'internal' } };
    }
  }
  const headerValue = headers.get(auth.headerName);
  if (!headerValue) {
    return { ok: false, reason: 'missing signature header', eventAuth: { kind: 'internal' } };
  }
  const m = headerValue.match(/^sha256=([a-f0-9]+)$/i);
  if (!m) {
    return { ok: false, reason: 'malformed signature header', eventAuth: { kind: 'internal' } };
  }
  const presentedHex = (m[1] as string).toLowerCase();
  const expectedHex = await hmacSha256Hex(secret, rawBody);
  if (!timingSafeEqual(presentedHex, expectedHex)) {
    return { ok: false, reason: 'bad signature', eventAuth: { kind: 'internal' } };
  }
  return { ok: true, eventAuth: { kind: 'hmac', signatureHash: presentedHex } };
}

/**
 * Parse an HTTP timestamp header (seconds, milliseconds, or RFC 3339).
 * Returns seconds-since-epoch, or `null` on malformed input.
 */
function parseTimestamp(raw: string): number | null {
  const trimmed = raw.trim();
  // Integer timestamps: if it's all digits, treat as seconds when the
  // value is ≤ 10 digits, else milliseconds.
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    return trimmed.length <= 10 ? n : Math.floor(n / 1000);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

// ── Config validation ────────────────────────────────────────────────────

function assertTriggerConfig(config: unknown): asserts config is WebhookTriggerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('webhook trigger config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('webhook trigger config requires non-empty "id"');
  }
  if (c.path !== undefined) {
    if (typeof c.path !== 'string' || !c.path.startsWith('/')) {
      throw new Error('webhook trigger config "path" must be a string starting with "/"');
    }
  }
  if (c.bodyAs !== undefined && c.bodyAs !== 'json' && c.bodyAs !== 'string') {
    throw new Error('webhook trigger config "bodyAs" must be "json" or "string"');
  }
  if (c.idempotencyKeyHeader !== undefined && typeof c.idempotencyKeyHeader !== 'string') {
    throw new Error('webhook trigger config "idempotencyKeyHeader" must be a string');
  }
  if (c.auth !== undefined) assertAuth(c.auth);
  if (c.rateLimit !== undefined) assertRateLimit(c.rateLimit);
  if (c.maxBodyBytes !== undefined) {
    if (typeof c.maxBodyBytes !== 'number' || c.maxBodyBytes <= 0) {
      throw new Error('webhook trigger config "maxBodyBytes" must be a positive number');
    }
  }
  if (!c.target || typeof c.target !== 'object') {
    throw new Error('webhook trigger config requires an object "target"');
  }
}

function assertAuth(value: unknown): asserts value is WebhookAuth {
  if (!value || typeof value !== 'object') {
    throw new Error('webhook auth must be an object');
  }
  const a = value as Record<string, unknown>;
  if (a.kind === 'hmac') {
    if (a.algorithm !== 'sha256') throw new Error('webhook hmac algorithm must be "sha256"');
    if (typeof a.secretEnv !== 'string' || !a.secretEnv) {
      throw new Error('webhook hmac requires "secretEnv"');
    }
    if (typeof a.headerName !== 'string' || !a.headerName) {
      throw new Error('webhook hmac requires "headerName"');
    }
    if (
      a.timestampHeader !== undefined &&
      (typeof a.timestampHeader !== 'string' || !a.timestampHeader)
    ) {
      throw new Error('webhook hmac timestampHeader must be a non-empty string');
    }
    if (a.replayWindowSec !== undefined) {
      if (typeof a.replayWindowSec !== 'number' || a.replayWindowSec <= 0) {
        throw new Error('webhook hmac replayWindowSec must be a positive number');
      }
    }
    return;
  }
  if (a.kind === 'bearer') {
    if (typeof a.tokenEnv !== 'string' || !a.tokenEnv) {
      throw new Error('webhook bearer requires "tokenEnv"');
    }
    if (typeof a.headerName !== 'string' || !a.headerName) {
      throw new Error('webhook bearer requires "headerName"');
    }
    return;
  }
  throw new Error(`unknown webhook auth kind: ${String(a.kind)}`);
}

function assertRateLimit(value: unknown): asserts value is WebhookRateLimit {
  if (!value || typeof value !== 'object') {
    throw new Error('webhook rateLimit must be an object');
  }
  const r = value as Record<string, unknown>;
  if (typeof r.max !== 'number' || r.max <= 0) {
    throw new Error('webhook rateLimit.max must be a positive number');
  }
  if (typeof r.windowMs !== 'number' || r.windowMs <= 0) {
    throw new Error('webhook rateLimit.windowMs must be a positive number');
  }
}

// ── Runtime state ────────────────────────────────────────────────────────

interface TriggerRuntime {
  config: WebhookTriggerConfig;
  deps: SourceDependencies;
  paused: boolean;
  rateLimitWindowStart: number | null;
  rateLimitCount: number;
  eventsPublished: number;
  lastEventAt: number | null;
  /** Last HTTP status emitted by this trigger. Used by health(). */
  lastStatus: number | null;
}

interface Route {
  runtime: TriggerRuntime;
  onRequest: (req: Request) => Promise<Response>;
}

async function handleTriggerRequest(req: Request, runtime: TriggerRuntime): Promise<Response> {
  if (runtime.paused) {
    runtime.lastStatus = 503;
    return new Response('paused', { status: 503 });
  }

  // Per-trigger rate limit. Fixed-window; the per-window counter resets
  // when the window rolls. Good enough for phase 3 — a proper sliding
  // window can land later if a user reports lumpy throttling.
  const rl = runtime.config.rateLimit;
  if (rl) {
    const now = Date.now();
    if (runtime.rateLimitWindowStart === null || now - runtime.rateLimitWindowStart > rl.windowMs) {
      runtime.rateLimitWindowStart = now;
      runtime.rateLimitCount = 0;
    }
    runtime.rateLimitCount += 1;
    if (runtime.rateLimitCount > rl.max) {
      runtime.lastStatus = 429;
      return new Response('rate limited', { status: 429 });
    }
  }

  // Body-size guard. Reject before consuming the stream when
  // Content-Length already exceeds the limit. After reading the body we
  // re-check byte length for `Transfer-Encoding: chunked` requests that
  // omit Content-Length.
  const maxBodyBytes = runtime.config.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  const declaredLength = Number(req.headers.get('content-length') ?? '-1');
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    runtime.lastStatus = 413;
    runtime.deps.logger.warn('webhook.body.too-large', {
      triggerId: runtime.config.id,
      declaredLength,
      maxBodyBytes,
    });
    return new Response('request too large', {
      status: 413,
      headers: { 'content-length': '0' },
    });
  }

  // Read raw body ONCE so HMAC verification sees the exact bytes the
  // sender signed. `req.text()` consumes the stream; we reuse the string
  // below for JSON parsing.
  const rawBody = await req.text();
  if (rawBody.length > maxBodyBytes) {
    runtime.lastStatus = 413;
    runtime.deps.logger.warn('webhook.body.too-large', {
      triggerId: runtime.config.id,
      observedLength: rawBody.length,
      maxBodyBytes,
    });
    return new Response('request too large', { status: 413 });
  }

  const authResult = await verifyAuth(runtime.config.auth, req.headers, rawBody);
  if (!authResult.ok) {
    runtime.deps.logger.warn('webhook.auth.failed', {
      triggerId: runtime.config.id,
      reason: authResult.reason ?? 'unknown',
    });
    runtime.lastStatus = 401;
    return new Response('unauthorized', { status: 401 });
  }

  let body: unknown;
  if (runtime.config.bodyAs === 'string') {
    body = rawBody;
  } else {
    if (rawBody.length === 0) {
      body = null;
    } else {
      try {
        body = JSON.parse(rawBody);
      } catch (err) {
        runtime.lastStatus = 400;
        // Phase 6 slice-4: 400 bodies MUST NOT leak server-side detail.
        // The full parse error surfaces in the audit log only.
        runtime.deps.logger.warn('webhook.body.invalid-json', {
          triggerId: runtime.config.id,
          err: err instanceof Error ? err.message : String(err),
        });
        return new Response('bad request', { status: 400 });
      }
    }
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const url = new URL(req.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const event: AgentEvent<{
    headers: Record<string, string>;
    body: unknown;
    query: Record<string, string>;
  }> = {
    id: crypto.randomUUID(),
    kind: 'webhook.received',
    source: { type: 'webhook', triggerId: runtime.config.id },
    target: runtime.config.target,
    timestamp: Date.now(),
    payload: { headers, body, query },
    auth: authResult.eventAuth,
  };

  if (runtime.config.idempotencyKeyHeader) {
    const key = req.headers.get(runtime.config.idempotencyKeyHeader);
    if (key) event.meta = { idempotencyKey: key };
  }

  try {
    await runtime.deps.bus.publish(stampTenantId(event, runtime.deps.tenant));
  } catch (err) {
    runtime.deps.logger.error('webhook.publish.error', {
      triggerId: runtime.config.id,
      err: err instanceof Error ? err.message : String(err),
    });
    runtime.lastStatus = 503;
    return new Response('dispatch error', { status: 503 });
  }

  runtime.eventsPublished += 1;
  runtime.lastEventAt = Date.now();
  runtime.lastStatus = 200;

  return Response.json({ eventId: event.id, accepted: true });
}

// ── Default listener (Bun.serve) ────────────────────────────────────────

const defaultListen: NonNullable<WebhookAdapterOptions['listen']> = async ({
  port,
  hostname,
  fetch,
}) => {
  // biome-ignore lint/suspicious/noExplicitAny: Bun global is not typed in this repo.
  const bun = (globalThis as any).Bun;
  if (!bun || typeof bun.serve !== 'function') {
    throw new Error(
      'webhook adapter: Bun.serve not available. Supply an explicit `listen` option in non-Bun hosts.',
    );
  }
  const server = bun.serve({
    port,
    hostname,
    fetch: (req: Request) => fetch(req),
  });
  return {
    port: server.port,
    hostname: server.hostname ?? hostname,
    async stop() {
      await server.stop();
    },
  };
};

// ── Adapter factory ──────────────────────────────────────────────────────

export function createWebhookAdapter(
  opts: WebhookAdapterOptions = {},
): EventSourceAdapter<WebhookTriggerConfig> {
  const defaultPort = opts.port ?? 7777;
  const defaultHostname = opts.hostname ?? '127.0.0.1';
  const listen = opts.listen ?? defaultListen;

  const routes = new Map<string, Route>();
  let server: WebhookServerHandle | null = null;
  let startingServer: Promise<WebhookServerHandle> | null = null;
  let activeCount = 0;

  async function ensureServer(): Promise<WebhookServerHandle> {
    if (server) return server;
    if (startingServer) return startingServer;
    startingServer = listen({
      port: defaultPort,
      hostname: defaultHostname,
      fetch: async (req: Request) => dispatchToRoute(routes, req),
    });
    try {
      server = await startingServer;
      return server;
    } finally {
      startingServer = null;
    }
  }

  async function maybeShutdownServer(): Promise<void> {
    if (activeCount === 0 && server) {
      const s = server;
      server = null;
      await s.stop();
    }
  }

  return {
    type: 'webhook',
    validateConfig(config: unknown): asserts config is WebhookTriggerConfig {
      assertTriggerConfig(config);
    },
    async create(
      config: WebhookTriggerConfig,
      deps: SourceDependencies,
    ): Promise<EventSourceInstance> {
      const path = config.path ?? `/webhook/${config.id}`;
      const runtime: TriggerRuntime = {
        config,
        deps,
        paused: false,
        rateLimitWindowStart: null,
        rateLimitCount: 0,
        eventsPublished: 0,
        lastEventAt: null,
        lastStatus: null,
      };
      let started = false;

      return {
        id: config.id,
        type: 'webhook',
        async start() {
          if (started) return;
          if (routes.has(path)) {
            throw new Error(`webhook path conflict: "${path}" already registered`);
          }
          started = true;
          runtime.paused = false;
          routes.set(path, {
            runtime,
            onRequest: (req) => handleTriggerRequest(req, runtime),
          });
          activeCount += 1;
          await ensureServer();
        },
        async stop() {
          if (!started) return;
          started = false;
          routes.delete(path);
          activeCount -= 1;
          await maybeShutdownServer();
        },
        async pause() {
          runtime.paused = true;
        },
        async resume() {
          runtime.paused = false;
        },
        async health() {
          if (!started) {
            return { status: 'degraded', details: 'not-started' };
          }
          if (runtime.paused) return { status: 'degraded', details: 'paused' };
          return { status: 'ok' };
        },
        metrics() {
          return {
            eventsPublished: runtime.eventsPublished,
            lastEventAt: runtime.lastEventAt,
          };
        },
      };
    },
  };
}

async function dispatchToRoute(routes: Map<string, Route>, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const route = routes.get(url.pathname);
  if (!route) return new Response('not found', { status: 404 });
  return await route.onRequest(req);
}
