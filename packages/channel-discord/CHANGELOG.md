# @declaragent/channel-discord

## 2.0.0

### Patch Changes

- Updated dependencies [da8f330]
- Updated dependencies [579362c]
- Updated dependencies [778f505]
- Updated dependencies [a4ba7a4]
- Updated dependencies [9a6c64f]
  - @declaragent/core@0.3.0

## 1.0.0

### Minor Changes

- 4309000: Phase 6 slice 4: HMAC + webhook + dep-scan security hardening.

  - **Discord Ed25519 verification**. Replaces the stub-warn in
    `channel-discord` with real `crypto.subtle.verify('Ed25519', ...)`
    over `timestamp + body`. A new `transport.publicKey` config field
    carries the application's hex-encoded Ed25519 public key. Unsigned or
    tampered webhooks return a sanitized 401 `unauthorized`. Webhook mode
    REFUSES to process any request when `publicKey` isn't configured.
  - **Webhook endpoint hardening** (`createWebhookAdapter`):
    - `maxBodyBytes` cap enforced BEFORE auth (1 MiB default), returning
      413 both on pre-read Content-Length and post-read byte length.
    - HMAC auth grows `timestampHeader` + `replayWindowSec` (5-minute
      default) — requests outside the window are rejected even with a
      valid signature.
    - Sanitized 400/401 bodies — parse details land in the audit log, not
      the response.
  - **HMAC audit + property tests**. Line-by-line walk of every
    signature-comparison site in core + channel adapters confirms
    `timingSafeEqual` is the sole primitive. ~1500 assertions across
    `packages/core/src/events/sources/hmac-properties.test.ts` cover
    length mismatches, prefix / suffix attacks, symmetry, and avalanche.
    A static anti-pattern guard fails CI if any file regresses to
    `===` / `startsWith` HMAC comparisons.
  - **CI dep scanning**. New workflows:
    - `.github/workflows/deps-scan.yml` — `osv-scanner` against `bun.lock`
      on every PR + nightly. `.osv-ignore.yml` entries must carry
      `expires` + `reason`; CI rejects expired entries or missing fields.
    - `.github/workflows/npm-audit.yml` — `bun pm audit --audit-level=high`
      for double-coverage.

### Patch Changes

- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
  - @declaragent/core@0.2.0
