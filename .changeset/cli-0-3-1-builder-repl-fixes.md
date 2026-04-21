---
'@declaragent/cli': patch
---

Fix REPL hangs when the agent-builder's propose flow blocks on user input.

`DeclaraProposeChange.execute` intentionally awaits the user's
`/yes` / `/no` / `/edit` via a Promise the proposal registry
resolves — but the REPL's render path was unmounting the
`TextInput` whenever `busy === true`, leaving no way to type the
confirming slash command. The only escape was a double Ctrl+C
exit; users lost the proposal and any in-progress work.

**Render path** (`packages/cli/src/app.tsx`)
- `TextInput` is now always mounted unless a model-picker or
  permission prompt is claiming exclusive focus.
- When `busy`, a "…working… (Ctrl+C to abort)" status line
  renders above the input box + the border turns yellow, so the
  user sees the engine is still running but can still type.
- Slash-suggestion + history-navigation `useInput` handlers no
  longer gate on `!busy`, so Up/Down + tab-complete work during
  a turn.

**Ctrl+C abort** — first press now has three behaviours:
1. Turn in flight → abort via an `AbortController` wired through
   `engine.runAgent({ abortSignal })`. The `DeclaraProposeChange`
   tool's `raceWithAbort` rejects the pending proposal so the
   engine unwinds cleanly + `busy` clears.
2. Pending proposal with no live turn (edge case) → reject it.
3. Nothing to abort → warn; second press within 2s exits as
   before.

**Unmount cleanup** — the registry-listener useEffect now
rejects any dangling pending proposals on component unmount so
closing the REPL doesn't leak a listener or a half-resolved
Promise.

No API changes; patch bump.
