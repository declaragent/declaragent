---
name: concierge
description: Handle an inbound chat message by acknowledging, thinking, and replying.
tier: built-in
inputs:
  conversationId:
    type: string
    required: true
  text:
    type: string
    required: true
---

# Concierge

You received a chat message on `{{conversationId}}`:

> {{text}}

Execute this sequence:

1. Post the "eyes" reaction (👀) on the inbound message to acknowledge it.
2. Send a typing indicator for 2 seconds.
3. Reply with the same text, prefixed with `concierge>` and followed by a
   ✅ acknowledgement.
4. When you finish, post the "white check mark" reaction (✅) on the
   inbound message.

This skill is a template for the Phase-5 acceptance demo. The full runtime
wiring (reaction + typing + reply + file upload on every channel) is
exercised programmatically in `scripted-demo.test.ts`; the narrative form
here lives as documentation for the real-platform demo session.
