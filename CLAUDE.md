# CLAUDE.md

Project memory for Declaragent. Read this first when starting work here.

- **Name:** Declaragent (official).
- **Domain:** [declaragent.dev](https://declaragent.dev)
- **npm scope:** [`@declaragent/*`](https://www.npmjs.com/org/declaragent) — 13 packages published at `0.1.0` (2026-04-20).
- **GitHub org:** `declaragent`.

## What this project is

Declaragent is a declarative, git-versioned AI agent platform. An agent = immutable runtime **core** + git-versioned declarative **configuration** (`agent.yaml`: identity, tools, skills, plugins, event sources, channels, permissions, secrets, deployment).

The reference implementation archive — the leaked Claude Code source — lives at `/Users/ssvk/Documents/GitHub/claude-code/` and is read-only. Treat it as a study/reference codebase, not a dependency.

## Canonical plan

`docs/SPEC_AND_PLAN.md` is the source of truth for requirements and phased implementation. It supersedes the 8 background design docs (also in `docs/`), which are kept for historical context only.

When the plan and a background doc disagree, `SPEC_AND_PLAN.md` wins.

## Current status

**v0.1.0 shipped on npm (2026-04-20).** Full runtime across 13 packages:
`@declaragent/core`, `@declaragent/cli`, `@declaragent/plugin-agent-rpc`,
`@declaragent/testkit`, five source adapters (kafka/nats/mqtt/amqp/sqs),
and four channel adapters (slack/telegram/discord/whatsapp).

Features delivered through 0.1.0:
- Phases 1–7: engine loop, built-in tools, permission gate, REPL,
  session persistence, sub-agents, slash commands, event sources +
  dispatcher + DLQ, multi-tenant + audit + secrets + Prometheus, install
  wizard, template packs, Cloud Run deploy.
- v1.1: Agent RPC (producer tool, consumer source, memory transport,
  envelope + pending registry).
- v1.2: Fleet — slices 0–10. `fleet.yaml` manifest, scaffolder,
  single-process dev loop, promote/demote, deploy with rolling +
  all-or-nothing + version-skew, graph + peers + status verbs, fleet-
  starter template, docs-site reference + cookbook.

**Next: v1.2 slice 11** — soak + RC. Nightly three-agent fleet running
over in-memory RPC for 24h, deploy soak against a throwaway GCP
project, `v1.2.0-rc.1` → `v1.2.0` promotion.

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
