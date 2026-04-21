---
'@declaragent/cli': minor
---

`declaragent up` now brings channels online. It loads `~/.declaragent/channels.json`, discovers every `@declaragent/channel-*` adapter installed in `node_modules`, instantiates each configured channel into a shared `ChannelRegistry`, and wires the `SendMessage` tool into the engine so skills can post to Slack / Telegram / Discord / WhatsApp end-to-end without any manual plumbing.

**What works now**:
- `SendMessage({ kind: 'channel', channelId, conversationId, content })` delivers to the matching adapter via the registry.
- `SendMessage({ kind: 'agent', agent, payload })` enqueues on the mailbox backed by the shared sessions db.
- A missing `channels.json` → empty runtime; a missing adapter package → skipped with a clear banner; a broken adapter (throws on `create`) → skipped, healthy siblings still start.
- Per-agent lifecycle: channels are torn down on `declaragent up`'s shutdown alongside sources + MCP runtimes.

Changes: new `channels-runtime.ts` (+ test), `up-cli.ts` loads channels between sources and dispatcher attach, `buildRuntimeTools({ extra })` threads the `SendMessage` tool into the engine.

The optional `ChannelOutboundBridge` layer that auto-forwards `assistant.final` events to the bound conversation is NOT wired in this slice — skill-driven sends via the `SendMessage` tool are sufficient for the first-principles vision. Bridge wiring can land later once the streaming / typing-indicator story is ready.
