---
'@declaragent/cli': minor
---

Complete the builder-tool matrix (Phase B of USABILITY_PLAN.md). Four new authoring tools ship in this release — `DeclaraAddSource` (per-agent `event-sources.yaml` with round-trip adapter validation for webhook/cron/file-watch), `DeclaraAddChannel` (user-global `channels.json`), `DeclaraAddMCP` (user-global `mcp-servers.json`), `DeclaraAddPlugin` (user-global `plugins.json` with consent captured via the proposal flow). Every scaffolded capability — skill, source, channel, MCP, plugin, secret, peer — is now reachable through conversational authoring; `DeclaraApplyChange` no longer returns "step kind not supported" for these four kinds.
