# Control-plane plan — aggregate N `up` processes into one fleet view

**Target release:** `@declaragent/cli@0.7.0` · **Effort:** ~6 calendar weeks · **Authored:** 2026-04-22

This plan answers the single biggest enterprise-production gap in [FIRST_PRINCIPLES_AUDIT.md](./FIRST_PRINCIPLES_AUDIT.md): SSH-per-host doesn't scale. Operators running 5 / 20 / 200 agents across hosts, zones, or Kubernetes clusters need **one place to see what's happening**, without introducing a hosted SaaS dependency.

Pairs with [RELEASE_0_6_0_PLAN.md](./RELEASE_0_6_0_PLAN.md) — 0.6.0 made each `up` process observable (Slice 1 Prometheus + Slice 2 OTel). 0.7.0 makes a **fleet of `up` processes** observable.

---

## 1 · First-principles framing

An operator-facing control plane has to answer four questions, fast:

| Question | Today's answer | 0.7.0 target |
| --- | --- | --- |
| "Is my fleet healthy right now?" | SSH + `declaragent ps` per host | `declaragent fleet ps` — aggregated status table in one command |
| "Show me events across the whole fleet — why did this Slack message come in at 3am?" | `declaragent events list` per host, manually merge | `declaragent fleet events --since 1h --kind chat.*` — time-merged |
| "What's stuck in any DLQ, anywhere?" | `declaragent dlq list` per host | `declaragent fleet dlq list` |
| "Tail the logs of `classifier` on every host, live." | one `tmux` pane per host | `declaragent fleet logs -f classifier` |

The shape of the answer is **fan-out + aggregate** — not a long-running dashboard daemon, not a web UI, not a hosted SaaS. Each `up -d` already has a local HTTP listener (the `/metrics` endpoint from Slice 1). We extend that listener with a few more read-only endpoints and ship a CLI client that fans out.

---

## 2 · Scope

### In scope (0.7.0 MVP)

| Layer | Artifact | New in 0.7.0? |
| --- | --- | --- |
| `up` process | HTTP endpoints: `/metrics`, `/status`, `/events`, `/dlq`, `/audit`, `/logs` | `/metrics` exists (0.6.0); rest are new |
| `up` process | Auth layer on the HTTP listener (bearer / HTTP basic / mTLS-ready) | New |
| `up` process | Optional remote bind (`observability.bindAddress: 0.0.0.0`) | New — default stays localhost-only |
| CLI client | `~/.declaragent/control-plane.yaml` loader | New |
| CLI client | `declaragent fleet ps` — aggregated status | New |
| CLI client | `declaragent fleet events list \| show` — time-merged event queries | New |
| CLI client | `declaragent fleet dlq list \| show \| drop --kind dispatch` | New |
| CLI client | `declaragent fleet logs [-f] <agent>@<host>` — streaming tail | New |
| CLI client | `declaragent fleet health` — reachability + auth probe | New |
| CLI client | `declaragent fleet audit export --to <sink>` — Splunk/OTLP/S3 sinks | New |
| Docs | Quickstart: "run 3 agents on 3 hosts, see them in one terminal" | New |
| Docs | Runbook: TLS + auth setup for remote bind | New |

### Out of scope (0.7.x patches or 0.8.0+)

- **Web UI / persistent dashboard** — operators use an ink-TUI (0.7.x patch) or Grafana (existing today). A browser-based control plane is 0.8+ territory.
- **Long-running aggregator daemon** (push model) — the fan-out client is stateless. If latency becomes a problem at >200 hosts we'll introduce `declaragent control-plane serve`, but MVP proves stateless suffices.
- **Incident management workflow** (acknowledge / escalate / post-mortem) — belongs in an external PagerDuty / Opsgenie integration, not in declaragent itself.
- **Service mesh / Consul integration** — static `control-plane.yaml` first. Dynamic discovery lands with v1.2.
- **Cross-tenant administration** — tenancy stays scoped to the `up` process. The control plane respects tenant boundaries by passing the operator's tenant claim through.
- **Policy engine** (OPA/Rego) on control-plane actions — every verb today is read-only or explicitly destructive (`dlq drop`). Approval workflows for destructive verbs are a 0.7.x patch.

