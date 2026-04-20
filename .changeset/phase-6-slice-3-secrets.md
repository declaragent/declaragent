---
'@declaragent/core': minor
---

Phase 6 slice 3: secret providers + rotation audit.

- **SecretProvider contract** (`packages/core/src/secrets/types.ts`) — typed
  `resolve()` / `metadata()` / `close()` with `SecretResolveContext`
  (tenant + requester) and a `SecretAccessAuditRecord` that never
  carries the secret value.
- **Four fetch-based providers**, no peer deps:
  - **Vault** — token + AppRole auth, KV v1/v2 support, `#field` fragment
    selector, lease-aware TTL cache.
  - **AWS Secrets Manager** — inline SigV4 signing (Web Crypto HMAC),
    env-based credential chain, JSON `#field` extraction.
  - **GCP Secret Manager** — bearer-token flow with metadata-server
    fallback, version pinning via `/versions/N`.
  - **Kubernetes Secrets** — in-cluster SA token, base64-decoded fields,
    cached per Secret so multi-field reads are one HTTP call.
  - Plus an env-backed provider for local dev.
- **Resolver integration** — `createDefaultSecretResolver` grows a
  `providers: SecretProvider[]` option; typed refs (`vault:`, `aws-sm:`,
  `gcp-sm:`, `k8s:`) route to the matching provider; `secret:` falls
  back to `defaultProviderType`. Every resolve emits a
  `secret_access` audit record (outcome: `resolved` / `denied` /
  `error`) with the ref + requester but NEVER the value.
- **`secrets.yaml` config loader** with Zod validation, `${env:...}`
  expansion, and a rotation-monitor knob block.
- **Rotation monitor** — periodic `metadata()` poll flags secrets past
  `warnAfterDays` / `errorAfterDays`. Never resolves values.
- **Property test** — 500 random secrets across the resolve + denied
  paths, asserting no value appears in audit records or log lines.
