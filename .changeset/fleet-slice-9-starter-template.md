---
'@declaragent/cli': patch
---

Fleet slice 9 — `templates/fleet-starter/` + verifier recursion.

First fleet template ships the full §9 reference: a two-agent fleet
pairing **concierge** (RPC producer, Haiku 4.5) with **pr-reviewer**
(RPC consumer, Sonnet 4.6). Completes FLEET_PLAN.md §16 acceptance
check #1 for the `fleet new` + `fleet add` bootstrap loop — the
`--template fleet-starter` path now produces a working fleet without a
single further edit.

**New under `templates/fleet-starter/`**

```
fleet.yaml               # 2 agents + shared env + rolling deploy + optional RPC knobs
package.json             # bun workspaces + fleet:* scripts + core/plugin-agent-rpc pins
rpc-peers.yaml           # fleet-level peer table (memory default, kafka commented)
.env.example             # ANTHROPIC_API_KEY + KAFKA_BROKERS (opt)
.gitignore
README.md                # dev + cross-process + deploy + cost sections
agents/concierge/        # agent.yaml + event-sources.yaml + skills/delegate.md
agents/pr-reviewer/      # agent.yaml + capabilities.yaml + event-sources.yaml + skills/review-pr.md
```

**`scripts/verify-templates.ts` extension**

- Detects a fleet template by presence of a top-level `fleet.yaml`.
- Parses the manifest, walks every `agents[].path` as a nested
  single-agent template (`verifyAgentDirectory(nestedInFleet: true)`).
- Threads the fleet-root `.env.example` keys through so fleet members
  don't need their own `.env.example` / `README.md`.
- Enforces the §14.4 invariant (`fleet.yaml → agents[].id ==
  agent.yaml.name`) as a verification failure, not a runtime surprise.

`bun run scripts/verify-templates.ts` now verifies 8 templates (was 7).

**Tests.** 3 integration tests in `fleet-starter-template.test.ts`:
shape assertions, `loadFleet` + `aggregateCapabilities` round-trip
against a tmpdir copy of the template, and a full `startFleetDaemon`
RPC round-trip (concierge → pr-reviewer → response).

**Next.** Slice 10 — docs-site `docs/reference/fleet.mdx` +
`cookbook/fleet.mdx`.
