/**
 * `/logs` — Server-Sent Events endpoint for live log tailing.
 *
 * Completes Slice 1 of `docs/CONTROL_PLANE_PLAN.md` by landing the
 * last of the five control-plane routes (`/metrics`, `/status`,
 * `/events`, `/dlq`, `/audit` ship in earlier PRs). Reads from the
 * per-agent JSON-lines log files the `up` daemon already writes to
 * `~/.declaragent/logs/<agent>.log` via
 * {@link ../../cli/src/up-lifecycle.openAgentLog} and re-frames each
 * line as an SSE `event: log\ndata: {...}\n\n` frame.
 *
 * Design choices:
 *
 *   - **SSE over WebSocket.** One-way server → client. HTTP/1.1
 *     compatible. Native `EventSource` API on every browser + a
 *     `fetch`-based reader in the CLI. No framing layer.
 *   - **Heartbeats.** Every 15s we emit `: keep-alive\n\n` (a
 *     comment-only frame) so proxies + load balancers don't close
 *     the idle socket. Clients that ignore comments see nothing.
 *   - **Back-pressure.** The tailer can outrun the socket on a
 *     busy agent. We buffer up to 1024 pending frames; once that
 *     queue fills, we drop the whole buffer and emit a single
 *     `{"system":"dropped","count":N}` so the client can reconnect
 *     or resync from `/events`. Dropping is preferred to blocking
 *     the tailer — a stuck SSE client must not back-pressure the
 *     file I/O loop.
 *   - **Resource discipline.** Every stream registers its tailer
 *     with the underlying `ReadableStream`'s `cancel` hook. When
 *     the client drops the socket, the controller reports `cancel`
 *     and we destroy the tailer + stop the heartbeat timer. We
 *     also honour `request.signal.abort` as a belt-and-suspenders
 *     cleanup path (Bun's runtime wires AbortController into
 *     Request.signal when the client disconnects).
 *
 * @since 0.7.0-slice.1 (PR 1.2)
 */

import type { ControlPlaneRoute } from './control-plane-server.js';
import { type LogTailer, createLogTailer } from './log-tail.js';

// ── Route options + query ──────────────────────────────────────────────────

/**
 * Host-supplied policy for which log files the `/logs` endpoint is
 * allowed to stream. The route doesn't know the `up` daemon's path
 * layout — it calls back into the host (the `up-cli.ts` wiring)
 * which maps `?agent=<id>` to the concrete `~/.declaragent/logs/<id>.log`
 * file paths.
 *
 * Returning `null` is the "unknown agent" signal → 400. Returning
 * an empty array is "valid query but no files to tail" → 200 with
 * an immediate `system: no-paths` frame (rare — tests rely on this
 * to assert the error path; production callers should return null).
 */
export type ResolveLogPaths = (
  query: LogsQuery,
) => LogsResolvedPaths | null | Promise<LogsResolvedPaths | null>;

export interface LogsQuery {
  /** Literal `?agent=` param. Undefined when the caller wants the multiplex. */
  readonly agent: string | undefined;
  /** Literal `?since=` param. ms-epoch or ISO-8601. Callers decide how to seek. */
  readonly since: string | undefined;
  /** URL of the request, for callers that want to parse additional params. */
  readonly url: URL;
}

export interface LogsResolvedPaths {
  /** Absolute paths to tail. One per log file; multiple files may map to one agent. */
  readonly paths: readonly ResolvedLogPath[];
  /** When true, the tailer replays the whole file before following. */
  readonly fromStart?: boolean;
}

export interface ResolvedLogPath {
  readonly path: string;
  readonly agentId: string;
}

export interface LogsRouteOptions {
  path?: string;
  resolvePaths: ResolveLogPaths;
  /**
   * Heartbeat interval in ms. Default 15_000. Tests override to
   * 50ms so assertions on the comment frame don't take 15s.
   */
  heartbeatMs?: number;
  /**
   * Maximum pending frames before the back-pressure drop kicks in.
   * Default 1024. On drop, we replace the queue with a single
   * `system: dropped` frame carrying the count we discarded.
   */
  maxBufferedFrames?: number;
  /**
   * Testing seam — override the tailer factory so unit tests can
   * drive lines deterministically instead of touching the disk.
   */
  tailerFactory?: (opts: {
    paths: readonly ResolvedLogPath[];
    fromStart: boolean;
  }) => LogTailer;
}

// ── Route ──────────────────────────────────────────────────────────────────

/**
 * `GET /logs` — SSE live-tail of one or more agent log files.
 *
 * Query params:
 *   - `agent` (optional) — limit to one agent. Omit to multiplex all running agents.
 *   - `since` (optional) — ms-epoch or ISO-8601 offset. When set, the
 *     tailer starts at byte 0 of each file; callers filter on the
 *     wire.
 *
 * Response:
 *   - `200 text/event-stream`. Every log line is an `event: log`
 *     frame with JSON body. Heartbeats are `: keep-alive` comments.
 *     Disconnects tear the tailer down.
 *   - `400 application/json` when `resolvePaths` returns `null` for
 *     an unknown agent. Error body: `{ "error": "..." }`.
 *   - `405` for non-GET.
 */
