/**
 * Control socket for the `declaragent up` daemon.
 *
 * A Unix domain socket (Windows: named pipe) bound at
 * `~/.declaragent/<agent-id>/control.sock` that speaks a minimal
 * NDJSON-over-stream JSON-RPC dialect. Unlike the richer
 * `packages/core/src/events/daemon.ts` control plane — which is scoped to
 * a standalone `startDaemon` process — this socket is specifically for
 * the multi-agent `up` loop and ships five fixed ops:
 *
 *   - `ping`         → `{ pong: true }`. Cheap health check.
 *   - `status`       → `{ pid, uptimeMs, sources, lastEventAt }`.
 *                       Replaces the `up-state.json` read in `ps`.
 *   - `dlq.requeue`  → re-injects a rejected event onto the bus via
 *                       `requeue()` in {@link ../events/dlq.ts}.
 *   - `reload`       → best-effort hot-reload of sources. Returns
 *                       `{ reloaded: false, reason: 'skills-changed' }`
 *                       when the declarative skill set has drifted
 *                       (we refuse rather than half-apply).
 *   - `shutdown`     → acks then triggers the daemon's shutdown hook.
 *
 * The op set is intentionally fixed; this is not a pluggable registry.
 * Broader extensibility lives in the Phase-3 `startDaemon` path already.
 *
 * Protocol: one JSON object per line. Each request carries a client-side
 * `id` (string) so multiple concurrent calls can be correlated.
 * Responses echo that id. Errors use a `{ error: { code, message } }`
 * shape.
 *
 * Hardening notes:
 *   - Socket file is chmod'd to 0600 so other local users can't speak
 *     to the daemon.
 *   - A stale socket from a previous crash is unlinked on startup —
 *     never wedges `up`. (Windows named-pipe path is unique-per-process
 *     so stale-pipe handling is a no-op.)
 *   - Auto-clean on process exit via the returned handle's `close()`.
 *   - Malformed / unknown-op requests get a typed error reply rather
 *     than a TCP-reset so operators can see what went wrong.
 *
 * @since 0.6.x
 */

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { NDJSONDecoder } from '../events/control-protocol.js';
import { type RequeueResult, requeue } from '../events/dlq.js';
import type { EventStore } from '../events/store.js';
import type { EventBus, EventSourceInstance } from '../events/types.js';
import type { Logger } from '../types/logger.js';

// ── Op protocol ─────────────────────────────────────────────────────────

/** Every request carries a caller-supplied correlation id. */
export interface ControlSocketRequestBase {
  readonly id: string;
}

export type ControlSocketRequest =
  | (ControlSocketRequestBase & { readonly op: 'ping' })
  | (ControlSocketRequestBase & { readonly op: 'status' })
  | (ControlSocketRequestBase & {
      readonly op: 'dlq.requeue';
      readonly params: { readonly eventId: string };
    })
  | (ControlSocketRequestBase & { readonly op: 'reload' })
  | (ControlSocketRequestBase & { readonly op: 'shutdown' });

export type ControlSocketOp = ControlSocketRequest['op'];

export interface ControlSocketStatus {
  readonly pid: number;
  readonly agentId: string;
  readonly startedAt: number;
  readonly uptimeMs: number;
  readonly sources: readonly { readonly id: string; readonly type: string }[];
  /** ms epoch of the last event the daemon observed; undefined if none. */
  readonly lastEventAt?: number;
}

export interface ControlSocketReloadResult {
  readonly reloaded: boolean;
  /** Populated when `reloaded === false` so callers can message the user. */
  readonly reason?: 'skills-changed' | 'unsupported' | 'no-handler';
  readonly message?: string;
}

export interface ControlSocketResultByOp {
  readonly ping: { readonly pong: true };
  readonly status: ControlSocketStatus;
  readonly 'dlq.requeue': RequeueResult;
  readonly reload: ControlSocketReloadResult;
  readonly shutdown: { readonly ok: true };
}

export interface ControlSocketErrorBody {
  readonly code: string;
  readonly message: string;
}

/** Distribute over op so narrowing on `resp.op` narrows `resp.result`. */
export type ControlSocketResponse = {
  [Op in ControlSocketOp]:
    | { readonly id: string; readonly op: Op; readonly result: ControlSocketResultByOp[Op] }
    | { readonly id: string; readonly op: Op; readonly error: ControlSocketErrorBody };
}[ControlSocketOp];

