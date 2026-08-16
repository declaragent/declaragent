# @declaragent/cli

The Declaragent CLI — REPL, runtime daemon, and fleet verbs for
[Declaragent](https://declaragent.dev), the declarative, git-versioned AI agent
platform. An agent is an immutable runtime core plus a git-versioned
`agent.yaml` (identity, tools, skills, plugins, event sources, channels,
permissions, secrets, deployment). The CLI is itself an agent built on
`@declaragent/core` — the same runtime you ship.

## Install

```bash
npm install -g @declaragent/cli     # or: curl -sSL https://get.declaragent.dev | sh
declaragent --version               # a `d9t` alias is installed too
```

## Quickstart

```bash
declaragent init                 # scaffold from a template (concierge, oncall-escalator, …)
declaragent auth login           # Anthropic / OpenRouter / env-var credentials
declaragent up -d                # bind sources + channels, run the daemon
declaragent logs -f              # tail per-agent logs
declaragent events list --last 20
declaragent down
```

Detached mode serves a read-only control plane on `127.0.0.1:9464` —
Prometheus `/metrics`, `/status`, `/events`, `/dlq`, `/audit`, `/logs` (SSE),
plus auth-exempt `/healthz` + `/readyz` for k8s probes.

## Surface overview

- **Lifecycle** — `up [-d]`, `ps`, `logs [-f]`, `down`, `daemon-reload`
- **Observability** — `events list`, `dlq list|show|drop|requeue`, `audit query|verify|prune`
- **Fleets** — `fleet new|add|run|validate|capabilities|graph|peers|status|render|deploy`,
  cross-host `fleet ps|events|dlq|logs` via `fleet.yaml#hosts[]`,
  `fleet audit-rpc` (pre-flight for the 0.8.0 zero-trust default flip)
- **Extensions** — `mcp add|list|login` (stdio; remote transports via config),
  `plugin install`, `source add|list`, `skill`, `extensions`
- **Secrets & tenants** — `secrets describe|rotate`, `tenants list`, `erase --user`
  (GDPR), env / Vault / AWS-SM / GCP-SM / K8s secret providers
- **Builder** — set `DECLARAGENT_BUILDER=on` and converse a deployable agent or
  fleet into existence from the REPL
- **Deploy** — `deploy gcp-cloud-run` generates Dockerfile + service.yaml +
  the exact `gcloud` steps (you run them)

## Honest status

Single-machine production is ready; multi-host/enterprise is partial and
tracked openly — see [AGENTS.md](https://github.com/declaragent/declaragent/blob/main/AGENTS.md)
for the evidence-backed capability ledger.

- Docs: <https://declaragent.dev>
- Repo: <https://github.com/declaragent/declaragent>
- License: Apache-2.0