export function logsRoute(opts: LogsRouteOptions): ControlPlaneRoute {
  const path = opts.path ?? '/logs';
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxBuffered = opts.maxBufferedFrames ?? 1024;
  const makeTailer =
    opts.tailerFactory ?? (({ paths, fromStart }) => createLogTailer({ paths, fromStart }));

  return {
    path,
    async fetch(req) {
      if (req.method !== 'GET') {
        return new Response('method not allowed', {
          status: 405,
          headers: { Allow: 'GET' },
        });
      }

      const url = new URL(req.url);
      const query: LogsQuery = {
        agent: url.searchParams.get('agent') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
        url,
      };

      let resolved: LogsResolvedPaths | null;
      try {
        resolved = await opts.resolvePaths(query);
      } catch (err) {
        return jsonError(500, `path resolver failed: ${errMsg(err)}`);
      }
      if (resolved === null) {
        return jsonError(400, `unknown agent "${query.agent ?? ''}"`);
      }

      const tailer = makeTailer({
        paths: resolved.paths,
        fromStart: Boolean(resolved.fromStart),
      });

      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let pending: Uint8Array[] = [];
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const canFlush = (): boolean => {
        if (!controller || closed) return false;
        // `desiredSize` is positive when the consumer is ready, 0
        // when at the high-water mark, null when the stream is
        // errored. Anything <= 0 means we should buffer rather
        // than enqueue directly.
        const desired = controller.desiredSize;
        return desired === null ? false : desired > 0;
      };

      const flush = (): void => {
        if (!controller || closed) return;
        while (pending.length > 0 && canFlush()) {
          const frame = pending.shift();
          if (!frame) break;
          try {
            controller.enqueue(frame);
          } catch {
            // Controller already closed — happens during cancel
            // races. Drop the frame and stop flushing.
            closed = true;
            break;
          }
        }
      };

      const enqueueRaw = (bytes: Uint8Array): void => {
        if (closed) return;
        // Back-pressure: if we're buffering more than the cap, drop
        // everything and emit a single system notice. We reset the
        // queue rather than dropping oldest because the consumer is
        // better off with a "you missed N lines" signal than with a
        // half-stale tail. 1024 lines × ~200 bytes = ~200KB ceiling.
        if (pending.length >= maxBuffered) {
          const dropped = pending.length;
          pending = [];
          pending.push(formatSystemFrame(encoder, { system: 'dropped', count: dropped }));
        }
        pending.push(bytes);
        flush();
      };

      const enqueueLogLine = (agentId: string, line: string): void => {
        if (closed) return;
        // The log writer emits well-formed JSON per line; re-emit
        // as-is, adding the `agentId` field if the line doesn't
        // already carry one. If parsing fails we wrap the raw text
        // so a non-JSON log entry doesn't kill the stream.
        let payload: string;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (typeof obj.agent !== 'string' && typeof obj.agentId !== 'string') {
            obj.agentId = agentId;
          }
          payload = JSON.stringify(obj);
        } catch {
          payload = JSON.stringify({ agentId, raw: line });
        }
        enqueueRaw(encoder.encode(`event: log\ndata: ${payload}\n\n`));
      };

      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          controller = ctrl;

          // Initial comment frame so eager proxies know the stream is
          // alive before the first real line lands. Harmless for well-
          // behaved clients.
          enqueueRaw(encoder.encode(': stream-open\n\n'));

          // Heartbeat loop — comment frames only, ignored by
          // `EventSource`. We don't .unref() here because the timer
          // is bound to the stream lifetime and is cleaned up in
          // `cancel` / on abort.
          heartbeat = setInterval(() => {
            enqueueRaw(encoder.encode(': keep-alive\n\n'));
          }, heartbeatMs);

          // Pump the tailer. We don't await here — the whole point
          // of the stream is to deliver lines as they arrive.
          void (async () => {
            try {
              for await (const { agentId, line } of tailer) {
                if (closed) break;
                enqueueLogLine(agentId, line);
              }
            } catch (err) {
              enqueueRaw(
                encoder.encode(
                  `event: system\ndata: ${JSON.stringify({
                    system: 'tailer-error',
                    message: errMsg(err),
                  })}\n\n`,
                ),
              );
            }
          })();

          // AbortController signal fires on client disconnect under
          // Bun. Mirror the cleanup so we don't double-close.
          if (req.signal) {
            if (req.signal.aborted) {
              shutdown();
            } else {
              req.signal.addEventListener('abort', shutdown, { once: true });
            }
          }
        },
        pull() {
          // Consumer has space again — drain whatever we stashed in
          // `pending`.
          flush();
        },
        cancel() {
          shutdown();
        },
      });

      function shutdown(): void {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        void tailer.destroy();
        pending = [];
        try {
          controller?.close();
        } catch {
          // already closed
        }
      }

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // Disable proxy buffering — critical for nginx + certain
          // cloud load-balancers that batch small responses by
          // default, which defeats the point of a live tail.
          'x-accel-buffering': 'no',
        },
      });
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatSystemFrame(encoder: TextEncoder, body: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: system\ndata: ${JSON.stringify(body)}\n\n`);
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