/** Narrow guard. Rejects anything that doesn't fit the request shape. */
export function isControlSocketRequest(value: unknown): value is ControlSocketRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.op !== 'string') return false;
  switch (v.op) {
    case 'ping':
    case 'status':
    case 'reload':
    case 'shutdown':
      return true;
    case 'dlq.requeue': {
      const p = v.params as { eventId?: unknown } | undefined;
      return typeof p?.eventId === 'string' && p.eventId.length > 0;
    }
    default:
      return false;
  }
}

/** Encode a request or response as a single NDJSON line (trailing `\n`). */
export function encodeControlSocketMessage(
  value: ControlSocketRequest | ControlSocketResponse,
): string {
  return `${JSON.stringify(value)}\n`;
}

// ── Handlers ────────────────────────────────────────────────────────────

/**
 * Context exposed to each op. The caller assembles this once at bind
 * time and passes it to the server; handlers can read-through it on every
 * request.
 */
export interface ControlSocketContext {
  readonly agentId: string;
  /** Pid to report in `status`. Defaults to `process.pid` when omitted. */
  readonly pid: number;
  /** ms epoch when the daemon started. */
  readonly startedAt: number;
  /** Snapshot of bound sources — returned verbatim in `status.sources`. */
  readonly sources: () => readonly EventSourceInstance[];
  /** Last event timestamp; the daemon updates this from its bus subscriber. */
  readonly lastEventAt: () => number | undefined;
  /**
   * Called when `dlq.requeue` is invoked. Callers wire this to
   * {@link requeue} with their bus + store. Returning undefined means
   * the daemon has no bus wired yet → the op returns `{ code: 'ENOBUS' }`.
   */
  readonly bus?: EventBus;
  readonly store?: EventStore;
  /**
   * Called when `reload` is invoked. Should return a result describing
   * what happened. If omitted, `reload` responds with `unsupported`.
   */
  readonly reload?: () => Promise<ControlSocketReloadResult> | ControlSocketReloadResult;
  /**
   * Called when `shutdown` is invoked. Should initiate graceful stop;
   * the socket acks immediately and does not await this. If omitted,
   * the op still acks but no shutdown is triggered (test harness use).
   */
  readonly shutdown?: () => Promise<void> | void;
  readonly logger?: Logger;
}

/**
 * Pure op dispatch. No I/O — both the socket server and tests call this
 * directly. Returns a response the caller serialises back to the client.
 */
export async function handleControlSocketRequest(
  request: ControlSocketRequest,
  ctx: ControlSocketContext,
): Promise<ControlSocketResponse> {
  try {
    switch (request.op) {
      case 'ping':
        return { id: request.id, op: 'ping', result: { pong: true } };

      case 'status': {
        const sources = ctx.sources().map((s) => ({ id: s.id, type: s.type }));
        const status: ControlSocketStatus = {
          pid: ctx.pid,
          agentId: ctx.agentId,
          startedAt: ctx.startedAt,
          uptimeMs: Date.now() - ctx.startedAt,
          sources,
          ...(ctx.lastEventAt() !== undefined && { lastEventAt: ctx.lastEventAt() as number }),
        };
        return { id: request.id, op: 'status', result: status };
      }

      case 'dlq.requeue': {
        if (!ctx.bus || !ctx.store) {
          return {
            id: request.id,
            op: 'dlq.requeue',
            error: {
              code: 'ENOBUS',
              message: 'daemon has no bus/store wired — cannot requeue',
            },
          };
        }
        const result = await requeue({
          bus: ctx.bus,
          store: ctx.store,
          eventId: request.params.eventId,
        });
        return { id: request.id, op: 'dlq.requeue', result };
      }

      case 'reload': {
        if (!ctx.reload) {
          return {
            id: request.id,
            op: 'reload',
            result: {
              reloaded: false,
              reason: 'unsupported',
              message: 'reload is not supported by this daemon',
            },
          };
        }
        const result = await ctx.reload();
        return { id: request.id, op: 'reload', result };
      }

      case 'shutdown': {
        // Kick off shutdown without awaiting — operators expect the ack
        // before the daemon actually tears down.
        if (ctx.shutdown) {
          void Promise.resolve()
            .then(() => ctx.shutdown?.())
            .catch((err) => {
              ctx.logger?.warn('control-socket.shutdown-failed', {
                err: err instanceof Error ? err.message : String(err),
              });
            });
        }
        return { id: request.id, op: 'shutdown', result: { ok: true } };
      }
    }
  } catch (err) {
    const body: ControlSocketErrorBody = {
      code: 'EHANDLER',
      message: err instanceof Error ? err.message : String(err),
    };
    // Type-narrow the op literal into each arm so the response stays
    // discriminated.
    switch (request.op) {
      case 'ping':
        return { id: request.id, op: 'ping', error: body };
      case 'status':
        return { id: request.id, op: 'status', error: body };
      case 'dlq.requeue':
        return { id: request.id, op: 'dlq.requeue', error: body };
      case 'reload':
        return { id: request.id, op: 'reload', error: body };
      case 'shutdown':
        return { id: request.id, op: 'shutdown', error: body };
    }
  }
}

