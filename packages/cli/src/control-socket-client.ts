/**
 * Shared CLI helper for talking to the per-agent control socket bound by
 * `declaragent up`.
 *
 * Before this module, the connect → call → close dance was duplicated inline
 * across `ps-cli.ts` and `dlq-dispatch-cli.ts`. Slice 3 of the control-plane
 * plan (`docs/CONTROL_PLANE_PLAN.md`) adds a third caller — cross-host
 * `fleet ps`/`fleet status` fan-out — that wants the same semantics. Rather
 * than let the inline form proliferate, both 0.6.x verbs funnel through the
 * helpers here and the fan-out caller will do the same.
 *
 * Design notes:
 *
 *   - The helper is transport-identical to `connectControlSocket` (no wrapper
 *     layer, no retry loop). Callers that want observability/retry stack it
 *     on top — this module is intentionally mechanical.
 *   - `withControlSocketClient` guarantees `close()` even when the callback
 *     throws. That's the invariant both existing callers manually enforced
 *     inside a `try/finally`.
 *   - `tryFetchControlSocketStatus` is the silent `status`-probe pattern
 *     `ps-cli` uses — any failure collapses to `null`, letting the caller
 *     fall back to the on-disk snapshot.
 *   - `unwrapOpResult` is a typed narrowing helper: given an expected op
 *     tag it returns the `result` slot if the response matches, otherwise
 *     `null`. Callers that want richer error handling (print error code,
 *     exit non-zero) stay hand-written — we don't impose an error model
 *     because the two call sites disagree on UX.
 *
 * @since 0.7.1 (backlog item #42)
 */

import {
  type ControlSocketClient,
  type ControlSocketRequest,
  type ControlSocketResponse,
  type ControlSocketResultByOp,
  type ControlSocketStatus,
  connectControlSocket,
  controlSocketPath,
} from '@declaragent/core';

export interface ControlSocketConnectOptions {
  /** Default 2000ms — same as `connectControlSocket`. */
  readonly timeoutMs?: number;
}

/**
 * Resolve the per-agent control socket path. Thin re-export of the core
 * helper so every CLI caller imports one module for "talk to a control
 * socket."
 */
export const resolveAgentControlSocketPath = controlSocketPath;

/**
 * Connect to a control socket, invoke `fn`, and always close the client —
 * even if `fn` throws. Returns whatever `fn` returns.
 *
 * Callers that want to *swallow* errors should add their own try/catch
 * around the invocation; this helper surfaces them unchanged.
 */
export async function withControlSocketClient<T>(
  socketPath: string,
  options: ControlSocketConnectOptions,
  fn: (client: ControlSocketClient) => Promise<T>,
): Promise<T> {
  const client = await connectControlSocket(socketPath, {
    timeoutMs: options.timeoutMs ?? 2000,
  });
  try {
    return await fn(client);
  } finally {
    try {
      client.close();
    } catch {
      // Best-effort — the socket may already be gone.
    }
  }
}

/**
 * Silent status probe. Returns the agent's live status snapshot, or `null`
 * if the socket is unreachable, the connect times out, or the response is
 * an error. `ps-cli` uses this and falls back to the state-file snapshot.
 */
export async function tryFetchControlSocketStatus(
  socketPath: string,
  options: ControlSocketConnectOptions = {},
): Promise<ControlSocketStatus | null> {
  try {
    return await withControlSocketClient(socketPath, { timeoutMs: 500, ...options }, async (c) => {
      const resp = await c.call({ id: 'ps-status', op: 'status' });
      return unwrapOpResult('status', resp);
    });
  } catch {
    return null;
  }
}

/**
 * Narrow a {@link ControlSocketResponse} to the expected op's result slot.
 * Returns `null` when the op tag doesn't match or when the response is an
 * error. Use this to keep call sites terse; use explicit narrowing when you
 * need to distinguish "wrong op" from "error" from "success."
 */
export function unwrapOpResult<Op extends ControlSocketRequest['op']>(
  expected: Op,
  response: ControlSocketResponse,
): ControlSocketResultByOp[Op] | null {
  if (response.op !== expected) return null;
  if ('error' in response) return null;
  // `ControlSocketResponse` is a discriminated union over `op`; narrowing
  // by `expected` gives us the right variant at runtime but TS needs an
  // explicit `unknown` step to see the result slot as the expected type.
  return (response as unknown as { result: ControlSocketResultByOp[Op] }).result;
}
