---
'@declaragent/cli': patch
---

REPL UX polish (Phase C / P2 of USABILITY_PLAN.md). Four conversational-flow items shipping together:

- **Bracketed-paste support.** Multi-line pastes no longer submit after the first line. Architecture mirrors Claude Code's tokenizer: `CSI ?2004h` is enabled on mount; a parallel `process.stdin` listener runs a two-state FSM that detects `CSI 200~` / `CSI 201~` markers (spanning chunk boundaries), buffers the content, and flushes it via `setInput(prior + body)` once the end marker arrives. Ink's own pre-parser continues to route keystrokes as usual, but TextInput's `onChange` / `onSubmit` are gated on an `inPaste` flag so the embedded `\n` mid-paste never fires a submit and the first line never leaks into the controlled input. `\x1b[?2004l` is written on unmount.
- **`/prompt <path>`** reads a file and submits its contents verbatim as the next user message. Stays useful for pastes that exceed terminal buffering, or terminals without bracketed-paste support.
- **`@<path>` file refs** inline file contents into any user message. Supports absolute + relative + `~/` paths, deduplicates repeated tokens, truncates oversized attachments at 256KB, and surfaces per-ref hit/miss system lines so the user sees what got attached. Emails (`user@host.com`) are left alone.
- **Y/N keypress shortcuts for pending proposals** — a bare `y` / `yes` / `n` / `no` submission is routed as `/yes` / `/no` while a proposal is outstanding. The typed flow (including `/yes <phrase>` for explicit-yes proposals and `/edit <n> <replacement>`) keeps working unchanged. A new hint line renders above the input when a proposal is pending.
