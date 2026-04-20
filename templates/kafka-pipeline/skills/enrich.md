---
name: enrich
description: Enrich an `order.created` record with a summary + risk tier, then re-emit to `orders.enriched`.
inputs:
  id:
    type: string
    description: Order id. Stable across retries — used as the idempotency key.
    required: true
  total:
    type: number
    description: Order total in USD.
    required: true
  items:
    type: array
    description: Line items. Each has `sku`, `name`, `quantity`.
    required: true
  shipTo:
    type: object
    description: Shipping address. Includes `country`, `city`, `region`.
    required: true
outputs:
  summary:
    type: string
    description: One-sentence human-friendly summary.
  riskTier:
    type: string
    description: One of `low`, `medium`, `high`.
---

# Enrich skill

You received a single order record:

```
id: {{id}}
total: ${{total}}
items: {{items}}
shipTo: {{shipTo}}
```

Do this:

1. **Summary** — compose one sentence like `3 × Blue Widget shipped to
   Austin, TX`. Enumerate items by `quantity × name`. Append the city
   + region, not the full address.

2. **Risk tier**:
   - `low` if total < $100 and `shipTo.country === "US"`.
   - `high` if total ≥ $2000 or `shipTo.country` is in a non-US sanctions-
     adjacent list (accept whatever Anthropic's guardrails already block).
   - `medium` otherwise.

3. **Emit** via `SendMessage` to the `orders.enriched` topic with the
   original record plus `{ summary, riskTier }` merged in.

Failure modes:

- Missing `id` or `total`: throw. The message will hit the DLQ and ops
  will see it.
- `total` is negative or zero: classify `riskTier: high` and set
  `summary` to `"Anomalous order — review required."`.