// ── Path helpers ────────────────────────────────────────────────────────

/**
 * Returns `true` on Windows, where Unix domain sockets at filesystem paths
 * aren't reachable via the same primitives. Node's `net.createServer`
 * does accept a `\\.\pipe\...` path to create a Windows named pipe, which
 * we use as the fallback transport. Callers don't need to branch.
 */
export function isWindows(): boolean {
  return platform() === 'win32';
}

/**
 * Canonical control socket path for an agent. Must match the client-side
 * resolver in the CLI (`ps`, future `declaragent control *` verbs).
 *
 * Honors `$HOME` when the env var is set — matching the same behavior
 * `packages/cli/src/paths.ts#configDir` uses — so a test that redirects
 * HOME to a tmp dir gets a tmp-scoped socket rather than writing into
 * the user's real `~/.declaragent`.
 *
 * @param agentId  The agent identifier from `agent.yaml#name`.
 * @param root     Optional override. Defaults to `$HOME` then `os.homedir()`.
 */
export function controlSocketPath(agentId: string, root?: string): string {
  const sanitized = sanitizeAgentId(agentId);
  if (isWindows()) {
    // Named pipes live in the special NT namespace — no filesystem path.
    // We still return a stable identifier so both sides agree.
    return `\\\\.\\pipe\\declaragent-${sanitized}`;
  }
  const home = root ?? process.env.HOME ?? homedir();
  return join(home, '.declaragent', sanitized, 'control.sock');
}

