---
'@declaragent/core': patch
'@declaragent/cli': patch
---

fix(security): clear OSV advisories blocking the release gate

Bump four dependencies flagged by `osv-scanner` to their fixed versions:

- `@anthropic-ai/sdk` 0.89.0 → 0.91.1 (GHSA-p7fg-763f-g4gf, core direct dep).
- `fast-xml-builder` 1.1.4 → 1.2.0 (GHSA-5wm8-gmm8-39j9, CVSS 8.7 — transitive via `fast-xml-parser`/aws-sdk).
- `ip-address` 10.1.0 → 10.2.0 (GHSA-v2v4-37r5-5v8g — transitive via `socks`).
- `ws` 8.20.0 → 8.21.0 (GHSA-58qx-3vcg-4xpx — transitive via `ink`/`mqtt`).

The three transitive bumps are pinned via a root `overrides` block. No
public API changes.
