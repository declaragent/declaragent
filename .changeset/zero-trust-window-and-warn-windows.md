---
"@declaragent/cli": patch
"@declaragent/testkit": patch
---

0.8.0 strict-mode window wired + the two remaining warn-windows (RELEASE_0_8_0_PLAN.md §3/§4):

- **Soak/nightly fleets now run the zero-trust posture**: the multi-process harness scaffold stamps `rpc.auth.enabled: true` on every agent and an hmac `auth:` block on every peer (including the test driver, secret via `env:DECLARAGENT_SOAK_HMAC_SECRET`). The soak driver signs every request, the workers verify fail-closed with the production `buildAuthVerifyRegistry` and sign every response with `buildOutboundSigner`, and the soak asserts zero unsigned replies — the 24h run measures the signed path the 0.8.0 flip makes default.
- **Always-on drift guard** (`zero-trust-window.test.ts`): scaffolds the harness fleet and runs the real `fleet audit-rpc --strict --json --dry-run-with-flag` CLI against it on every test run — stripping auth from the harness fails CI immediately.
- **Nightly + weekly workflows** run with `DECLARAGENT_RPC_AUTH_DEFAULT=on` (the 0.8.0 preview), starting the ≥14-green-night window.
- **Flip-2 warn-window** (`up`): when `controlPlane.auth` is enabled but `allowLoopback` is unset, boot now warns that the default (true) flips to false at 0.8.0.
- **Flip-3 warn-window** (`up`): unknown top-level `agent.yaml` keys (the `rcp:` typo class) are now warned at boot, naming the 0.8.0 strict-schema failure and pointing at `agent validate`.
- **Release flow**: `version-packages` re-formats with Biome after `changeset version`, so Version Packages PRs stop landing npm-formatted package.jsons that red the (now branch-protection-required) lint check.