function sanitizeAgentId(id: string): string {
  // Matches the sanitizer in up-lifecycle.ts; defensive for any id the
  // user renames on disk that still slipped past yaml validation.
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ── Server ──────────────────────────────────────────────────────────────

export interface ControlSocketServer {
  readonly socketPath: string;
  /** Close the listener + unlink the socket file. Idempotent. */
  close(): Promise<void>;
}

export interface StartControlSocketOptions {
  readonly context: ControlSocketContext;
  /**
   * Override for the socket path. Defaults to
   * {@link controlSocketPath}(context.agentId).
   */
  readonly socketPath?: string;
  /**
   * When `true` (default) and a socket file already exists at the target
   * path, it's unlinked before bind. Prevents a stale socket from a
   * crashed `up` wedging the next startup.
   */
  readonly force?: boolean;
}

/**
 * Bind a control socket server. On Unix this creates a Unix domain
 * socket chmod'd to 0600; on Windows this creates a named pipe with the
 * same NDJSON protocol.
 *
 * The returned handle has `close()` which gracefully stops the listener
 * + unlinks the socket file.
 */
export async function startControlSocket(
  options: StartControlSocketOptions,
): Promise<ControlSocketServer> {
  const { context } = options;
  const socketPath = options.socketPath ?? controlSocketPath(context.agentId);
  const force = options.force ?? true;

  if (!isWindows()) {
    // Parent dir must exist for bind to succeed.
    try {
      mkdirSync(dirname(socketPath), { recursive: true });
    } catch {
      // ignore — bind will surface the error if mkdir genuinely failed.
    }
    if (force && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Not fatal — maybe it wasn't a socket; listen() will throw if
        // the path is unusable.
      }
    }
  }

  const server: Server = createServer((socket) => handleConnection(socket, context));
  // Reject new connections if the server is shutting down rather than
  // hang the socket.
  server.on('error', (err) => {
    context.logger?.warn('control-socket.server-error', {
      err: err instanceof Error ? err.message : String(err),
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });

  if (!isWindows()) {
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // Non-fatal on filesystems where chmod is a no-op; the file is
      // still in a user-owned dir.
    }
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (!isWindows() && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
  };

  return { socketPath, close };
}

function handleConnection(socket: Socket, ctx: ControlSocketContext): void {
  const decoder = new NDJSONDecoder();
  socket.setEncoding('utf8');

  socket.on('data', async (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parsed = decoder.push(text);
    for (const entry of parsed) {
      if (!isControlSocketRequest(entry)) {
        // Malformed or unknown op — respond with a typed error so the
        // operator can see what went wrong. Use a fabricated id + op
        // when we can pull them out of the input.
        const maybe = (entry ?? {}) as { id?: unknown; op?: unknown };
        const id = typeof maybe.id === 'string' ? maybe.id : 'invalid';
        writeResponse(socket, {
          id,
          op: 'ping', // placeholder; the client should key off `error`
          error: {
            code: 'EBADREQ',
            message: `malformed or unknown control-socket request: ${JSON.stringify(maybe)}`,
          },
        } as ControlSocketResponse);
        continue;
      }
      try {
        const response = await handleControlSocketRequest(entry, ctx);
        writeResponse(socket, response);
      } catch (err) {
        writeResponse(socket, {
          id: entry.id,
          op: entry.op,
          error: {
            code: 'EUNHANDLED',
            message: err instanceof Error ? err.message : String(err),
          },
        } as ControlSocketResponse);
      }
    }
  });

  socket.on('error', () => {
    // Client disconnected or write failed — nothing to do.
  });
}

function writeResponse(socket: Socket, response: ControlSocketResponse): void {
  try {
    socket.write(encodeControlSocketMessage(response));
  } catch {
    // Best-effort; socket may already be closed.
  }
}

// ── Client ──────────────────────────────────────────────────────────────

import { connect } from 'node:net';

export interface ControlSocketClient {
  /**
   * Send one request; resolves with the matching response. The generic
   * `Op` is inferred from the request so callers can narrow the result
   * without a cast (`(resp: { op: 'ping'; result: { pong: true } })`).
   */
  call(request: ControlSocketRequest): Promise<ControlSocketResponse>;
  close(): void;
}

/**
 * Open a client to a control socket. Multiple `call()` invocations share
 * the same connection; responses are correlated by the request `id`.
 */
export async function connectControlSocket(
  socketPath: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<ControlSocketClient> {
  const timeoutMs = options.timeoutMs ?? 2000;

  const socket: Socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect(socketPath);
    s.setEncoding('utf8');
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`control-socket connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onErr = (err: Error): void => {
      clearTimeout(timer);
      s.removeListener('connect', onConn);
      reject(err);
    };
    const onConn = (): void => {
      clearTimeout(timer);
      s.removeListener('error', onErr);
      resolve(s);
    };
    s.once('error', onErr);
    s.once('connect', onConn);
  });

  const decoder = new NDJSONDecoder();
  const pending = new Map<string, (resp: ControlSocketResponse) => void>();
  let closed = false;

  socket.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const parsed = decoder.push(text);
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || !('id' in entry)) continue;
      const id = (entry as { id: string }).id;
      const resolver = pending.get(id);
      if (resolver) {
        pending.delete(id);
        resolver(entry as ControlSocketResponse);
      }
    }
  });

  socket.on('close', () => {
    closed = true;
    for (const [id, resolver] of pending) {
      resolver({
        id,
        op: 'ping',
        error: { code: 'ESOCKETCLOSED', message: 'control socket closed before response' },
      } as ControlSocketResponse);
    }
    pending.clear();
  });

  return {
    async call(request: ControlSocketRequest): Promise<ControlSocketResponse> {
      if (closed) {
        return {
          id: request.id,
          op: request.op,
          error: { code: 'ESOCKETCLOSED', message: 'control socket is closed' },
        } as ControlSocketResponse;
      }
      return new Promise<ControlSocketResponse>((resolve) => {
        pending.set(request.id, (resp) => resolve(resp));
        socket.write(encodeControlSocketMessage(request));
      });
    },
    close(): void {
      if (!closed) {
        closed = true;
        socket.end();
      }
    },
  };
}