### Explicit non-goals (permanent 🔵)

- **Hosted SaaS.** Declaragent stays self-hosted, Apache-2.0. If someone wants to run a hosted control plane on top, that's their product — not ours.
- **Replacing per-host SQLite.** Each `up` still owns its audit + events + dlq in local SQLite. Control plane is a view over N local stores; never the write path.

---

## 3 · Prerequisites

Must ship before Slice 1 of 0.7.0 starts:

1. **0.6.0 published.** Specifically the `/metrics` HTTP listener pattern from Slice 1 — that's the substrate we extend.
2. **Kafka nightly soak green** (RELEASE_0_6_0_PLAN.md Slice 7 tail). Control plane trust-boundary work assumes the RPC layer has been field-tested.
3. **No open AGENTS.md 🟡 rows in the observability category** — operators will scrape the new endpoints; they have to be stable.

Soft prerequisites (nice-to-have but not blocking):

- **Dispatch-DLQ active requeue** (Slice 5 deferral). `fleet dlq drop` works at 0.7.0; `fleet dlq requeue` unlocks once the `up` control socket exists. Not gating.

---

## 4 · Architecture

### 4.1 Data flow

```
                       ┌──────────────────────────────────┐
                       │   declaragent fleet <verb>        │
                       │     (control-plane client)        │
                       │                                   │
                       │   reads ~/.declaragent/           │
                       │     control-plane.yaml            │
                       └──────────────┬───────────────────┘
                                      │  HTTPS
                                      │  (parallel fan-out)
           ┌──────────────────────────┼──────────────────────────┐
           │                          │                          │
           ▼                          ▼                          ▼
    ┌────────────┐             ┌────────────┐             ┌────────────┐
    │ up on      │             │ up on      │             │ up on      │
    │ host-A     │             │ host-B     │             │ host-C     │
    │            │             │            │             │            │
    │ :9464/     │             │ :9464/     │             │ :9464/     │
    │  metrics   │             │  metrics   │             │  metrics   │
    │  status    │             │  status    │             │  status    │
    │  events    │             │  events    │             │  events    │
    │  dlq       │             │  dlq       │             │  dlq       │
    │  audit     │             │  audit     │             │  audit     │
    │  logs      │             │  logs      │             │  logs      │
    │            │             │            │             │            │
    │ SQLite:    │             │ SQLite:    │             │ SQLite:    │
    │  sessions  │             │  sessions  │             │  sessions  │
    │  audit     │             │  audit     │             │  audit     │
    │  events    │             │  events    │             │  events    │
    │  rejected  │             │  rejected  │             │  rejected  │
    │  events    │             │  events    │             │  events    │
    └────────────┘             └────────────┘             └────────────┘
```

**Key properties:**
- **Stateless client.** No daemon. No cache beyond per-invocation HTTP responses. `fleet ps` exits as soon as it's printed.
- **Read-only fan-out.** The only destructive verb is `dlq drop` (+ `dlq requeue` when available), both of which gate on `--force` and log to audit on both ends.
- **Local SQLite stays authoritative.** The control plane never writes to per-host state; it only reads snapshots.
- **Opt-in remote exposure.** `observability.bindAddress` defaults to `127.0.0.1`. Operators explicitly flip it to `0.0.0.0` (or a specific interface) and configure auth before remote access works.

### 4.2 Trust boundary

Three threat models the control plane must handle:

| Scenario | Mitigation |
| --- | --- |
| Curious LAN peer scrapes `/events` | Default bind is localhost. Opt-in remote bind requires auth. |
| Stolen bearer token replays `/dlq drop` | Bearer tokens support rotation + audit. Destructive verbs log the caller identity to audit. Short-TTL tokens recommended; mTLS for critical fleets. |
| MITM between control-plane client and `up` | Users MUST terminate TLS in a reverse proxy (nginx / caddy / Cloud Run ingress). The HTTP listener itself is plaintext — the plan does not ship a TLS implementation for v0.7.0 (rolling our own PKI is out of scope; reverse proxies are the right integration point). |
| Malicious `up` responds with crafted payload to crash the CLI | Every endpoint is schema-validated on the client; non-conforming responses log + skip without crashing the aggregation. |

