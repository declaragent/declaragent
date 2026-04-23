---
'@declaragent/core': minor
---

**Resolve `MessageContent` name collision at `@declaragent/core`'s export surface (backlog #41).**

`@declaragent/core` previously re-exported two unrelated types named `MessageContent`: the LLM content-block union from `types/messages.ts` (LLM engine) and the channels-envelope union from `channels/types.ts` (Slack/Telegram/Discord/WhatsApp adapters). Consumers had to disambiguate with module-path imports or alias through `LLMResponse['content'][number]` — the builder recording provider and replay harness both carried hand-written workarounds.

The channels-layer type is renamed to `ChannelMessageContent`. The top-level `MessageContent` name now unambiguously resolves to the LLM union. All internal references, renderer signatures (`renderSlack` / `renderTelegram` / `renderDiscord` / `renderWhatsApp`), `BaseChannelInstance.edit`, `SendMessageParams.content`, the `SendMessage` tool input, and the four first-party channel packages (`channel-slack`, `channel-telegram`, `channel-discord`, `channel-whatsapp`) have been updated. The `testkit` `MockChannelInstance` + load/contract fixtures follow.

Breaking for any external caller importing `MessageContent` from `@declaragent/core` and expecting the channels-envelope shape. Fix is mechanical — rename the import to `ChannelMessageContent`. The LLM-layer `MessageContent` is unchanged.
