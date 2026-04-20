# Threat model — Declaragent v1.0

**Status:** Phase 6 slice 8 — first complete pass. External security
review pending ([PEN_TEST_SIGNOFF.md](./PEN_TEST_SIGNOFF.md)).

**Scope.** The runtime as shipped at the close of Phase 6: core engine,
event sources, channel adapters, built-in tools, MCP client, secret
resolver, audit sink, and the daemon / control plane. Out of scope:
per-tenant provisioning UI, billing, SSO (deferred to Phase-7+).

**Methodology.** STRIDE (Spoofing / Tampering / Repudiation /
Information disclosure / Denial of service / Elevation of privilege)
per component. Every threat lists its primary mitigations + the
residual risk that an external review will challenge.

---

## 1. Core engine + permission gate

Runtime loop that drives the LLM provider, dispatches tool calls, and
enforces the permission gate.

| Threat | STRIDE | Mitigation | Residual |
| ------ | ------ | ---------- | -------- |
| A plugin contributes a tool whose `permissionKey` mis-matches its actual action | T / E | Permission key is the sole gate input; the gate evaluates it against the user's globs before `execute()` runs. Permission-key authorship is part of the plugin review contract. | Plugin authors still own the mapping; a malicious plugin is an untrusted source. Mitigated via plugin-source restrictions (plugin consent flow). |
| Sub-agent escapes the depth cap | E | `DEFAULT_SUBAGENT_DEPTH_CAP=2` with engine-level guard that throws on exceed. Ports of Phase-1 tests cover the break case. | Callers that override the cap take responsibility for its safety. |
| Session-id spoofing from a tool / plugin | S / E | Sessions are opaque handles threaded through `ToolContext`; plugins cannot construct their own. `createChildSession` is the only factory. | Phase-6 note: session IDs become `(tenantId, id)` tuples in the follow-up; spoofing narrows further. |
| A malicious LLM response drives unintended tool calls | T / E | Every tool call still routes through the permission gate + the user's globs. The LLM has no privileged path. | Prompt-injection attacks remain a user-content problem; Phase-7 adds LLM-level prompt-injection detection. |

## 2. Event bus + sources

| Threat | STRIDE | Mitigation | Residual |
| ------ | ------ | ---------- | -------- |
| Webhook replay attack | T | Phase 6 slice 4: HMAC refs carry an optional `timestampHeader` + `replayWindowSec` (5-min default). Replays past the window are rejected with a sanitized 401. | Only HMAC refs that opt in enforce replays; bearer refs + unauthenticated webhooks don't. Documented in §5.6 of the plan. |
| HMAC bypass / prefix attack | I / E | Every compare uses `timingSafeEqual`; static anti-pattern guard (`hmac-properties.test.ts`) fails CI on `===` / `!==` / `startsWith`. Property tests cover length-mismatch + prefix / suffix attacks. | Third-party dependencies (kafkajs, etc.) handle their own auth; covered by their upstream audit. |
| Broker spoofing | S | Broker adapters authenticate via the broker's own TLS + credential flow (Kafka SASL, AMQP TLS, etc.). Credentials resolve through the secret resolver. | Broker-side security depends on operator deployment; documented in each adapter's README. |
| Schema-injection (malformed avro / protobuf crashes the normalizer) | D / T | Schema-registry decoder wraps parse calls in try/catch; failures land in DLQ. Phase-4 slice-6 tests cover malformed-byte cases. | Adversarial payloads that parse but drive semantically wrong dispatch remain possible — hook points fire `filter` predicates but trust adapter-declared schemas. |
| Webhook body-size DoS | D | Phase 6 slice 4: `maxBodyBytes` cap (1 MiB default) enforced pre- + post-read. 413 returned before auth check. | Caller-configurable; operators running public-internet webhooks should size conservatively. |

## 3. Channel adapters

| Threat | STRIDE | Mitigation | Residual |
| ------ | ------ | ---------- | -------- |
| Bot token theft via `event.payload` | I | Tokens resolve via the secret resolver + never land in `AgentEvent` payloads. Adapter startup logs redact tokens. | Stack traces caught in hook callbacks may still include transport errors — the hook registry scrubs but only best-effort. |
| Slack request-signature bypass | S / T | `timingSafeEqual` against `v0=<hex>`; 5-min replay window enforced. Property tests cover length + prefix attacks. | Slack key rotation requires operator action; secret rotation monitor warns past 90 days. |
| WhatsApp `X-Hub-Signature-256` forgery | S / T | Same `timingSafeEqual` path; verify-token handshake uses constant-time compare. | Meta-side key rotation same as above. |
| Discord Ed25519 forgery | S / T | Phase 6 slice 4 replaces the stub warn with real `crypto.subtle.verify('Ed25519')`. Webhook mode refuses to process if `transport.publicKey` is not configured. | Older configs without `publicKey` pre-Phase-6 log an error on startup + return 401 on every webhook — safe-by-default. |
| Template abuse (WhatsApp) | T | Template send path uses the approved-template registry; outbound audit logs every template hit + reject. Tier-health alert fires on sustained rejections. | Operator still owns template approval hygiene. |
| Privileged-intent escalation (Discord) | E | `DiscordTransportConfig.privileged` must be explicitly set + intents listed; the validator rejects privileged intents without opt-in. | Relies on operator honoring Discord Developer Portal approval. |

## 4. Built-in tools