### 4.3 Why pull and not push

Push-based control planes (OTel collector, Fluent Bit, Splunk forwarder) are excellent for high-volume telemetry. Declaragent's control plane is **low-volume, high-interactivity**: an operator running `fleet ps` wants to know what's true **right now**, not what was true 30 seconds ago when the last push batched.

The pull model also:
- Matches Prometheus' scrape model — operators already understand it.
- Avoids a new shared-infrastructure dependency (no Kafka-for-control-plane).
- Keeps each `up` process independent — a single bad forwarder in a push model can DoS the ingestor; a bad pull client just times out on its end.

When fleet size grows past ~200 hosts and stateless fan-out gets slow, **that's** when we add `declaragent control-plane serve` (push-indexed cache). 0.7.0 doesn't pre-optimize for it.

---

## 5 · Configuration surface

### 5.1 Per-`up` side: `agent.yaml → observability`

New fields on the existing `observability` block:

```yaml
# agent.yaml
observability:
  metricsPort: 9464            # existing, since 0.6.0
  bindAddress: 127.0.0.1       # NEW. '0.0.0.0' / '::0' opt in to remote
  endpoints:                   # NEW. Per-endpoint toggles; default all-on when bound
    metrics: true
    status:  true
    events:  true
    dlq:     true
    audit:   true
    logs:    true
  auth:                        # NEW. Required when bindAddress != localhost
    mode: bearer               # bearer | basic | none
    token: ${file:/run/secrets/cp-token}
    # For basic:
    # username: ops
    # password: ${env:CP_PASSWORD}
  rateLimit:                   # NEW. Per-endpoint request cap
    perMinute: 60
```

**Validation rules:**
- `bindAddress` != `127.0.0.1` + `auth.mode === 'none'` → boot rejects with a clear error. "Remote bind requires auth."
- `auth.mode: bearer` with an unresolved token ref → boot rejects. No silent fallback.
- Endpoints map defaults to all-true when `bindAddress` is set; operators can disable per-endpoint (e.g. `logs: false` for compliance).

### 5.2 Client side: `~/.declaragent/control-plane.yaml`

```yaml
version: 1
# Optional named clusters — group hosts so `fleet ps --cluster prod-us-east` works.
clusters:
  prod-us-east:
    hosts: [prod-a, prod-b, prod-c]
  prod-eu-west:
    hosts: [prod-eu-a, prod-eu-b]

hosts:
  - name: prod-a
    url:  https://declaragent-a.internal:9464
    auth: bearer:${file:~/.declaragent/tokens/prod-a.token}
    # Or: auth: basic:ops:${env:CP_PROD_PASS}
    # Or: auth: none   (only when the url is localhost)
    timeoutMs: 5000
    tags: [prod, us-east, kafka-primary]

  - name: prod-b
    url:  https://declaragent-b.internal:9464
    auth: bearer:${file:~/.declaragent/tokens/prod-b.token}
    timeoutMs: 5000
    tags: [prod, us-east]

  - name: dev-laptop
    url:  http://127.0.0.1:9464
    auth: none
    tags: [dev]

# Optional: default filters so bare `fleet ps` doesn't list the whole world.
defaults:
  cluster: prod-us-east
```

**Env var + file expansion** reuses the existing secret-resolver (`createDefaultSecretResolver`) so `${env:...}` / `${file:...}` work out of the box. No new resolver.

---

## 6 · HTTP endpoint contract

Each endpoint is a narrow, versioned read of state the `up` process already has. All responses are JSON except `/metrics` (Prometheus text) and `/logs?format=text`.

