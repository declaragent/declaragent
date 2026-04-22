---
'@declaragent/core': minor
'@declaragent/cli': minor
---

**Slice 4 of 0.6.0 production hardening — default provider rate limits.**

### Core (@declaragent/core)

New `withProviderRateLimit(provider, options)` wrapper at `packages/core/src/providers/rate-limit.ts`. Applies a token-bucket limiter before every `complete()` call (and the first chunk of a streaming call). When the bucket is empty, the call awaits the refill — no events dropped, no synthetic 429s thrown. `ProviderTokenBucket` + `defaultRateForProvider(providerId)` helpers exported alongside for users composing their own stacks.

Published steady-state defaults:

| Provider | Rate (requests/sec) | Source |
| --- | --- | --- |
| Anthropic | 50 | Tier-4 Opus published rate |
| OpenRouter | 20 | Conservative cap below their proxy throttles |
| Unknown | 10 | Fallback — safe for a fresh key |

The wrapper fires an `onWait(ms)` hook when a call queues for a token. The hook must not throw; if it does, the wrapper swallows the error and still serves the call. Calling `take()` on a healthy bucket returns synchronously with `waitedMs === 0` so the happy path carries zero overhead beyond a map-lookup.

### CLI (@declaragent/cli)

`declaragent up` now wraps the per-process `LLMProvider` with the new limiter using `defaultRateForProvider(creds.providerId)`. Every wait bumps:

- `declaragent_provider_rate_limit_waits_total{provider}` (counter)
- `declaragent_provider_rate_limit_wait_ms{provider}` (histogram)

Scrapable through the `/metrics` endpoint from Slice 1. The startup banner prints the active rate + the env-var escape hatches so operators see the limit immediately.

**Migration note:** existing loud-dev workloads that hammer the provider will now queue instead of burning tokens against the ratelimiter server-side. Two escape hatches:

```bash
# Opt out entirely (load tests, backfills)
export DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE=1

# Override the rate (floating-point rps)
export DECLARAGENT_PROVIDER_RATE_LIMIT_RPS=200
```

### Intentional deferrals

- **`agent.yaml#reliability.rateLimits` schema** — consistent with Slices 2 + 3, the schema extension is a follow-up once operators ask. Env vars are the MVP surface.
- **Streaming rate-limit + per-model granularity** — streams go through the same limiter (first-chunk gated), but finer-grained limits (e.g. `claude-opus-4-7` faster than `haiku`) are a future feature once we have real operator data on which models get throttled.

Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 4.
