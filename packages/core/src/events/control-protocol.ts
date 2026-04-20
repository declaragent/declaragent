import type {
  Daemon,
  DaemonReloadOptions,
  DaemonReloadResult,
  DaemonShutdownOptions,
  DaemonStatus,
} from './daemon.js';
import type { AgentEvent, DLQEntry, DLQListParams, DispatchOutcome } from './types.js';

/**
 * JSON-RPC-ish framing. Both the Unix socket server and any future HTTP
 * control plane share these types and the `handleControlRequest` dispatch
 * below — only the transport differs.
 */

export interface ControlRequestBase {
  /** Client-supplied correlation id, echoed in the response. */
  id: string;
}

export interface ReplayRangeParams {
  /** Source instance id to replay from. */
  sourceId: string;
  fromMs: number;
  toMs?: number;
  limit?: number;
  /**
   * Optional JSONPath filter-expression string, applied to the event
   * JSON. The daemon compiles it server-side; the CLI passes it verbatim.
   */
  filterExpr?: string;
  /** When true, dispatch each replayed event; when false, just return the count. */
  dispatch?: boolean;
}

export interface ReplayRangeResult {
  replayed: number;
  dispatched: number;
  outcomes: readonly { eventId: string; outcome: DispatchOutcome }[];
}

export interface DLQListControlParams extends DLQListParams {
  sourceId: string;
}

export interface DLQShowControlParams {
  sourceId: string;
  entryId: string;
}

export interface DLQRedriveControlParams {
  sourceId: string;
  entryId: string;
}

export type ControlRequest =
  | (ControlRequestBase & { method: 'status' })
  | (ControlRequestBase & { method: 'reload'; params?: DaemonReloadOptions })
  | (ControlRequestBase & { method: 'shutdown'; params?: DaemonShutdownOptions })
  | (ControlRequestBase & { method: 'send-event'; params: { event: AgentEvent } })
  | (ControlRequestBase & { method: 'replay-range'; params: ReplayRangeParams })
  | (ControlRequestBase & { method: 'dlq-list'; params: DLQListControlParams })
  | (ControlRequestBase & { method: 'dlq-show'; params: DLQShowControlParams })
  | (ControlRequestBase & { method: 'dlq-redrive'; params: DLQRedriveControlParams });

export type ControlMethod = ControlRequest['method'];

export interface ControlResultByMethod {
  status: DaemonStatus;
  reload: DaemonReloadResult;
  shutdown: { ok: true };
  'send-event': { outcome: DispatchOutcome };
  'replay-range': ReplayRangeResult;
  'dlq-list': { entries: readonly DLQEntry[] };
  'dlq-show': { entry: DLQEntry | null };
  'dlq-redrive': { ok: true };
}

export interface ControlErrorBody {
  code: string;
  message: string;
}

/**
 * Distribute over methods so `resp.method === 'send-event'` narrows
 * `resp.result` to `ControlResultByMethod['send-event']` rather than the
 * union across every method.
 */
export type ControlResponse = {
  [M in ControlMethod]:
    | { id: string; method: M; result: ControlResultByMethod[M] }
    | { id: string; method: M; error: ControlErrorBody };
}[ControlMethod];

/** Narrow guard so handlers can key on `method` safely. */
export function isControlRequest(value: unknown): value is ControlRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.method !== 'string') return false;
  return (
    v.method === 'status' ||
    v.method === 'reload' ||
    v.method === 'shutdown' ||
    v.method === 'send-event' ||
    v.method === 'replay-range' ||
    v.method === 'dlq-list' ||
    v.method === 'dlq-show' ||
    v.method === 'dlq-redrive'
  );
}

/**
 * Dispatch a single request against a daemon. Pure: no I/O, no sockets —
 * both the Unix socket server and any tests call this directly.
 */
export async function handleControlRequest(
  daemon: Daemon,
  request: ControlRequest,
): Promise<ControlResponse> {
  try {
    switch (request.method) {
      case 'status': {
        const status = await daemon.status();
        return { id: request.id, method: 'status', result: status };
      }
      case 'reload': {
        const result = await daemon.reload(request.params);
        return { id: request.id, method: 'reload', result };
      }
      case 'shutdown': {
        // Kick off shutdown but don't await it — callers want the ack first,
        // and awaiting here would block the response until the daemon is
        // fully stopped (which, depending on drainTimeoutMs, can be 30s+).
        void daemon.shutdown(request.params).catch(() => {
          // swallow; the daemon logged it already.
        });
        return { id: request.id, method: 'shutdown', result: { ok: true } };
      }
      case 'send-event': {
        const outcome = await daemon.sendEvent(request.params.event);
        return { id: request.id, method: 'send-event', result: { outcome } };
      }
      case 'replay-range': {
        const result = await daemon.replayRange(request.params);
        return { id: request.id, method: 'replay-range', result };
      }
      case 'dlq-list': {
        const entries = await daemon.dlqList(request.params);
        return { id: request.id, method: 'dlq-list', result: { entries } };
      }
      case 'dlq-show': {
        const entry = await daemon.dlqShow(request.params);
        return { id: request.id, method: 'dlq-show', result: { entry: entry ?? null } };
      }
      case 'dlq-redrive': {
        await daemon.dlqRedrive(request.params);
        return { id: request.id, method: 'dlq-redrive', result: { ok: true } };
      }
    }
  } catch (err) {
    // Per-method error response; cast once so each arm doesn't need its own.
    const body: ControlErrorBody = {
      code: 'EHANDLER',
      message: err instanceof Error ? err.message : String(err),
    };
    switch (request.method) {
      case 'status':
        return { id: request.id, method: 'status', error: body };
      case 'reload':
        return { id: request.id, method: 'reload', error: body };
      case 'shutdown':
        return { id: request.id, method: 'shutdown', error: body };
      case 'send-event':
        return { id: request.id, method: 'send-event', error: body };
      case 'replay-range':
        return { id: request.id, method: 'replay-range', error: body };
      case 'dlq-list':
        return { id: request.id, method: 'dlq-list', error: body };
      case 'dlq-show':
        return { id: request.id, method: 'dlq-show', error: body };
      case 'dlq-redrive':
        return { id: request.id, method: 'dlq-redrive', error: body };
    }
  }
}

/** Encode a response as a single NDJSON line (trailing `\n`). */
export function encodeControlMessage(value: ControlRequest | ControlResponse): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Stream decoder: feed raw string chunks; iterate over each complete line's
 * JSON parse result. Incomplete trailing fragments are buffered.
 */
export class NDJSONDecoder {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Malformed line — ignore; callers will see no result.
      }
    }
    return out;
  }
}
