---
"@declaragent/core": patch
---

Skills loader now loads `.md` files exposed as **symlinks** — Kubernetes ConfigMap volumes present every file as a symlink into the `..data` snapshot dir, so `isFile()`-only walking silently dropped every ConfigMap-mounted skill (agents booted skill-less and webhook events rejected with `no-handler`). Found live in a minikube fleet sandbox; regression-tested against the exact ConfigMap volume layout. Also fixes the `oncall-escalator` template's triage skill, which referenced `{{alerts}}` — the events dispatcher provides `{{__event}}` (plus static `target.inputs`), so the shipped skill could never render.