### `/status` (new)
```
GET /status
Response: 200
  {
    "version": 1,
    "cliVersion": "0.7.0",
    "pid": 12345,
    "startedAt": "2026-04-22T08:00:00Z",
    "manifestPath": "/opt/declaragent/fleet.yaml",
    "agents": [
      {
        "id": "classifier",
        "uptimeMs": 3600000,
        "sources": [
          { "type": "webhook", "id": "gh", "summary": "webhook on :8080/gh" }
        ],
        "channels": [
          { "type": "slack", "id": "slack-main", "ready": true }
        ],
        "metrics": {
          "eventsDispatched": 1247,
          "eventsRejected":   3,
          "breakerOpen":      0
        }
      }
    ]
  }
```

### `/events` (new)
```
GET /events?kind=chat.*&since=<ms>&limit=100&outcome=rejected&state=circuit-open
Response: 200
  {
    "version": 1,
    "rows": [
      { "id": "...", "kind": "chat.mention", "timestamp": 1234567, "source": {...},
        "target": {...}, "outcome": {"kind":"rejected","reason":"circuit-open",...} }
    ],
    "nextCursor": "<opaque>"
  }
```

Backed by `EventStore.list()` (no new core work). Filters match `EventStoreListFilter`; the CLI's `--state circuit-open` convenience flag translates.

### `/dlq` (new)
```
GET /dlq?kind=dispatch&reason=circuit-open&minAttempts=3&since=<ms>&limit=100
Response: 200
  {
    "version": 1,
    "rows": [
      { "eventId": "...", "rejectionReason": "invalid",
        "attemptCount": 4, "firstSeenMs": ..., "lastSeenMs": ... }
    ]
  }

DELETE /dlq/<eventId>?kind=dispatch
Response: 200 { "dropped": true }   — requires auth with write scope
```

Backed by `EventStore.listRejections()` + `deleteRejection()` (shipped 0.6.0 Slice 5).

### `/audit` (new)
```
GET /audit?since=<ms>&kind=<glob>&limit=500
Response: 200
  {
    "version": 1,
    "rows": [ <AuditEntry> ]
  }
```

Backed by the existing `createSqliteAuditSink` reader (`packages/core/src/audit/sqlite-sink.ts`). The hash-chain head is also exposed via `/audit?head=1` so a SIEM export can request a chain-proof.

### `/logs` (new)
```
GET /logs?agent=classifier&lines=200&format=json
Response: 200
  <NDJSON stream — one log record per line>

GET /logs?agent=classifier&follow=1
Response: 200 (text/event-stream)
  Server-sent events — one NDJSON line per event, heartbeats every 15s
```

Reads from the existing per-agent log files under `~/.declaragent/logs/<agent>/*.jsonl`. `follow=1` switches to SSE so the client can tail live.

### `/metrics` (unchanged from 0.6.0)
Prometheus text format — `fleet metrics` scrapes each host + aggregates in-CLI for the TUI dashboard.

---

## 7 · CLI surface

All new verbs are under `declaragent fleet` alongside the existing `fleet deploy` / `fleet run` / `fleet graph` / etc.

### `declaragent fleet ps [--cluster <name>] [--tag <tag>] [--json]`

```
NAME         HOST       AGENTS            UPTIME    DISPATCHED  REJECTED  BREAKER
────────────────────────────────────────────────────────────────────────────────
prod-a       10.0.0.5   classifier,…(3)   2d 14h    12,401      3         —
prod-b       10.0.0.6   reviewer,…(2)     2d 14h    8,932       1         —
prod-eu-a    10.1.0.5   classifier,…(3)   1d 03h    6,110       0         —
dev-laptop   localhost  concierge         14m       42          0         —
```

Failure: a host that doesn't respond within `timeoutMs` appears with `HOST: unreachable` + a clear error in the trailer. One bad host never blocks the table.

### `declaragent fleet events list [--since <dur>] [--kind <glob>] [--state <s>] [--host <name>] [--cluster <name>] [--limit <n>] [--json]`

Fans out to every matching host's `/events`, merges by timestamp, prints a table identical in format to `declaragent events list`. `--host` restricts to one host; `--cluster` restricts by cluster name.

### `declaragent fleet events show <eventId>`

The CLI doesn't pre-index event ids → hosts. Behavior: fan out to every host, first match wins, print the row. Warns if multiple hosts claim the id (shouldn't happen — ids are UUIDs — but surfaces fleet-misconfiguration).

