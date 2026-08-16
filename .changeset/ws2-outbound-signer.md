---
"@declaragent/plugin-agent-rpc": minor
"@declaragent/cli": patch
---

WS2 — outbound envelope signing wired into the fleet runtime (RELEASE_0_8_0_PLAN.md §B1, the hard blocker for the 0.8.0 zero-trust flip):

- **`buildOutboundSigner`** (plugin-agent-rpc): sign-side counterpart of `buildAuthVerifyRegistry`. Builds one provider per peer with an `auth:` block and returns a `signOutbound`-compatible hook that dispatches on the envelope's destination — outbound to peer B is signed with the credentials shared with B (HMAC: the pair's secret + keyId). Destinations without an `auth:` block keep the legacy `internal` stamp, so mixed fleets sign exactly where a verifier expects a signature.
- **Response-leg signing**: `createRespondHook` accepts `signOutbound`, replacing the hard-coded `auth:{kind:'internal'}` on replies.
- **`fleet run` wires both legs**: signers are built at boot from the fleet-root and per-agent `rpc-peers.yaml` (same per-agent-wins selection as the verify registries) and threaded into every `RequestAgent` tool (request leg) and every worker's respond hook (response leg). A signer that cannot be built under `rpc.auth` (e.g. unresolvable `secretRef`) **aborts boot** with an actionable error instead of shipping a fleet whose delegations would all be rejected.
- **`fleet audit-rpc` sign-side findings**: peers without an `auth:` block are reported (`no-auth-block`, fails `--strict` — at 0.8.0 outbound to them breaks) and `provider: oidc` peers are flagged as verify-only for the built-in signer.

With this, the WS2 flagship scenario passes: strict verify ON + HMAC configured on both sides → built-in delegation succeeds end-to-end with both legs signed (previously rejected `wrong-kind`).
