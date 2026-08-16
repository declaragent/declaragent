# @declaragent/channel-discord

## 5.0.0

### Patch Changes

- Updated dependencies [0a15577]
- Updated dependencies [e67edc4]
  - @declaragent/core@0.6.0

## 4.0.0

### Patch Changes

- Updated dependencies [1bc842d]
- Updated dependencies [b69d717]
- Updated dependencies [2e60de4]
  - @declaragent/core@0.5.0

## 3.0.0

### Patch Changes

- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
  - @declaragent/core@0.4.0

## 2.0.1

### Patch Changes

- Fix external adapter discovery regression introduced in 0.5.0. All nine shipped source + channel packages default-exported the **factory function** (`createKafkaAdapter`, `createSlackAdapter`, etc.) rather than the adapter instance, so slice 1's discovery (which did `mod.default ?? mod`) rejected them with "did not export an EventSourceAdapter" at runtime.

  **Two-sided fix**:

  - **Core** (`adapter-discovery.ts`, `channels/adapter-discovery.ts`) now resolves the export permissively: if `mod.default` is already an adapter, use it; if it's a zero-arg factory, invoke it; otherwise walk named exports looking for an adapter-shaped value, preferring one whose `.type` matches the manifest's declared type. Covers every package shape we've seen in the wild.
  - **9 adapter packages** now default-export the adapter instance (`kafkaAdapter as default`, `slackAdapter as default`, …) — semantically correct and matches what slice 1's inline fixtures always did. The factory stays as a named export for callers who need to override options.

  Regression tests: `adapter-discovery.test.ts` + `channels/adapter-discovery.test.ts` each gain a factory-default-export case that would have caught the bug pre-ship.

- Updated dependencies
  - @declaragent/core@0.3.1

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