### `declaragent fleet dlq list|show|drop --kind dispatch`

Same fan-out pattern. `drop` requires `--force` + a host-qualified id (`dlq drop --kind dispatch eventId@host-name`).

### `declaragent fleet logs [-f] [<agent>[@<host>]]`

- No args: tail the last 100 lines from every agent on every host.
- `<agent>`: restrict to one agent name; fan out to every host that runs it.
- `<agent>@<host>`: pinpoint one log stream.
- `-f`: follow live via the SSE endpoint. Multiplexes multiple streams with a `[host/agent]` prefix per line.

### `declaragent fleet health [--json]`

Probe each host: reachability + auth + endpoint-level `200` + core metrics present. Exit code 0 when every host is healthy, 1 otherwise. Fits into a monitoring cron.

### `declaragent fleet metrics [--cluster <name>] [--top 10]`

Aggregates Prometheus scrapes from each host. Prints a sparkline TUI (Ink) for the top N metrics (events/sec, rejection rate, breaker transitions, LLM cost). Press `q` to exit. Designed to be the "on-call Grafana replacement when you don't have a dashboard yet."

### `declaragent fleet audit export --to <sink> [--since <dur>] [--format ndjson|otlp|cef]`

Pulls from every host's `/audit` endpoint, writes to:

- `--to splunk:<url>` — HEC pusher
- `--to otlp:<endpoint>` — OTLP logs exporter
- `--to s3://<bucket>/<prefix>` — chunked NDJSON + manifest
- `--to file://<path>` — local NDJSON dump (smoke test)

Hash-chain continuity is preserved across hosts — each host's chain export carries its chain-head + root-of-trust so a SIEM can verify continuity per-host.

### `declaragent fleet control-plane init`

Scaffold `~/.declaragent/control-plane.yaml` + generate a fresh bearer token per declared host + print the `auth.token` YAML to paste into each host's `agent.yaml`. This is the 30-second bootstrap path.

---

## 8 · Security model

### 8.1 Default posture

- HTTP listener binds `127.0.0.1` until an operator explicitly opts in.
- `auth.mode: none` is refused when `bindAddress != localhost`.
- Destructive verbs (`dlq drop`, future `dlq requeue`) require `write` scope in the bearer token — the server-side config maps scopes to tokens. Read-only clients can't mutate state with a compromised read token.

### 8.2 Token lifecycle

- **Generation:** `declaragent fleet control-plane init` mints per-host tokens using `crypto.randomBytes(32).toString('hex')`. Length matters; short tokens are refused at boot.
- **Rotation:** tokens are single-value files. Operators rotate by dropping a new file + SIGHUP'ing the `up` process (existing reload path).
- **Audit:** every authenticated request appends `cp.request` to the local audit chain — `{ pathname, method, scope, requestIp, tokenId }`. A compromised token leaves a chain-traceable trail.

### 8.3 Network path

The plan does **not** ship TLS in `up`'s HTTP listener. Instead:

- **Recommended:** terminate TLS in a reverse proxy (nginx, Caddy, Cloud Run ingress, Istio sidecar). Document the nginx config in `docs/RUNBOOK_CONTROL_PLANE_TLS.md`.
- **Fleet-local alternative:** SSH tunnel via `declaragent fleet ssh-tunnel <host>` — spawns a local port-forward. Zero extra infrastructure; best for ops laptops.
- **v0.7.x patch:** accept a `tls` block on `observability.auth` that loads cert + key files and wraps the listener. Punted to a patch because the reverse-proxy path covers 90% of deployments.

### 8.4 Rate limit

Per-endpoint request cap (default 60/min) keeps a malicious client from burning local CPU with repeated `/events?limit=10000` queries. Rate-limit exceeded → 429 with `Retry-After`; the CLI backs off + warns.

---

## 9 · Slice plan

### Slice 1 · Extended HTTP endpoints on `up` (1 week)

**PR 1.1** · Refactor `up-cli.ts`'s HTTP listener to accept a `router` instead of hardcoding `/metrics`. Add `/status` + `/events` + `/dlq` + `/audit` endpoints, each reading from the existing core stores (`EventStore`, `SqliteAuditSink`). Localhost-only; no auth yet. Unit tests per endpoint.

