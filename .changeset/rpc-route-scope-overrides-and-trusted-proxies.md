---
'@declaragent/core': patch
'@declaragent/cli': patch
---

**Security sprint 2 follow-ups from `POST_ENTERPRISE_BACKLOG.md` — items #6 + #7.**

- **#6 — Per-route scope overrides on the control-plane HTTP surface.** `controlPlane.auth` now accepts a `routeScopes: Record<path, string[]>` map so operators can gate `/audit` on `read:audit`, `/events` on `read:events`, etc., without weakening the global scope floor. Enforcement lives inside `applyControlPlaneAuth` and fires AFTER the verifier's own scope check, returning `reason: 'insufficient-scope'` with a detail string naming the mismatched route. Routes not listed in the map fall back to the verifier's scopes (no breaking change). New `ControlPlaneAuthContext` carries the matched route path from the server down to the middleware. One test per enforced route lives in `packages/core/src/observability/control-plane-auth.test.ts`.

- **#7 — `allowLoopback` reverse-proxy semantics.** `controlPlane.auth.allowLoopback` now accepts `boolean | { trustedProxies: string[] }`. Scalar `true` (the default) preserves today's Host-header-based bypass — no breaking change. The object form flips on proxy-aware evaluation: the middleware inspects the immediate TCP peer (via Bun's `server.requestIP(req)`) and only promotes the leftmost `X-Forwarded-For` hop to "real client" when the peer is explicitly trusted. An untrusted peer presenting XFF headers is rejected with a new typed reason `untrusted-proxy` (401) before the verifier runs — this closes the "behind nginx every request looks like 127.0.0.1" bypass vulnerability. IPv4-mapped IPv6 peers (`::ffff:10.0.0.5`) are normalised against the trusted list so operators don't need both forms.

CLI wiring: the startup banner prints `allowLoopback: trustedProxies=[10.0.0.5,…]` when the object form is used, and appends `, routeScopes: /audit,/events,…` when per-route overrides are configured. `buildControlPlaneAuth` in `packages/cli/src/control-plane-auth-factory.ts` propagates both fields.

No breaking changes — both knobs are opt-in additions on top of the existing `controlPlane.auth` block.
