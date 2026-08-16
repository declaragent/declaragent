# Docs Truth Plan — closing the docs↔code delta

**Status:** Waves 0–2 (findings) complete 2026-08-16 — **all 214 audited findings resolved** (one refuted on re-check: concierge does ship `.env.example`). Wave 1 extras done: fix-code dozen closed (OTel + broker optional peerDependencies declared; `fleet run` provider wrapped by the shared rate limiter; MCP SIGTERM→SIGKILL kill-on-close with tests; `DECLARAGENT_CONFIG_DIR` honored), superseded banners on the 10 historical design docs, 8 runbooks corrected, testkit dashboards/alerts renamed to real metric names (phantom-metric rules annotated → backlog #65). Deferred capabilities: POST_ENTERPRISE_BACKLOG #53–#65. **Wave 2 uncovered surfaces also complete (2026-08-16):** changeset internal contradictions reconciled; READMEs written for all 11 README-less published packages (+ honest `@declaragent/cli` description); sidebar orphans (`capabilities`, `control-plane`) linked and `onBrokenLinks`/`onBrokenMarkdownLinks` flipped to `throw` (build green); deploy-generated README now includes the binary/config staging steps + the 8787 port note; all 10 template `agent.yaml`s pass `agent validate`, marketing `.env.example` completed; one dead repo link removed; **all 35 placeholder `todo-block`s cleared — the 23 runbook stub pages now mirror the corrected canonical runbooks**. **Wave 3 complete (2026-08-16): the drift mechanisms are live.** Four linters run in CI (`bun run lint:docs`, wired into `ci.yml` + the pre-push hook): **docs-command-lint** (every `declaragent` invocation in docs code fences validated against the CLI surface derived from `index.tsx` — on first run it caught 60 phantom commands across 15 runbooks the audit's spot-checks had missed, all since fixed), **env-vars-lint** (`scripts/env-vars.registry.json` — source reads ⊆ registry, docs mentions ⊆ registry, documented entries ⊆ env-vars.mdx; caught + documented `DECLARAGENT_USE_BINARY`), **metrics-lint** (`scripts/metrics.manifest.json` regenerated from source registrations via `--write`; dashboards/alerts/docs validated, 8 pending metrics tracked as #65), and **docs-policy-lint** (single-scoreboard rule + no-placeholder gate). Mechanisms 5/6/8 (version tokens, defaults-matrix test, reference-resolver) are ticketed as POST_ENTERPRISE_BACKLOG #66–#68. **The plan is complete.** · branch `agent-durability-followups`
**Method:** 15-agent audit workflow — 7 doc slices, each through claim-extraction → independent adversarial verification against source, plus a completeness critic. Every finding below carries code evidence and survived a refutation attempt (**0 of 214 findings were refuted**).
**Scope audited:** all of `docs-site/docs/` (reference, quickstart, troubleshooting, all 19 cookbooks), the status ledgers (`CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/STATUS.md`, `docs/COMPAT.md`), ops/audit docs, plan docs' shipped-claims, and every template/package README.
**Excluded by policy:** the historical design docs (`FLEET_PLAN`, `AGENT_RPC_PLAN`, `CONTROL_PLANE_PLAN`, `BUILDER_PLAN`, `EVENT_SOURCE_REGISTRY`, `AGENT_BUILDING_AGENT`, `EXTENDING_YOUR_AGENT`, `COMMUNICATION_CHANNELS`, `BUILDING_A_GENERIC_AGENT`, `EVENT_DRIVEN_AGENT`) — CLAUDE.md marks them superseded; Wave 1 adds a superseded-banner instead of line-editing ~8k lines.

## The numbers

| | |
|---|---|
| Confirmed deltas | **214** (0 refuted) |
| Severity | 30 critical · 59 high · 63 medium · 62 low |
| Kind | 73 overstates · 49 broken examples · 62 stale references · 30 understates |
| Resolution | 171 fix-docs · 12 fix-code · 31 either (product decision) |
| Effort | 169 minutes-level · 43 hours-level · 2 days-level |

The shape of the problem: this is **broad drift, not a few bad pages** — findings landed across nearly every audited file, and the docs-site golden paths (quickstart tour, cookbooks, reference tables) contain commands, flags, env vars, and capability checkmarks that do not exist in the code. 80% of the fix is minutes-per-item doc editing; the remaining 20% is a short list of code changes where the doc wrote a check the code should cash, plus CI mechanisms so the delta cannot re-open.

## Truth policy (adopt with this plan)

1. **Code leads, docs follow.** No capability claim ships to `docs-site` without a resolvable code reference. Plan docs may describe roadmap, but only rows marked shipped/✅ are subject to this rule — and all of them are.
2. **One scoreboard.** The AGENTS.md evidence ledger is the single source of capability status. CLAUDE.md, README, STATUS.md, FIRST_PRINCIPLES_* link to it; no copied pillar tables (CLAUDE.md currently contradicts itself between its 5-of-5 table and its own accuracy note).
3. **"By default" means npm-install default.** A feature gated behind undeclared peer deps, an env var, or wired into only one of the two runtimes (`up` vs `fleet run`) is documented as opt-in, with the exact activation steps.
4. **Every example is executable.** Cookbook and README command sequences must run verbatim against the published CLI.

---

## Wave 0 — kill the 30 criticals (≈1 focused day)

Every critical is a user-facing landmine: a documented command that errors, a flag that doesn't exist, or a capability table lying on a first-touch page. Themes (full list in the appendix, tagged **W0**):

- **Phantom CLI verbs/flags on golden paths:** `declaragent init --template …` (fleet-starter, agent-rpc cookbooks + template READMEs), `declaragent run` as the daemon verb across six template READMEs (real verb: `up`), `declaragent rpc peers` / `rpc capabilities`, `dlq list --kind rejected` (real: `--kind dispatch --reason auth-rejected`), `fleet deploy --target cloud-run --canary` as the quickstart-tour finale, `deploy --verify` IAM preflight, `auth store`, `mcp add --transport http`.
- **Phantom env vars** on the reference page: `DECLARAGENT_LOG_LEVEL`, `DECLARAGENT_TELEMETRY`, `DECLARAGENT_OFFLINE`, `DECLARAGENT_CONFIG_DIR` (never read — and the generated Cloud Run Dockerfile *depends* on the last one), plus a chaos/integration gate table naming five variables that don't exist while omitting the twelve real `*_INTEGRATION` gates.
- **Fabricated observability waterfall:** `observability.mdx` + `grafana-tracing.mdx` span names (`engine.turn`, `tool.invoke`, `bus.dispatch`, `channel.inbound.*`) — 4 of 5 don't exist; every real span is a root span.
- **Config keys that aren't in the schema:** `rpc.auth.required: hmac` + `keysRef`, fleet `hosts[].region`, the zero-trust cookbook's `fleet.yaml#rpc.auth.enabled` rollback key, the cross-host cookbook's `rpc-peers.yaml` peer shape.
- **Templates whose flagship promise can't execute:** kafka-pipeline claims Kafka-out enrichment with no Kafka outbound path; marketing README's `mcp:` block consent flow; webhook signature examples that don't match verification code.

Rule for Wave 0: default to **fix-docs** (truthful now beats capable later); any `either` item gets a one-line TODO in `docs/POST_ENTERPRISE_BACKLOG.md` if the capability is worth building.

## Wave 1 — highs, the fix-code dozen, and ledger consolidation (≈1 week)

**1a. The 59 high-severity doc fixes** (tagged **W1** in the appendix) — headline items: `providers.mdx` capability matrix claims Streaming/Images/Audio ✅ (none implemented — no provider streams, `MessageContent` has no image/audio type), `error-codes.mdx` (7 deltas vs `RPC_ERROR_CODES`), FIRST_PRINCIPLES_VALIDATION's "5 of 5 pillars ✅ at enterprise scale" verdict.

**1b. The fix-code dozen** — docs wrote a check the code should cash. Recommended dispositions:

| Item | Disposition | Effort |
|---|---|---|
| `DECLARAGENT_CONFIG_DIR` never read, generated Dockerfile depends on it | **Fix code** — one-line `configDir()` env read | hours |
| OTel packages undeclared by published packages (breaks documented setup on npm installs; cited by AGENTS.md:118, OTEL_SETUP.md:57, PRODUCTION_READINESS_PLAN.md:30) | **Fix code** — optional peerDependencies + peerDependenciesMeta on core/cli | hours |
| "Token bucket wraps every provider" — false for `fleet run` (bare provider, `fleet-run.ts:1035`; cited by AGENTS.md:162, FIRST_PRINCIPLES_AUDIT.md:63, VALIDATION.md:78) | **Fix code** — wrap fleet-run provider with `withProviderRateLimit` (also a prerequisite for the Claude-subscription runtime) | hours |
| THREAT_MODEL.md SIGTERM→SIGKILL 5s grace for MCP procs — not implemented | **Fix code** — proc handle already held at `stdio-client.ts:429-435` | hours |
| Broker client peer-dep ranges claimed "aligned" but undeclared (amqplib/mqtt/kafkajs/sqs) | **Fix code** — declare optional peers mirroring the nats entry | hours |
| kafka-pipeline template Kafka-out enrichment | **Fix docs now** (scope README to logged enrichment), backlog the Kafka outbound channel | days if built |
| marketing template `mcp:` block consent at `up` | **Decide:** either teach `up` to merge `agent.yaml#mcp.servers` (the declarative story argues for it) or ship `.mcp.json` | hours |
| multi-tenant-starter per-tenant `TenantRuntime` wiring | **Fix docs now** (describe the single resolved tenant context that ships), backlog full wiring | days if built |

**1c. Ledger consolidation** (~24 findings across CLAUDE.md/AGENTS.md/README/STATUS/COMPAT + FIRST_PRINCIPLES_*): rewrite the CLAUDE.md pillar table as a pointer to the AGENTS.md ledger; correct AGENTS.md's three "by default" rows; refresh stale file:line citations. Add the superseded-banner to the 10 historical design docs.

**1d. The critic's two hottest uncovered finds — treat as critical:**
- `docs/runbooks/` (20 files, unaudited): spot-checks already found 6 citing nonexistent `declaragent daemon status|restart|reload` verbs. Sweep all 20.
- `packages/testkit/alerts/*.rules.yaml` + `packages/testkit/dashboards/*.json`: **published npm artifacts querying metrics that don't exist**, and the anchor for every `runbook_url`. Validate every metric name against the registry.

## Wave 2 — the 123-item sweep + uncovered surfaces (≈1 week, parallelizable)

Medium/low items (tagged **W2**): stale defaults (`subagentDepthCap` 3→2), renamed verbs, wrong ports/paths, stale version snapshots. Plus the remaining critic gaps: pending changeset accuracy (it becomes the permanent npm changelog), missing READMEs for 11 of 13 published packages, docs-site sidebar orphans (`capabilities.mdx`, `control-plane.mdx` unreachable — flip `onBrokenLinks` to `throw`), CLI-printed copy (banners, wizard, deploy-generated files), template non-README YAML (`${keychain:…}` refs, `.env.example`), absolute-GitHub-URL checking, `multi-tenant-starter.mdx` + `reference/index.mdx` full pass.

## Wave 3 — mechanisms so it never re-opens (≈1 week engineering, highest leverage last)

The critic distilled the 214 into 8 drift classes, each killable by one mechanism instead of N hand-edits. Priority order:

1. **Doc-command linter** — extend the existing `scripts/docs-cli-extract.ts` + `ci.yml` drift guard (today it protects only `cli.mdx`) to extract every ```` ```bash ```` `declaragent …` invocation across docs-site/templates/runbooks and validate verbs+flags against the parser. Kills the largest class (~50 findings).
2. **Env-var registry** — one module through which all `process.env.DECLARAGENT_*` reads go (name, default, description); doc-gen `env-vars.mdx` from it. Kills both invention (5 phantom vars) and omission (5 undocumented real ones).
3. **Metrics manifest** — the Prometheus registry already knows every metric at registration; emit a generated manifest, validate docs + testkit dashboards/alerts against it in CI.
4. **Single scoreboard enforcement** — CI grep failing on pillar-table/"5 of 5" copies outside AGENTS.md.
5. **Version tokens** — ban literal version numbers in docs-site prose; inject from `packages/cli/package.json`.
6. **Defaults-matrix test** — table-driven spec asserting each documented default (metrics listener, OTel activation, rate limiting, per runtime `up` vs `fleet run`) so "by default" claims are executable.
7. **Placeholder gate** — CI grep forcing `draft: true` on `todo-block`/"placeholder —" pages.
8. **Reference-resolver** — migrate evidence-doc citations to `symbol @ path` form; CI asserts the symbol exists in the file (kills file:line rot).

## Definition of done

- All W0/W1 appendix boxes checked; W2 ≥ 90% with the remainder ticketed.
- Mechanisms 1–4 running in CI (5–8 ticketed).
- Re-run the audit workflow (`workflows/scripts/docs-code-delta-audit-*.js`, resumable) → **0 critical, 0 high**.
- CLAUDE.md accuracy note replaced by a dated pointer to this plan's completion.

---
## Appendix — full findings inventory (214 items)

Legend: **W0** = critical, fix immediately · **W1** = high severity or requires a code change · **W2** = medium/low sweep. Resolution: `fix-docs` (doc must match code), `fix-code` (code should honor what the doc promises), `either` (product decision). Every item was extracted by one agent and independently confirmed against source by an adversarial verifier; re-check the cited evidence at edit time anyway.

### docs-site · Reference (51 findings)

#### `docs-site/docs/reference/env-vars.mdx` — 6

- [x] **W0** · `:16` · critical/overstates · *fix-code, hours*  
  **Claim:** DECLARAGENT_CONFIG_DIR overrides the per-user config directory; used by the Cloud Run Dockerfile to mount /etc/declaragent  
  **Fix:** Make configDir() honor process.env.DECLARAGENT_CONFIG_DIR (one-line change; the generated Dockerfile already depends on it), or remove the ENV line from deploy-dockerfile.ts and delete the doc row.  
  <sub>Evidence: Confirmed. packages/cli/src/paths.ts:5-8 — configDir() is join(homedir(), '.declaragent') with no env-var read; repo-wide grep finds DECLARAGENT_CONFIG_DIR only at packages/cli/src/deploy-dockerfile.ts:14 (ENV line in the generated Dockerfile) — the container ENTRYPOINT 'declaragent run' ignores it, so the COPY conf…</sub>
- [x] **W1** · `:17` · high/overstates · *fix-docs, minutes*  
  **Claim:** DECLARAGENT_TELEMETRY=0 opts out of the three first-run telemetry events (installed, wizard_completed, deploy_invoked)  
  **Fix:** Replace the row with the real mechanism (wizard prompt writing ~/.declaragent/.telemetry-opt-out) or state that telemetry is not yet implemented.  
  <sub>Evidence: Confirmed. The env var is read nowhere; the real opt-out is a sentinel file — packages/cli/src/init-paths.ts:9-12 telemetryOptOutPath() → ~/.declaragent/.telemetry-opt-out, written by the wizard at init-wizard.tsx:348. Grep finds no code emitting events named installed/wizard_completed/deploy_invoked.</sub>
- [x] **W1** · `:18` · high/overstates · *either, minutes*  
  **Claim:** DECLARAGENT_LOG_LEVEL (default info; trace/debug/info/warn/error) controls runtime log level; 'runbooks frequently set debug'  
  **Fix:** Delete the row (and fix any runbooks citing it), or implement the env var in the runtime logger.  
  <sub>Evidence: Confirmed. Repo-wide grep for DECLARAGENT_LOG_LEVEL across packages/, scripts/, templates/, .github/ returns zero hits — the variable is never read; setting it does nothing.</sub>
- [x] **W1** · `:19` · high/overstates · *fix-docs, minutes*  
  **Claim:** DECLARAGENT_OFFLINE skips network calls outside the configured provider and affects the wizard's verify step  
  **Fix:** Delete the row and point offline users at 'declaragent init --skip-verify' instead.  
  <sub>Evidence: Confirmed. Repo-wide grep for DECLARAGENT_OFFLINE returns zero hits; the wizard's verify step is skipped via the --skip-verify flag (index.tsx:1264-1275, init-wizard.tsx:134), not an env var. Note the referenced 'declaragent upgrade' verb also does not exist in the CLI.</sub>
- [x] **W2** · `:10` · medium/understates · *fix-docs, hours*  
  **Claim:** 'The CLI and runtime read a small set of environment variables' — presented as the env-var reference  
  **Fix:** Add rows for the working DECLARAGENT_* vars (METRICS_PORT, BIND_ADDRESS, RPC_AUTH_DEFAULT, BUILDER, CLI_VERSION, DRAIN_DEADLINE_MS, PROVIDER_RATE_LIMIT_RPS/_DISABLE, BASH_ENV_ALLOW/_DENY) plus OTEL_EXPORTER_OTLP_ENDPOINT.  
  <sub>Evidence: Confirmed. Distinct DECLARAGENT_* vars actually read in source but absent from the page: DECLARAGENT_METRICS_PORT (up-cli.ts:1953), DECLARAGENT_BIND_ADDRESS, DECLARAGENT_RPC_AUTH_DEFAULT (0.7.6 zero-trust preview, load-agent.ts:695-707), DECLARAGENT_BUILDER, DECLARAGENT_CLI_VERSION, DECLARAGENT_DRAIN_DEADLINE_MS, DE…</sub>
- [x] **W2** · `:38` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Chaos/integration harness gates: DECLARAGENT_CHAOS=1, DECLARAGENT_CHANNEL_IT=1, DECLARAGENT_SECRETS_IT=1, DECLARAGENT_E2E=1, DECLARAGENT_INTEGRATION=1  
  **Fix:** Replace the table with the actual *_INTEGRATION / KAFKA_SOAK gate variables.  
  <sub>Evidence: Confirmed. None of the five variables appear anywhere in packages/, scripts/, or .github/. The real gates are per-suite: KAFKA_INTEGRATION, NATS_INTEGRATION, MQTT_INTEGRATION, AMQP_INTEGRATION, SQS_INTEGRATION, ELASTIC_INTEGRATION, SPLUNK_INTEGRATION, DATADOG_INTEGRATION, FLEET_INTEGRATION, LOAD_INTEGRATION, RPC_AUT…</sub>

#### `docs-site/docs/reference/observability.mdx` — 3

- [x] **W0** · `:114` · critical/overstates · *either, minutes*  
  **Claim:** OTel key spans include channel.inbound.<platform>, bus.dispatch, engine.turn (turn_number/model/tokens), tool.invoke, channel.outbound.<platform>  
  **Fix:** Replace the span list with the three real spans (source.message, channel.outbound.send, channel.outbound.edit) and mark engine/tool/dispatch/inbound spans as roadmap — or ship those spans before keeping the list.  
  <sub>Evidence: grep for startSpan across core+cli finds exactly three span names: 'source.message' (packages/core/src/events/base-source.ts:293), 'channel.outbound.send' (packages/core/src/channels/base-channel.ts:240,258), 'channel.outbound.edit' (base-channel.ts:417). No engine.turn/tool.invoke/bus.dispatch/channel.inbound span …</sub>
- [x] **W1** · `:112` · high/overstates · *fix-docs, minutes*  
  **Claim:** When OTEL_EXPORTER_OTLP_ENDPOINT is set, Declaragent exports spans + metrics over OTLP/HTTP  
  **Fix:** Say 'exports spans over OTLP/HTTP (metrics are exposed via Prometheus /metrics only)' and note the service name is fixed to "declaragent".  
  <sub>Evidence: maybeCreateOtelTracer (packages/cli/src/up-cli.ts:2109-2140) only takes bridge.tracer (the meter is discarded) and calls startOtelSdk({ endpoint, serviceName: 'declaragent' }) — trace export only, hardcoded service name. Metrics are Prometheus /metrics only; no OTLP metric export path exists.</sub>
- [x] **W2** · `:64` · low/understates · *fix-docs, minutes*  
  **Claim:** Channel metric table (sent/failed/latency/inbound_received) is the channel counter index  
  **Fix:** Add the seven missing channel_* metrics to the table.  
  <sub>Evidence: base-channel.ts registers 11 instruments (packages/core/src/channels/base-channel.ts:191-209): also channel.outbound.edited, channel.outbound.deleted, channel.outbound.idempotency_hits, channel.outbound.rate_limit_retries, channel.typing.sent, channel.reactions.sent, channel.inbound.failed — seven metrics missing fr…</sub>

#### `docs-site/docs/reference/rpc.mdx` — 13

- [x] **W0** · `:283` · critical/broken_example · *fix-docs, minutes*  
  **Claim:** Runtime inspection via declaragent rpc peers / rpc peers --verify / rpc capabilities  
  **Fix:** Change the three commands to declaragent fleet peers, declaragent fleet peers --verify, and declaragent fleet capabilities.  
  <sub>Evidence: No 'rpc' case in the top-level dispatch (packages/cli/src/index.tsx:492-1564 handles plugin/skill/mcp/extensions/daemon/agent/up/down/ps/logs/events/dlq/source/mailbox/fleet/capabilities/tenants/audit/erase/secrets/init/deploy/migrate/auth — never rpc). Shipped equivalents: fleet peers [--verify] (index.tsx:1043) an…</sub>
- [x] **W0** · `:302` · critical/overstates · *fix-docs, minutes*  
  **Claim:** Agents that require signed envelopes declare it in agent.yaml via rpc.auth.required: hmac + keysRef: ${secret:...}  
  **Fix:** Replace the rpc.auth.required/keysRef example with rpc.auth.enabled: true in agent.yaml plus a provider: hmac auth block on the peer entry in rpc-peers.yaml.  
  <sub>Evidence: agent.yaml rpc schema is z.object({ auth: z.object({ enabled: z.boolean().optional() }).passthrough() }).passthrough() (packages/core/src/agents/load-agent.ts:328-338) — 'required'/'keysRef' pass through unread (zero grep hits in any src). Real mechanism: rpc.auth.enabled + per-peer auth blocks with provider: oidc\|…</sub>
- [x] **W1** · `:97` · high/understates · *fix-docs, hours*  
  **Claim:** Transports table lists only memory, kafka, nats  
  **Fix:** Add jetstream, sqs, amqp, mqtt rows (factory + peer dep) and note which kinds fleet run auto-constructs (kafka, nats) vs which need a programmatic factory; note jetstream is not yet a declarable rpc-peers.yaml kind.  
  <sub>Evidence: Shipped exported factories also include createJetStreamTransport (packages/plugin-agent-rpc/src/jetstream-transport.ts:251, index.ts:92), createSqsTransport (index.ts:108), createAmqpTransport (index.ts:119), createMqttTransport (index.ts:131). CORRECTION to first pass: fleet run does NOT wire all seven — rpc-peers.…</sub>
- [x] **W1** · `:373` · high/broken_example · *fix-docs, minutes*  
  **Claim:** Inspect auth decisions via declaragent audit list --kind auth_check  
  **Fix:** Replace with declaragent audit query --kind auth_check.  
  <sub>Evidence: runAuditSubcommand (packages/cli/src/index.tsx:1199-1256) accepts only query\|verify\|erase\|prune; 'list' falls through to 'unknown audit subcommand' + exit 1. auth_check is a valid kind (packages/core/src/audit/types.ts:90) and audit query takes --kind (index.tsx:1204-1220), so the working command is declaragent a…</sub>
- [x] **W2** · `:15` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** 'Since v1.1 / Introduced in v1.1. Frozen surfaces are tagged @since 1.1.0' and 'Authenticated RPC (OIDC / OAuth2) — since 1.2.0' (line 309)  
  **Fix:** Replace 'Since v1.1'/'since 1.2.0' with the real npm versions that shipped these surfaces (0.5.x-0.7.x), or explicitly label them as internal plan-version tags.  
  <sub>Evidence: No 1.x release exists anywhere: packages/cli/package.json is 0.7.6, packages/core/package.json is 0.5.5, npm latest is 0.7.4. The v1.1/v1.2 numbers are internal plan-doc versions (envelope.ts also carries '@since 1.1.0' comments) presented on a public docs page as product releases — same defect class as the already-…</sub>
- [x] **W2** · `:125` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** 'No JetStream.' — durable streams belong to @declaragent/source-nats; RPC transport is deliberately core-NATS only  
  **Fix:** Rewrite the bullet: the nats kind stays core-NATS for low latency; durable RPC delivery is available via the separate createJetStreamTransport factory (programmatic wiring today).  
  <sub>Evidence: createJetStreamTransport shipped (packages/plugin-agent-rpc/src/jetstream-transport.ts:251, exported at index.ts:92) as a separate durable RPC transport. Nuance: the nats kind IS still core-NATS, and jetstream is factory-only today (no rpc-peers.yaml kind, no fleet-run auto-construction) — but the flat 'No JetStream…</sub>
- [x] **W2** · `:307` · medium/overstates · *fix-docs, minutes*  
  **Claim:** Each transport plugin exposes a validateAuth(envelope, raw, transportCtx) hook for mTLS/SPIFFE  
  **Fix:** Remove the validateAuth sentence or reframe transport-layer mTLS/SPIFFE as a roadmap item.  
  <sub>Evidence: The only validateAuth in the repo is a private helper in the Elastic audit exporter (packages/core/src/audit/exporters/elastic.ts:55,185) — unrelated. No transport file (kafka/nats/jetstream/sqs/amqp/mqtt/memory-transport.ts) implements or accepts such a hook; RpcTransport is publish/subscribe only.</sub>
- [x] **W2** · `:59` · low/understates · *fix-docs, minutes*  
  **Claim:** Envelope interface snippet types auth as only { kind: 'internal' } \| { kind: 'hmac'; keyId; signature }  
  **Fix:** Add the oidc and oauth2-client variants to the auth union in the envelope snippet.  
  <sub>Evidence: RpcAuth also includes { kind: 'oidc'; token; keyId? } and { kind: 'oauth2-client'; token; scope? } (packages/core/src/rpc/envelope.ts:43-47) — which the same page's Security table (lines 292-295) already documents; only the frozen-wire-format snippet is stale.</sub>
- [x] **W2** · `:109` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** NATS example documents queueGroup as the load-balancing option  
  **Fix:** Show queueGroups (per-topic map) in the example and mark queueGroup as deprecated-fallback.  
  <sub>Evidence: queueGroup is '@deprecated since 0.7.1 — prefer queueGroups' (packages/plugin-agent-rpc/src/nats-transport.ts:133-140); queueGroups (per-topic map) takes precedence when both are set. The page's queue-groups bullet (line 122-124) also only describes the deprecated scalar.</sub>
- [x] **W2** · `:152` · low/understates · *fix-docs, minutes*  
  **Claim:** Sync mode returns status 'ok' \| 'error' \| 'timeout' \| 'abandoned' \| 'busy'  
  **Fix:** Add 'schema-violation' (with violations/schemaSide) to the documented status union.  
  <sub>Evidence: RequestAgentOutput.status also includes 'schema-violation', with violations[] ({path,message}) and schemaSide: 'request'\|'response' fields (packages/plugin-agent-rpc/src/request-agent.ts:53-70).</sub>
- [x] **W2** · `:220` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Skipping ctx.respond auto-publishes { ok: true, data: assistant.final.content } on turn-end  
  **Fix:** Document the actual default payload shape { text, stopReason, usage? }.  
  <sub>Evidence: The fleet-run LLM handler responds with { ok: true, data: { text: extractText(...), stopReason, usage? } } (packages/cli/src/fleet-run-llm-handler.ts:247-254) — a structured object, not the raw assistant content.</sub>
- [x] **W2** · `:228` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** future (v1.2) registry aggregation pulls from capabilities.yaml  
  **Fix:** Replace 'future (v1.2)' with a pointer to the shipped fleet capabilities verb.  
  <sub>Evidence: Aggregation shipped: declaragent fleet capabilities (index.tsx:895-897) backed by packages/core/src/fleet/aggregator.ts (file exists).</sub>
- [x] **W2** · `:359` · low/understates · *fix-docs, minutes*  
  **Claim:** Rejection reason list (missing-auth … bad-signature) is the complete typed vocabulary  
  **Fix:** Add unknown-peer to the reason list and document the provider: hmac peer-auth variant plus strictAuth semantics.  
  <sub>Evidence: strictAuth mode adds reason 'unknown-peer' for envelopes whose from has no registry entry (packages/plugin-agent-rpc/src/agent-inbox.ts:102-112,327-342); the peer auth block also accepts provider: hmac (packages/core/src/rpc/peers-loader.ts:149) which the page's auth-config section (oidc/oauth2-client examples only)…</sub>

#### `docs-site/docs/reference/agent-yaml.mdx` — 8

- [x] **W1** · `:177` · high/broken_example · *fix-docs, minutes*  
  **Claim:** Rejected envelopes land in rejected_events 'so declaragent dlq list --kind rejected surfaces the specific peer + reason'  
  **Fix:** Replace the command with `declaragent dlq list --kind dispatch --reason auth-rejected`, and fix line 123's 'kind=rejected' to the dispatch-DLQ terminology.  
  <sub>Evidence: Confirmed, with refinement: index.tsx:686-692 explicitly warns 'unknown --kind value "rejected"; supported: source, dispatch. Ignoring.' then kind stays 'source' and without --source the command errors with usage (index.tsx:770-776). Auth rejections are stored via upsertRejection(id, 'auth-rejected', …) (fleet-run.t…</sub>
- [x] **W2** · `:30` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** subagentDepthCap defaults to 3  
  **Fix:** Change 'Defaults to `3`' to 'Defaults to `2`'.  
  <sub>Evidence: Confirmed. packages/core/src/engine/engine.ts:35 — export const DEFAULT_SUBAGENT_DEPTH_CAP = 2; applied at engine.ts:286 via session.spec.subagentDepthCap ?? DEFAULT_SUBAGENT_DEPTH_CAP.</sub>
- [x] **W2** · `:93` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** tools.rateLimit burst 'Defaults to `rps`. Set to `2 * rps` for the classic token-bucket "1-second absorb" pattern' — and the example at lines 78-80 says 'Bash: rps: 1' means 'no burst; a 10-call burst will take ~9 sec…  
  **Fix:** Change the burst row to 'Defaults to 2 × rps (ceil)' and fix the example comment (set burst: 1 explicitly to get the documented no-burst behavior); also refresh the stale comment at load-agent.ts:239.  
  <sub>Evidence: packages/core/src/tools/rate-limit-gate.ts:117 — const burst = Math.max(1, cfg.burst ?? Math.ceil(cfg.rps * 2)); burst defaults to 2×rps (POST_ENTERPRISE_BACKLOG #28, listed as shipped in CLAUDE.md), not rps. With rps: 1 the default burst is 2, so the example's 'no burst … ~9 seconds' comment is wrong (~8s, first tw…</sub>
- [x] **W2** · `:26` · low/understates · *fix-docs, minutes*  
  **Claim:** model and systemPrompt are Required: yes in agent.yaml  
  **Fix:** Mark model and systemPrompt as optional and document their fallbacks (default model resolution chain ending at claude-sonnet-4-5; synthesized system prompt).  
  <sub>Evidence: Confirmed. packages/core/src/agents/load-agent.ts:193-195 marks both .optional(); the comment at load-agent.ts:177-189 says only name is hard-required; systemPrompt is synthesized at load-agent.ts:798-801 ('You are "<name>", a declaragent-authored agent…') and model falls back to --model > auth-config > preset defau…</sub>
- [x] **W2** · `:29` · low/overstates · *fix-docs, minutes*  
  **Claim:** maxTokens 'Per-turn cap. Defaults to the provider's ceiling.'  
  **Fix:** Change to 'Defaults to 4096 (runtime constant), not the provider's ceiling — set explicitly for longer outputs.'  
  <sub>Evidence: packages/core/src/providers/anthropic.ts:6 DEFAULT_MAX_TOKENS = 4_096 (applied at line 122: request.maxTokens ?? DEFAULT_MAX_TOKENS) and openai-compat.ts:5 DEFAULT_OPENAI_COMPAT_MAX_TOKENS = 4_096 (applied at line 147) — omitting maxTokens caps every turn at a hardcoded 4096 tokens, far below e.g. Claude's output ce…</sub>
- [x] **W2** · `:234` · low/understates · *fix-docs, minutes*  
  **Claim:** The 401 reason vocabulary is nine values: missing-token, malformed-token, bad-signature, expired, wrong-issuer, wrong-audience, insufficient-scope, idp-unreachable, provider-failed  
  **Fix:** Add not-yet-valid, config-error, and untrusted-proxy to the stable reason list.  
  <sub>Evidence: Confirmed. packages/core/src/observability/control-plane-auth.ts:75-87 — ControlPlaneAuthRejectReason has twelve values; the doc omits not-yet-valid, config-error, and untrusted-proxy (the trustedProxies rejection from backlog #7).</sub>
- [x] **W2** · `:401` · low/understates · *fix-docs, minutes*  
  **Claim:** audit.export Observability lists four metrics (acked_total, failures_total, last_seq, paused)  
  **Fix:** Add the four back-pressure and two adaptive-batch metrics to the Observability bullet list.  
  <sub>Evidence: Confirmed. packages/core/src/audit/exporter-loop.ts:235-265 also registers declaragent.audit.backpressure.paused_total / .active / .drops_total / .backlog_ms (#11) and declaragent.audit.batch.interval_ms / .rows (#12) in the same loop; none appear on the page. (The four listed metrics, their {exporter,vendor} labels…</sub>
- [x] **W2** · `:424` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** The generated reference will additionally document tools.allow[] / tools.deny[] engine tool allowlists  
  **Fix:** Replace 'tools.allow[] / tools.deny[]' with the shipped top-level 'permissions.rules[]' (pattern + decision) block, and add maxIterations and memory to the pending-fields list.  
  <sub>Evidence: Confirmed, but the first pass misnamed the shipped shape: it is a TOP-LEVEL permissions.rules[] block (load-agent.ts:265-277 — z.object({ rules: [{ pattern, decision: 'allow'\|'deny' }] }) matched by glob against '<ToolName>:<permissionKey>'), not tools.rules[]. No tools.allow[]/tools.deny[] arrays exist anywhere. T…</sub>

#### `docs-site/docs/reference/control-plane.mdx` — 7

- [x] **W1** · `:110` · high/stale_reference · *fix-docs, hours*  
  **Claim:** allowLoopback bypass fires for requests whose Host header parses to 127.0.0.1/localhost/[::1]; only boolean true/false documented  
  **Fix:** Rewrite the loopback-bypass section around peer-IP resolution, document the { trustedProxies: [...] } object form + XFF semantics, and add untrusted-proxy to the rejection-reason table.  
  <sub>Evidence: resolveEffectivePeer (packages/core/src/observability/control-plane-auth.ts:326-390) bases the loopback decision on the real connection peer IP — the code comment explicitly says NOT the forgeable Host header (Host sniff is only the stub-listener fallback). allowLoopback also accepts { trustedProxies } with X-Forwar…</sub>
- [x] **W2** · `:25` · medium/stale_reference · *fix-docs, hours*  
  **Claim:** Remote bind (Slice 2) is gated on an explicit opt-in that isn't wired into the CLI yet  
  **Fix:** Document DECLARAGENT_BIND_ADDRESS, the fail-closed rule (non-loopback + no auth => safe-subset serving only /metrics,/healthz,/readyz), and that auth enables full remote serving.  
  <sub>Evidence: DECLARAGENT_BIND_ADDRESS is wired: resolveBindAddress (packages/cli/src/up-cli.ts:1888-1897) defaults 127.0.0.1 and supports non-loopback binds; without auth a non-loopback bind serves only /metrics,/healthz,/readyz (safe-subset mode, up-cli.ts commentary at 1873-1886 + route filtering around the startControlPlaneSe…</sub>
- [x] **W2** · `:235` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** declaragent fleet logs is '(planned)'  
  **Fix:** Drop the '(planned)' tag and link to the shipped fleet logs verb with its --host/--agent/-f flags.  
  <sub>Evidence: fleet logs shipped with cross-host fan-out: index.tsx:1151-1168 wires --host, --agent, -f/--follow, --max-lines into fleetLogs; the fleet usage string includes logs (index.tsx:1171).</sub>
- [x] **W2** · `:11` · low/overstates · *fix-docs, minutes*  
  **Claim:** declaragent up [-d] exposes the HTTP listener on 127.0.0.1:9464 by default  
  **Fix:** Clarify that the listener defaults on for -d only; foreground runs need DECLARAGENT_METRICS_PORT set.  
  <sub>Evidence: Listener defaults on only in detached mode: 'Defaults: on in detached mode (port 9464), off in foreground mode unless DECLARAGENT_METRICS_PORT is set' (up-cli.ts:590-593; port resolver returns isDetached ? 9464 : 0 at up-cli.ts:1962). observability.mdx:17 states this correctly.</sub>
- [x] **W2** · `:13` · low/understates · *fix-docs, minutes*  
  **Claim:** The listener multiplexes five endpoints (table then lists six)  
  **Fix:** Say eight endpoints and add /healthz + /readyz rows (auth-exempt, used by k8s probes).  
  <sub>Evidence: The table itself has six rows (/metrics /status /events /dlq /audit /logs) and the server additionally serves auth-exempt /healthz + /readyz (packages/core/src/observability/control-plane-server.ts:73 HEALTH_CHECK_PATHS, handlers at 518/542) used by k8s probes.</sub>
- [x] **W2** · `:126` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** 'The listener still binds to 127.0.0.1 — a reverse proxy is expected to front the port for remote access and the proxy's Host header rewrite plumbs the original hostname through'  
  **Fix:** Rewrite the paragraph: direct non-loopback binds are supported via DECLARAGENT_BIND_ADDRESS (auth required for full routes), and proxy deployments should configure allowLoopback: { trustedProxies: [...] } for X-Forwarded-For attribution instead of relying on Host rewrites.  
  <sub>Evidence: Both halves are stale: (1) DECLARAGENT_BIND_ADDRESS lets the listener bind non-loopback directly (up-cli.ts resolveBindAddress:1888-1897; the k8s renderer sets it to 0.0.0.0), so a reverse proxy is no longer the only remote path; (2) the auth middleware no longer keys anything on the Host header — loopback/remote at…</sub>
- [x] **W2** · `:149` · low/understates · *fix-docs, hours*  
  **Claim:** /logs query params are only agent and since; no fan-out or scope knobs documented  
  **Fix:** Document ?all=1, the 50-watcher/413 cap (logs.fanOutLimit), and the controlPlane.auth.routeScopes config key.  
  <sub>Evidence: The route also supports ?all=1 (mutually exclusive with ?agent — logs-sse-route.ts:192-200), a fan-out cap of 50 returning 413 (DEFAULT_FAN_OUT_LIMIT at logs-sse-route.ts:170, check at 225-229, tunable via logs.fanOutLimit), and per-route scope overrides via controlPlane.auth.routeScopes (packages/core/src/agents/lo…</sub>

#### `docs-site/docs/reference/fleet.mdx` — 7

- [x] **W1** · `:229` · high/understates · *fix-docs, hours*  
  **Claim:** CLI surface table is the complete fleet verb list (new/add/promote/demote/run/deploy/render/list/validate/capabilities/graph/peers/status)  
  **Fix:** Add rows for fleet audit-rpc, fleet ps, fleet events, fleet dlq (list/drop/requeue), and fleet logs [--host] [-f].  
  <sub>Evidence: Shipped verbs missing from the table: fleet audit-rpc [--suggest-enable --strict] (packages/cli/src/index.tsx:1060), fleet ps (1072), fleet events (1079), fleet dlq [list\|drop\|requeue] (1104-1149), fleet logs [--host --agent -f --max-lines] (1151-1168). The unknown-subcommand usage string (index.tsx:1171) lists al…</sub>
- [x] **W2** · `:14` · medium/stale_reference · *fix-docs, hours*  
  **Claim:** 'Since v1.2 / Introduced in v1.2' and manifest example pins runtime.declaragent: "^1.2.0"  
  **Fix:** Replace internal plan versions with real npm versions (0.6.x/0.7.x) and note runtime pins are advisory-only today (validated, not enforced).  
  <sub>Evidence: No 1.x release exists: packages/cli/package.json version 0.7.6, npm latest 0.7.4 (per CLAUDE.md). runtime is schema-validated (manifest-schema.ts runtimeSchema ~line 140) but a grep for manifest.runtime consumption across cli+core src finds nothing — the pin is never enforced.</sub>
- [x] **W2** · `:125` · medium/understates · *fix-docs, hours*  
  **Claim:** Top-level manifest fields are version/name/description/runtime/agents/environments/rpc/deploy, and 'unknown keys fail load' (strict mode)  
  **Fix:** Add hosts[] (name / url / auth.bearer with env:/file: refs / timeoutMs) and the fleet-level controlPlane: block to the field table + manifest example, linking them to the fleet ps/events/dlq/logs fan-out verbs.  
  <sub>Evidence: The shipped manifest schema also accepts hosts[] ({ name, url, auth: { bearer }, timeoutMs } per host, unique names — packages/core/src/fleet/manifest-schema.ts:170-186,276-291, @since 0.7.4 #50) which drives the cross-host fan-out for fleet ps/events/dlq/logs, plus a fleet-level controlPlane: block (#17, manifest-s…</sub>
- [x] **W2** · `:192` · medium/understates · *fix-docs, minutes*  
  **Claim:** Deploy strategies are rolling \| all-or-nothing \| per-agent  
  **Fix:** Add a canary row to the strategy table (deploy first agent, soak, re-probe, then rest) and document --canary / --canary-wait-ms on fleet deploy; fix the line-107 comment too.  
  <sub>Evidence: deployStrategySchema = z.enum(['rolling','all-or-nothing','per-agent','canary']) (packages/core/src/fleet/manifest-schema.ts:97) and the CLI accepts --strategy canary plus --canary / --canary-wait-ms (index.tsx:976-1001, default 60s soak). The manifest example comment at fleet.mdx:107 repeats the three-strategy list.</sub>
- [x] **W2** · `:339` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Scope out: Kustomize output — 'revisit if customers ask'  
  **Fix:** Move Kustomize out of 'scope out' into the render docs and add --format <helm\|kustomize> and --config-split rows to the flags table.  
  <sub>Evidence: renderKustomize is imported and dispatched for --target k8s --format kustomize (packages/cli/src/fleet-render-cli.ts:36,154-155; kustomize-renderer.ts exists; golden snapshot dir fleet-starter-kustomize present). The flags table also omits --format <helm\|kustomize> and --config-split (index.tsx:1013,1030).</sub>
- [x] **W2** · `:413` · medium/overstates · *fix-docs, minutes*  
  **Claim:** Design decision shipped: 'fleet install wraps bun install'  
  **Fix:** Change the row to say workspace installs are plain bun install at the fleet root (no fleet install verb).  
  <sub>Evidence: runFleetSubcommand (index.tsx:884-1174) has no 'install' case, and the usage string (index.tsx:1171) omits it; grep for fleetInstall finds nothing.</sub>
- [x] **W2** · `:411` · low/overstates · *fix-docs, minutes*  
  **Claim:** Design decision shipped: channel ownership is an explicit owner: field per channel, per environment  
  **Fix:** Reword the row — channel ownership is via the shared channelsRef file today; no owner: key exists.  
  <sub>Evidence: grep for 'owner' in packages/core/src/fleet/manifest-schema.ts returns nothing; environment entries carry only tenantsRef/peersRef/secretsRef/channelsRef/envFiles/overrides. No owner key exists in channel config either.</sub>

#### `docs-site/docs/reference/providers.mdx` — 3

- [x] **W1** · `:35` · high/overstates · *fix-docs, minutes*  
  **Claim:** Streaming ✅ for every provider; 'All OpenAI-compat providers support stream: true. Anthropic exposes its own streaming SSE format which the core runtime normalizes.'  
  **Fix:** Change the Streaming column to ❌/planned in both tables and delete the SSE-normalization sentence.  
  <sub>Evidence: Confirmed. packages/core/src/providers/openai-compat.ts:56 declares 'stream?: false' and line 148 sends stream: false; anthropic.ts:148 sends { ...buildCreateParams(request), stream: false }; LLMProvider.stream?() (types/llm.ts:35) is optional and grep shows no provider implements it — every LLM call is non-streamin…</sub>
- [x] **W1** · `:37` · high/overstates · *fix-docs, minutes*  
  **Claim:** Images ✅ for Anthropic and OpenAI: 'Inline image support in the user message. OpenAI and Anthropic are the stable paths.'  
  **Fix:** Change the Images column to ❌ (or 'planned') for all providers and remove the 'stable paths' feature note.  
  <sub>Evidence: Confirmed. packages/core/src/types/messages.ts:5-13 — MessageContent is only text \| tool_use \| tool_result; grep for 'image' in packages/core/src/providers/*.ts returns zero matches. No image content block exists anywhere in the pipeline.</sub>
- [x] **W1** · `:38` · high/overstates · *fix-docs, minutes*  
  **Claim:** Audio ✅ for OpenAI: 'OpenAI gpt-4o-audio-preview is the only cloud target for now.'  
  **Fix:** Change the Audio column to ❌ for every provider and reword the feature note as roadmap.  
  <sub>Evidence: Confirmed. Zero matches for 'audio' in packages/core/src/providers/ and packages/core/src/types/messages.ts — no audio content type, no request mapping, no gpt-4o-audio-preview reference anywhere in source.</sub>

#### `docs-site/docs/reference/builder.mdx` — 2

- [x] **W2** · `:61` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** For broker-level DLQ entries, run declaragent dlq show <sourceId> <entryId> outside the REPL  
  **Fix:** Correct the command to declaragent dlq show --source <id> <entryId>.  
  <sub>Evidence: The shipped syntax takes the source as a flag: 'usage: declaragent dlq show --source <id> <entryId>' (packages/cli/src/index.tsx:782). Positional sourceId is consumed as entryId with no --source set, hitting the usage error (exit 1).</sub>
- [x] **W2** · `:10` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** 15 tools, 10 slash commands  
  **Fix:** Change the headline to '15 tools, 9 slash commands'.  
  <sub>Evidence: 15 distinct builder tools confirmed (name: 'Declara…' across packages/cli/src/builder/*.ts). Builder slash commands in packages/cli/src/slash-commands.ts: /plan /yes /no /edit /diff /scope /fleet graph /undo /history = 9, matching the page's own 9-row table.</sub>

#### `docs-site/docs/reference/extensions.mdx` — 1

- [x] **W2** · `:42` · medium/understates · *fix-docs, minutes*  
  **Claim:** @declaragent/plugin-agent-rpc exposes 'RequestAgent tool + agent-inbox source + ctx.respond hook + in-memory transport'  
  **Fix:** Extend the 'Exposes' cell to list the six broker transports (Kafka, NATS, JetStream, SQS, AMQP, MQTT) and OIDC/OAuth2 envelope auth.  
  <sub>Evidence: Confirmed. packages/plugin-agent-rpc/src/index.ts:70-140 also exports createKafkaTransport, createNatsTransport, createJetStreamTransport, createSqsTransport, createAmqpTransport, createMqttTransport plus buildAuthVerifyRegistry / auth types — the registry page tells users the flagship RPC plugin only has an in-memo…</sub>

#### `docs-site/docs/reference/capabilities.mdx` — 1

- [x] **W2** · `:73` · low/overstates · *fix-docs, minutes*  
  **Claim:** format: uuid \| email \| uri \| uri-reference \| date-time — 'Anything outside this list is rejected at load time so the agent never starts with a schema it can't enforce'  
  **Fix:** Note that unknown format values are accepted and treated as advisory no-ops; only unsupported keywords are rejected at load time.  
  <sub>Evidence: Confirmed. packages/core/src/rpc/capability-validator.ts:590-614 — checkFormat's default branch is 'Unknown format — advisory only; do not error'; 'format' itself is on the SUPPORTED_KEYWORDS allow-list (line 227) so any format string (e.g. ipv4) loads fine and silently validates nothing. Only unsupported keywords a…</sub>

### docs-site · Intro & Quickstart (12 findings)

#### `docs-site/docs/quickstart/conversational-tour.mdx` — 5

- [x] **W0** · `:287` · critical/broken_example · *either, hours*  
  **Claim:** Final tour step: "declaragent fleet deploy --target cloud-run --canary --canary-wait-ms 60000" promotes the fleet to production  
  **Fix:** Replace step 6 with the working per-agent path (`declaragent deploy gcp-cloud-run` + the printed docker build/push + gcloud commands) — or ship a real cloud-run FleetDeployTarget and wire a default targetFactory into the index.tsx call site.  
  <sub>Evidence: The CLI calls fleetDeploy(args) with no deps (packages/cli/src/index.tsx:964-1004 — `return fleetDeploy({...})`, single argument), and fleetDeploy defaults deps to {} (fleet-deploy-cli.ts:674-676). resolveAdapters then always throws `no adapter registered for target ...` (fleet-deploy-cli.ts:864-884) for any non-dry…</sub>
- [x] **W1** · `:284` · high/broken_example · *fix-docs, minutes*  
  **Claim:** "Watch events stream: declaragent events list --last 20 --follow"  
  **Fix:** Drop `--follow` (use `declaragent events list --last 20` plus `declaragent logs -f` for live tailing), or add a real --follow flag to events list.  
  <sub>Evidence: The `events list` arg loop parses only --kind/--last/--correlation/--outcome/--state (packages/cli/src/index.tsx:582-611); `--follow` matches no branch and is silently ignored — no warning, no streaming. events-cli has no follow mode. Follow exists only on `logs` via -f/--follow (index.tsx:551-559). The user gets a …</sub>
- [x] **W2** · `:243` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** "In 0.6 only the most-recent apply is undoable; stacked undo lands in 0.7"  
  **Fix:** Update to "only the most-recent apply is undoable; stacked undo is on the roadmap" without a version promise.  
  <sub>Evidence: 0.7.x has shipped (packages/cli/package.json:3 = 0.7.6) and undo is still single-level: runUndo reads only registry.lastApplied() (packages/cli/src/builder/undo.ts:43) and the file's docblock (:5-9) says stacking "lands in a later slice" with no version attached.</sub>
- [x] **W2** · `:56` · low/understates · *fix-docs, minutes*  
  **Claim:** "declaragent init --fleet acme ... lays down:" a tree of exactly fleet.yaml, rpc-peers.yaml, .env.example, and agents/  
  **Fix:** Extend the step-1 tree to the real scaffold output: fleet.yaml, package.json, .gitignore, .env.example, rpc-peers.yaml, README.md, agents/.  
  <sub>Evidence: scaffoldFleet writes seven targets, not four: fleet.yaml, package.json, .gitignore, .env.example, rpc-peers.yaml, README.md, and agents/.gitkeep (packages/cli/src/fleet-scaffold.ts:110-121). The doc's tree omits package.json, .gitignore, and README.md — and package.json matters because the scaffold's overwrite-refus…</sub>
- [x] **W2** · `:311` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** DeclaraFleetAdd errors with "no fleet.yaml in scope."  
  **Fix:** Quote the real builder error string from builder/fleet-add.ts:56 in the troubleshooting entry.  
  <sub>Evidence: CORRECTED citation — the builder tool's actual error is at packages/cli/src/builder/fleet-add.ts:54-56: "no fleet.yaml at ${fleetRoot}. Run `declaragent init --fleet <name>` first, or point fleetRoot at an existing fleet." (the first pass cited the CLI verb's similar message at fleet-add-cli.ts:74). Either way, a us…</sub>

#### `docs-site/docs/intro.mdx` — 3

- [x] **W1** · `:36` · high/stale_reference · *fix-docs, hours*  
  **Claim:** "This site tracks v0.5.21 (latest on npm) with 0.6.0 staged (…tag + publish gated by operator sign-off — see RELEASE_0_6_0_READINESS.md)"  
  **Fix:** Update Status to the current npm version (0.7.x), remove the dead RELEASE_0_6_0_READINESS.md link, and fold the "0.6.0 (staged)" list into a shipped-changelog section.  
  <sub>Evidence: packages/cli/package.json:3 is 0.7.6; CLAUDE.md records @declaragent/cli@0.7.4 live on npm since 2026-04-23. docs/ contains no RELEASE_0_6_0_READINESS.md (ls docs/ → no match), so the GitHub link 404s. The whole "What's new in 0.6.0 (staged)" section (lines 38-47) presents long-shipped features as pending.</sub>
- [x] **W1** · `:41` · high/overstates · *either, hours*  
  **Claim:** "OpenTelemetry auto-enable — set OTEL_EXPORTER_OTLP_ENDPOINT, install the peer deps, and up wires the bridged tracer into every source + channel" (also line 17 "Prometheus + OpenTelemetry out of the box")  
  **Fix:** Either declare the OTel packages as optional peerDependencies of @declaragent/cli and keep the claim, or reword to "experimental: requires manually installing @opentelemetry/* next to the CLI" and name the three spans that actually exist.  
  <sub>Evidence: REPEATS the red-team-confirmed OTel delta. @opentelemetry/api, exporter-trace-otlp-http, sdk-node exist only in the ROOT package.json devDependencies (package.json:24-26). packages/cli/package.json (:34-49) declares no OTel packages in dependencies/optionalDependencies/devDependencies and has no peerDependencies key…</sub>
- [x] **W2** · `:14` · medium/understates · *fix-docs, minutes*  
  **Claim:** "The four pillars" — pillar list omits the conversational builder entirely  
  **Fix:** Retitle to "The five pillars" and add "5. Conversational builder — converse a deployable fleet into existence (DECLARAGENT_BUILDER=on)".  
  <sub>Evidence: The builder is a shipped, differentiating surface — getBuilderTools registers 15 Declara* tools behind DECLARAGENT_BUILDER=on (packages/cli/src/builder/register.ts:71-96; verified by counting the factory calls) — and the quickstart itself calls it "Declaragent's headline capability" (conversational-tour.mdx:12). CLA…</sub>

#### `docs-site/docs/quickstart/index.mdx` — 2

- [x] **W1** · `:14` · high/overstates · *fix-docs, minutes*  
  **Claim:** "From an empty laptop to an agent running on GCP Cloud Run, in under ten minutes. Measured, not estimated" with step 3 `declaragent deploy gcp-cloud-run` labeled "Deploy"  
  **Fix:** Change step 3's label to "Generate deploy artifacts" and amend the headline to include the docker build/push + gcloud replace steps (or drop the "Measured, not estimated" claim).  
  <sub>Evidence: deployGcpCloudRun only writes Dockerfile/.dockerignore/service.yaml/README.md to .declaragent/deploy/ (packages/cli/src/deploy-cli.ts:374-378) and then prints "Next, run these three commands:" — docker build, docker push, gcloud run services replace (:385-388) — which the user must run themselves. Nothing is running…</sub>
- [x] **W2** · `:44` · low/overstates · *fix-docs, minutes*  
  **Claim:** "What you'll end up with" tree: my-agent/ with .env.example always, channels.yaml "only when a channel is picked", event-sources.yaml for webhook/Kafka templates  
  **Fix:** Keep .env.example; change the channels.yaml annotation to "ships with channel-using templates (incl. concierge)", and add README.md + .mcp.json to the tree.  
  <sub>Evidence: CORRECTED — the first pass's core evidence was wrong: single-agent init DOES write .env.example (every templates/*/ dir ships one as a dotfile and the unpacker copies 1:1, init-template-unpacker.ts:159-196), so that tree line is accurate. What IS wrong: "only when a channel is picked" — the init wizard has no channe…</sub>

#### `docs-site/docs/quickstart/first-agent.mdx` — 1

- [x] **W2** · `:40` · low/understates · *fix-docs, minutes*  
  **Claim:** concierge scaffold produces ./agent.yaml, .env.example, skills/concierge.md, README.md  
  **Fix:** Add channels.yaml and .mcp.json to the scaffold listing (agent.yaml, channels.yaml, .env.example, .mcp.json, skills/concierge.md, README.md); do NOT remove .env.example.  
  <sub>Evidence: CORRECTED — the first pass misread this: templates/concierge/ DOES ship .env.example (it is a dotfile; `ls -a templates/concierge/` shows .env.example, agent.yaml, channels.yaml, README.md, skills/concierge.md — every template ships a .env.example). The unpacker copies the tree 1:1 (init-template-unpacker.ts:159-196…</sub>

#### `docs-site/docs/quickstart/installing.mdx` — 1

- [x] **W2** · `:79` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Verify output "declaragent 0.4.1" and DECLARAGENT_VERSION example "v1.0.2"  
  **Fix:** Show a current 0.7.x version in the verify output and use a real tag (e.g. v0.7.4) in the DECLARAGENT_VERSION example (line 35).  
  <sub>Evidence: Current in-tree version is 0.7.6 (packages/cli/package.json:3), npm latest 0.7.4; the verify block (installing.mdx:78-83) shows 0.4.1 for both the declaragent and d9t aliases, and the v1.0.2 pin example (line 35) would 404 in scripts/install.sh's verbatim URL construction (:91-92) since no v1.x tag exists.</sub>

### docs-site · Troubleshooting (11 findings)

#### `docs-site/docs/troubleshooting/deploy-403.mdx` — 2

- [x] **W0** · `:36` · critical/overstates · *either, hours*  
  **Claim:** "declaragent deploy --verify" is an IAM preflight that checks roles/run.admin, roles/iam.serviceAccountUser, roles/secretmanager.secretAccessor and "will tell you which [is missing] before gcloud has a chance to 403 you"  
  **Fix:** Rewrite the page (and flowchart node B) to present `declaragent deploy gcp-cloud-run --verify` as a post-deploy health check, and give manual `gcloud projects get-iam-policy` steps for the IAM preflight — or implement the promised IAM preflight in verifyGcpCloudRunDeploy (days of work).  
  <sub>Evidence: verifyGcpCloudRunDeploy (packages/cli/src/deploy-cli.ts:408-491) runs `gcloud run services describe` (:450-458) then fetches `<url>/health` (:480-491) — a post-deploy health probe that requires the service to already exist; its own docblock (:403-407) calls it exactly that. grep for run.admin/serviceAccountUser/secr…</sub>
- [x] **W2** · `:28` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** "The §9.2 preflight" links to docs/PHASE_7_PLAN.md on GitHub  
  **Fix:** Remove the dead link along with the preflight claim it anchors.  
  <sub>Evidence: docs/PHASE_7_PLAN.md does not exist (ls docs/ \| grep PHASE_7 → empty), so the GitHub link 404s, and no §9.2 IAM preflight was ever implemented (verifyGcpCloudRunDeploy is a describe + /health probe, deploy-cli.ts:403-491; zero IAM-role strings in packages/).</sub>

#### `docs-site/docs/troubleshooting/index.mdx` — 2

- [x] **W1** · `:41` · high/overstates · *either, hours*  
  **Claim:** "Every runbook expects DECLARAGENT_LOG_LEVEL=debug when reproducing an issue: DECLARAGENT_LOG_LEVEL=debug declaragent daemon"  
  **Fix:** Implement DECLARAGENT_LOG_LEVEL in the daemon/up logger, or delete the env var from this page and any runbook repro steps.  
  <sub>Evidence: DECLARAGENT_LOG_LEVEL is read nowhere: repo-wide grep for LOG_LEVEL across all of packages/ and scripts/ (*.ts, *.tsx, *.js) returns zero hits. Setting it is a silent no-op — users believe they are capturing debug logs when nothing changes. The `declaragent daemon` subcommand itself does exist (index.tsx:508).</sub>
- [x] **W2** · `:29` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Install flowchart: download 404 → "Check DECLARAGENT_VERSION. v1.0.x and later are expected."  
  **Fix:** Change to "expected tags are v0.x releases — check the GitHub releases page for valid values".  
  <sub>Evidence: No v1.x releases exist — the CLI is 0.7.6 in-tree (packages/cli/package.json:3) with 0.7.4 latest on npm per CLAUDE.md. scripts/install.sh:62 takes DECLARAGENT_VERSION verbatim and interpolates it into the download URL (:91-92), so pinning v1.0.x guarantees the exact 404 the flowchart is meant to fix.</sub>

#### `docs-site/docs/troubleshooting/error-codes.mdx` — 7

- [x] **W2** · `:10` · medium/understates · *fix-docs, hours*  
  **Claim:** "Every E* code emitted by the core runtime" (table of 13 codes)  
  **Fix:** Add rows for the seven missing RPC codes (incl. EVERSION_SKEW), especially AUTH_REJECTED given the 0.8.0 migration.  
  <sub>Evidence: CORRECTED count — core/src/rpc/errors.ts:9-33 defines SEVEN shipped codes missing from the table, not six: EAGENTRPC_NO_CAPABILITY, EAGENTRPC_INVALID_ENVELOPE, EAGENTRPC_AUTH_FAILED, EAGENTRPC_DEADLINE_EXCEEDED, EAGENTRPC_TENANT_MISMATCH, EVERSION_SKEW (missed by the first pass), plus the wire code AUTH_REJECTED — t…</sub>
- [x] **W2** · `:18` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** EQUOTA common cause: "dailyTokenUSD or requestsPerMinute on the tenant/agent tripped"  
  **Fix:** Replace requestsPerMinute with maxEventIngressPerSec (and optionally list the other real quota keys).  
  <sub>Evidence: The quota engine has no requestsPerMinute field — repo-wide grep returns zero hits. Actual quota keys tripped by tripIfExceeded: maxActiveSessions (core/src/tenancy/quota.ts:122), maxConcurrentToolCalls (:132), maxEventIngressPerSec (:147), dailyTokenUSD (:159). EQUOTA itself is real (quota.ts:23, engine.ts:600).</sub>
- [x] **W2** · `:22` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** First action for EAGENTRPC_TIMEOUT / EAGENTRPC_NO_PEER: "declaragent rpc peers --verify" / "declaragent rpc peers"  
  **Fix:** Change both rows (lines 22 and 25) to `declaragent fleet peers --verify` / `declaragent fleet peers`.  
  <sub>Evidence: There is no `rpc` subcommand — grep for a 'rpc' branch in packages/cli/src/index.tsx returns nothing (subcommand list covers plugin/skill/mcp/extensions/daemon/.../fleet/audit etc.). The working verb is `declaragent fleet peers [--verify]` (index.tsx:1043-1049 → fleetPeers in fleet-peers-cli.ts). Affects both line 2…</sub>
- [x] **W2** · `:26` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Fix for EAGENTRPC_NO_TRANSPORT: "install @declaragent/plugin-agent-rpc-kafka"  
  **Fix:** Point to @declaragent/plugin-agent-rpc (already a CLI dependency, packages/cli/package.json:36) and to checking the transport `kind` spelling in rpc-peers.yaml instead.  
  <sub>Evidence: That package does not exist — `ls packages/ \| grep rpc` shows only plugin-agent-rpc. The Kafka transport ships inside it (packages/plugin-agent-rpc/src/kafka-transport.ts), whose header comment (:11-14) explicitly says a separate @declaragent/plugin-agent-rpc-kafka package is a FUTURE split ("this module is the see…</sub>
- [x] **W2** · `:32` · medium/overstates · *fix-docs, minutes*  
  **Claim:** Codes are grouped into counters engine.errors.total{code=...} and channel.outbound.errors.total{code=...}  
  **Fix:** Replace the two invented metric names with the real ones (declaragent.provider.errors_total, channel.outbound.failed, channel.inbound.failed) and drop the {code=...} label claim.  
  <sub>Evidence: Neither metric name exists anywhere in packages/. Actual counters: declaragent.provider.errors_total (core/src/engine/engine.ts:406) and channel.outbound.failed / channel.inbound.failed (core/src/channels/base-channel.ts:195,208) — registered with name + help only, no code label.</sub>
- [x] **W2** · `:33` · medium/overstates · *fix-docs, minutes*  
  **Claim:** security.rules.yaml and daemon.rules.yaml fire on sustained spikes of EPERM, TENANT_BOUNDARY, EQUOTA  
  **Fix:** Say the alerts fire on the security/daemon metrics (secret_access_denied_total, tenant_boundary_violation_total, etc.) that correspond to these failure classes, not on the error codes themselves.  
  <sub>Evidence: packages/testkit/alerts/security.rules.yaml exprs key on secret_access_denied_total (:12), tenant_boundary_violation_total (:28), secret_rotation_age_seconds (:44), webhook_auth_failures_total (:60); daemon.rules.yaml keys on bus_inflight, daemon_last_heartbeat_seconds, session_active, source_messages_received. No r…</sub>
- [x] **W2** · `:15` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** EPERM first action: "see [Install](/quickstart/installing) for --mode flags"  
  **Fix:** Point to the CLI reference / REPL /mode documentation instead of the install page.  
  <sub>Evidence: installing.mdx (read in full) contains no --mode documentation; --mode <default\|plan\|bypass\|auto> is a REPL launch flag parsed in packages/cli/src/index.tsx:96-100 and surfaced by the /mode slash command (slash-commands.ts:36).</sub>

### docs-site · Cookbook (47 findings)

#### `docs-site/docs/cookbook/agent-rpc.mdx` — 3

- [x] **W0** · `:22` · critical/broken_example · *fix-docs, minutes*  
  **Claim:** declaragent init --template rpc-client / --template rpc-server  
  **Fix:** Change the scaffold section to use `declaragent init --fleet` + `declaragent fleet add --template rpc-client\|rpc-server`, or extend TEMPLATE_NAMES.  
  <sub>Evidence: TEMPLATE_NAMES (init-template-unpacker.ts) contains neither rpc-client nor rpc-server; init-wizard.tsx:82-84 errors 'unknown template'. templates/rpc-client and rpc-server dirs exist but are reachable only via `fleet add --template`.</sub>
- [x] **W1** · `:178` · high/broken_example · *fix-docs, minutes*  
  **Claim:** declaragent rpc peers / declaragent rpc capabilities inspect verbs  
  **Fix:** Replace with `declaragent fleet peers --verify` and `declaragent fleet capabilities`.  
  <sub>Evidence: Full `subcommand ===` dispatch list in index.tsx (lines 492-1564) has no 'rpc' branch. Real verbs: `fleet peers [--verify]` and `fleet capabilities` (fleet usage block, index.tsx:191,195).</sub>
- [x] **W2** · `:187` · medium/understates · *fix-docs, minutes*  
  **Claim:** Per-transport plugins (@declaragent/plugin-agent-rpc-kafka, -nats, -sqs, -amqp, -mqtt) follow the envelope in subsequent v1.1 slices  
  **Fix:** Update the Deferred section: transports shipped in-package (also add jetstream to the line-164 list); only @declaragent/plugin-github remains unpublished.  
  <sub>Evidence: All transports already ship inside @declaragent/plugin-agent-rpc: kafka-transport.ts, nats-transport.ts, jetstream-transport.ts, sqs-transport.ts, amqp-transport.ts, mqtt-transport.ts, memory-transport.ts in packages/plugin-agent-rpc/src/ (ls confirms); no separate -kafka/-nats packages exist under packages/.</sub>

#### `docs-site/docs/cookbook/cross-host-fleet-kafka.mdx` — 7

- [x] **W0** · `:26` · critical/broken_example · *fix-docs, hours*  
  **Claim:** rpc-peers.yaml peer shape: id/transport/topic/bootstrap/sasl/ssl + auth {enabled, provider: hs256, secret}  
  **Fix:** Rewrite the snippet using the real schema (agent/transports/kind/brokers/topics.requests + auth.provider hmac with keyId/secretRef) and move SASL to the server's capabilities.yaml — templates/fleet-starter/rpc-peers.yaml shows the correct shape.  
  <sub>Evidence: peerEntrySchema (core/src/rpc/peers-loader.ts:166-171) is .strict() requiring `agent: agent://<id>` + `transports: [...]` — id/transport/topic/bootstrap/sasl/ssl are all rejected. peerAuthSchema is a discriminated union on provider oidc \| oauth2-client \| hmac (peers-loader.ts:112-161); no hs256, no enabled/secret …</sub>
- [x] **W0** · `:60` · critical/broken_example · *fix-docs, minutes*  
  **Claim:** fleet.yaml hosts[] entries accept a `region:` key  
  **Fix:** Delete the region: lines from the hosts[] example (or encode region in the host name).  
  <sub>Evidence: fleetHostSchema (core/src/fleet/manifest-schema.ts:169-185) is .strict() with only name, url, auth, timeoutMs — `region` fails zod validation, so the copy-pasted fleet.yaml breaks every fleet verb.</sub>
- [x] **W1** · `:117` · high/broken_example · *fix-docs, minutes*  
  **Claim:** fleet dlq requeue --kind dispatch <id> / drop ... --reason; 'the command locates the host automatically'  
  **Fix:** Rewrite as `fleet dlq requeue --kind dispatch --id <id> --host <name>` (or --all-hosts --yes), drop --reason, and remove the auto-locate claim.  
  <sub>Evidence: index.tsx:1111-1126 mutation branch reads only --host/--id/--kind/--all-hosts/--yes; the positional <id> after the sub-verb is never read, so runFleetDlqMutation (fleet-cross-host-cli.ts:786-789) exits 1 '--id is required'. --reason is parsed only on the list path (index.tsx:1130). With >1 hosts and no --host it ref…</sub>
- [x] **W2** · `:17` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** use DECLARAGENT_CONTROL_PLANE_BIND=127.0.0.1 + a sidecar  
  **Fix:** Replace with DECLARAGENT_BIND_ADDRESS=127.0.0.1.  
  <sub>Evidence: Repo-wide grep: DECLARAGENT_CONTROL_PLANE_BIND appears nowhere; the bind env is DECLARAGENT_BIND_ADDRESS (up-cli.ts:1875 'Source: DECLARAGENT_BIND_ADDRESS (default 127.0.0.1)', :1892 reads it; k8s/helm renderers set it to 0.0.0.0).</sub>
- [x] **W2** · `:90` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** declaragent fleet events --json \| jq '. \| select(.kind == "tool_call")' filters the merged stream  
  **Fix:** Change the jq to `jq '.events[] \| select(.kind == "tool_call")'`.  
  <sub>Evidence: fleetEventsList --json emits a single object { events: [{host, agentId, ...entry}], failures } (fleet-cross-host-cli.ts:298-304); `. \| select(.kind == ...)` runs select on that wrapper object (no .kind) and outputs nothing. Needs `.events[] \| select(...)`.</sub>
- [x] **W2** · `:109` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** fleet ps --json \| jq '.hosts[] \| {host: .name, up: .agents \| length}'  
  **Fix:** Use jq '.hosts[] \| {host: .host.name, ok: .ok}' or drill into the status payload's actual agent list.  
  <sub>Evidence: fleetPs JSON rows are { host: <FleetHost obj>, ok, status\|error } (fleet-cross-host-cli.ts:168-176); `.name` and `.agents` are not top-level row keys, so the jq emits nulls.</sub>
- [x] **W2** · `:142` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Alert on source_messages_dlq_total{transport="kafka"} and source_inflight{transport="kafka"}  
  **Fix:** Change to source_messages_dlq{type="kafka"} and source_inflight{type="kafka"}.  
  <sub>Evidence: Counter is 'source.messages.dlq' (base-source.ts:170); the /metrics scrape this recipe wires renders it via normalizeMetricName (observability/prometheus.ts:197,237-251) which only maps dots to underscores — no _total suffix. Labels are {id, type} (base-source.ts:157), never transport. Evidence correction vs first p…</sub>

#### `docs-site/docs/cookbook/enterprise-zero-to-deploy.mdx` — 7

- [x] **W0** · `:60` · critical/broken_example · *fix-docs, minutes*  
  **Claim:** Running bare `declaragent` gives a REPL with the 15 Declara* builder tools (Steps 2-13 rely on it)  
  **Fix:** Prefix every REPL launch in the walkthrough with DECLARAGENT_BUILDER=on (Steps 2 and 13) and state the flag requirement in Prerequisites.  
  <sub>Evidence: builder/register.ts builderEnabled() returns env.DECLARAGENT_BUILDER === 'on'; getBuilderTools returns [] otherwise, and app.tsx:576 threads that through the REPL. The walkthrough never sets the flag (Step 2 line 60 runs plain `declaragent`, Step 13 line 394 runs `BUILDER_RECORD=1 declaragent`; grep for DECLARAGENT_…</sub>
- [x] **W0** · `:232` · critical/broken_example · *either, hours*  
  **Claim:** declaragent mcp add gh --transport http --url https://mcp.github.com (line 211 claims CLI verb supports stdio+http+sse+http-streamable with OAuth PKCE; repeated at line 474)  
  **Fix:** Change Step 6 (and the Honest-gaps bullet at line 474) to say remote (http/sse) MCP servers must be added by hand-editing ~/.declaragent/mcp-servers.json today, or ship --transport/--url flags on `mcp add` first.  
  <sub>Evidence: index.tsx usage: `mcp add <name> --command <cmd> [--args a,b,c] [--scope user\|project\|local]`; --command required (index.tsx:474-477 err '--command is required'), --transport/--url never parsed. mcpAdd (mcp-cli.ts:82-88) hardcodes transport type: 'stdio'; its doc comment says the stdio/http picker 'lands in slice …</sub>
- [x] **W1** · `:271` · high/broken_example · *fix-docs, minutes*  
  **Claim:** Proposal step runs `declaragent auth playbook slack`  
  **Fix:** Replace the runCommand step with the builder invoking its DeclaraAuthPlaybook tool directly (no `declaragent auth playbook` shell verb exists).  
  <sub>Evidence: index.tsx:1564-1618 — auth subcommands are exactly status, logout, login; anything else hits 'unknown auth subcommand'. The playbook exists only as builder tool DeclaraAuthPlaybook (createAuthPlaybookTool in builder/register.ts; AUTH_PLAYBOOKS exported from builder/index.ts).</sub>
- [x] **W1** · `:341` · high/broken_example · *fix-docs, hours*  
  **Claim:** curl -sX POST http://localhost:8787/webhook/concierge drives the fleet  
  **Fix:** Either add a webhook source to the scaffold steps (with an explicit port) or drive the demo through the REPL/RequestAgent path instead of curl.  
  <sub>Evidence: templates/rpc-client/event-sources.yaml declares only a single agent-inbox source — no webhook at all. Webhook default port is 7777 (core/src/events/sources/webhook.ts:90 'Port to bind. Default 7777', :509 defaultPort = 7777); 8787 exists only in deploy artifacts (deploy-dockerfile.ts EXPOSE 8787 9464).</sub>
- [x] **W2** · `:330` · medium/overstates · *fix-docs, minutes*  
  **Claim:** fleet run binds :9464 (metrics) by default; override with DECLARAGENT_METRICS_PORT  
  **Fix:** Remove the metrics-port line from the fleet-run proposal preview; note that /metrics is an `up` daemon feature.  
  <sub>Evidence: grep of packages/cli/src/fleet-run.ts for 9464 / METRICS_PORT / PrometheusRegistry / '/metrics' returns nothing — fleet-run has only in-memory FleetAgentWorkerMetrics counters. The 9464 metrics listener + DECLARAGENT_METRICS_PORT env belong to `up` only (up-cli.ts:592-604, 1944-1953).</sub>
- [x] **W2** · `:295` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** /fleet graph emits literally `graph LR\n  from-->\|label\| to` with edge label RequestAgent::review-pr::memory (cites fleet-graph-cli.ts:177)  
  **Fix:** Show the real mermaid output (node lines + `-->\|review-pr (memory)\|` edges + linkStyle lines).  
  <sub>Evidence: renderMermaid (fleet-graph-cli.ts:175-195) emits node declaration lines (`n_concierge["agent://concierge (client)"]`), edges `n_concierge -->\|review-pr (memory)\| n_pr_reviewer` via edgeLabel() (`${capability} (${transport})`), plus linkStyle color lines. The `RequestAgent::capability::transport` label format exist…</sub>
- [x] **W2** · `:389` · low/understates · *fix-docs, minutes*  
  **Claim:** peer auth providers are `oidc` and `oauth2-client` — peers-loader.ts:140  
  **Fix:** Change to 'peer auth providers are oidc, oauth2-client, and hmac (shared-secret via keyId/secretRef) — peers-loader.ts:157'.  
  <sub>Evidence: peerAuthSchema (core/src/rpc/peers-loader.ts:157-161) is a three-way union: oidc, oauth2-client, AND hmac (hmacPeerAuthSchema at 146-155, '@since 0.7.6', described as 'the zero-infra default'). Omitting hmac steers readers away from the simplest option; the cited line 140 is also mid-oauth2 block.</sub>

#### `docs-site/docs/cookbook/fleet-starter.mdx` — 1

- [x] **W0** · `:38` · critical/broken_example · *fix-docs, minutes*  
  **Claim:** declaragent init --template fleet-starter --out acme-fleet  
  **Fix:** Replace the scaffold command with `declaragent init --fleet acme-fleet` followed by two `fleet add --template ...` calls (or copy templates/fleet-starter manually).  
  <sub>Evidence: init-template-unpacker.ts TEMPLATE_NAMES = [concierge, oncall-escalator, pr-review, kafka-pipeline, multi-tenant-starter] (const, exhaustive); init-wizard.tsx:82-84 rejects anything else with '✗ unknown template'. enterprise-zero-to-deploy.mdx:87 documents the correct composition (init --fleet + fleet add).</sub>

#### `docs-site/docs/cookbook/grafana-tracing.mdx` — 3

- [x] **W0** · `:39` · critical/overstates · *either, hours*  
  **Claim:** A single trace shows spans channel.inbound.<platform>, bus.dispatch, engine.turn, tool.invoke, channel.outbound.<platform>  
  **Fix:** Rewrite the Explore section to list only source.message / channel.outbound.send / channel.outbound.edit (each a root span), or land the missing spans + propagation before republishing.  
  <sub>Evidence: Re-verified: grep over packages/core/src finds exactly three startSpan call sites — 'source.message' (events/base-source.ts:293), 'channel.outbound.send' (channels/base-channel.ts:240,258), 'channel.outbound.edit' (base-channel.ts:417). No engine.turn/tool.invoke/bus.dispatch/channel.inbound spans exist, and with no…</sub>
- [x] **W1** · `:17` · high/broken_example · *fix-docs, minutes*  
  **Claim:** Testkit docker-compose ships Prometheus, Tempo, and Grafana; Tempo on :3200; pick the Tempo data source (lines 9, 17, 37)  
  **Fix:** Replace Tempo references with Jaeger (jaegertracing/all-in-one:1.61, UI http://localhost:16686) to match the shipped compose file.  
  <sub>Evidence: packages/testkit/observability/docker-compose.yml (note: .yml, doc says .yaml) contains otel-collector, prom/prometheus:v2.54.1, grafana/grafana:11.2.0, and jaegertracing/all-in-one:1.61 with UI on :16686. No Tempo image, no :3200, so 'pick the Tempo data source' fails.</sub>
- [x] **W2** · `:29` · medium/overstates · *fix-docs, minutes*  
  **Claim:** export OTEL_SERVICE_NAME=declaragent-agent then search by service name; spans emitted by default  
  **Fix:** Drop OTEL_SERVICE_NAME (service is always 'declaragent') and add the required `npm i @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http` install step.  
  <sub>Evidence: OTEL_SERVICE_NAME appears nowhere in packages/ source (only in testkit/observability/README.md prose); up-cli.ts startOtelSdk call hardcodes serviceName: 'declaragent' (~line 2130). Line 9's 'emits OpenTelemetry spans by default' is also false: maybeCreateOtelTracer (up-cli.ts:2109-2141) no-ops with a warning unless…</sub>

#### `docs-site/docs/cookbook/oncall-escalator.mdx` — 2

- [x] **W0** · `:46` · critical/broken_example · *fix-docs, hours*  
  **Claim:** curl -X POST http://localhost:8787/webhooks/alertmanager -H 'X-Signature: $(cat fixtures/mock-alert.sig)' --data @fixtures/mock-alert.json  
  **Fix:** Correct to port 7777 + /webhook/alertmanager + X-Alertmanager-Signature, reference ./mock-alert.json, and show computing the HMAC inline with openssl.  
  <sub>Evidence: templates/oncall-escalator/event-sources.yaml binds path /webhook/alertmanager (singular) with headerName X-Alertmanager-Signature + timestampHeader X-Alertmanager-Timestamp; webhook default port is 7777 (webhook.ts:90,509); template ships mock-alert.json at the root — no fixtures/ dir, no .sig file (ls confirms). P…</sub>
- [x] **W2** · `:57` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** duplicate fingerprints within a 15-minute window are dropped at ingress  
  **Fix:** Change '15-minute' to '10-minute (in-memory cache) / 24-hour (store)' or just 'a dedup window'.  
  <sub>Evidence: DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000 (core/src/events/dispatcher.ts:20) and DEFAULT_DEDUP_WINDOW_MS = 24h (dispatcher.ts:22) — 15 minutes matches neither.</sub>

#### `docs-site/docs/cookbook/rotate-vault-secret.mdx` — 1

- [x] **W0** · `:22` · critical/overstates · *either, hours*  
  **Claim:** secrets rotate triggers cache invalidation, a secret_rotated bus event to every session, and channel adapters rebinding — zero-downtime graceful re-resolve  
  **Fix:** Rewrite 'What happens inside' to match shipped behavior (reachability check + audit record; live processes pick up new values on TTL expiry/restart), or build the rotate-fanout before republishing.  
  <sub>Evidence: secretsRotate (secrets-cli.ts:~210-289) resolves the ref once to prove reachability, writes a single kind:'secret_access' audit record (which does not even include --reason), and prints 'note: real rotation is provider-owned; this CLI verifies reachability + records an audit entry only.' grep for 'secret_rotated' ac…</sub>

#### `docs-site/docs/cookbook/zero-trust-rpc-migration.mdx` — 5

- [x] **W0** · `:95` · critical/broken_example · *fix-docs, minutes*  
  **Claim:** Opt in early / roll back via fleet.yaml `rpc: auth: enabled: true\|false` (also Rollback section line 125)  
  **Fix:** Move the opt-in/rollback YAML from fleet.yaml to each agent's agent.yaml (rpc.auth.enabled).  
  <sub>Evidence: fleet.yaml rpcSchema (manifest-schema.ts:127-134) is .strict() with only stampFleetVersion and minFleetVersion — an `auth:` key fails validation and breaks every fleet verb. The real knob is per-agent agent.yaml rpc.auth.enabled, exactly what the inspector reads (fleet-audit-rpc-cli.ts:87-123 readAgentRpcAuthState).</sub>
- [x] **W1** · `:29` · high/broken_example · *fix-docs, minutes*  
  **Claim:** audit-rpc --json emits .findings[] with categories OK / MISSING_AUTH / MISSING_PEERS_FILE / INVALID_PROVIDER  
  **Fix:** Document the real JSON shape (`jq '.agents[]'`) and the real state values enabled/disabled/absent/unreadable.  
  <sub>Evidence: renderJson (fleet-audit-rpc-cli.ts:306-330) emits {ok, allEnabled, agents:[{agentId, agentYamlPath, state, reason?, peerAuthProvider?, suggestion?}]} — no findings key. RpcAuthState = 'enabled' \| 'disabled' \| 'absent' \| 'unreadable' (fleet-audit-rpc-cli.ts:53); the four documented categories exist nowhere.</sub>
- [x] **W1** · `:47` · high/overstates · *fix-docs, hours*  
  **Claim:** --suggest-enable emits a per-peer rpc-peers.yaml diff adding auth: enabled/provider: hs256/secret/audience/issuer  
  **Fix:** Show the actual output (agent.yaml rpc.auth.enabled snippet with provider-echo comment) and explain the auth provider block is hand-authored in rpc-peers.yaml.  
  <sub>Evidence: suggestRpcAuthYaml (fleet-audit-rpc-cli.ts:171-192) emits an agent.yaml snippet 'rpc:\n  auth:\n    enabled: true' plus comments echoing the peer's declared provider; its own comment states 'rpc.auth today only consumes enabled; the provider block lives in rpc-peers.yaml'. It never generates provider/secret/audience…</sub>
- [x] **W1** · `:66` · high/overstates · *fix-docs, minutes*  
  **Claim:** Common auth providers table: hs256 (shared secret), rs256 (JWKS URL), oidc  
  **Fix:** Replace the table rows with hmac (keyId/secretRef), oidc (issuer/audience/jwksUri), oauth2-client (tokenEndpoint/clientId/clientSecretRef).  
  <sub>Evidence: peerAuthSchema is a discriminated union on provider 'oidc' \| 'oauth2-client' \| 'hmac' (peers-loader.ts:112-161). hs256 and rs256 do not exist anywhere; the shared-secret option is hmac with keyId + secretRef (hmacPeerAuthSchema, peers-loader.ts:146-155).</sub>
- [x] **W1** · `:108` · high/broken_example · *fix-docs, minutes*  
  **Claim:** declaragent fleet up -d  
  **Fix:** Replace with `declaragent up -d` (fleet.yaml-aware) or `declaragent fleet run` under a supervisor.  
  <sub>Evidence: The fleet usage string (index.tsx:1170-1172) lists new\|add\|run\|promote\|demote\|deploy\|render\|graph\|peers\|status\|list\|validate\|capabilities\|audit-rpc\|ps\|events\|dlq\|logs — no `up`, and fleet run parses only repeatable --agent (usage line 185), no -d/--detach.</sub>

#### `docs-site/docs/cookbook/build-an-agent.mdx` — 1

- [x] **W1** · `:151` · high/overstates · *fix-docs, minutes*  
  **Claim:** To deploy, switch to /mode bypass — bypass lets you run `declaragent deploy gcp-cloud-run` from the REPL (also lines 193-194)  
  **Fix:** Replace the /mode bypass advice with 'run declaragent deploy outside the REPL' in both places (line 194 already offers that as the alternative — make it the only path).  
  <sub>Evidence: createPermissionGate (core/src/permission/gate.ts:64-72): 'Explicit deny beats everything, in every mode' — the deny match returns before the mode switch, so DEFAULT_DEPLOY_DENY_RULES ('Bash:declaragent deploy*', builder/index.ts:156-162) still blocks under /mode bypass. enterprise-zero-to-deploy.mdx:362 states the …</sub>

#### `docs-site/docs/cookbook/deploy-cloud-run.mdx` — 1

- [x] **W1** · `:36` · high/broken_example · *fix-docs, hours*  
  **Claim:** Verify locally: docker build -t declaragent-agent .declaragent/deploy/  
  **Fix:** Document the prerequisite of placing the linux binary at .declaragent/deploy/bin/ and the config dir (per the generated README) before docker build, or drop the local dry-run section.  
  <sub>Evidence: deployGcpCloudRun writes exactly Dockerfile/.dockerignore/service.yaml/README (deploy-cli.ts:339-343), but renderDockerfile (deploy-dockerfile.ts:5-17) emits `COPY bin/${BINARY}` (declaragent-linux-x64) and `COPY config /etc/declaragent` — neither bin/ nor config/ is ever staged into .declaragent/deploy, so the buil…</sub>

#### `docs-site/docs/cookbook/grafana-dashboard-import.mdx` — 2

- [x] **W1** · `:126` · high/overstates · *fix-docs, minutes*  
  **Claim:** The same counters flow through OTel when OTEL_EXPORTER_OTLP_ENDPOINT is set  
  **Fix:** Remove the metrics-over-OTel sentence; OTLP endpoint affects spans only, and only after users install the OTel peer deps.  
  <sub>Evidence: maybeCreateOtelTracer (up-cli.ts:2109-2141) takes only bridge.tracer and discards the meter; startOtelSdk exports spans only. No metric-over-OTLP path exists in `up`, and the OTel packages are root devDependencies not shipped with published packages (prior red-team confirmed).</sub>
- [x] **W2** · `:112` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** Alert expr rate(source_messages_dlq_total{kind="dispatch"}[10m]) > 0 for dispatch-DLQ growth  
  **Fix:** Use rate(source_messages_dlq[10m]) > 0 and drop the kind label; note dispatch-DLQ depth has no Prometheus series today.  
  <sub>Evidence: Direct /metrics scrape (this page's Step 1-2 pipeline) renders 'source.messages.dlq' as source_messages_dlq — normalizeMetricName (observability/prometheus.ts:237-251) appends no _total — with labels {id, type} (base-source.ts:157); no kind label exists, and the dispatch DLQ has no Prometheus series. The page's own …</sub>

#### `docs-site/docs/cookbook/index.mdx` — 2

- [x] **W1** · `:43` · high/overstates · *fix-docs, minutes*  
  **Claim:** Enterprise walkthrough is ~90 minutes and exercises OIDC, OTel, cross-host, and GitOps to a local k3d cluster with ArgoCD (repeated at line 47: 'live on k3d via ArgoCD')  
  **Fix:** Rewrite the teaser (and the line-47 table row) to match the walkthrough's actual scope: Vault, builder flow, rate limits, SIEM, fleet render + Cloud Run artifacts, ~60 min.  
  <sub>Evidence: enterprise-zero-to-deploy.mdx:3,13 says ~60 min; the page contains no k3d, no ArgoCD steps (Step 15 renders manifests and links out to the GitOps recipe), no OIDC login (auth login anthropic is paste-a-key), no OTel step, no cross-host section.</sub>
- [x] **W2** · `:15` · medium/overstates · *fix-docs, minutes*  
  **Claim:** Five starter packs ship with the `declaragent init` wizard — table then lists 7 including rpc-client+rpc-server and fleet-starter  
  **Fix:** Split the table into 'init templates (5)' and 'fleet templates (via fleet add / init --fleet)' sections.  
  <sub>Evidence: TEMPLATE_NAMES accepts exactly 5 (init-template-unpacker.ts); rpc-client/rpc-server/fleet-starter are only reachable via `fleet add --template` / `init --fleet`, but table rows 6-7 sit under the 'ship with the init wizard' heading.</sub>

#### `docs-site/docs/cookbook/siem-audit-export.mdx` — 4

- [x] **W1** · `:110` · high/overstates · *fix-docs, minutes*  
  **Claim:** index: "declaragent_${tenant:id}" — index is set per-tenant at runtime  
  **Fix:** Delete the per-tenant index templating example; recommend routing on the exported tenantId field at SIEM ingest instead.  
  <sub>Evidence: grep for '${tenant' across packages/core/src + packages/cli/src returns zero hits; the splunk export schema's index is a plain optional z.string() (load-agent.ts:~426) passed through verbatim. All tenants would land in one literal index named 'declaragent_${tenant:id}'.</sub>
- [x] **W2** · `:97` · medium/overstates · *either, hours*  
  **Claim:** Alert on declaragent_audit_export_last_seq lag vs declaragent_audit_last_seq  
  **Fix:** Drop the lag row or add a chain-head last-seq gauge to the sink before documenting it.  
  <sub>Evidence: Only 'declaragent.audit.export.last_seq' is registered (exporter-loop.ts:229-232); grep finds no chain-head gauge (declaragent_audit_last_seq / audit.last_seq) anywhere, so the documented lag comparison cannot be built in Prometheus.</sub>
- [x] **W2** · `:13` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** metrics named audit_backpressure_paused_total and audit_batch_interval_ms (intro bullets, lines 13-14)  
  **Fix:** Add the declaragent_ prefix to the two metric names in the intro bullets.  
  <sub>Evidence: Registered names are 'declaragent.audit.backpressure.paused_total' (exporter-loop.ts:236) and 'declaragent.audit.batch.interval_ms' (exporter-loop.ts:253) → wire names carry the declaragent_ prefix. The doc's own metrics table at lines 94-96 uses the correct prefixed names; the intro parentheses don't.</sub>
- [x] **W2** · `:60` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Elastic auth modes — see packages/core/src/agents/load-agent.ts:370  
  **Fix:** Update the line reference to the elastic auth union (~load-agent.ts:438).  
  <sub>Evidence: load-agent.ts:370 sits inside the controlPlane.auth oidc block (verified by reading 360-375); the elastic auth union (apiKey/basic/bearer) is at load-agent.ts:438-446. The auth modes themselves are documented correctly.</sub>

#### `docs-site/docs/cookbook/two-tenants-one-daemon.mdx` — 3

- [x] **W1** · `:36` · high/broken_example · *fix-docs, minutes*  
  **Claim:** tenants.yaml quotas accept requestsPerMinute (lines 36 and 43)  
  **Fix:** Replace requestsPerMinute with maxEventIngressPerSec (or drop it) in both tenant examples.  
  <sub>Evidence: quotasSchema (core/src/tenancy/config-loader.ts:52-59) is .strict() with only maxActiveSessions, dailyTokenUSD, maxConcurrentToolCalls, maxEventIngressPerSec — requestsPerMinute fails validation and the daemon rejects the file.</sub>
- [x] **W2** · `:67` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** declaragent audit query --kind tenant_boundary_denied (also line 72; repeated in multi-tenant-starter.mdx:41 and :48)  
  **Fix:** s/tenant_boundary_denied/tenant_boundary_violation/ in both cookbook pages (4 occurrences).  
  <sub>Evidence: The audit kind is 'tenant_boundary_violation' (core/src/audit/types.ts:59; doc comment at :15); 'tenant_boundary_denied' appears nowhere in packages/. Queries for the documented kind always return zero rows — which the docs then interpret as 'healthy', silently defeating the boundary check.</sub>
- [x] **W2** · `:16` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Metrics — every Prometheus series gets a `tenant=` label (repeated at line 73: 'auto-stamps tenant= on every series')  
  **Fix:** s/`tenant=`/`tenant_id=`/ in both bullets.  
  <sub>Evidence: The label is `tenant_id`, not `tenant`: daemon.ts:346 creates each tenant registry with constLabels: { tenant_id: tenant.id } (mechanism documented at observability/prometheus.ts:39-41 and tenancy/runtime.ts:37,67). PromQL selectors written as {tenant="acme-prod"} match nothing.</sub>

#### `docs-site/docs/cookbook/gitops-argocd-flux.mdx` — 1

- [x] **W2** · `:33` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Helm output tree: templates/deployment-<agent>.yaml, service-<agent>.yaml, servicemonitor-<agent>.yaml, secret-<agent>.yaml, README.md  
  **Fix:** Replace the output-shape block with the real chart layout from helm-renderer.ts:5-16.  
  <sub>Evidence: helm-renderer.ts:5-16 header documents (and renderHelm emits) Chart.yaml, values.yaml, .helmignore, templates/_helpers.tpl, namespace.yaml, secret.yaml (single), agents/<id>.yaml (combined ConfigMap+Deployment+Service+optional ServiceMonitor). No per-agent split files, no README in the chart.</sub>

#### `docs-site/docs/cookbook/kafka-pipeline.mdx` — 2

- [x] **W2** · `:29` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** rpk topic produce orders.created --brokers localhost:19092 < fixtures/order.json  
  **Fix:** Either ship fixtures/order.json in the template or switch the doc to the compose file's inline-payload invocation (`echo '{"id":"o-1",...}' \| docker compose exec -T redpanda rpk topic produce orders.created`).  
  <sub>Evidence: templates/kafka-pipeline/ contains only README.md, agent.yaml, docker-compose.yaml, event-sources.yaml, skills/enrich.md — no fixtures/ dir and no order.json, so the redirect fails. The template's own docker-compose.yaml:12-14 shows the working invocation (docker compose exec -T redpanda rpk topic produce with an in…</sub>
- [x] **W2** · `:43` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** The message's Kafka (topic, partition, offset) is the idempotency key  
  **Fix:** State that this template dedupes on the payload's $.id (routing.idempotencyKey), and rename 'enrich-order' to 'enrich' at line 35.  
  <sub>Evidence: The template's source config uses a JSON-path payload key: routing.idempotencyKey.path: $.id (templates/kafka-pipeline/event-sources.yaml:30-31), with the header comment 'Pull the stable order id out of the payload for dedup', and skills/enrich.md declares the id input as 'used as the idempotency key'. Doc line 35 a…</sub>

#### `docs-site/docs/cookbook/pr-review.mdx` — 1

- [x] **W2** · `:23` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Point the app's webhook at https://<your-host>/webhooks/github  
  **Fix:** s\|/webhooks/github\|/webhook/github\| (and note the default port 7777 for local testing).  
  <sub>Evidence: templates/pr-review/event-sources.yaml:9 binds path: /webhook/github (singular). A GitHub App pointed at /webhooks/github gets 404s on every delivery — same singular/plural mismatch class as the oncall-escalator page.</sub>

#### `docs-site/docs/cookbook/concierge.mdx` — 1

- [x] **W2** · `:24` · low/overstates · *either, minutes*  
  **Claim:** Files produced include .env.example (list: agent.yaml, skills/concierge.md, channels.yaml, .env.example, README.md); 'the wizard unpacks that directory verbatim'  
  **Fix:** Add .env.example to templates/concierge (and oncall-escalator) or drop it from the doc's file tree and reword the README copy step.  
  <sub>Evidence: templates/concierge/ contains only README.md, agent.yaml, channels.yaml, skills/concierge.md — no .env.example (ls confirms), even though the template's own README tells users to `cp .env.example .env`. Since the unpacker copies the directory verbatim, scaffolded projects miss the file the docs (and README) referenc…</sub>

### Status ledgers (24 findings)

#### `CLAUDE.md` — 10

- [x] **W0** · `:66` · critical/overstates · *either, minutes*  
  **Claim:** `declaragent fleet run` → multi-agent runtime over `memory`, `kafka`, `nats`, `jetstream`, `sqs`, `amqp`, `mqtt` transports  
  **Fix:** Change the bullet to '…over `memory`, `kafka`, `nats` transports (JetStream via `kind: nats`; SQS/AMQP/MQTT exist as `@declaragent/plugin-agent-rpc` library factories, not yet constructible from `fleet.yaml`)' — or wire the remaining factories into buildTransportFactories (days of work).  
  <sub>Evidence: Verified: packages/cli/src/transport-factories.ts:116 SUPPORTED_FACTORY_KINDS = ['kafka','nats']; buildTransportFactories (79-113) constructs only kafka+nats and its doc header (74-77) says other kinds 'still warn-skip in startFleetDaemon'. 'jetstream' is not a RpcTransportKind (packages/core/src/rpc/types.ts:12) — …</sub>
- [x] **W1** · `:36` · high/overstates · *either, minutes*  
  **Claim:** Pillar 3 enterprise ✅ (v0.7.4) — 'every named broker transport shipped' (memory + Kafka / NATS / JetStream / SQS / AMQP / MQTT RPC)  
  **Fix:** Qualify the row: 'Kafka + NATS wired into `fleet run` (JetStream reachable via kind: nats); SQS/AMQP/MQTT shipped as library transports only' — or add the missing CLI factory wiring before keeping the ✅.  
  <sub>Evidence: Verified: only kafka+nats constructible by the CLI (transport-factories.ts:116, factories at 79-113); sqs/amqp/mqtt declared in fleet.yaml warn-skip; 'jetstream' is not a config kind (core/src/rpc/types.ts:12). 'Shipped' holds only at the plugin-agent-rpc library layer (jetstream/sqs/amqp/mqtt-transport.ts all exist…</sub>
- [x] **W1** · `:42` · high/overstates · *fix-docs, minutes*  
  **Claim:** **Enterprise production: ✅ (5 of 5 pillars)** — stated flatly, while the accuracy note at line 28 in the same file says the ✅ enterprise marks are overstated and 'enterprise readiness is still partial'  
  **Fix:** Downgrade the enterprise-column marks and the bold 'Enterprise production: ✅ (5 of 5 pillars)' line to match the accuracy note (e.g. '⚠️ partial — see accuracy note') instead of keeping contradictory ✅s.  
  <sub>Evidence: Verified internal contradiction: CLAUDE.md:28 accuracy note ('enterprise readiness is still partial — live-broker cross-host delegation, k8s deploy, real OTel export, multi-tenancy, and the soak proof remain') vs the all-✅ table (34-38) and the bold 5-of-5 at 42. Code sides with the note: CLI fleet transports kafka+…</sub>
- [x] **W1** · `:65` · high/broken_example · *fix-docs, minutes*  
  **Claim:** `declaragent fleet render --format k8s\|helm` → GitOps manifests  
  **Fix:** Replace with `declaragent fleet render --target k8s\|helm [--format helm\|kustomize]` here and in COMPAT.md:48 + AGENTS.md:186.  
  <sub>Evidence: Verified: packages/cli/src/fleet-render-cli.ts:90-105 — the target selector is the required `--target` flag (k8s\|helm); `--format` is a separate helm\|kustomize output modifier and unknown values exit 1 ('unknown --format "k8s". Supported: helm, kustomize.'). Copy-pasting the documented command fails. Same broken s…</sub>
- [x] **W2** · `:46` · medium/understates · *fix-docs, minutes*  
  **Claim:** #50 Slice 6b — `fleet dlq drop/requeue` cross-host mutations '(snapshot + logs -f shipped; mutations pending)'  
  **Fix:** Move #50 Slice 6b from 'Top open work' to shipped-in-working-tree (also update 'Next priorities' item 3 at line 87).  
  <sub>Evidence: Verified: packages/cli/src/fleet-cross-host-cli.ts:693+ implements '`fleet dlq drop` + `fleet dlq requeue` — cross-host mutations … Slice 6b of POST_ENTERPRISE_BACKLOG.md #50' with --host / --all-hosts / --yes semantics, ambiguous-target exit 2, confirmation prompt, and per-host failure isolation (FleetDlqMutationAr…</sub>
- [x] **W2** · `:86` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** #51 Grafana dashboard aggregating 'the key counters' including `audit_export_queue_depth` (plus unprefixed `rate_limit_waits_total`, `audit_backpressure_paused_total`, `audit_batch_interval_ms`)  
  **Fix:** Replace `audit_export_queue_depth` with a real metric (declaragent_audit_backpressure_backlog_ms or declaragent_audit_export_last_seq) and use exact exposition names for the audit/rate-limit entries (declaragent_audit_backpressure_paused_total, declaragent_audit_batch_interval_ms, declaragent_tool_rate_limit_waits_total); the mcp_* names are already correct. Also fix the sibling list at line 44.  
  <sub>Evidence: Verified with one refinement: no metric named audit_export_queue_depth exists anywhere (grep of packages/). The audit exporter registers declaragent.audit.export.{acked_total,failures_total,paused,last_seq}, declaragent.audit.backpressure.{paused_total,active,drops_total,backlog_ms}, declaragent.audit.batch.{interva…</sub>
- [x] **W2** · `:7` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** 'latest published `@declaragent/cli@0.7.4` … 0.7.5 (docs-only Sprint 5) is in-flight'  
  **Fix:** Update to '…in-flight at HEAD: 0.7.6 (branch agent-durability-followups)' and re-verify the npm dist-tag claim (`npm view @declaragent/cli dist-tags`) when refreshing the line-56 status header.  
  <sub>Evidence: At HEAD, packages/cli/package.json is 0.7.6 (core 0.5.5, testkit 4.0.5) and a v0.7.6 git tag exists — so the in-flight version is 0.7.6, not 0.7.5. The header (and the 'verified 2026-04-23' status heading at line 56) is at least one release cycle stale on the same axis STATUS.md:60 was flagged for; STATUS.md:53-55 e…</sub>
- [x] **W2** · `:37` · low/overstates · *fix-docs, minutes*  
  **Claim:** Pillar 4: 'Tools + MCP (8 built-ins + MCP stdio/HTTP/SSE/OAuth PKCE + plugins)'  
  **Fix:** Change '8 built-ins' to '7 built-ins (+ SendMessage when channels are configured)'.  
  <sub>Evidence: Verified: packages/cli/src/builtin-tools.ts:13 — BUILTIN_TOOLS = [Read, Write, Edit, GlobTool, Grep, Bash, Agent]: 7 tools. SendMessage is appended via extraTools only when a channel runtime exists (up-cli.ts:1446-1453). AGENTS.md rows 64/73 correctly say 7.</sub>
- [x] **W2** · `:45` · low/understates · *fix-docs, minutes*  
  **Claim:** Builder polish (#36–#38) — `tool_result` blocks in BUILDER_RECORD (#36) and cache-token cost regression (#37) 'remain open' (also lines 38, 88)  
  **Fix:** Mark #36/#37 as landed in the working tree (fixtures 06+07 + recorder support), leaving only #38 (longer-lived RecordingProviderHandle) open — update lines 38, 45, 88.  
  <sub>Evidence: Verified: fixtures exist at packages/cli/src/builder/fixtures/06-cache-usage-regression.jsonl and 07-tool-result-replay.jsonl, replayed in packages/cli/src/builder/__tests__/fixture-replay.test.ts:147,161; recording-provider.ts:38-56 documents #36 tool_result capture ('The recorder now detects tool_result blocks…') …</sub>
- [x] **W2** · `:62` · low/overstates · *fix-docs, minutes*  
  **Claim:** '`logs` coalesces per-agent lines and caps multi-agent fan-out at 50 watchers' (attributed to the local `declaragent ps / logs / down` lifecycle verbs)  
  **Fix:** Reword to: '`logs` prefixes each line with its agent id; the 50-watcher fan-out cap (413 over-cap) applies to the control-plane `/logs` route, not the local verb.'  
  <sub>Evidence: The local `declaragent logs` verb has NO watcher cap: packages/cli/src/logs-cli.ts:83-90 opens one fs.watch per matched agent unbounded (its only '50' default is the tail window of 50 lines/agent, lines 36+70). The 50-watcher cap with 413 lives exclusively on the control-plane `/logs` SSE route: packages/core/src/ob…</sub>

#### `AGENTS.md` — 5

- [x] **W1** · `:118` · high/overstates · *fix-code, hours*  
  **Claim:** OpenTelemetry tracing attached by default ✅ — `createOtelBridge()` auto-loads when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (and §0 line 43: 'OTel NodeSDK actually starts (spans export) ✅ live-verified')  
  **Fix:** Declare @opentelemetry/api (+ sdk-node/exporter as optional peers) in the published core/cli package.json so the ✅ holds for npm installs, or amend rows 43/118/180 to 'works only when the operator installs the OTel packages themselves'.  
  <sub>Evidence: Verified (repeats a pre-confirmed red-team delta): @opentelemetry/{api,sdk-node,exporter-trace-otlp-http} appear ONLY in the root monorepo package.json devDependencies (lines 24-26); packages/core/package.json declares deps @anthropic-ai/sdk, chokidar, yaml, zod — no OTel dep or peerDep; packages/cli/package.json li…</sub>
- [x] **W1** · `:162` · high/overstates · *fix-code, hours*  
  **Claim:** Provider rate limits enforced by default ✅ — 'Token bucket wraps every provider'  
  **Fix:** Extract wrapProviderWithRateLimit to a shared module and wrap the fleet-run provider with the same token bucket (or amend the row to 'enforced in `up`; `fleet run` provider is un-rate-limited').  
  <sub>Evidence: Verified (repeats a pre-confirmed red-team delta): packages/cli/src/fleet-run.ts:1035 builds the fleet-run provider via bare createProviderFromCreds({ creds }) and hands it straight to createLLMHandlerFactory — no rate-limit wrap anywhere in fleet-run.ts or fleet-run-llm-handler.ts (grep for withRateLimit/rate finds…</sub>
- [x] **W2** · `:76` · medium/stale_reference · *fix-docs, hours*  
  **Claim:** File:line evidence pointers: 'up-cli.ts:397-408 bringUp()', 'buildRuntimeTools({ mcpTools }) at line 632', 'up-cli.ts:598-613' (line 78), 'buildRuntimeTools({ extra })' (line 89), 'fleet-run.ts:641-649' (line 87), 'up…  
  **Fix:** Refresh every file:line pointer in §2/§3/§6 and replace the retired buildRuntimeTools references with resolveRuntimeTools (resolve-tools.ts).  
  <sub>Evidence: All verified drifted: bringUp at up-cli.ts:979; loadScopedMCPServers/startMCPServers at 1071-1072; startChannelRuntime at 1147; startPluginRuntime at 1426; createSendMessageTool constructed at 1449; rpc-peers.yaml loading at fleet-run.ts:1046-1057; createSendMessageTool exported from core index.ts:258. Crucially, bu…</sub>
- [x] **W2** · `:92` · medium/understates · *fix-docs, minutes*  
  **Claim:** SQS / AMQP / MQTT RPC transport factories 🔵 'Deliberately deferred to v1.1+ per AGENT_RPC_PLAN.md §5'  
  **Fix:** Update the row (and lines 202/273) to '🟡 library factories shipped in plugin-agent-rpc (tested); not constructible from fleet.yaml — CLI factory map still kafka+nats only'.  
  <sub>Evidence: Verified: packages/plugin-agent-rpc/src/{sqs,amqp,mqtt,jetstream}-transport.ts all exist with colocated .test.ts files and are exported from src/index.ts (createJetStreamTransport line 92, createSqsTransport line 108, createAmqpTransport line 119, createMqttTransport line 131); packages/testkit/src/fleet-integration…</sub>
- [x] **W2** · `:186` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** Happy-path step 10: '`declaragent fleet render --format k8s` → portable k8s manifests (Helm supported)'  
  **Fix:** Change step 10 to '`declaragent fleet render --target k8s` → portable k8s manifests (`--target helm` supported; `--format kustomize` optional with k8s)'.  
  <sub>Evidence: Same broken flag spelling the first pass caught in CLAUDE.md:65 and COMPAT.md:48 but missed here: packages/cli/src/fleet-render-cli.ts:90-97 exits 1 without the required `--target` ('--target is required. Supported: k8s, helm.'), and lines 99-105 reject `--format k8s` ('unknown --format "k8s". Supported: helm, kusto…</sub>

#### `README.md` — 3

- [x] **W1** · `:36` · high/overstates · *either, minutes*  
  **Claim:** Event sources — cron, webhook, file-watch, plus broker adapters… DLQ + replay + hot reload  
  **Fix:** Drop 'hot reload' and qualify replay as Kafka-only in the README bullet, or implement source hot-reload behind the existing control-socket `reload` op (days).  
  <sub>Evidence: Verified: packages/cli/src/up-cli.ts:1322-1325 — the control-socket reload op returns { reloaded: false, reason: 'unsupported', message: 'hot reload of sources is not implemented; restart `declaragent up` to apply changes' }. Replay is adapter-gated: events-cli.ts:156-161 doc comment says replay-range 'Requires the …</sub>
- [x] **W2** · `:41` · medium/overstates · *fix-docs, minutes*  
  **Claim:** Agent RPC — typed request/response between agents over **any broker**  
  **Fix:** Replace 'over any broker' with 'over Kafka or NATS from fleet.yaml (JetStream/SQS/AMQP/MQTT via the plugin-agent-rpc library)'.  
  <sub>Evidence: Verified: `fleet run` constructs only kafka and nats transports (packages/cli/src/transport-factories.ts:116, factories 79-113); plugin-agent-rpc adds jetstream/sqs/amqp/mqtt for programmatic use (src/index.ts:92-131). Six specific brokers, not 'any', and only two reachable from fleet.yaml.</sub>
- [x] **W2** · `:33` · low/overstates · *fix-docs, minutes*  
  **Claim:** Runtime core — built-in tools (Read / Write / Edit / Glob / Grep / Bash / Agent / SendMessage)  
  **Fix:** List SendMessage separately as channel-conditional: '…Bash / Agent; plus SendMessage when channels are configured'.  
  <sub>Evidence: Verified: SendMessage is not in BUILTIN_TOOLS (packages/cli/src/builtin-tools.ts:13); createSendMessageTool is pushed onto extraTools only when channelsRuntime !== undefined (up-cli.ts:1446-1453), so agents without channels never see it.</sub>

#### `docs/COMPAT.md` — 2

- [x] **W1** · `:48` · high/broken_example · *fix-docs, minutes*  
  **Claim:** Frozen 1.0 CLI verb surface includes `declaragent fleet render --format k8s\|helm`  
  **Fix:** Change the frozen verb to `declaragent fleet render --target k8s\|helm [--format helm\|kustomize]`.  
  <sub>Evidence: Verified: packages/cli/src/fleet-render-cli.ts:90-97 — no --target ⇒ exit 1 with '--target is required. Supported: k8s, helm. usage: declaragent fleet render --target <k8s\|helm> [--format <helm\|kustomize>]'; lines 99-105 reject unknown --format values, so `--format k8s` errors either way. The compat contract freez…</sub>
- [x] **W2** · `:24` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Authoritative loader: load-agent.ts (`loadAgent`, around line 575)  
  **Fix:** Update the pointer to 'around line 740' or drop the line number and reference the exported symbol only.  
  <sub>Evidence: Verified: packages/core/src/agents/load-agent.ts:740 — `export async function loadAgent(options: LoadAgentOptions): Promise<LoadedAgent>`; ~165 lines below the cited location. (The audit-types pointers in the same doc — TenantAuditRecord ~240, StoredAuditEntry ~290, VerifyReport ~300 — all still check out, as does t…</sub>

#### `docs/STATUS.md` — 4

- [x] **W1** · `:41` · high/overstates · *either, minutes*  
  **Claim:** Pillar 3 enterprise ✅ (v0.7.4 — JetStream / SQS / AMQP / MQTT all shipped; soak accumulating)  
  **Fix:** Reword to 'JetStream/SQS/AMQP/MQTT shipped as library transports; only Kafka + NATS constructible from fleet.yaml' or wire the factories into the CLI.  
  <sub>Evidence: Verified: SUPPORTED_FACTORY_KINDS = ['kafka','nats'] (packages/cli/src/transport-factories.ts:116); `declaragent fleet run` cannot instantiate sqs/amqp/mqtt (warn-skip per the factory doc header, lines 74-77) and 'jetstream' is not a config kind (packages/core/src/rpc/types.ts:12). The four transports exist only as …</sub>
- [x] **W1** · `:45` · high/overstates · *fix-docs, minutes*  
  **Claim:** **Single-machine production: ✅. Enterprise production: ✅ (5 of 5 pillars).** (reproduced 'verbatim' as the canonical scoreboard, with no accuracy caveat)  
  **Fix:** Carry the CLAUDE.md accuracy note into the scoreboard (or downgrade the enterprise column) so the self-declared source of truth doesn't repeat the overstated 5-of-5 marks.  
  <sub>Evidence: Verified: STATUS.md:3-7 declares 'when this file and any other doc disagree about current status, this file wins', then lines 45-47 repeat the 5-of-5 claim with zero caveat — while CLAUDE.md:28's accuracy note disowns those marks and code confirms the gaps (kafka+nats-only CLI transports at transport-factories.ts:11…</sub>
- [x] **W2** · `:60` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Current package versions 'at HEAD — the source of truth': cli 0.7.5, core 0.5.4, testkit 4.0.4  
  **Fix:** Bump the three stale rows (cli 0.7.6, core 0.5.5, testkit 4.0.5) and refresh the 'Last refreshed: 2026-06-04' date.  
  <sub>Evidence: Verified at HEAD: @declaragent/cli 0.7.6 (packages/cli/package.json), @declaragent/core 0.5.5 (packages/core/package.json), @declaragent/testkit 4.0.5 (packages/testkit/package.json). The other rows are still correct (plugin-agent-rpc 4.0.3, channels/sources 4.0.0, root 0.0.0 private). A table that self-describes as…</sub>
- [x] **W2** · `:69` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** 'no v<cli-version> git tag exists — the newest v* tag is v0.5.21, so the binary-release pipeline keyed on v* tags has not fired for any 0.6.0→0.7.5 release'  
  **Fix:** Update the paragraph: v0.7.6 tag exists and matches the HEAD CLI version; rescope the gap to the untagged 0.6.0–0.7.5 history and record whether release-binaries.yml fired for v0.7.6.  
  <sub>Evidence: Verified: `git tag -l 'v*'` newest is v0.7.6 (26 v* tags total; sequence …v0.5.0, v0.5.1, v0.5.2, v0.5.21, v0.7.6), and cli at HEAD is 0.7.6 — so a v<cli-version> tag now exists. The residual truth: 0.6.0 through 0.7.5 remain untagged, so the historical gap is real but the stated 'newest is v0.5.21' and blanket 'has…</sub>

### docs/ — ops, audit & plan docs (46 findings)

#### `docs/FIRST_PRINCIPLES_VALIDATION.md` — 7

- [x] **W0** · `:33` · critical/overstates · *fix-docs, hours*  
  **Claim:** All five pillars are ✅ at enterprise scale as of @declaragent/cli@0.7.5  
  **Fix:** Replace the 'all five ✅' headline with the reconciled per-pillar state matching CLAUDE.md's 2026-06 accuracy note, and re-verify the whole doc against the current branch (cli 0.7.6) rather than 0.7.4/0.7.5.  
  <sub>Evidence: Verified: line 33 makes the all-five-✅ headline while the doc's own table (line 28: Pillar 4 🟡 'shipping 0.7.5') and §Pillar 4 (lines 169-172: #27 'Shipping in Sprint 5', #13 'Not started') contradict it. Code confirms #27/#13 did ship (packages/core/src/mcp/supervisor.ts:1031-1045 aggregate check, :411-413 drain kn…</sub>
- [x] **W1** · `:78` · high/overstates · *fix-code, hours*  
  **Claim:** Provider rate limits — token-bucket wrapper ProviderTokenBucket (listed as works-today, with Pillar 2 verdict 'enterprise story ... complete')  
  **Fix:** Thread withProviderRateLimit into fleet-run's provider construction, or scope the doc claim to `declaragent up` explicitly.  
  <sub>Evidence: Verified: ProviderTokenBucket exists (packages/core/src/providers/rate-limit.ts:49) and up applies it (up-cli.ts:2086 withProviderRateLimit), but fleet run builds an un-rate-limited provider (fleet-run.ts:1035), so the claim does not hold for the fleet runtime the Pillar 2 'complete' verdict (line 106) covers.</sub>
- [x] **W2** · `:171` · medium/understates · *fix-docs, minutes*  
  **Claim:** #27 shipping in Sprint 5 (still 🟡) and #13 MCP graceful draining 'Not started — in-flight tool calls dropped today'  
  **Fix:** Update §Pillar 4's 'Remaining 🟡' block to mark #27 and #13 shipped with supervisor.ts file:line evidence; note the doc's line-33 headline already asserts this, so the internal contradiction resolves too.  
  <sub>Evidence: Verified: both are in code — aggregate cap at supervisor.ts:1031-1045 (@since 0.7.5), drain-during-respawn knobs `drainTimeoutMs` / `resubmitOnRespawn` at supervisor.ts:411-413 with the `mcp_server_drain_duration_ms` metric shipping in the 0.7.6 Grafana bundle (packages/cli/CHANGELOG.md 0.7.6 entry f70c436).</sub>
- [x] **W2** · `:47` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Outbound channels wired via createSendMessageTool in packages/core/src/channels/channels-runtime.ts  
  **Fix:** Point the evidence at packages/cli/src/channels-runtime.ts (wiring) and packages/core/src/tools/send-message.ts (tool).  
  <sub>Evidence: Verified: packages/core/src/channels/ contains no channels-runtime.ts (ls); the wiring lives in packages/cli/src/channels-runtime.ts and createSendMessageTool is defined at packages/core/src/tools/send-message.ts:97.</sub>
- [x] **W2** · `:75` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Prometheus bound on 127.0.0.1:9464 in detached mode (up-cli.ts:944-961); OTel activates when the env var is set (up-cli.ts:1051-1058)  
  **Fix:** Refresh both refs: resolveMetricsPort up-cli.ts:1952-1962 for the 9464 default; maybeCreateOtelTracer up-cli.ts:2109-2141 for OTel activation.  
  <sub>Evidence: Verified: up-cli.ts:944-961 is memory-store shutdown code; the 9464 default is documented at up-cli.ts:589-593 and implemented in resolveMetricsPort (up-cli.ts:1952-1962, returns isDetached ? 9464 : 0); OTel activation is maybeCreateOtelTracer (up-cli.ts:2109-2141) with the banner at :525-535.</sub>
- [x] **W2** · `:76` · low/overstates · *fix-docs, minutes*  
  **Claim:** createOtelBridge dynamically loads @opentelemetry/api as an optional peer dep  
  **Fix:** Reword to 'dynamically imports @opentelemetry/api when the operator has installed it (currently undeclared — not a peer dependency of any published package)'; resolves automatically if the OTEL_SETUP.md:57 fix-code path (optional peerDependencies) lands.  
  <sub>Evidence: Repeats the red-team-confirmed OTel delta in a doc the first pass didn't flag at this line: the dynamic import is real (packages/core/src/events/observability.ts:253-264) but no published package declares @opentelemetry/api as a peer dependency (packages/core + packages/cli package.json: peerDependencies absent; OTe…</sub>
- [x] **W2** · `:189` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Running declaragent with no subcommand launches the Ink REPL (packages/cli/src/index.tsx:259-263)  
  **Fix:** Update the reference to launchRepl at packages/cli/src/index.tsx:296-301 (invoked at :1624).  
  <sub>Evidence: Verified: index.tsx:259-263 is inside runAuthStatus (credential output). The REPL launch is launchRepl() at index.tsx:296-301 (render(<App …/>)), invoked from the no-subcommand path at :1624.</sub>

#### `docs/ENTERPRISE_PRODUCTION_PLAN.md` — 5

- [x] **W1** · `:12` · high/overstates · *fix-docs, minutes*  
  **Claim:** Summary banner: '12/12 items complete ✅ — all five pillars shipped; all CLI integrations live in `up` + `fleet run`'  
  **Fix:** Add an accuracy note above the banner (mirroring CLAUDE.md's) stating the 12/12 marks predate the 2026-06 audit and runtime wiring completed later on agent-durability-followups.  
  <sub>Evidence: Verified in-doc (line 12). PRODUCTION_READINESS_PLAN.md's landed-work ledger documents that several 'shipped' behaviors needed post-hoc wiring: WS1 real default-mode tool gate in up/fleet run (was effectively bypass), WS2 RPC verify now fails CLOSED (was failing open for unregistered senders), WS4(a) per-envelope re…</sub>
- [x] **W2** · `:13` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** 'Latest release: @declaragent/cli@0.6.0 (…unreleased)' in a banner the doc mandates keeping current (line 18)  
  **Fix:** Update the §0 banner to the current release line or replace it with a pointer to POST_ENTERPRISE_BACKLOG/AGENTS.md as the live status surface.  
  <sub>Evidence: Verified: packages/cli/package.json:3 is 0.7.6 and CLAUDE.md records npm latest 0.7.4 — the banner is 6+ releases behind its own 'update this banner whenever an item ships' rule.</sub>
- [x] **W2** · `:131` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** #2 scope-out: 'SQS / AMQP / MQTT transports … Track as follow-ups in POST_DEMO_BACKLOG.md'  
  **Fix:** Point the scope-out note at POST_ENTERPRISE_BACKLOG.md #24 (shipped) instead of the archived POST_DEMO_BACKLOG.md.  
  <sub>Evidence: docs/POST_DEMO_BACKLOG.md no longer exists at that path (moved to docs/archive/POST_DEMO_BACKLOG.md, verified by ls), and the follow-ups were actually tracked — and shipped — as POST_ENTERPRISE_BACKLOG.md #24 (SQS 0.7.3, AMQP + MQTT 0.7.4).</sub>
- [x] **W2** · `:134` · low/broken_example · *fix-docs, minutes*  
  **Claim:** #2 acceptance: `import { createNatsTransport } from '@declaragent/plugin-agent-rpc/nats'` works  
  **Fix:** Correct the import specifier to `from '@declaragent/plugin-agent-rpc'`.  
  <sub>Evidence: Verified: packages/plugin-agent-rpc/package.json exports only '.' (lines 10-15) — no './nats' subpath; createNatsTransport is exported from the package root (src/index.ts:84).</sub>
- [x] **W2** · `:493` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Cross-reference link `[RELEASE_0_6_0_PLAN.md](./RELEASE_0_6_0_PLAN.md)` — 'what shipped so far'  
  **Fix:** Point the link at ./archive/RELEASE_0_6_0_PLAN.md.  
  <sub>Evidence: CORRECTED evidence: the file EXISTS but was moved to docs/archive/RELEASE_0_6_0_PLAN.md (verified by ls), so the relative link ./RELEASE_0_6_0_PLAN.md is broken. The first pass's claim that it is 'not in docs/ nor docs/archive/' was wrong about archive — the broken-link finding itself stands.</sub>

#### `docs/FIRST_PRINCIPLES_AUDIT.md` — 8

- [x] **W1** · `:5` · high/overstates · *fix-docs, hours*  
  **Claim:** Last refreshed 2026-04-23, verified against @declaragent/cli@0.7.4 — with enterprise ✅ marks throughout (e.g. line 78 'Pillar 2 is ✅ at enterprise scale')  
  **Fix:** Add the same 2026-06 accuracy note CLAUDE.md carries, bump the 'verified against' line to the current branch, and re-verify each enterprise ✅ before the next release.  
  <sub>Evidence: Verified: packages/cli/package.json is at 0.7.6 with a materially different state (0.7.6 changelog: zero-trust preview, builder #36-#38, Grafana #51, session pinning, WS1 permission enforcement); CLAUDE.md carries a 2026-06 accuracy note that the enterprise ✅ marks were found overstated, but this doc carries no such…</sub>
- [x] **W1** · `:61` · high/overstates · *fix-docs, minutes*  
  **Claim:** OpenTelemetry auto-enable ✅ (single) \| ✅ (enterprise) — createOtelBridge + peer-dep dynamic import  
  **Fix:** Downgrade the enterprise column to 🟡 citing undeclared deps, hardcoded service name, and root-span-only tracing until the OTel workstream closes.  
  <sub>Evidence: Verified: no published package declares OTel deps (core + cli peerDependencies absent; root devDependencies only, package.json:24-26); service name is hardcoded 'declaragent' in startOtelSdk call (up-cli.ts:2130) with OTEL_SERVICE_NAME never read; the bridge's metrics registry is created but metrics are not exported…</sub>
- [x] **W1** · `:63` · high/overstates · *fix-code, hours*  
  **Claim:** Default provider rate limits ✅ \| ✅ — token bucket at complete() callsite, per-provider defaults  
  **Fix:** Wrap fleet-run's provider in withProviderRateLimit the same way up-cli.ts:2086 does (or mark the enterprise column 🟡 citing the fleet-run gap).  
  <sub>Evidence: Verified: only `up` wraps the provider (up-cli.ts:2086 withProviderRateLimit); `fleet run` constructs it bare — packages/cli/src/fleet-run.ts:1035 `createProviderFromCreds({ creds })` handed straight to createLLMHandlerFactory (:1038-1043); grep for TokenBucket/rate-limit in fleet-run.ts returns zero hits. Multi-age…</sub>
- [x] **W1** · `:89` · high/overstates · *either, minutes*  
  **Claim:** RPC envelope (typed version, kind, correlation id, traceId) ✅/✅  
  **Fix:** Remove 'traceId' from the row (noting spans are root-only today), or add a trace-context field to the v1 envelope and propagate it through RequestAgent/agent-inbox (a much larger change).  
  <sub>Evidence: Verified: packages/core/src/rpc/envelope.ts has no traceId field — the only 'trace' match is a comment about opaque transport annotations (line 82); the envelope carries version (line 64), kind (line 65), correlationId (line 69). Repeats the red-team-confirmed delta (no W3C traceparent propagation; all spans root-on…</sub>
- [x] **W2** · `:119` · medium/understates · *fix-docs, minutes*  
  **Claim:** Permission gate ✅ — prompt mode wired into REPL; bypass is the default for `up`  
  **Fix:** Update the row: up enforces tools.defaults through a default-mode gate (resolve-tools.ts, since 0.7.6 WS1); bypass applies only to the extension registry.  
  <sub>Evidence: Verified stale: `up` now resolves declared tools + permission rules into a real 'default'-mode gate — resolveRuntimeTools returns createPermissionGate({ mode: 'default', rules }) (packages/cli/src/resolve-tools.ts:180-184) and up-cli's WS1 block hands resolvedTools.gate to createEngine (up-cli.ts:1567-1585). The onl…</sub>
- [x] **W2** · `:128` · medium/understates · *fix-docs, minutes*  
  **Claim:** #27 Per-MCP-server aggregate rate-limit cap ❌ \| 🟡 — shipping Sprint 5 toward 0.7.5; the only item holding Pillar 4's enterprise column  
  **Fix:** Flip row #27 to ✅ with supervisor.ts:1031-1045 evidence and rewrite the 'only item holding Pillar 4' framing (though the pillar's enterprise ✅ still needs the OTel/rate-limit reconciliation noted elsewhere).  
  <sub>Evidence: Verified: the aggregate per-server cap is implemented and wired — MCPServerRateLimitedError '@since 0.7.5 — Post-Enterprise Backlog #27' (packages/core/src/mcp/supervisor.ts:112-131), aggregate check runs first in callTool with `mcp_server_rate_limited_total{reason:'aggregate'}` (:1031-1045), counter registered (:48…</sub>
- [x] **W2** · `:140` · medium/understates · *fix-docs, hours*  
  **Claim:** 21 items remain open, including #13 draining, #17 controlPlane block, #33 Kustomize, #51 Grafana bundle, #36–#38 builder polish  
  **Fix:** Recount the open-item tiers against the 0.7.6 changelog and current source, moving #13/#17/#33/#51/#36-#38 out of the 'honestly missing' section.  
  <sub>Evidence: Verified all five shipped: drain knobs (supervisor.ts:411-413), fleet-level controlPlane block (packages/core/src/fleet/manifest-schema.ts:190-201 '#17'), Kustomize renderer (packages/cli/src/fleet-render/kustomize-renderer.ts exists with tests), Grafana bundle (docs/grafana/declaragent-fleet-dashboard.json + dashbo…</sub>
- [x] **W2** · `:36` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** capabilities.yaml loaded by packages/core/src/fleet/capabilities-loader.ts  
  **Fix:** Change the path to packages/core/src/rpc/capabilities-loader.ts.  
  <sub>Evidence: Verified: capabilities-loader.ts lives in packages/core/src/rpc/ (ls shows capabilities-loader.ts + test there; nothing matching in fleet/). VALIDATION.md line 50 cites the correct rpc/ path.</sub>

#### `docs/LAUNCH_PLAN.md` — 2

- [x] **W1** · `:5` · high/overstates · *fix-docs, minutes*  
  **Claim:** Status anchor: '5/5 pillars green per docs/FIRST_PRINCIPLES_VALIDATION.md'  
  **Fix:** Re-anchor the status line to the AGENTS.md/PRODUCTION_READINESS_PLAN ledger ('single-machine ready; enterprise partial — see accuracy note').  
  <sub>Evidence: Verified in-doc (line 5). Contradicted by CLAUDE.md's 2026-06 accuracy note and docs/PRODUCTION_READINESS_PLAN.md's own 'still genuinely outstanding' list (7-week soak, 0.8.0 cutover, multi-host broker soak, etc.); LAUNCH_PLAN line 17 even makes the Pillar-3 soak a ship-gate, contradicting its own 5/5 header. §8 for…</sub>
- [x] **W2** · `:5` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** '@declaragent/cli@0.7.4 live on npm … Sprint 5 (0.7.5) is docs-only and in-flight'  
  **Fix:** Refresh the status anchor to the 0.7.6 state and correct '0.7.5 docs-only'.  
  <sub>Evidence: Verified: repo at 0.7.6 (packages/cli/package.json:3); POST_ENTERPRISE_BACKLOG rows show 0.7.5 shipping CODE items (#13, #17, #27, #32, #33, Slice 6a) and a Sprint-6 0.7.6 (#36-38, #50 Slice 6b, #5b preview) — '0.7.5 docs-only in-flight' is two sprints behind.</sub>

#### `docs/OTEL_SETUP.md` — 2

- [x] **W1** · `:57` · high/overstates · *fix-code, hours*  
  **Claim:** The @declaragent/core package declares @opentelemetry/api as a peer dep only  
  **Fix:** Declare @opentelemetry/api (and optionally sdk-node / exporter-trace-otlp-http) as optional peerDependencies (peerDependenciesMeta) in @declaragent/core and @declaragent/cli, or rewrite §2 to say the deps are undeclared and must be manually installed next to the CLI.  
  <sub>Evidence: Verified: packages/core/package.json (v0.5.5) has no peerDependencies key at all and no OTel entries in dependencies; packages/cli/package.json (v0.7.6) likewise. OTel packages exist only as root-workspace devDependencies (package.json:24-26), which never publish. Repeats the red-team-confirmed delta. Note createOte…</sub>
- [x] **W2** · `:48` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** Startup banner reads 'otel: tracing enabled (OTLP endpoint http://localhost:4318)' or '⚠ OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing could not start: …'  
  **Fix:** Quote the four real banner strings (exporting, bridged-without-SDK, bridge-load-failed, sdk-start-failed) from up-cli.ts so operators can grep logs successfully.  
  <sub>Evidence: Verified: actual banners are '  otel: spans exporting to <endpoint> (NodeSDK started).' / '  otel: tracer bridged to @opentelemetry/api (endpoint …), but no SDK started — spans will not export…' (up-cli.ts:529-535), '⚠ OTEL_EXPORTER_OTLP_ENDPOINT is set but the @opentelemetry/api bridge could not load: …' (up-cli.ts…</sub>

#### `docs/THREAT_MODEL.md` — 3

- [x] **W1** · `:128` · high/overstates · *fix-code, hours*  
  **Claim:** Kill-on-shutdown is guaranteed via SIGTERM on adapter close; adapter falls back to SIGKILL after a 5-second grace  
  **Fix:** Implement SIGTERM on the spawned proc at close with a SIGKILL fallback timer (the stdio connect fn holds the proc handle at stdio-client.ts:429-435), or downgrade the mitigation to 'stdin close; hung servers may linger' and move forced kill to residual.  
  <sub>Evidence: Verified: grep for SIGTERM/SIGKILL/.kill( across packages/core/src/mcp/*.ts (non-test) returns zero hits. Shutdown only closes the JSON-RPC connection / ends stdin (stdio-client.ts:183, :311, :453-465 closeWrite → stdin.end()). A spawned server that ignores stdin EOF is never force-killed and no grace timer exists.</sub>
- [x] **W1** · `:145` · high/overstates · *fix-docs, minutes*  
  **Claim:** Hot-reload uses atomic swap: new runtime assembles in a worktree, then atomic pointer swap replaces the live tree; in-flight requests drain against the old runtime  
  **Fix:** Rewrite the config-reload row: reload = SIGTERM the prior up process + fresh start; no in-process hot reload. Drop the atomic-swap/drain language and the macOS/Linux-vs-Windows distinction built on it.  
  <sub>Evidence: Verified: the control-socket reload op returns { reloaded: false, reason: 'unsupported', message: 'hot reload of sources is not implemented; restart `declaragent up` to apply changes' } (packages/cli/src/up-cli.ts:1321-1326), and up's 'reload semantics' is gracefulStop(prior.pid) then fresh start (up-cli.ts:193-197)…</sub>
- [x] **W2** · `:119` · medium/overstates · *either, hours*  
  **Claim:** Path globs enforced at the permission gate + resolved via realpath to normalize ../ traversals  
  **Fix:** Either switch permissionKey derivation to realpathSync with lexical fallback for non-existent targets, or reword the mitigation to 'lexical path.resolve (normalizes ../, does not follow symlinks)' and add symlink traversal to the residual column.  
  <sub>Evidence: Verified: Read/Write/Edit derive permission keys with lexical `resolve(path)` from node:path (read.ts:31, write.ts:29, edit.ts:41) and grep for 'realpath' across packages/core/src (non-test) returns zero hits. `resolve` normalizes ../ lexically but does NOT follow symlinks, so a symlink inside an allowed glob can po…</sub>

#### `docs/ZERO_TRUST_DEFAULT_MIGRATION.md` — 7

- [x] **W1** · `:268` · high/broken_example · *fix-docs, minutes*  
  **Claim:** Verify the flip via `declaragent audit export --to <your-siem>`  
  **Fix:** Replace step 2 with `declaragent audit query --kind auth_check` (or 'check your SIEM destination fed by the configured audit exporter').  
  <sub>Evidence: Verified: the audit CLI surface is query/verify/erase/prune only (packages/cli/src/index.tsx:212-217 usage; :1213-1252 dispatch; packages/cli/src/audit-cli.ts exports auditQuery/auditVerify/auditErase/auditPrune). No 'export' subcommand anywhere; SIEM export runs via the exporter loop, not a verb.</sub>
- [x] **W1** · `:269` · high/overstates · *either, hours*  
  **Claim:** Scrape /metrics for the existing rpc_auth_checks_total{result="accept"} counter  
  **Fix:** Either register an rpc_auth_checks_total{decision} counter on the shared registry at the fleet-run verify path, or delete step 3 and point operators at auth_check audit rows.  
  <sub>Evidence: Verified: grep for rpc_auth across all packages/*.ts returns zero hits — no such counter is registered anywhere. Auth outcomes are recorded only as auth_check audit records via writeAuthCheck (packages/cli/src/fleet-run.ts:872-902), with decision accept/reject, not a metric.</sub>
- [x] **W2** · `:112` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** Preview-mode rehearsal example: `declaragent fleet run --transport kafka`  
  **Fix:** Change the example to plain `declaragent fleet run` and note the transport comes from capabilities.yaml `transports:` (kafka etc.), not a flag.  
  <sub>Evidence: No `--transport` flag exists anywhere in packages/cli — usage is `declaragent fleet run [--agent <id>...]` (packages/cli/src/index.tsx:185, :925). Transport kinds are resolved from each agent's capabilities.yaml `transports` list against wired transport factories (packages/cli/src/fleet-run.ts:387-407), not a CLI flag.</sub>
- [x] **W2** · `:232` · medium/stale_reference · *fix-docs, minutes*  
  **Claim:** `auth-check` records land with `result: 'reject'` and reason `auth-rejected` or `idp-unreachable`  
  **Fix:** Correct §6 and the §7 FAQ to `auth_check` records with `decision: 'accept'\|'reject'` and the granular RpcAuthRejectReason values so SIEM queries built from the doc match rows.  
  <sub>Evidence: Verified: the record kind is `auth_check` (underscore) and the field is `decision: 'accept' \| 'reject'` (packages/core/src/audit/types.ts AuthCheckAuditRecord — kind/decision/reason fields; fleet-run.ts:882-889 builds the record). There is no 'auth-rejected' reason: reasons come from the RpcAuthRejectReason union (…</sub>
- [x] **W2** · `:230` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Evidence: packages/cli/src/fleet-run.ts:675 + :716 emits RPC_ERROR_CODES.AUTH_REJECTED  
  **Fix:** Update to :710/:751/:782 or cite the enclosing function instead of raw line numbers.  
  <sub>Evidence: Verified: AUTH_REJECTED emissions are now at fleet-run.ts:710, :751, :782 (grep); nothing auth-related at :675/:716.</sub>
- [x] **W2** · `:247` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** This is documented in docs/VERSIONING.md  
  **Fix:** Create docs/VERSIONING.md with the pre-1.0 semver rule, or reword to 'per the project's pre-1.0 SemVer convention' without the dangling link.  
  <sub>Evidence: Verified: docs/VERSIONING.md does not exist (ls: No such file).</sub>
- [x] **W2** · `:277` · low/overstates · *fix-docs, minutes*  
  **Claim:** If you take @declaragent/cli@0.8.0, the other packages are peer-dep-resolved — the installer will pull matching minors automatically  
  **Fix:** Say the companions are regular dependencies pinned by the CLI's dependency ranges (installer pulls matching versions via those ranges), not 'peer-dep-resolved'.  
  <sub>Evidence: Verified: packages/cli/package.json declares no peerDependencies (only optionalDependencies @declaragent/channel-whatsapp). Companion packages resolve as regular dependencies pinned by the CLI's own ranges, not peer deps.</sub>

#### `docs/AGENT_MEMORY.md` — 2

- [x] **W2** · `:72` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** Permissioning example: an agent.yaml `permissions:` block with `allow:` / `deny:` string lists (e.g. `allow: [memory_read:support/*]`, `deny: [memory_write:*]`)  
  **Fix:** Rewrite the example as:
permissions:
  rules:
    - { pattern: "memory_write:*", decision: deny }
    - { pattern: "memory_read:support/*", decision: allow }
    - { pattern: "memory_write:support/note-*", decision: allow }
and note an explicit deny beats any allow (load-agent.ts:255-262).  
  <sub>Evidence: The real agent.yaml permissions schema is a strict object accepting only `rules: [{ pattern, decision: allow\|deny }]` (packages/core/src/agents/load-agent.ts:265-276, `.strict()`), matched against '<ToolName>:<permissionKey>'. The doc's `allow:`/`deny:` keys are unknown to the strict schema, so pasting the example …</sub>
- [x] **W2** · `:43` · low/understates · *fix-docs, minutes*  
  **Claim:** namespace is the per-agent isolation boundary; two agents that share a namespace share memories  
  **Fix:** Add a paragraph documenting the WS8 tenant/subject namespace partitioning (::t::<tenantId> / ::sub::<subject>) and note permission-key globs match against the base namespace only.  
  <sub>Evidence: Verified: the runtime additionally partitions per tenant and per subject — scopedNamespace() appends ::t::<tenantId> and ::sub::<subject> (packages/core/src/tools/memory.ts:47-50 tenantScopedNamespace, :60-66 scopedNamespace; used in execute at :152, :190, :236) while permission keys still use the base namespace (:1…</sub>

#### `docs/POST_ENTERPRISE_BACKLOG.md` — 4

- [x] **W1** · `:60` · medium/overstates · *fix-code, hours*  
  **Claim:** #24 evidence: '`amqplib@^0.10` aligned with @declaragent/source-amqp … `mqtt@^5` aligned with @declaragent/source-mqtt'  
  **Fix:** Declare amqplib/mqtt/kafkajs/@aws-sdk/client-sqs as optional peerDependencies with the documented ranges (mirroring the nats entry).  
  <sub>Evidence: Verified: packages/plugin-agent-rpc/package.json declares NO amqplib/mqtt/kafkajs/@aws-sdk dependency in any section — its only peer dep is nats ^2.28.0 (lines 25-33). No version alignment is expressed to npm consumers; the transports dynamically import whatever the host has installed.</sub>
- [x] **W2** · `:12` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Banner: 'Status: 15 open follow-ups … (37 shipped across 0.7.1 + … + 0.7.6)'  
  **Fix:** Correct the banner to 11 open / 42 shipped (counting the 5a/5b split) and refresh the category counts.  
  <sub>Evidence: Verified by counting: the §1 table has 11 `[ ]` rows (1, 2, 3, 5b, 10, 15, 34, 35, 39, 46, 51) and 42 `[x]` rows (grep -c), contradicting the banner two lines below its own 'update this banner' instruction. The per-category counts (lines 13-23) are stale for the same reason.</sub>
- [x] **W2** · `:37` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Row #2 still open: '[ ] Cut `@declaragent/cli@0.7.0` release with full enterprise stack + peer-dep cascade \| Ship-gate \| 1 d \| Not started'  
  **Fix:** Tick row #2 as shipped (0.7.0…0.7.4 on npm) or reword it to the next actual release gate, and fix the 'before 0.7.0 cut' note at line 13.  
  <sub>Evidence: The 0.7.0 cut happened long ago: CLAUDE.md records `npm view @declaragent/cli dist-tags` → latest 0.7.4, and the repo is at 0.7.6 (packages/cli/package.json:3). The same table's own [x] rows cite shipped versions 0.7.1 through 0.7.6, so ship-gate row #2 (and the banner's 'must land before 0.7.0 cut' note at line 13)…</sub>
- [x] **W2** · `:127` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Cross-reference link `./POST_DEMO_BACKLOG.md` (older backlog)  
  **Fix:** Update the link to ./archive/POST_DEMO_BACKLOG.md.  
  <sub>Evidence: Verified: docs/POST_DEMO_BACKLOG.md does not exist (ls error); the file lives at docs/archive/POST_DEMO_BACKLOG.md.</sub>

#### `docs/PRODUCTION_READINESS_PLAN.md` — 2

- [x] **W1** · `:30` · medium/overstates · *fix-code, hours*  
  **Claim:** WS7: 'NodeSDK now actually starts — startOtelSdk loads @opentelemetry/sdk-node + calls start() so spans export; up starts/stops it + banner reflects real state'  
  **Fix:** Add the three @opentelemetry packages as optional peerDependencies of core (or cli) and note in WS7 that the shipped-package dependency gap is still open.  
  <sub>Evidence: Verified: @opentelemetry/api, sdk-node, exporter-trace-otlp-http are ROOT devDependencies only (package.json:21-27) and grep shows no packages/*/package.json declares them, so an npm-installed CLI cannot load the SDK — up-cli catches the load failure, warns 'Install peer deps to enable', and falls back to a noop tra…</sub>
- [x] **W2** · `:3` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Header: 'Status: **proposed plan, nothing implemented.** Authored 2026-06-10'  
  **Fix:** Change the status line to something like 'Status: plan authored 2026-06-10; implementation landed on agent-durability-followups — see Implementation progress below.'  
  <sub>Evidence: The same doc's 'Implementation progress' section (lines 9-45) records landed, live-verified work across all 11 workstreams, and the cited artifacts exist and are wired in code: packages/core/src/events/recovery.ts (recoverPendingEvents imported at up-cli.ts:92, called at :1709), packages/cli/src/zero-trust-preview.t…</sub>

#### `docs/AGENT_DURABILITY.md` — 1

- [x] **W2** · `:15` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** DEFAULT_MAX_ITERATIONS = 50 at packages/core/src/engine/engine.ts:32, loop break at :411  
  **Fix:** Update the two line references to engine.ts:34 and :261.  
  <sub>Evidence: Verified: the constant is at engine.ts:34 and the cap is applied at engine.ts:261 (`config.maxIterations ?? DEFAULT_MAX_ITERATIONS`); engine.ts:411 is provider-cost-estimation code. The doc's behavioral claims (iterations histogram at :279, max_iterations_hit_total at :720, spec>config>default precedence) check out.</sub>

#### `docs/PEN_TEST_SIGNOFF.md` — 1

- [x] **W2** · `:34` · low/overstates · *fix-docs, minutes*  
  **Claim:** Scope document is linked from the vendor portal + archived under docs/security/pen-test-sow.pdf (not in the public repo)  
  **Fix:** Rewrite the Engagement-scope preamble in future tense ('will be agreed at kickoff…', 'will be archived under docs/security/pen-test-sow.pdf') so no excerpt reads as evidence of an engagement.  
  <sub>Evidence: Verified: docs/security/ does not exist (ls error), no engagement exists per the doc's own NOT-YET-ENGAGED banner (lines 3-7), and no vendor portal is referenced anywhere. The Engagement-scope section (lines 32-36) is written in completed-fact tense inside a template, so an excerpt read without the banner asserts a …</sub>

#### `docs/SPEC_AND_PLAN.md` — 2

- [x] **W2** · `:3` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** 'Working name: Declaragent (placeholder — see Part 7)' and Part 7 (~line 255) still lists product naming as an open decision  
  **Fix:** Change the header to 'Name: Declaragent (official)' and delete the Part 7 product-name row.  
  <sub>Evidence: Verified in-doc (line 3 header + Part 7 'Product name' row). The name is official: npm scope @declaragent/* published, declaragent.dev, GitHub org claimed (CLAUDE.md); LAUNCH_PLAN.md:14 makes removing this row a launch ship-gate.</sub>
- [x] **W2** · `:161` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Phase 0 scope: 'pnpm + Turborepo monorepo'  
  **Fix:** Update Phase 0 scope to Bun workspaces to match the built reality.  
  <sub>Evidence: Verified: root package.json:7 uses Bun workspaces ('workspaces': ['packages/*', 'examples/*']); no pnpm/turbo anywhere in package.json; CLAUDE.md stack confirms 'Bun workspaces (not pnpm/Turbo)'.</sub>

### Templates & package READMEs (23 findings)

#### `templates/concierge/README.md` — 1

- [x] **W0** · `:37` · critical/broken_example · *either, minutes*  
  **Claim:** `declaragent run` connects the Slack Socket Mode agent  
  **Fix:** Change 'Run locally' to `declaragent up`.  
  <sub>Evidence: Verified: no 'run' verb in index.tsx (491-1618); falls to launchRepl() at index.tsx:1624. `up` is the verb that starts channels — up-cli.ts:1147 startChannelRuntime — so the suggested replacement is valid.</sub>

#### `templates/fleet-starter/README.md` — 2

- [x] **W0** · `:9` · critical/broken_example · *either, hours*  
  **Claim:** `declaragent init --template fleet-starter --out my-fleet` unpacks this fleet template  
  **Fix:** Either add fleet-starter to TEMPLATE_NAMES (and make the unpacker handle the nested agents/ tree) or change the README to a git-copy / `declaragent fleet new` instruction.  
  <sub>Evidence: Verified: TEMPLATE_NAMES in packages/cli/src/init-template-unpacker.ts:23-29 lists exactly [concierge, oncall-escalator, pr-review, kafka-pipeline, multi-tenant-starter]; init-wizard.tsx:83 prints 'unknown template "fleet-starter". Known: …' and exits — the README's first command fails.</sub>
- [x] **W0** · `:71` · critical/overstates · *either, minutes*  
  **Claim:** `declaragent fleet deploy --target cloud-run-reviewer` deploys the reviewer (and `--rollback` reverts)  
  **Fix:** Mark the Deploy section as roadmap (`--dry-run` prints the plan today) or ship the gcloud deploy adapter before advertising the command.  
  <sub>Evidence: Verified with corrected citation: index.tsx:994 calls fleetDeploy() with NO deps.targets/targetFactory, so resolveAdapters (fleet-deploy-cli.ts:864-886) throws 'no adapter registered for target … Supply one via deps.targets or deps.targetFactory' for the template's fleet.yaml `kind: gcp-cloud-run` (fleet.yaml:44); t…</sub>

#### `templates/kafka-pipeline/README.md` — 2

- [x] **W0** · `:10` · critical/overstates · *fix-code, days*  
  **Claim:** The agent 'produces one enriched record per input to `orders.enriched`' (agent.yaml:16-17 instructs the skill to emit via SendMessage), watchable in the Redpanda console  
  **Fix:** Add a Kafka outbound path (producer-backed channel or SendMessage kafka destination) or rewrite the README + agent.yaml system prompt to state the enrichment is logged only — the template's flagship promise cannot execute today.  
  <sub>Evidence: Verified: SendMessageInput union supports only kind 'agent' (mailbox) and 'channel' (ChannelRegistry) — packages/core/src/tools/send-message.ts:33-55; the kafka source's producer is used only for DLQ send (packages/source-kafka/src/instance.ts:154-164) and DLQ redrive (instance.ts:518-543); the template ships no cha…</sub>
- [x] **W0** · `:43` · critical/broken_example · *either, minutes*  
  **Claim:** `declaragent run` starts the Kafka-consuming agent  
  **Fix:** Change to `declaragent up` (run-agent-sources binding happens there), or wire runAgent into a top-level `run` verb.  
  <sub>Evidence: Verified: index.tsx dispatch (lines 491-1618) has no 'run' subcommand; unknown verbs hit the else branch at index.tsx:1619-1625 which launches the interactive REPL (or exits 1 without credentials) and binds no sources. run-agent-cli.ts:84 exports runAgent but nothing in index.tsx imports run-agent-cli.</sub>

#### `templates/marketing/README.md` — 4

- [x] **W0** · `:36` · critical/overstates · *fix-code, hours*  
  **Claim:** The `mcp:` block in agent.yaml declares Declan's MCP servers; at `declaragent up` the CLI prompts consent for each on first run  
  **Fix:** Teach `up` to merge `agent.yaml#mcp.servers` into the scoped MCP list (the declarative-config story), or ship the servers as a .mcp.json and correct the README.  
  <sub>Evidence: Verified: up-cli.ts:1071 loads MCP servers only via loadScopedMCPServers, which reads three JSON files — user mcp-servers.json, <agentDir>/.mcp.json, .declaragent/mcp.local.json (mcp-runtime.ts:95-118); the agent.yaml schema's `mcp` object parses only `supervised` and passthrough-ignores `servers` (packages/core/src…</sub>
- [x] **W0** · `:110` · critical/broken_example · *either, minutes*  
  **Claim:** `declaragent auth store github-token` (plus 3 more `auth store` calls at 111-113 and table cells at 41-47) stores tokens in the keychain  
  **Fix:** Replace `auth store` with env-var / secret-provider (env, vault, aws-sm, gcp-sm, k8s) instructions, or implement a keychain-backed `auth store` verb.  
  <sub>Evidence: Verified: the auth subcommand accepts only status/logout/login (index.tsx:1564-1613); any other action prints 'unknown auth subcommand' + help and exits 1 (index.tsx:1614-1618).</sub>
- [x] **W1** · `:41` · high/overstates · *either, minutes*  
  **Claim:** Tokens resolve via keychain refs (agent.yaml uses `${keychain:github-token}` at lines 124/153/165/173)  
  **Fix:** Switch the template to `${env:...}` refs, or add a keychain secret provider before documenting it.  
  <sub>Evidence: Verified: shipped secret providers are env/vault/aws-sm/gcp-sm/k8s only (packages/core/src/secrets/providers/ contains exactly those); grep for 'keychain' across packages/core/src + packages/cli/src returns zero hits — the template's `${keychain:...}` refs cannot resolve.</sub>
- [x] **W2** · `:116` · medium/broken_example · *fix-docs, minutes*  
  **Claim:** `declaragent doctor` (or `d9t doctor`) verifies the agent config  
  **Fix:** Replace `declaragent doctor` with `declaragent agent validate`.  
  <sub>Evidence: Verified: no `doctor` subcommand (index.tsx:491-1618); the command silently opens the REPL (1619-1625). Shipped validator is `declaragent agent validate [dir]` (index.tsx:512-522).</sub>

#### `templates/multi-tenant-starter/README.md` — 3

- [x] **W0** · `:36` · critical/broken_example · *either, minutes*  
  **Claim:** `declaragent run` boots the two-tenant daemon  
  **Fix:** Change to `declaragent up` here and in the Smoke test intro (line 44).  
  <sub>Evidence: Verified: no 'run' subcommand (index.tsx:491-1618); opens the REPL instead (1619-1625). Line 44 'After `declaragent run`' repeats it.</sub>
- [x] **W1** · `:39` · high/overstates · *fix-code, days*  
  **Claim:** The daemon loads tenants.yaml, builds one TenantRuntime per tenant, wires each tenant to its matching Slack channel, and starts listening  
  **Fix:** Wire multi-TenantRuntime construction (per-tenant bus + channels) into `up`, or scope the README to what ships: one resolved tenant context with tenant-scoped quotas/audit/memory.  
  <sub>Evidence: Verified: `up` resolves exactly one tenant context per agent from `agent.yaml#tenant` (up-cli.ts:1518-1553, resolveTenantContext) and no CLI code calls createTenantRuntime (grep: only core exports it — packages/core/src/tenancy/runtime.ts:80); the `strategy.bus: per-tenant` key parses (config-loader.ts:102) but noth…</sub>
- [x] **W2** · `:71` · medium/overstates · *either, hours*  
  **Claim:** The generated service.yaml 'stamps `tenant_id` as a Prometheus metric label via `createPrometheusRegistry`'s `constLabels` wiring'  
  **Fix:** Either wire tenant-labelled registries (pass constLabels: {tenant_id} when a tenant context resolves) or trim the README sentence to the volume mounts only.  
  <sub>Evidence: createPrometheusRegistry does support constLabels (packages/core/src/observability/prometheus.ts:42,74), but no CLI code uses it: up-cli.ts:472 calls `createPrometheusRegistry()` bare, and grep finds no 'constLabels' or 'tenant_id' in packages/cli/src (deploy-service-yaml.ts / deploy-cli.ts included). The per-tenant…</sub>

#### `templates/oncall-escalator/README.md` — 2

- [x] **W0** · `:35` · critical/broken_example · *either, minutes*  
  **Claim:** `declaragent run` starts the webhook listener  
  **Fix:** Change to `declaragent up`.  
  <sub>Evidence: Verified: no 'run' subcommand (index.tsx:491-1618, fallthrough to REPL at 1619-1625); webhook sources bind only via `up` (up-cli.ts:121 imports startAgentSources).</sub>
- [x] **W1** · `:38` · high/broken_example · *either, minutes*  
  **Claim:** The agent listens on http://localhost:8787/webhook/alertmanager by default (smoke-test curl at line 43 targets it)  
  **Fix:** Correct README (and line 61's service.yaml note) to 7777, or make 8787 the adapter default so runtime matches the EXPOSEd manifests.  
  <sub>Evidence: Verified: webhook adapter default port is 7777 (packages/core/src/events/sources/webhook.ts:509 `opts.port ?? 7777`); run-agent-sources.ts:73 instantiates createWebhookAdapter() with no options and WebhookTriggerConfig has no per-route port field, so nothing overrides it. Aggravating: the deploy generators EXPOSE 87…</sub>

#### `templates/pr-review/README.md` — 2

- [x] **W0** · `:40` · critical/broken_example · *either, minutes*  
  **Claim:** `declaragent run` starts the GitHub-webhook reviewer  
  **Fix:** Change to `declaragent up` (also in the line 68 deferral note).  
  <sub>Evidence: Verified: no 'run' verb (index.tsx:491-1618); REPL fallthrough at 1619-1625. Line 68's deferral note repeats `declaragent run`.</sub>
- [x] **W1** · `:43` · high/broken_example · *either, minutes*  
  **Claim:** The agent listens on http://localhost:8787/webhook/github; tunnel `ngrok http 8787`  
  **Fix:** Correct to port 7777 or align the code default with the documented/EXPOSEd 8787.  
  <sub>Evidence: Verified: same 7777 default (webhook.ts:509) with no override in the template's event-sources.yaml or the up path (run-agent-sources.ts:73); documented URL and ngrok port are wrong. Line 53's service.yaml claim shares the 8787-vs-7777 mismatch.</sub>

#### `templates/rpc-client/README.md` — 2

- [x] **W0** · `:41` · critical/broken_example · *fix-docs, hours*  
  **Claim:** `declaragent run --agent ./agent.yaml --agent ../rpc-server/agent.yaml` starts both agents in one daemon  
  **Fix:** Rewrite single-process instructions around `declaragent fleet run` + a fleet.yaml (as fleet-starter does) and two-process ones around `declaragent up` per agent dir; lines 52 and 58 repeat the bad verb.  
  <sub>Evidence: Verified: no top-level 'run' verb; the only repeated `--agent` parser lives under `fleet run` (index.tsx:924-935, inside runFleetSubcommand). The documented command opens the REPL (index.tsx:1619-1625). Note the template ships no fleet.yaml, so the fleet-run rewrite needs one added.</sub>
- [x] **W1** · `:64` · high/broken_example · *fix-docs, minutes*  
  **Claim:** `declaragent rpc peers` / `declaragent rpc peers --verify` print and live-ping the peer table  
  **Fix:** Change to `declaragent fleet peers --verify`.  
  <sub>Evidence: Verified: no `rpc` subcommand in index.tsx dispatch (491-1618); the shipped equivalent is `declaragent fleet peers [--verify]` (index.tsx:1043-1049).</sub>

#### `templates/rpc-server/README.md` — 2

- [x] **W0** · `:36` · critical/broken_example · *fix-docs, hours*  
  **Claim:** `declaragent run --agent ../rpc-client/agent.yaml --agent ./agent.yaml` (and standalone `declaragent run` at line 42)  
  **Fix:** Replace with `declaragent fleet run` (paired, needs a fleet.yaml) / `declaragent up` (standalone).  
  <sub>Evidence: Verified: same missing 'run' verb (index.tsx:491-1618 dispatch; REPL fallthrough 1619-1625); `--agent` repetition only exists under `fleet run` (index.tsx:924-935).</sub>
- [x] **W1** · `:50` · high/broken_example · *fix-docs, minutes*  
  **Claim:** `declaragent rpc capabilities` prints this agent's capabilities  
  **Fix:** Change to `declaragent fleet capabilities` (or `capabilities gen --peer`).  
  <sub>Evidence: Verified: no `rpc` subcommand; top-level `capabilities` supports only `gen` (index.tsx:1508-1527); the aggregate view is `fleet capabilities` (index.tsx:895-897).</sub>

#### `templates/README.md` — 1

- [x] **W2** · `:4` · medium/overstates · *either, minutes*  
  **Claim:** Each directory is a fully-specified agent that `declaragent init --template <name>` unpacks (catalog includes rpc-client/rpc-server at line 16)  
  **Fix:** Annotate the catalog with init-able vs copy-only, or register the remaining directories in TEMPLATE_NAMES / `fleet add --template`.  
  <sub>Evidence: Verified: only 5 names are init-able (init-template-unpacker.ts:23-29); rpc-client, rpc-server, fleet-starter, and marketing directories exist under templates/ but init-wizard.tsx:83 rejects them.</sub>

#### `packages/plugin-agent-rpc/README.md` — 2

- [x] **W2** · `:5` · low/understates · *fix-docs, minutes*  
  **Claim:** 'This package provides:' — lists only RequestAgent, agent-inbox, createRespondHook, and createMemoryTransport/createMemoryBus ('an in-memory RpcTransport for tests'), framed as 'Declaragent (v1.1)'  
  **Fix:** Extend the feature list with the six broker transport factories and the auth providers, and drop the stale '(v1.1)' framing.  
  <sub>Evidence: src/index.ts also exports six broker transports — createKafkaTransport (:76), createNatsTransport (:84), createJetStreamTransport (:92), createSqsTransport (:108), createAmqpTransport (:119), createMqttTransport (:131) — plus three auth providers (createHmacAuthProvider :41, createOidcAuthProvider :46, createOAuth2C…</sub>
- [x] **W2** · `:15` · low/stale_reference · *fix-docs, minutes*  
  **Claim:** Wire format, peer registry, and capabilities config 'are all declared in `@declaragent/core/rpc`'  
  **Fix:** Say 'declared in @declaragent/core (src/rpc/)' or add a ./rpc subpath export.  
  <sub>Evidence: Verified: packages/core/package.json exports only the '.' subpath, so a literal `@declaragent/core/rpc` import fails to resolve; rpc types are re-exported from the core package root (src/index.ts).</sub>

### Uncovered surfaces (completeness critic)

- **Canonical runbooks: docs/runbooks/*.md (20 files) — zero audit findings despite being the operator-facing repro docs** — Spot-checked: 6 of them cite verbs that don't exist — `declaragent daemon status\|restart\|reload` (real verbs per generated cli.mdx: `daemon-status`, `daemon-reload`, `daemon-shutdown`) in daemon-bus-pressure-sustained.md:20,25, daemon-bus-inflight-stuck.md:18,26, daemon-heartbeat-timeout.md:18,20,30, daemon-session-spawn-stall.md:22,28, event-sources-latency.md:19; `declaragent sources reload <id>` (no such verb) in event-sources-connection-errors.md:30; plus the unimplemented `DECLARAGENT_LOG_LEVEL=debug` (daemon-bus-inflight-stuck.md:31) that the audit already ordered purged from 'any runbooks citing it' without listing which. They also cite phantom metrics (dispatcher_queued_total, dispatcher_rejected_total — 0 hits in packages/*/src). Separately, all 24 docs-site/docs/troubleshooting/runbooks/*.mdx pages are published placeholder stubs ('[placeholder — landing 2026-Q2]') that only deep-link to these broken canonical files on GitHub. *Check:* Extract every fenced `declaragent …` command from docs/runbooks/*.md and validate against the verb grammar in scripts/docs-cli-extract.ts output; grep every metric token against registry registrations in packages/core/src (dot→underscore mapping); decide whether the 24 stub .mdx pages should ship at all (draft: true) until Slice 7.5 inlines content.
- **Shipped observability artifacts: packages/testkit/alerts/*.rules.yaml and packages/testkit/dashboards/*.json query metrics that do not exist** — These are published npm artifacts and the anchor for error-codes.mdx, runbook-index.mdx, and every runbook_url — yet no slice audited them. Spot-checked: daemon.rules.yaml alerts on bus_inflight, bus_publishes_total, session_active, session_spawned_total, and `time() - max(daemon_last_heartbeat_seconds) > 60` — all 0 hits in core/cli src; the real gauge is `declaragent.daemon.heartbeat_timestamp_seconds` (packages/core/src/observability/heartbeat.ts:19, whose own docstring at :10 shows the correct expr). This makes the pending changeset's claim that 'the DaemonHeartbeatTimeout alert can finally fire' still false as shipped. dashboards/declaragent-event-sources.json queries source_messages_received_total / source_messages_dlq_total etc., but exposition names carry no _total suffix (source.messages.dlq → source_messages_dlq, base-source.ts:170) — same suffix bug the audit caught in cookbook prose but not in the shipped JSON/YAML. *Check:* Script: parse every PromQL identifier out of packages/testkit/alerts/*.yaml + packages/testkit/dashboards/*.json and assert each resolves to a registered metric name dumped from createPrometheusRegistry; run it in CI next to the existing cli.mdx drift guard.
- **Changesets and published CHANGELOG.md files (.changeset/production-readiness-ws1-ws9-ws10.md; packages/cli/CHANGELOG.md, packages/core/CHANGELOG.md, …)** — The pending changeset is a ~40-paragraph claims document that will become the permanent npm changelog, and it already contains at least one claim contradicted by shipped code (heartbeat alert firing — see previous gap), plus volatile claims ('3202 pass / 0 fail', 'all three render formats at parity') that will fossilize. packages/cli/CHANGELOG.md (1200+ lines, published to npm) is an unaudited historical claims ledger; its 0.7.6 entry says builder items #36, #37 AND #38 all landed, while CLAUDE.md:45 and the backlog findings say #38 remains open — a three-way disagreement the audit didn't catch because no slice read changelogs. *Check:* Grep .changeset/*.md and packages/*/CHANGELOG.md for the audit's known-delta patterns (heartbeat alert, transport list, hot reload, #36–#38); add 'changeset claims reviewed against code' to the release checklist so the changelog stops inheriting overstated workstream summaries verbatim.
- **npm package metadata: missing READMEs and stale package.json descriptions** — Spot-checked: only packages/core and packages/plugin-agent-rpc have a README.md — the other 11 packages, including the flagship @declaragent/cli, render blank npm pages. Descriptions leak internal plan jargon into public metadata: 'Phase 5' (all four channel-*), 'Phase 4' (all five source-*), 'Phase 4 slice 16' (testkit), '(v1.1)' plus the exact understated feature list the audit flagged in plugin-agent-rpc's README ('RequestAgent tool, agent-inbox source adapter, and an in-memory transport for tests' — no broker transports, no auth). cli's description is 'Interactive REPL for Declaragent', underselling the entire fleet/up/deploy surface the docs lead with. *Check:* CI loop over packages/*/package.json: assert README.md exists and description contains no /Phase \d\|slice \d\|\(v1\.\d\)/ tokens; hand-rewrite the 13 descriptions once against the current positioning.
- **docs-site navigation integrity: sidebar orphans + onBrokenLinks: 'warn'** — Spot-checked docs-site/sidebars.ts end-to-end: reference/capabilities.mdx and reference/control-plane.mdx — two pages the audit spent 10+ findings correcting — are absent from the reference sidebar items (agent-yaml, cli, env-vars, providers, extensions, rpc, fleet, builder, observability only), so they're unreachable by nav. docusaurus.config.ts:26,36 sets onBrokenLinks and onBrokenMarkdownLinks to 'warn', which is why dead links like intro.mdx's RELEASE_0_6_0_READINESS.md survived to publication. *Check:* Add capabilities + control-plane to sidebars.ts; flip both broken-link settings to 'throw' and fix what falls out; add a CI assertion that every docs/**/*.mdx id appears in sidebars.ts (or is explicitly draft/unlisted).
- **Absolute GitHub URLs across docs (docs-site stubs, alert-rule links, footer)** — Docusaurus link checking (even at 'throw') only covers internal routes. The 24 runbook stubs, runbook-index.mdx, and every alert rule's runbook_url point at github.com/declaragent/declaragent/... paths; the footer links 'Changelog' to github releases — which the audited STATUS.md:69 finding says has no tags for the whole 0.6.0–0.7.5 range, so the public 'Changelog' link shows an essentially empty page. Nobody audited whether these absolute URLs resolve (repo public? paths exist at main?). *Check:* Run lychee/linkinator over docs-site/docs + docs/ restricted to github.com/declaragent URLs; for tree/blob links, cheaper offline check: strip the prefix and assert the path exists in the working tree; repoint the footer Changelog link at the npm CHANGELOG.
- **Claims printed or generated by the CLI itself (banners, wizard copy, proposal previews, deploy-generated README/Dockerfile/service.yaml comments)** — The audit treated committed .md/.mdx as the claims surface, but the most-read 'docs' are what the CLI prints and writes: the deploy gcp-cloud-run generated README (which the deploy-cloud-run.mdx finding leans on), builder proposal previews (the enterprise-zero-to-deploy.mdx:330 finding shows a preview claiming ':9464 by default' — that text lives in code), the OTel startup banners (OTEL_SETUP.md:48 finding shows they drifted), and init scaffold README copy. None of these code-embedded strings were audited as a category; the generated cli.mdx help text is the only mechanized one (verified: .github/workflows/ci.yml:48 drift guard exists and works). *Check:* Snapshot-test the generated artifacts (deploy README/Dockerfile/service.yaml, init scaffolds, builder proposal previews) and grep the snapshots for ports, env vars, and `declaragent` verbs using the same validators as the doc linter; audit banner/hint strings in up-cli.ts and index.tsx once.
- **Template non-README files: agent.yaml prompts/comments, channels.yaml, .env.example, service.yaml inside templates/*** — The audit covered every template README but the YAML files make independent runtime claims: marketing's `${keychain:...}` refs (agent.yaml:124,153,165,173) and kafka-pipeline's SendMessage-to-Kafka instruction (agent.yaml:16-17) were caught only because the READMEs happened to repeat them. Templates whose READMEs are quiet may still carry broken config, wrong ports (the 8787-vs-7777 class), or comments citing dead verbs — these unpack verbatim into user projects. *Check:* Run `declaragent agent validate --json` over every templates/*/ directory in CI (the WS10 verb exists now); grep templates/**/*.{yaml,yml,json,example} comments and prompt text for `declaragent ` verbs, DECLARAGENT_* vars, and port numbers, validating against the same canonical lists as the docs linter.
- **docs-site/docs/cookbook/multi-tenant-starter.mdx and reference/index.mdx as pages** — multi-tenant-starter.mdx was only grazed by a substring fix inherited from the two-tenants finding (tenant_boundary_denied at :41,:48), yet it documents the template whose README earned a HIGH 'multi-TenantRuntime not wired into up' finding — the page almost certainly repeats that architecture claim and was never read as a page. reference/index.mdx and quickstart landing links likewise never appear in any finding. *Check:* One-pass read of multi-tenant-starter.mdx against the templates/multi-tenant-starter findings (per-tenant runtimes, tenant_id metric labels, `declaragent run`), plus a skim of the three section index.mdx pages for inherited claims.
- **docs/ background design docs (FLEET_PLAN.md + 8 design docs)** — CLAUDE.md's repo-layout tree presents 'docs/ SPEC_AND_PLAN.md + FLEET_PLAN.md + 8 bg design docs' as current context, and the audit showed their internal plan-versions (v1.1/v1.2, Phases) leaked into published reference pages and npm descriptions. The docs themselves got zero findings — reasonable to skip content-auditing them, but only if they're mechanically fenced off as historical. *Check:* Assert (CI grep) that every docs/*.md outside an allowlist carries a one-line 'Historical — superseded by SPEC_AND_PLAN.md' banner, so future doc work can't cite them as current; this is cheaper than auditing ~9 documents.

### Cross-cutting drift themes → one mechanism each (completeness critic)

- **Metric-name drift (invented names, _total suffix confusion, missing declaragent_ prefix, wrong labels)** (seen in: observability.mdx, error-codes.mdx, cross-host-fleet-kafka.mdx, grafana-dashboard-import.mdx, siem-audit-export.mdx, two-tenants-one-daemon.mdx, CLAUDE.md:86, docs/runbooks/*, packages/testkit/alerts/*.yaml, packages/testkit/dashboards/*.json, ZERO_TRUST_DEFAULT_MIGRATION.md:269) — One mechanism: a generated metrics manifest. The registry already knows every metric at registration (packages/core/src/observability/prometheus.ts; dot-form names like 'source.messages.dlq'); add a script that instantiates the registry, dumps exposition names, regenerates the observability.mdx metric tables between BEGIN/END markers (clone of scripts/docs-cli-extract.ts), and asserts every PromQL identifier in testkit alerts/dashboards + every `metric_name`-shaped token in docs resolves against the manifest. Kills ~15 hand-edits and prevents recurrence.
- **CLI verb/flag drift — commands that never existed or were renamed (rpc peers→fleet peers, declaragent run→up, fleet render --format→--target, daemon subverbs, dlq flag shapes)** (seen in: ~25 broken_example findings across rpc.mdx, error-codes.mdx, cookbook/*, templates/*/README.md, COMPAT.md, AGENTS.md, plus the unaudited docs/runbooks/* (daemon status/restart, sources reload)) — The mechanism already exists for one file: scripts/docs-cli-extract.ts + the ci.yml:48 drift guard keep cli.mdx in sync. Extend it into a doc-command linter: extract every fenced/backticked `declaragent …` invocation across docs-site/, docs/, templates/, README.md and parse it against the same verb grammar; unknown verb/flag = CI failure. This single check would have caught the largest category of confirmed findings and both runbook problems found in this pass.
- **Version-identity drift — internal plan versions (v1.1/v1.2, Phase N, slice N) and stale npm snapshots (0.4.1, 0.5.21, 0.7.4/0.7.5) presented as current** (seen in: rpc.mdx:15, fleet.mdx:14, intro.mdx:36, installing.mdx:79, troubleshooting/index.mdx:29, STATUS.md:60, CLAUDE.md:7, ENTERPRISE_PRODUCTION_PLAN.md:13, all 13 package.json descriptions, plugin-agent-rpc/README.md) — Mechanism: ban literal versions in prose. Docs build injects the real version from packages/cli/package.json via a token/component; a lint rule fails docs-site + package descriptions on /\bv?1\.[12]\b\|Phase \d\|slice \d/ and on hardcoded 0.x versions outside changelogs; a CI step diffs the CLAUDE.md/STATUS.md version headers against package.json so status docs can't silently lag.
- **Env-var invention/omission — documented vars never read (LOG_LEVEL, TELEMETRY, OFFLINE, CONFIG_DIR, CHAOS gates) alongside real vars never documented (METRICS_PORT, BIND_ADDRESS, RPC_AUTH_DEFAULT, DRAIN_DEADLINE_MS, BASH_ENV_*)** (seen in: env-vars.mdx (6 findings), troubleshooting/index.mdx:41, cross-host-fleet-kafka.mdx:17, docs/runbooks/* (unaudited repeats of LOG_LEVEL)) — Mechanism: a single env-var registry module (name, default, one-line description) that all `process.env.DECLARAGENT_*` reads go through; doc-gen the env-vars.mdx table from it, and a CI grep asserts the set of DECLARAGENT_* tokens in src equals the registry equals the doc table. Both directions of drift (invented and undocumented) become build failures.
- **file:line reference rot in evidence-style docs** (seen in: AGENTS.md:76ff, FIRST_PRINCIPLES_VALIDATION.md:47/75/189, FIRST_PRINCIPLES_AUDIT.md:36, ZERO_TRUST_DEFAULT_MIGRATION.md:230, COMPAT.md:24, AGENT_DURABILITY.md:15, siem-audit-export.mdx:60) — Mechanism: a reference-resolver CI script. Convert citations to `symbol @ path` form (e.g. `resolveMetricsPort @ packages/cli/src/up-cli.ts`); the script asserts the file exists and the symbol appears in it, warning on raw :NNN line numbers. Evidence docs keep their teeth without a human re-verifying dozens of pointers each release — exactly the failure mode that produced ~10 stale_reference findings.
- **Status-scoreboard duplication — the 5-pillar/✅ matrix and ship-lists restated in 6+ places that drift independently (including self-contradiction inside CLAUDE.md)** (seen in: CLAUDE.md:28-46, docs/STATUS.md:41-45, FIRST_PRINCIPLES_VALIDATION.md:33, FIRST_PRINCIPLES_AUDIT.md:5, LAUNCH_PLAN.md:5, ENTERPRISE_PRODUCTION_PLAN.md:12, README.md, intro.mdx:14) — Mechanism: one canonical scoreboard (the AGENTS.md evidence ledger) and links everywhere else — no copies. Enforce with a CI grep that the '5 of 5' / pillar-table pattern appears in exactly one file; other docs get a standard 'status lives in AGENTS.md' pointer block. The audit's worst CRITICAL contradictions (accuracy note vs ✅ marks in the same file) are structurally impossible once there is one writer.
- **'By default / out of the box' inflation for features that are opt-in, peer-dep-gated, or wired in only one of the two runtimes (up vs fleet run)** (seen in: intro.mdx:17/41, observability.mdx:112, grafana-dashboard-import.mdx:126, control-plane.mdx:11, enterprise-zero-to-deploy.mdx:330, OTEL_SETUP.md, AGENTS.md:118/162, FIRST_PRINCIPLES_AUDIT.md:61/63, rotate-vault-secret.mdx) — Mechanism: a defaults-matrix integration test — one table-driven spec asserting each documented default (metrics listener, OTel activation, rate limiting, MCP supervision) in BOTH `up` and `fleet run` construction paths; docs may only claim 'by default' for rows in the spec. Secondary soft gate: CI warn-annotation on doc diffs adding 'by default\|out of the box\|automatically' so a reviewer must confirm the wiring callsite.
- **Placeholder/stub content published as finished docs (todo-blocks, '[placeholder — landing 2026-Q2]', 'Slice 7.5 will inline')** (seen in: All 24 docs-site/docs/troubleshooting/runbooks/*.mdx, runbook-index.mdx:53-58; same pattern risk anywhere todo-block CSS class is used) — Mechanism: CI grep for `todo-block`/`placeholder —` in docs-site/docs that forces `draft: true` (Docusaurus unlisted) or fails the build. Stubs then can't occupy nav slots looking like real runbooks; combined with flipping onBrokenLinks to 'throw', the docs build itself becomes the completeness gate the audit had to perform by hand.