**PR 1.2** · Add `/logs` endpoint (both batched + SSE follow). File-tailing logic lives in a new `packages/core/src/observability/log-tail.ts`. Tests with in-memory fake streams.

**Acceptance:** `curl :9464/status` returns a valid JSON snapshot when `declaragent up -d` is running.

### Slice 2 · Auth + remote bind (4 days)

**PR 2.1** · `observability.bindAddress` + `observability.auth` schema additions to `agent.yaml`. Zod validation + boot-time refusal for `bindAddress != localhost && auth.mode === 'none'`.

**PR 2.2** · Middleware layer on the HTTP listener: bearer / basic auth + rate limit. Audit integration — every authenticated request appends to the chain.

**Acceptance:** curl against a remote-bound `up` with a bad token gets 401 + no leak; with a good token gets 200; without any auth config the bind is refused with a clear error.

### Slice 3 · `control-plane.yaml` loader (3 days)

**PR 3.1** · Loader in `packages/cli/src/control-plane-config.ts` — YAML parsing, env/file substitution via existing resolver, per-host auth config normalization, cluster-membership expansion. Unit tests covering malformed YAML + bad auth shapes.

**PR 3.2** · `declaragent fleet control-plane init` verb — scaffold + token generation + per-host config fragment emission.

**Acceptance:** `init` in an empty home dir produces a working `control-plane.yaml` + tokens that validate at boot.

### Slice 4 · `declaragent fleet ps` (1 week)

**PR 4.1** · HTTP client in `packages/cli/src/control-plane-client.ts` with timeout + auth handling + concurrent fan-out (parallel `/status` calls). Returns a typed aggregated report.

**PR 4.2** · `declaragent fleet ps` verb — reads loader config, fans out, renders table or JSON. Unreachable-host row with a trailer.

**Acceptance:** `fleet ps` against 3 local `up` processes on different ports returns a coherent 3-row table.

### Slice 5 · `fleet events` + `fleet dlq` (1 week)

**PR 5.1** · `events list` + `events show` — time-merged aggregation, cursor-aware pagination.

**PR 5.2** · `dlq list` + `dlq show` + `dlq drop` — the drop path uses `DELETE /dlq/<id>` with write scope.

**Acceptance:** a webhook event fired at one host, a circuit-breaker trip at another, a DLQ drop at a third — all observable + manipulable through the new verbs.

### Slice 6 · `fleet logs -f` (1 week)

**PR 6.1** · SSE multiplexer in the CLI — reads from N `/logs?follow=1` streams, interleaves by timestamp, prefixes each line with `[host/agent]`. Clean shutdown on SIGINT.

**PR 6.2** · Replay / follow switching — `fleet logs` (no `-f`) shows last 100 per host; `-f` switches to SSE. Cursor handover between the two modes so no log lines are lost at the transition.

**Acceptance:** a three-host fleet tailing in one terminal shows interleaved output in real time; SIGINT closes all streams promptly.

### Slice 7 · `fleet health` + `fleet metrics` (4 days)

**PR 7.1** · `fleet health` — per-host reachability + auth probe + exit-code contract. JSON mode for monitoring cron integration.

**PR 7.2** · `fleet metrics` — Ink-based TUI with top-N sparklines. Subscribes to each host's `/metrics` on a 5-s interval, diffs counters, renders.

**Acceptance:** `fleet health` returns 0 against a healthy fleet, 1 when one host is unreachable; `fleet metrics` renders a live-updating TUI.

### Slice 8 · `fleet audit export` (1 week)

**PR 8.1** · Sink abstraction — `AuditExportSink` interface. Three impls: `splunk` (HEC), `otlp` (OTLP/HTTP logs), `s3` (multipart NDJSON). Plus `file://` for smoke tests.

**PR 8.2** · Hash-chain continuity check — verify each host's chain locally before exporting. A broken chain aborts the export with the compromised segment called out.

**PR 8.3** · `fleet audit export` verb — reads config + sink arg, pulls from every host's `/audit`, streams to sink. Idempotent with resumable cursors.

