---
'@declaragent/cli': minor
---

`declaragent up` now spawns configured MCP servers at boot and exposes their tools to the agent (`mcp__<server>__<tool>`). Three-scope config with Claude-Code-style precedence: local (`<agentDir>/.declaragent/mcp.local.json`) > project (`<agentDir>/.mcp.json`, git-tracked for teams) > user (`~/.declaragent/mcp-servers.json`).

First-run servers prompt for consent interactively; detached / CI boots skip un-consented servers with a warning instead of blocking. `mcp add` now auto-records consent for the server it installs and accepts `--scope user|project|local`. New `mcp approve <name>` / `mcp revoke <name>` verbs let operators pre-consent before a detached launch.

Stdio transport only in this slice — HTTP/SSE/streamable lands in 2b/2c. Per-server handshake is timeboxed (10s default); a slow or broken server is soft-failed so it doesn't block the rest of the agent from booting.
