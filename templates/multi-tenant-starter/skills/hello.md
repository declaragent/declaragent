---
name: hello
description: Reply with a scoped greeting that includes the active tenant's display name.
inputs:
  tenantId:
    type: string
    description: The tenant id from `meta.tenantId`. Required — refuse if missing.
    required: true
  text:
    type: string
    description: Inbound message text.
    required: true
outputs:
  reply:
    type: string
    description: A short greeting scoped to the active tenant.
---

# Hello skill

You received a message on tenant `{{tenantId}}`:

> {{text}}

Reply with a one-sentence greeting that includes the tenant's display
name (look it up from the tenant context — do NOT hardcode). Example
replies:

- `acme-prod` → `"Hi from the ACME Production workspace — how can I help?"`
- `beta-tenant` → `"Hi from the Beta Customer workspace — how can I help?"`

Hard rules:

- NEVER mention another tenant in the reply.
- NEVER dump the full tenant config — only the display name is OK to
  echo back.
- If `tenantId` is absent, refuse. Emit an audit record with kind
  `tenant.missing` and reply with `"unauthorized"`.
