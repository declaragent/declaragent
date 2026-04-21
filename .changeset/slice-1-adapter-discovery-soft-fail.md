---
'@declaragent/core': minor
---

Add `onPackageError` option to `discoverAdapters`. When supplied, per-package load failures (bad import, agent_compat mismatch, malformed export) invoke the callback instead of aborting discovery, letting callers keep booting with the healthy adapters. Duplicate-type claims across packages still throw — those are correctness issues, not package-health issues. Omitting the hook preserves the strict throw-on-first-error behavior.
