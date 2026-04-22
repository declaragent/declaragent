---
'@declaragent/core': minor
'@declaragent/cli': minor
---

**Slice 6 of 0.6.0 production hardening — inbound channel routing.**

### Core (@declaragent/core)

New `createChannelInboundBridge({ bus, routesByChannel, logger? })` at `packages/core/src/channels/inbound-bridge.ts`. Adapter-agnostic: matches on `source.channelId` + `event.kind`, so Slack / Telegram / Discord / WhatsApp all work through the same wiring without adapter changes.

For every session-targeted channel event that matches a configured route, the bridge publishes an additional event with `target: { type: 'skill', name: route.skill }` and `meta.causedBy` linking back to the original. The original session-target event still flows through — bridged dispatch is **additive**, not a replacement. `target.type === 'skill'` events skip the bridge (re-entry guard).

### CLI (@declaragent/cli)

`channels-runtime.ts` (used by `declaragent up`) parses an optional `inbound.routes` block from each channel entry in `channels.json`:

```jsonc
{
  "channels": [
    {
      "id": "slack-main",
      "type": "slack",
      "config": { /* … */ },
      "inbound": {
        "routes": [
          { "event": "chat.mention", "skill": "triage" },
          { "event": "chat.dm",      "skill": "chat"    }
        ]
      }
    }
  ]
}
```

One bridge per up-process, shared across every configured channel. Detaches cleanly on shutdown. Malformed route entries log a warning and skip — one bad block doesn't prevent the rest of the config from loading.

### What unlocks

A Slack mention → skill invocation now works end-to-end with no plugins and no custom routing code:

1. User @mentions the bot in a Slack workspace.
2. Slack adapter emits `chat.mention` onto the bus with `target: session`.
3. The bridge matches the channel id + kind and publishes a skill-target copy.
4. The dispatcher routes to the configured skill, which replies via `SendMessage` (shipped in 0.5.x).

Same flow for Telegram, Discord, and WhatsApp — no adapter-specific deltas needed. The "PR 6.2" portion of the plan (Telegram/Discord/WhatsApp inbound) is subsumed by PR 6.1's adapter-agnostic design, shipped in a single changeset.

### Intentional scope cuts

- **Inbound auth / principal pass-through** — the bridged event copies the original's `auth` + `meta.principal`, so skill-level permission checks see the right channel user. No new work needed.
- **Fan-out across multiple channels** — not yet tested in production with 4+ active channels. The design supports it (single bridge instance, O(routes) per event), but real-world fan-out gets proven during Slice 7's fleet integration soak.

Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 6.
