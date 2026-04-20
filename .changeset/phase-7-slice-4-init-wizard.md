---
'@declaragent/cli': patch
---

Phase 7 slice 4: `declaragent init` wizard.

First-run flow built on the existing Ink + `ink-text-input` stack. Walks the
user through telemetry opt-out → provider pick → (optional) tenant id →
template pick → config write → verify in under three minutes. Targets `./`
by default, `-o <dir>` for an explicit path, `--force` to overwrite an
existing `agent.yaml`, `--multi-tenant` to scaffold `tenants.yaml` alongside.

- **`packages/cli/src/init-wizard.tsx`** — orchestrator + Ink components.
  Exports `runInit(options, deps?)` that returns `0 | 1` so the top-level
  `index.tsx` routes cleanly. When both `--provider` and `--template` are
  passed, runs fully non-interactive. Missing flags without a
  `launchInteractive` dep exit 1 with a fix hint (the real interactive
  launcher lands when the Ink flow is wired end-to-end — the orchestrator
  already accepts it via DI).

- **`packages/cli/src/init-template-unpacker.ts`** — pure
  `unpackTemplate(opts, fs)` that writes `agent.yaml` + `.env.example` +
  `README.md` (and `tenants.yaml` when `multiTenant`). Idempotency guard
  checks every target before the first write and aborts unless `force`.
  Template bodies are stubbed; the five template names match the slice-5
  roster (`concierge`, `oncall-escalator`, `pr-review`, `kafka-pipeline`,
  `multi-tenant-starter`). TODO marker points at `templates/<name>/` for
  the real packs.

- **`packages/cli/src/init-paths.ts`** — `initializedMarkerPath()` +
  `telemetryOptOutPath()` helpers anchored on `configDir()`. The marker
  lands after a successful run; the telemetry opt-out is a pure-file
  sentinel (no network writes — slice 8's job).

- **`packages/cli/src/index.tsx`** — new `runInitSubcommand` that parses
  `--out / -o`, `--force`, `--multi-tenant`, `--template`, `--provider`,
  `--tenant-id`, `--skip-verify`, and `--help`. Help block grew one line
  under the `secrets` entry.

- **Verify step.** One `hello` turn against the resolved provider. Anthropic
  routes through `createAnthropicProvider`; every OpenAI-compat preset goes
  through `createOpenAICompatProvider`. Injectable via `deps.verify` or
  `deps.makeVerifyProvider` for tests. Errors are classified: `401` →
  `auth login` hint; network/timeout → `HTTPS_PROXY` hint; else → the
  `--skip-verify` escape.

- **Tests.** `init-wizard.test.ts` covers the non-interactive path,
  `--force` overwrite guard, `--multi-tenant` toggle, verify success +
  failure paths (injected provider + injected verify hook), and the
  interactive-gate fallback. Uses the same captured-IO + injected-FS
  pattern as `tenants-cli.test.ts` — no Ink is mounted.

**Not yet landed.**
- `templates/<name>/` real packs (slice 5's territory).
- Full interactive Ink orchestration that chains auth → tenant id →
  template pick → verify inside one render; slice 4 ships the Ink
  components + the non-interactive orchestrator and the `launchInteractive`
  DI seam, but the end-to-end chaining needs the auth flows to yield a
  continuation token rather than exiting their Ink instance — tracked for
  a slice 4.5 polish pass.
- Telemetry upload side of the opt-out sentinel — slice 8.
