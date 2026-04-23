---
'@declaragent/cli': patch
---

**Extract `packages/cli/src/control-socket-client.ts` shared helper (backlog #42).**

The connect → call → close dance for the per-agent control socket bound by `declaragent up` was inlined across `ps-cli.ts` (silent `status` probe with ~500ms timeout + snapshot fallback) and `dlq-dispatch-cli.ts` (`dlq.requeue` with rich exit-code semantics). Slice 3 of `docs/CONTROL_PLANE_PLAN.md` adds a third caller for cross-host fleet status fan-out; before that lands, fold the duplicated pattern into one module.

New module exposes:

- `resolveAgentControlSocketPath` — re-export of `controlSocketPath` so every CLI caller imports one module for "talk to a control socket."
- `withControlSocketClient(socketPath, options, fn)` — connect → invoke `fn` → always close (even on throw). Replaces the hand-rolled `try/finally` both callers duplicated.
- `tryFetchControlSocketStatus(socketPath, options)` — the silent-probe pattern from `ps-cli`: any error collapses to `null` so the caller falls back to the on-disk `up-state.json` snapshot.
- `unwrapOpResult(expected, response)` — typed narrowing helper that returns the response's `result` slot if the op matches and no error was set, else `null`.

Both existing callers refactored to consume the helper. No behavior change — `ps` still falls back to snapshot on a silent timeout; `dlqDispatchRequeue` preserves its four-exit-code contract (0/1/2/3/4). Test delta: +6 focused tests in `control-socket-client.test.ts` exercising the three surfaces against a real `startControlSocket`-bound daemon.
