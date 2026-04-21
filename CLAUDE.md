# CLAUDE.md

Project memory for Declaragent. Read this first when starting work here.

- **Name:** Declaragent (official).
- **Domain:** [declaragent.dev](https://declaragent.dev)
- **npm scope:** [`@declaragent/*`](https://www.npmjs.com/org/declaragent) — 13 packages on npm. CLI ships independently; latest `@declaragent/cli@0.4.16` (2026-04-21).
- **GitHub org:** `declaragent`.
- **Honest capability status:** see **[AGENTS.md](./AGENTS.md)**. This file is a project-orientation guide, not a status dashboard — AGENTS.md is the source of truth for "does feature X actually work end-to-end today?".

## What this project is

Declaragent is a declarative, git-versioned AI agent platform. An agent = immutable runtime **core** + git-versioned declarative **configuration** (`agent.yaml`: identity, tools, skills, plugins, event sources, channels, permissions, secrets, deployment).

The reference implementation archive — the leaked Claude Code source — lives at `/Users/ssvk/Documents/GitHub/claude-code/` and is read-only. Treat it as a study/reference codebase, not a dependency.

## Canonical plan

`docs/SPEC_AND_PLAN.md` is the source of truth for requirements and phased implementation. It supersedes the 8 background design docs (also in `docs/`), which are kept for historical context only.

When the plan and a background doc disagree, `SPEC_AND_PLAN.md` wins.

## Current status (verified 2026-04-21, CLI 0.4.16)

**What works end-to-end** (production-usable single-machine path):
- `declaragent init` → scaffold with `agent.yaml` + skills + `event-sources.yaml`
- `declaragent auth login` → OpenRouter / Anthropic / env-var credentials
- `declaragent up [-d]` → binds webhook/cron/file-watch sources, dispatcher routes events to skills, LLM turn runs, outcome recorded
- `declaragent ps / logs / down` → lifecycle verbs
- `declaragent events list / audit verify / dlq list` → observability backed by SQLite with hash-chained audit
- `declaragent deploy gcp-cloud-run` → generates Dockerfile + service.yaml (user runs `gcloud` themselves)
- Builder toolkit (`DECLARAGENT_BUILDER=on`): conversational authoring for skills, sources, channels, MCP, plugins, secrets, peers, fleet-add

**What's component-present but not wired to happy paths** (documented gaps):
- MCP server activation — `mcp add` stores but no runtime loads the servers
- Plugin activation — `plugin install` stores but no runtime loads the tools
- External source adapters (Kafka/NATS/SQS/AMQP/MQTT) — packages exist, `declaragent up` doesn't discover them (hardcodes webhook/cron/file-watch)
- Non-memory RPC transports — `fleet run` hardwires memory bus
- `RequestAgent` tool — not in `BUILTIN_TOOLS`, so skills can't call other agents without manual plugin wiring
- Channel delivery — adapters exist, no `SendMessage` tool in built-ins
- Circuit breakers, default rate limits, `/metrics` endpoint, real `gcloud` push — all component-present, none wired

**See [AGENTS.md](./AGENTS.md)** for the full evidence-backed matrix with file:line references. If you're about to promise a user a capability, verify against AGENTS.md first.

**Next priorities** (five items to close the largest first-principles gaps — see AGENTS.md § "Prioritized path"):
1. External source adapter discovery in `up` (~1 day)
2. Non-memory transports in `fleet run` (~1 day)
3. `RequestAgent` in `BUILTIN_TOOLS` (~2h)
4. MCP server activation at runtime (~1 day)
5. Channel `SendMessage` tool + runtime activation (~1 day)

## Stack

- **Runtime + package manager + test runner:** Bun (≥ 1.1)
- **Workspaces:** Bun workspaces (not pnpm/Turbo)
- **Lint + format:** Biome 1.9.4
- **Types:** TypeScript 5.7, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
- **Versioning:** changesets
- **LLM:** Anthropic Claude (Opus/Sonnet/Haiku) at v1.0; other providers later

## Conventions

- Imports from sibling source files use `.js` extension (TS resolves, Bun and bundlers handle at runtime).
- No `any` escape hatches without discussion.
- Tests colocated with source: `foo.ts` + `foo.test.ts`.
- Run `bun run lint:fix` before committing.
- Never commit `node_modules`, `dist`, or `.env*` (except `.env.example`).
- Lockfile (`bun.lock`) is committed.

## Dev loop

```bash
bun install
bun run typecheck
bun test
bun run build
bun run lint
```

CI runs all of the above plus `npm publish --dry-run` on every package.

## Repository layout

```
declaragent/
├── packages/            # 13 published packages
│   ├── core/            # @declaragent/core — runtime core
│   ├── cli/             # @declaragent/cli — interactive REPL + fleet verbs
│   ├── plugin-agent-rpc/
│   ├── testkit/
│   ├── source-{kafka,nats,mqtt,amqp,sqs}/
│   └── channel-{slack,telegram,discord,whatsapp}/
├── templates/           # init/fleet-add starter packs
│   └── fleet-starter/   # two-agent fleet reference
├── docs/                # SPEC_AND_PLAN.md + FLEET_PLAN.md + 8 bg design docs
├── docs-site/           # Docusaurus site published to declaragent.dev
├── .changeset/          # pending version bumps
├── .github/workflows/   # ci.yml, release.yml
├── tsconfig.base.json   # strict TS shared config
└── biome.json
```

## Open decisions (from SPEC_AND_PLAN.md § Part 7)

- **License** — Apache 2.0 is provisional; BSL also on the table.
- **Governance / commercial model / first design partners** — deferred.

## Gotchas

- Bun supports `.ts` imports natively, but TypeScript's `verbatimModuleSyntax` requires imports to use `.js` extensions (the emitted form). Don't "fix" these — they're correct.
- `@biomejs/biome` is pinned to an exact version (`1.9.4`) so formatter output is stable in CI.
- `packages/core/tsconfig.build.json` excludes `*.test.ts`; test files are typechecked but not published.

## The reference archive

`/Users/ssvk/Documents/GitHub/claude-code/` contains the leaked Claude Code source. Useful for:
- Understanding how the `Tool` contract, permission gate, and `QueryEngine` actually work in a production agent.
- Copying *patterns* (not code — licensing is unclear).

That repo's own `CLAUDE.md` warns it's read-only and has no `package.json`. Respect that.