**Acceptance:** `fleet audit export --to splunk:https://...` round-trips real audit entries from three hosts into Splunk with chain-verified order.

### Slice 9 · Docs + release cut (3 days)

**PR 9.1** · Quickstart: "3 hosts, 3 agents, one terminal" — installable tutorial.

**PR 9.2** · Runbook: TLS + auth setup for remote bind (reverse-proxy, SSH tunnel, `fleet ssh-tunnel` verb).

**PR 9.3** · AGENTS.md flip — "managed control plane" row 🟡 → ✅ single-machine, 🟡 enterprise (pending soak).

**PR 9.4** · `docs/RELEASE_0_7_0_READINESS.md` operator checklist (mirrors `RELEASE_0_6_0_READINESS.md`).

---

## 10 · Test strategy

### Unit layer

- Per-endpoint handler tests (`status.test.ts`, `events-endpoint.test.ts`, etc.) against stubbed `EventStore` / audit sink. Existing test patterns from `up-cli.test.ts` apply.
- Auth middleware test matrix: missing token × wrong token × wrong scope × rate-limit-exceeded.
- `control-plane-config.test.ts` covering every `auth:` shape + env substitution + bad YAML.
- CLI client test against a mocked `fetch` — one green host + one unreachable host + one auth-failing host, all in one `fleet ps` table.

### Integration layer

- `packages/testkit/src/control-plane-integration/` (new sibling to `fleet-integration/`):
  - Spin up 3 `up` processes on ports `19001-19003` against a tmp SQLite per agent.
  - `fleet ps` returns 3 rows.
  - `fleet events` time-merges events fired at different hosts.
  - `fleet dlq drop` at one host deletes only that host's row.
  - `fleet audit export --to file://` produces a verifiable chain.
- Gated by `CONTROL_PLANE_INTEGRATION=1` env var (mirrors `FLEET_INTEGRATION=1`).

### Nightly

- `.github/workflows/nightly-control-plane.yml` runs the integration suite. Failures file an issue (same pattern as `nightly-integration.yml` from 0.6.0 Slice 7).
- **Exit criterion** for 0.7.0 → stable: 7 consecutive green nightlies with the 3-host harness.

### Security

- Fuzz the HTTP handlers with malformed headers, oversized bodies, path-traversal attempts (e.g. `/logs?agent=../etc/passwd`).
- Property test: auth middleware never returns 200 for a mis-signed / expired / insufficient-scope token.

---

## 11 · Rollout + adoption path

### Phase A · Dogfood (Week 1–2 after 0.7.0 tag)

- Declaragent team runs `fleet ps` + `fleet events` against the npm-publish infrastructure (at minimum dev-laptop + one Cloud Run host).
- Any friction lands as a 0.7.1 patch before public adoption push.

### Phase B · Early adopters (Week 3–6)

- Publish "Run 3 agents across 3 hosts" blog post + a 10-min screencast.
- Follow-up with the first 3 enterprise design partners (see `SPEC_AND_PLAN.md` §Part 7 — "first design partners" is a deferred decision; this feature is the right hook to close that).
- Pair-on-install with each partner; harvest config-loader edge cases.

### Phase C · General adoption (Week 7+)

- Ship 0.7.1 with every partner-reported fix.
- AGENTS.md row flips 🟡 → 🟢 (enterprise-production for managed control plane) only after two partners run continuously for 30 days without intervention.

---

## 12 · Post-MVP: what 0.8.0+ adds

Not plans — hypotheses to validate with partner feedback:

- **`declaragent control-plane serve`** — opt-in indexing daemon for >200-host fleets. Push-based intake, cached aggregation, WebSocket subscriptions. Only ships if the stateless model actually becomes a bottleneck.
- **Browser UI** — once the `fleet metrics` TUI stabilizes and we know what operators look at, port the same views to a web app. Ship as `@declaragent/control-plane-ui` — separate package, same API.
- **Dynamic host discovery** — Consul / etcd / K8s label selectors. Config grows a `discover: { provider: k8s, namespace: ... }` block.
- **Policy engine** — Open Policy Agent on destructive verbs. Slack-approval runbook integration.
- **Multi-tenant control plane** — operators see only the hosts / tenants they're scoped to. Requires the SSO work called out in FIRST_PRINCIPLES_AUDIT.md §"Enterprise gaps".

