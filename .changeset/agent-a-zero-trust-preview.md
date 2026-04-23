---
'@declaragent/cli': patch
'@declaragent/core': patch
---

feat(rpc): 0.8.0 zero-trust preview mode — `DECLARAGENT_RPC_AUTH_DEFAULT=on` env var + `fleet audit-rpc --dry-run-with-flag` (#5b prep)

Operators can now rehearse the 0.8.0 RPC auth default flip against their fleets 2–4 weeks before the behavioural change ships. Nothing changes by default at 0.7.6.

- `@declaragent/core` exposes `isRpcAuthDefaultFlagOn()`, `resolveEffectiveRpcAuth()`, and a new `LoadedAgent.rpcAuthPosture: 'enabled' | 'disabled' | 'absent'` tri-state so call sites can distinguish explicit-opt-out from no-block.
- `@declaragent/cli` pre-boot gate in `up` + `fleet run`: when `DECLARAGENT_RPC_AUTH_DEFAULT=on`, agents with peers declared but no explicit `rpc.auth.enabled` value abort boot with `AUTH_REJECTED`. Agents with `rpc.auth.enabled: false` are honoured (Path B) with a boot-time warning.
- New `declaragent fleet audit-rpc --dry-run-with-flag` flag — non-mutating simulation of the 0.8.0 flip. Reports per-agent `would-fail`, `intentional-optout`, or `exempt (memory-only)` verdicts. Pairs with `--strict` for CI use.
- See `docs/ZERO_TRUST_DEFAULT_MIGRATION.md` §3a for the recommended rollout. The default flip still ships at 0.8.0.