| Threat | STRIDE | Mitigation | Residual |
| ------ | ------ | ---------- | -------- |
| Bash escape via shell-meta in tool input | E | Bash tool uses `spawn` with argv array; no `bash -c`. Every invocation routes through the permission gate's path globs. | Bash still has unfettered filesystem access when allowed; deny-lists live in `agent.yaml` permission rules. |
| File-system traversal via `Read` / `Write` / `Edit` | I / T | Path globs enforced at the permission gate + resolved via `realpath` to normalize `../` traversals. | Paths that resolve outside the user's `cwd` are accepted when globs permit; operator owns the glob scope. |
| Subprocess inherits secrets via env | I | Tools that spawn subprocesses inherit `process.env` minus entries named by the permission-gate's `secretEnvDenyList`. | Operator owns the deny list; Phase-7 will ship a default deny list for common secret env names. |
| MCP-wrapped tool returns a poisoned schema | T | MCP client validates tool schemas against the MCP protocol spec; unknown schemas reject at registration. | A malicious MCP server can still lie about schema validation passing; operator review of MCP server sources is the mitigation. |

## 5. MCP client

| Threat | STRIDE | Mitigation | Residual |
| ------ | ------ | ---------- | -------- |
| Stdio-server command injection via config | E | MCP server config passes `argv` as an array; no shell interpolation. | Operator-provided argv still runs with full process privileges. |
| Long-running server resource drain | D | Concurrency limiter + subprocess lifecycle hooks cap running servers. Kill-on-shutdown is guaranteed via `SIGTERM` on adapter close. | A hung server may ignore SIGTERM; adapter falls back to SIGKILL after a 5-second grace. |
| Server spoofing | S | stdio transport uses the configured binary path; tests assert `spawn`'s resolved path matches the config. No network-transport default. | HTTP-transport MCP servers must be authenticated via the user's chosen scheme; covered by the bearer/HMAC refs. |

## 6. Secret resolver

| Threat | STRIDE | Mitigation | Residual |
| ------ | ------ | ---------- | -------- |
| Ref-substitution injection (user input becomes a `secret:` ref) | I / E | Ref expansion only runs on config files (`agent.yaml`, `channels.yaml`, etc.), never on runtime payloads. | User-supplied strings that include `${...}` markers are NOT expanded; documented in Phase-4 §5. |
| Secret value leaks via log line | I | Phase 6 slice 3: `secret_access` audit records carry ref + requester only — never the value. Property test (`no-secret-in-logs.test.ts`) runs 500 random values through the resolver + asserts zero leaks. | Third-party log sinks configured by operators are outside the test's scope. |
| Cross-tenant secret access | E | Phase 6 slice 6: tenant-scoped `SecretProvider` wrappers + audit `secret_access` records surface the attempt. Boundary violations throw `TenantBoundaryError`. | Enforcement depends on provider's own path-scoping (e.g., Vault policies); defence-in-depth. |
| Rotation-window divergence | I | Rotation monitor polls provider metadata on a configurable interval (default 1h). Overdue alert fires past `warnAfterDays` / `errorAfterDays`. | The monitor reads metadata only; secret values themselves are NOT fetched during the poll. |

## 7. Daemon + control plane

| Threat | STRIDE | Mitigation | Residual |
| ------ | ------ | ---------- | -------- |
| Control-socket auth bypass | E | Unix domain socket with filesystem-level permissions (0600). Remote control requires explicit TCP bind + bearer auth. | Operator can turn off socket permissions; defence-in-depth via the `allowRemote` flag on the Prometheus exporter. |
| Config-reload race | T / D | Hot-reload uses atomic swap: new runtime assembles in a worktree, then atomic pointer swap replaces the live tree. In-flight requests drain against the old runtime. | macOS/Linux only; Windows reload is documented as a hard restart. |
| Prometheus `/metrics` scrape from untrusted network | I | Phase 6 slice 2: default bind is `127.0.0.1:9464`; non-localhost Host headers are rejected with 403 unless `allowRemote: true`. | Operators who flip `allowRemote` own the auth path (typically a sidecar proxy). |
| Boot-time secret leak via heap dump | I | Secrets resolve lazily on first access + cache with a TTL. `close()` on the resolver clears cache on graceful shutdown. | A core dump during a live request can still include cached values; filesystem permissions on the dump path are the mitigation. |
| Tenant-boundary violation at the bus layer | E | Phase 6 slice 6: `EventBus` with `tenantScope` throws on cross-tenant publish. Audit sink records the attempt as a `tenant_boundary_violation`. | Operator-run `shared-with-filter` bus mode carries a "read the documentation twice" footgun. |

## 8. Audit sink (Phase 6 slice 5)

| Threat | STRIDE | Mitigation | Residual |
| ------ | ------ | ---------- | -------- |
| Tampered audit rows | T | SHA-256 hash chain per tenant; `verifyEntries` walks the chain and surfaces `hash-mismatch` / `prev-hash-mismatch` at the offending seq. | Sqlite file is as tamper-evident as the filesystem allows; operators hosting the DB on untrusted storage should enable disk-level encryption. |
| PII exposure via forever-retained records | I | Per-tenant retention + right-to-erasure tombstones preserve chain continuity while scrubbing serialized content. | The `record_hash` itself is kept; external auditors see continuity without content. |

## External review

See [PEN_TEST_SIGNOFF.md](./PEN_TEST_SIGNOFF.md) for the third-party
review and its outcome. Any CRITICAL findings block Phase 6 signoff;
HIGH findings are remediated before Phase 7 kickoff.