---

## 13 · Relationship to existing plans

| Plan doc | Interaction with CONTROL_PLANE_PLAN |
| --- | --- |
| `SPEC_AND_PLAN.md` | Orthogonal — control plane is purely operational, doesn't touch the agent spec. |
| `RELEASE_0_6_0_PLAN.md` | Direct predecessor. 0.6.0's `/metrics` endpoint is the substrate. |
| `FIRST_PRINCIPLES_AUDIT.md` | Directly addresses gap #3 ("managed control plane") + gap #5 ("SIEM audit export"). |
| `FLEET_PLAN.md` | Complementary — `fleet deploy` (existing) ships agents; `fleet ps / events / logs` (this plan) operates them. |
| `AGENT_RPC_PLAN.md` | Independent. Control plane observes RPC traffic via metrics + audit; it doesn't route RPC. |
| `PHASE_6_PLAN.md` | The tenancy work there is the floor for future multi-tenant control plane. |

---

## 14 · Open questions

To close before Slice 1 starts:

1. **Token scheme — JWT vs opaque bearer?** Leaning opaque (simpler, no clock-skew concerns), but JWT allows self-contained scope claims without a server-side registry.
2. **SSE vs WebSocket for `/logs?follow=1`?** SSE is simpler, HTTP/1.1-compatible, no framing. WebSocket is bidirectional — do we ever need client → server messages on the logs channel? Probably not → SSE wins.
3. **Cursor format for `/events`?** Base64-opaque (hide the SQL), or explicit `{ sinceMs, id }`? Opaque is more forgiving for schema migrations; explicit is easier to debug. Leaning opaque.
4. **How does `fleet audit export` handle a host that can't produce a valid chain?** Abort the whole export (conservative) or skip the compromised segment with a warning (operator-friendly)? Going with "abort by default, `--allow-chain-gap` flag to override."
5. **Should `fleet ps` show per-tenant rollups when multi-tenant runtime is active?** Yes in post-MVP; MVP shows aggregate only.

---

## 15 · Sign-off checklist

Before declaring 0.7.0 done:

- [ ] All 9 slices merged + changesets staged.
- [ ] 7 consecutive green nightlies on `nightly-control-plane.yml`.
- [ ] At least 2 external operators ran `fleet ps` against their own fleets without a bug report.
- [ ] `docs/RELEASE_0_7_0_READINESS.md` checklist complete (mirrors 0.6.0 pattern).
- [ ] AGENTS.md "managed control plane" row flipped 🟡 → ✅ (single-machine) + 🟡 (enterprise, pending 30-day soak per Phase C above).
- [ ] `FIRST_PRINCIPLES_AUDIT.md` cross-pillar gap list updated — item #3 struck through; remaining gaps ranked.

---

## 16 · Summary

Six calendar weeks. Nine slices. Every feature is a thin extension over something 0.6.0 already ships — `/metrics`, `EventStore`, `SqliteAuditSink`, the log-file convention. No new infrastructure dependencies. No new architectural concepts. The hard part isn't design — it's getting the security model (auth + remote bind) right on the first merge, and getting the SSE log-multiplexer to not drop lines under load.

**Biggest risk:** the TLS punt. Operators will ask for in-process TLS; reverse-proxy documentation has to be truly rock-solid. If partner feedback makes this a deal-breaker, 0.7.x patches an in-process TLS block.

**Biggest win:** the CLI already has `declaragent fleet deploy` + `declaragent fleet run`; adding `fleet ps / events / dlq / logs / health / metrics / audit export` makes `declaragent fleet ...` a real operator verb tree — the enterprise story becomes *"one CLI, every capability, one fleet view."*

That's exactly the theme the home page now sells — **an agent to build and manage agents for enterprise.** 0.7.0 is the release that makes the "manage" word true at enterprise scale.
