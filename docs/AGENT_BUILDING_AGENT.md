# The Agent-Building Agent

> ⚠️ **Historical design doc — not maintained.** This document predates the shipped
> implementation and is kept for design context only; command names, config shapes,
> versions, and file paths in it may no longer match the code. `docs/SPEC_AND_PLAN.md`
> supersedes it for requirements; for live capability status see `AGENTS.md`, and for
> user-facing behavior see the docs site (`docs-site/`).


The biggest architectural shift in the series. Everything before this doc treated **my-agent** as a single process the user runs. This doc makes my-agent into a **platform** with two distinct tiers:

- **Builder tier** (local): a conversational agent that configures, builds, and deploys other agents
- **Runtime tier** (cloud): the deployed agents themselves, running on AWS, GCP, Azure, Cloudflare, Fly, Railway, or self-hosted Kubernetes, doing their job

The user installs one CLI. Through conversation, the local Builder helps them describe what an agent should do, compiles that into a deployable artifact, ships it to their chosen cloud, and then manages its lifecycle from the same CLI.

Read `IMPLEMENTATION_PLAN.md` first. This doc reshapes parts of it.

---

## Table of Contents

1. [The Paradigm Shift](#1-the-paradigm-shift)
2. [Two-Tier Architecture](#2-two-tier-architecture)
3. [The AgentSpec](#3-the-agentspec)
4. [The Builder Agent](#4-the-builder-agent)
5. [The Deployment Engine](#5-the-deployment-engine)
6. [Cloud Provider Adapters](#6-cloud-provider-adapters)
7. [Runtime Container & Packaging](#7-runtime-container--packaging)
8. [Secret Management](#8-secret-management)
9. [Control Plane Protocol](#9-control-plane-protocol)
10. [Observability Pipeline](#10-observability-pipeline)
11. [Lifecycle Operations](#11-lifecycle-operations)
12. [State Management](#12-state-management)
13. [Multi-Environment](#13-multi-environment)
14. [Cost Estimation & Governance](#14-cost-estimation--governance)
15. [End-to-End CLI UX](#15-end-to-end-cli-ux)
16. [New Implementation Phases](#16-new-implementation-phases)
17. [Worked Examples](#17-worked-examples)
18. [Pitfalls](#18-pitfalls)

---

## 1. The Paradigm Shift

### Before

```
user ──► my-agent (local CLI) ──► does work
```

One process. The agent lives on the user's laptop. When the laptop sleeps, the agent sleeps.

### After

```
user ──► Builder (local) ──┬──► AgentSpec ──► Deployment Engine ──► Cloud
                           │                                         │
                           └──── manages lifecycle ◄──────────────────┘

Deployed Agent (cloud) ──► handles its duty 24/7
                        ◄─► reports back to Builder on demand
```

Two processes, two tiers. The **Builder** configures and operates agents. The **Deployed Agent** does the actual work, in a cloud the user trusts, running when the laptop is off.

### Why this matters

A user who wants an "agent that monitors my GitHub and pings me in Slack about new PRs" does not want to leave their laptop on forever. They want the agent to *live somewhere else*. Every interesting long-running use case — support bots, on-call automation, event-driven workflows, IoT triage — needs cloud presence.

But they also don't want to write Dockerfiles, IAM policies, Terraform modules, secret bindings, or CI/CD pipelines. That's the Builder's job.

**The tagline**: *Describe it. Deploy it. Done.*

### What the user experiences

```bash
$ my-agent
builder> Hi. What should I build?

you> An agent that monitors my GitHub for new PRs on claude-code and summarizes them in #eng-reviews on Slack.

builder> I can build that. Here's what it needs:
  • Event source: GitHub webhook (on pull_request events)
  • Channel: Slack (bot in #eng-reviews)
  • Skill: pr-summary (summarizes diffs into structured messages)
  • Runtime: small, event-driven
  
  Where should it run?
    1. Cloudflare Workers (free, cold-starts)
    2. Google Cloud Run (~$2/mo, sleeps when idle)  [recommended]
    3. AWS Fargate (~$15/mo, always-on)
    4. Fly.io (~$3/mo)
    5. Self-hosted Kubernetes

you> cloud run

builder> Signing in to GCP... [opens browser]
         Creating project 'my-agent-pr-summarizer'...
         Building container...
         Pushing image...
         Creating Cloud Run service...
         Setting up webhook URL: https://pr-summarizer-xyz-uc.a.run.app/hooks/github
         Registering webhook on github.com/you/claude-code...
         Creating Slack app 'PR Summarizer'... [guides you through OAuth]
         Verifying end-to-end...

         ✅ Deployed. Open a PR to test.
         
         Monitor at: my-agent status pr-summarizer
         Update with: my-agent update pr-summarizer
         Logs: my-agent logs pr-summarizer

you> _
```

That dialogue represents ~30 minutes of work replaced with ~3 minutes of conversation. That's the product.

---

## 2. Two-Tier Architecture

Clear separation of concerns between what runs locally and what runs in the cloud.

### Builder (local tier)

**Runs**: User's laptop / workstation / CI.
**Responsibilities**:
- Conversational spec authoring
- Building container images (or serverless packages)
- Deploying to cloud providers
- Managing deployed agents' lifecycle (update, rollback, destroy)
- Fetching logs, metrics, and status from deployed agents
- Local-only dev loop (run deployed spec on localhost for testing)

**Composition**: all the machinery from the earlier docs — engine, tools, MCP, skills, plugins, channels, events — *plus* a new set of capabilities for deployment.

### Runtime (cloud tier)

**Runs**: cloud provider (Cloud Run, ECS, Fly Machine, Cloudflare Worker, etc.).
**Responsibilities**:
- Executing the AgentSpec: listening for configured events, running configured channels, invoking skills, using permitted tools
- Persisting session state in managed storage
- Exposing a control-plane endpoint for the Builder
- Emitting observability data (logs, metrics, traces) to a configured sink

**Composition**: the **same codebase** as the Builder, with a different entrypoint and a loaded AgentSpec. It is not a separate project; it's the same binary running in "runtime mode."

### Why same codebase

Because you want `my-agent run ./agent.yaml` to work identically on a laptop and in a container. Divergent codepaths = divergent bugs. The runtime mode is just: load spec, hydrate all subsystems from it, run forever. No REPL, no wizard, no deployment tools. Feature-flagged minimal bundle.

### Thin wire between tiers

The Builder and runtime talk over a **control plane protocol** (see §9). Two operations matter:

- **Builder → Runtime**: update, restart, reconfigure, query status, fetch logs
- **Runtime → Builder**: stream logs/events (when Builder is listening), report drift, alert on errors

Everything else — event ingestion, channel I/O, tool calls — happens inside the runtime tier, directly against cloud services.

---

## 3. The AgentSpec

The declarative unit. Think of it as a Kubernetes CRD or a Terraform module: it fully describes one agent. Everything else — build, deploy, update — operates on an AgentSpec.

### The schema

```yaml
# agents/pr-summarizer.yaml
apiVersion: my-agent/v1
kind: Agent
metadata:
  name: pr-summarizer
  description: "Summarizes new PRs in Slack"
  labels:
    env: prod
    owner: eng-productivity
  version: "0.3.1"

spec:
  # What kind of work does this agent do?
  identity:
    model:
      primary: "claude-opus-4-6"
      fallback: "claude-sonnet-4-6"
    systemPrompt: |
      You are a concise code reviewer. Summarize PRs into three parts:
      the change, the risk, the test coverage.

  # Capabilities
  tools:
    builtin: [Read, Grep, Glob]         # no Bash, no Edit — deployed agent is read-only
    disabled: [Bash, Edit, Write]

  skills:
    - name: pr-summary
      source: ./skills/pr-summary.md
    - name: risk-audit
      source: ./skills/risk-audit.md

  plugins:
    - "@my-agent/plugin-github"

  mcp:
    servers:
      - name: github
        command: "npx"
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_TOKEN: "${secret:github-pat}"

  # Triggers (event sources)
  eventSources:
    - name: github-webhooks
      type: webhook
      path: "/hooks/github"
      auth:
        kind: hmac
        header: "x-hub-signature-256"
        secret: "${secret:github-webhook-secret}"
      filter:
        expr: "$.action == 'opened' and $.pull_request != null"
      route:
        kind: skill
        name: pr-summary
        inputs:
          pr_number: "$.pull_request.number"
          repo: "$.repository.full_name"

  # Channels (bidirectional I/O)
  channels:
    - name: slack-eng-reviews
      type: slack
      transport:
        mode: socket
        botToken: "${secret:slack-bot-token}"
        appToken: "${secret:slack-app-token}"
      defaultChannel: "C0123456789"       # #eng-reviews
      permissions:
        mode: auto
        allow: ["Read(**/*)", "mcp__github__*"]
        deny: ["Bash(*)"]

  # Permissions (global ceiling)
  permissions:
    mode: auto
    rules:
      allow: ["mcp__github__*", "Read(**/*)"]
      deny: ["Bash(*)", "Edit(**/*)", "Write(**/*)"]

  # Persistence
  storage:
    sessions:
      backend: managed                    # provider-managed, or specify: s3, gcs, redis
      retentionDays: 30
    memory:
      backend: managed
    audit:
      backend: managed
      retentionDays: 365

  # Observability
  observability:
    logs:
      level: info
      sink: provider-default              # or: datadog, loki, elastic
    metrics:
      sink: provider-default              # or: prometheus, grafana-cloud
    traces:
      sink: provider-default              # or: honeycomb, tempo
    alerts:
      - when: "dlq.depth > 0 for 5m"
        notify: slack:C0ALERTS
      - when: "error_rate > 0.01"
        notify: pagerduty:service-id

  # Runtime hints
  runtime:
    target: cloud-run                      # see §6
    minInstances: 0
    maxInstances: 3
    concurrency: 50
    memoryMB: 512
    cpu: 1
    timeoutSec: 300
    region: us-central1

  # Networking
  networking:
    publicEndpoint:
      enabled: true
      paths: ["/hooks/*"]                  # public webhook paths
    private:
      vpc: "my-agent-vpc"                  # if using private connectivity
    customDomain: null                     # or: "pr-summarizer.mycompany.com"

  # Cost guardrails
  costControls:
    dailyTokenBudgetUSD: 5.00
    monthlyTotalBudgetUSD: 100.00
    onBudgetExceeded: throttle             # throttle | pause | alert
```

### Spec validation

On `my-agent build` or `my-agent deploy`, the spec is:
1. Schema-validated with Zod
2. Cross-validated (every `${secret:*}` reference must resolve in the target environment)
3. Capability-checked (skills reference existing files; plugins are installed; MCP servers are reachable locally for a smoke test)
4. Cost-estimated (see §14)

### Spec vs config

A **config** is what a running instance uses (shape from `IMPLEMENTATION_PLAN.md`). A **spec** is the *declarative* form — includes deployment metadata, resource sizing, observability, networking. A spec compiles down to a config when the runtime starts.

Think: spec = source. Config = build output.

### Multiple agents in one repo

A real deployment has several agents. One repo, many specs:

```
my-fleet/
├── agents/
│   ├── pr-summarizer.yaml
│   ├── oncall-triage.yaml
│   ├── customer-support.yaml
│   └── fraud-monitor.yaml
├── skills/
│   ├── pr-summary.md
│   ├── incident-investigation.md
│   └── fraud-triage.md
├── shared/
│   └── system-prompts.yaml
└── my-agent.config.yaml        # repo-wide defaults
```

The Builder understands the full fleet: `my-agent list` shows all specs, `my-agent deploy --all` deploys everything, `my-agent status` summarizes deployed state.

---

## 4. The Builder Agent

The Builder is itself an agent — a special one. It runs locally, has a specific system prompt, owns a set of **deployment tools**, and guides users through creating, testing, and shipping AgentSpecs.

### Builder system prompt (shape)

```
You are the my-agent Builder. You help users design, build, and deploy agents
to the cloud.

Your workflow:
1. Understand the user's goal.
2. Propose an AgentSpec sketch. Ask clarifying questions only where real
   ambiguity exists.
3. Use the SpecEdit tool to write/update agent YAML.
4. Use the CloudProvision tool to create required cloud resources.
5. Use the DeployAgent tool to push the agent.
6. Verify end-to-end with a smoke test.

Principles:
- Always prefer the cheapest viable target. Recommend provider based on workload
  shape (event-driven vs always-on, traffic volume, state needs).
- Never deploy without preview. Show the user what will be created, changed, or
  destroyed. Ask for confirmation.
- Least privilege. Scope permissions to exactly what skills need. Deny broadly
  by default.
- Propose rollback after every deploy. Test it works.
- Explain costs up front. A user who is surprised by a bill loses trust.
```

### Builder-only tools

The Builder has tools the deployed agent never sees:

| Tool | Purpose |
|---|---|
| `SpecCreate` | Scaffold a new AgentSpec from a high-level description |
| `SpecEdit` | Make targeted edits to an existing spec |
| `SpecValidate` | Run full validation pipeline on a spec |
| `SpecDiff` | Compare two versions of a spec (pre-deploy review) |
| `CloudSignIn` | Open browser to sign into AWS/GCP/Azure/Cloudflare/Fly/etc. |
| `CloudProvision` | Create required cloud resources (bucket, DB, IAM role, secret, etc.) |
| `CloudEstimateCost` | Run cost estimator on a spec for a target |
| `ContainerBuild` | Build the runtime container with the spec baked in |
| `ContainerPush` | Push to provider registry |
| `DeployAgent` | Wire up the full deploy: service, networking, scheduling |
| `RegisterWebhook` | Set up provider webhook (GitHub, Stripe, etc.) pointing at deployed URL |
| `ChannelBootstrap` | Guide through Slack app creation, Telegram bot, Discord app registration |
| `SmokeTest` | Trigger a synthetic event end-to-end; verify it lands as expected |
| `DeployedStatus` | Query a deployed agent's health, metrics, recent events |
| `DeployedLogs` | Stream logs from the deployed agent |
| `UpdateAgent` | Push a new version of the spec |
| `RollbackAgent` | Roll back to previous version |
| `DestroyAgent` | Tear down the cloud resources |

These tools are in a dedicated plugin (`@my-agent/plugin-builder`) that's always loaded in Builder mode.

### Special MCP servers the Builder uses

Each major cloud provider ships an MCP server that the Builder can drive:

- `@my-agent/mcp-aws` — wraps AWS SDK for targeted operations
- `@my-agent/mcp-gcp` — wraps gcloud
- `@my-agent/mcp-azure` — wraps az
- `@my-agent/mcp-cloudflare` — wraps wrangler
- `@my-agent/mcp-fly` — wraps flyctl
- `@my-agent/mcp-github` — for webhook registration, repo access

The Builder uses these through MCP, not bespoke code. That way each provider's integration is a package that evolves independently.

### Conversation pattern

The Builder follows a predictable shape:

1. **Discovery** — "what should it do?" → "where does the input come from?" → "who should it talk to?"
2. **Proposal** — shows the sketched spec + recommended target + cost estimate
3. **Confirmation** — "does this look right?"
4. **Prerequisites** — signs into clouds, creates Slack apps, gathers tokens (all guided, all in the REPL)
5. **Deploy** — runs the full pipeline, narrating each step
6. **Verify** — smoke-tests end-to-end; shows the user how to trigger it manually
7. **Teach-back** — "to update, run `my-agent update <name>`; to see logs, `my-agent logs <name>`"

---

## 5. The Deployment Engine

This is the subsystem that turns an AgentSpec into running cloud infrastructure.

### Pipeline stages

```
AgentSpec
  │
  ▼
[1] Validate       — schema, refs, deps, policy
  │
  ▼
[2] Plan           — compute desired cloud state, diff against current state
  │
  ▼
[3] Preview        — show user what will change; require confirmation
  │
  ▼
[4] Package        — build container / serverless bundle with spec baked in
  │
  ▼
[5] Provision      — create/update cloud resources (compute, storage, secrets, networking)
  │
  ▼
[6] Publish        — push image to registry, deploy revision
  │
  ▼
[7] Wire           — register webhooks, configure channels, set DNS
  │
  ▼
[8] Verify         — smoke test, health check, synthetic event
  │
  ▼
[9] Activate       — flip traffic (blue/green), set as live version
  │
  ▼
[10] Record        — update state store, emit audit event
```

Every stage is **idempotent**. Re-running a deploy converges to the same state. Failed deploys leave partial state rollback-able.

### Plan/apply model

Borrowed directly from Terraform. Two-phase:

```bash
$ my-agent plan pr-summarizer
  → ~ cloud-run service "pr-summarizer"
      - image: "gcr.io/p/pr-summarizer:0.3.0" → "gcr.io/p/pr-summarizer:0.3.1"
      - env.SPEC_HASH: "abc123" → "def456"
  → + secret "slack-bot-token" (new)
  → + github webhook on "you/claude-code"

  Estimated cost impact: +$0.20/month

  Run `my-agent apply pr-summarizer` to proceed.

$ my-agent apply pr-summarizer
  [1/4] Updating secret "slack-bot-token"...   ✓
  [2/4] Deploying cloud-run service...         ✓ (revision 14)
  [3/4] Registering github webhook...          ✓
  [4/4] Running smoke test...                  ✓

  Deployed: https://pr-summarizer-xyz-uc.a.run.app
```

### Failure isolation

A failing stage must not leave orphaned resources. Every stage registers compensating actions with a local transaction log; on failure, the engine runs compensations in reverse order.

**Example**: if container push succeeds but cloud-run deploy fails, the engine either (a) retries the deploy up to N times, or (b) cleans up the newly-pushed image and marks the deploy failed. The user's cloud bill doesn't include orphaned resources.

### Concurrency control

Only one deploy per agent at a time. Distributed lock in the state store (S3 with conditional writes, DynamoDB with condition expressions, etc.). Team usage: two engineers deploying the same agent simultaneously serializes safely.

---

## 6. Cloud Provider Adapters

Same pluggable pattern as event sources, channels, MCP servers: a **`ProviderAdapter`** interface, multiple implementations, each as its own package.

### The interface

```typescript
// src/deploy/provider.ts
export interface ProviderAdapter {
  readonly name: string;                     // "aws" | "gcp" | "azure" | ...
  readonly targets: readonly TargetType[];   // capabilities this provider offers

  /** Validate the spec fits this provider/target. */
  validateForTarget(spec: AgentSpec, target: TargetType): Promise<ValidationResult>;

  /** Compute current state of resources for this spec. */
  readState(spec: AgentSpec): Promise<ProviderState>;

  /** Compute desired state from spec. */
  planState(spec: AgentSpec, current: ProviderState): Promise<ProviderPlan>;

  /** Apply a plan. Idempotent, resumable. */
  applyPlan(plan: ProviderPlan, onProgress: (e: ApplyEvent) => void): Promise<ApplyResult>;

  /** Destroy all resources for a spec. */
  destroy(spec: AgentSpec, onProgress: (e: DestroyEvent) => void): Promise<void>;

  /** Fetch logs from the deployed agent. */
  fetchLogs(spec: AgentSpec, opts: LogOpts): AsyncGenerator<LogLine>;

  /** Fetch metrics / health. */
  fetchStatus(spec: AgentSpec): Promise<DeployedStatus>;

  /** Open an interactive shell to a running instance (for debugging). */
  shell?(spec: AgentSpec): Promise<InteractiveShell>;

  /** Cost estimate for this spec on this target. */
  estimateCost(spec: AgentSpec): Promise<CostEstimate>;
}

export type TargetType =
  | 'cloud-run'          // GCP
  | 'cloud-functions'    // GCP
  | 'fargate'            // AWS
  | 'lambda'             // AWS
  | 'ecs'                // AWS
  | 'apprunner'          // AWS
  | 'container-apps'     // Azure
  | 'functions'          // Azure
  | 'cf-workers'         // Cloudflare
  | 'cf-containers'      // Cloudflare Containers (new)
  | 'fly-machines'       // Fly.io
  | 'railway'            // Railway
  | 'render'             // Render
  | 'kubernetes'         // bare K8s
  | 'docker-compose'     // self-hosted
  | 'nomad';
```

### Provider → Target matrix

| Provider | Targets | Good for |
|---|---|---|
| **AWS** | Fargate, Lambda, ECS, App Runner | Enterprise, team comfort with AWS |
| **GCP** | Cloud Run, Cloud Functions, GKE | Cheapest for event-driven; great cold start |
| **Azure** | Container Apps, Functions, AKS | Enterprise with Microsoft ecosystem |
| **Cloudflare** | Workers, Containers | Edge, free tier, global distribution |
| **Fly.io** | Machines | Simple ops, good for small teams, multi-region |
| **Railway** | Containers | One-click dev-friendly |
| **Render** | Web services, cron | Simple alternative to Fly |
| **Kubernetes** | Any K8s | Users with existing clusters |
| **Docker Compose** | Local/VPS | Self-hosted, air-gapped, dev/staging |

Each is its own package: `@my-agent/provider-aws`, `@my-agent/provider-gcp`, etc. The Builder auto-discovers installed providers.

### Target selection heuristics

The Builder recommends a target based on spec shape:

```typescript
function recommendTarget(spec: AgentSpec, preferences: UserPrefs): TargetType[] {
  const { eventSources, channels, estimated } = analyze(spec);

  // Has long-lived WebSocket channels (Slack Socket Mode, Discord Gateway)?
  const needsAlwaysOn =
    channels.some(c => ['slack', 'discord'].includes(c.type) && usesSocketConnection(c));

  // Purely event-driven with idle periods?
  const idleFriendly = !needsAlwaysOn && eventSources.every(s =>
    ['webhook', 'cron', 'mcp-notification'].includes(s.type)
  );

  // Heavy streaming / high TPS?
  const highThroughput = estimated.eventsPerSec > 100;

  if (idleFriendly && !highThroughput) {
    return ['cf-workers', 'cloud-run', 'lambda'];   // ordered by cheapness
  }
  if (needsAlwaysOn) {
    return ['fly-machines', 'cloud-run', 'fargate']; // min-instances=1
  }
  if (highThroughput) {
    return ['fargate', 'cloud-run-2nd-gen', 'kubernetes'];
  }
  // ... default
}
```

Show 2–3 recommendations with costs; let the user choose.

### What each provider adapter actually does

Take GCP Cloud Run as the illustrative example. The adapter:

1. **Ensures project** (creates or uses existing GCP project)
2. **Enables APIs** (run.googleapis.com, secretmanager.googleapis.com, artifactregistry.googleapis.com)
3. **Creates artifact registry repo** for the container image
4. **Creates service account** with least-privilege IAM (access only to the specific secrets, storage buckets, and external APIs the spec declares)
5. **Creates/updates secrets** in Secret Manager (pulled from the Builder's keychain)
6. **Creates/updates storage** (GCS bucket for transcripts, Firestore for sessions)
7. **Builds container** via Cloud Build or local Docker
8. **Pushes image** to Artifact Registry
9. **Deploys Cloud Run service** with configured memory/CPU/concurrency/min-instances
10. **Sets env vars** (SPEC_HASH, CONTROL_PLANE_TOKEN, etc.)
11. **Provisions custom domain** if configured (via Cloud Run domain mappings)
12. **Configures Cloud Scheduler** jobs for cron event sources
13. **Configures Pub/Sub topics** for internal event transport
14. **Sets up Cloud Logging sink** for audit exports
15. **Writes state** (resource IDs, URLs, revisions) to state store

Other providers do analogous things with their primitives. The spec is the same; the translation differs.

---

## 7. Runtime Container & Packaging

What gets shipped to the cloud.

### The runtime image

A minimal container:

```dockerfile
# Dockerfile (shipped with my-agent)
FROM node:22-alpine AS base
# or: FROM oven/bun:1-alpine for Bun-native

WORKDIR /app

# Install the runtime (the same my-agent binary, runtime-mode)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Copy the spec + auxiliary files
COPY agent.yaml ./
COPY skills/ ./skills/
COPY plugins/ ./plugins/

# Pre-install MCP servers / plugins referenced in spec
RUN my-agent prefetch agent.yaml

# Security
USER 65532:65532
RUN chmod -R a-w /app

EXPOSE 8080
CMD ["my-agent", "run", "agent.yaml", "--mode=runtime"]
```

Size: ~80 MB (Alpine Node) or ~60 MB (Alpine Bun). With pre-installed MCP servers, can grow to 200–300 MB. Use multi-stage builds + `slim` variants.

### Serverless packaging

For function targets (Lambda, Cloud Functions, Cloudflare Workers), build a different artifact:

- **Lambda**: zip with handler that imports the runtime and invokes it with a cached spec. Connections reused via `globalThis` between invocations.
- **Cloud Functions**: similar, uses the functions-framework shim.
- **Cloudflare Workers**: `wrangler` bundle. Runtime must be Workers-compatible (no Node-specific APIs in hot path). Use Durable Objects for session state.

Not every feature works serverless (long-lived WebSocket channels are a bad fit for cold-start-prone platforms). The Builder warns when spec + target are mismatched.

### Build provenance

Every image is built with:

- **Source pinned to commit** (spec repo SHA, `my-agent` version)
- **SBOM emitted** alongside (`sbom.spdx.json`)
- **Signed** with sigstore/cosign
- **Labels**: `org.opencontainers.image.*`, including spec digest

Users can verify a deployed image matches a spec version. Critical for compliance and rollback.

### Reproducibility

Given the same spec + same `my-agent` version, builds must be bit-identical. Pin all transitive deps; use a lockfile; no timestamps baked in; deterministic container image builds (BuildKit `--reproducible` or `ko`-style builds).

---

## 8. Secret Management

Secrets flow from **user's laptop** to **cloud provider's secret manager**, never through anything else.

### Flow

```
Local keychain  ──►  Builder memory (in-process only)  ──►  Provider secret manager
                                                                    │
                                                                    ▼
                                                       Deployed agent fetches at boot
                                                       (or per-request for rotation)
```

### Never

- In the container image
- In environment variables at rest in the provider console
- In the AgentSpec YAML (only references `${secret:name}`)
- In logs
- In the state store
- In telemetry

### Resolution at runtime

On cold start, the deployed agent's initialization:

```typescript
async function resolveSpecSecrets(spec: AgentSpec, provider: ProviderInfo) {
  const client = getSecretClient(provider);   // AWS Secrets Manager, GCP Secret Manager, etc.

  return walk(spec, async (value) => {
    if (typeof value !== 'string' || !value.startsWith('${secret:')) return value;
    const name = value.slice(9, -1);
    return client.getSecret(name);
  });
}
```

### Rotation

```bash
$ my-agent secret rotate slack-bot-token --agent pr-summarizer
  [1/3] Writing new secret to keychain...   ✓
  [2/3] Updating provider secret...         ✓
  [3/3] Restarting agent to pick up...      ✓
```

Deployed agents watch their secret versions (provider-native mechanisms: Secret Manager notifications, Secrets Manager rotation). For providers without native watch, the Builder can trigger a rolling restart.

### Team-shared secrets

Larger teams don't want secrets in personal keychains. The Builder supports external backends:

```yaml
# ~/.my-agent/config.yaml
secrets:
  backend: "hashicorp-vault"              # or: aws-secrets-manager, gcp-secret-manager, 1password
  config:
    address: "https://vault.company.internal"
    path: "my-agent/"
    authMethod: "oidc"
```

All `${secret:name}` references resolve through the configured backend. Local keychain becomes the fallback for personal agents.

---

## 9. Control Plane Protocol

How the local Builder talks to a deployed agent.

### Why we need one

- Fetch logs and metrics in real-time
- Push config updates without full redeploy (hot-reload of skills, rules, prompts)
- Trigger synthetic events for testing
- Signal restart, drain, shutdown
- Query session state for debugging

### Design

**HTTPS + JWT**, not some exotic protocol. Every deployed agent exposes a small control API, gated by:

1. **Cloud provider network rules** (IAM-based, or VPC-only)
2. **JWT signed with the spec's deploy key** (rotated per deploy)
3. **Rate limited**

```
GET  /_ctrl/health                        → liveness
GET  /_ctrl/status                        → active sessions, stats, version
GET  /_ctrl/logs?since=<cursor>           → SSE stream of logs
GET  /_ctrl/metrics                       → OTel scrape endpoint
POST /_ctrl/reload                        → hot-reload skills/rules
POST /_ctrl/smoke                         → fire a synthetic event
POST /_ctrl/drain                         → stop accepting new events
POST /_ctrl/session/<id>/kill             → cancel a stuck session
WS   /_ctrl/events                        → subscribe to live event stream
```

### Authentication

When a spec is deployed, the Builder generates a **control-plane token** and stores it:
- Locally: keychain entry `my-agent-control:<agent-name>`
- Remotely: as a provider secret the runtime verifies against

Every CLI command that touches a deployed agent (`status`, `logs`, `update`, `rollback`, `destroy`) signs its requests with this token.

### Network model

Three options, user-selectable:

1. **Public HTTPS** (default for simple setups) — `/_ctrl/*` on the same ingress as webhook paths, gated by JWT + IP allowlist
2. **Private network** — control plane only reachable from VPC/VPN; typical for enterprise
3. **Cloud-native** — provider-specific (Cloud Run IAM, AWS IAM auth, Azure managed identity)

The adapter picks the right option based on spec + provider capabilities.

### Offline updates (when the Builder isn't connected)

For GitOps-style workflows, the runtime can pull its spec from a configured source (git repo, S3 object, signed manifest). The CLI generates the signed manifest; CI/CD pushes it; the runtime polls.

```yaml
# in spec
spec:
  update:
    mode: pull
    source: "s3://my-agent-specs/pr-summarizer/latest.yaml"
    pollSec: 60
    publicKey: "${file:./update-signing.pub}"
```

---

## 10. Observability Pipeline

The deployed agent must be observable from the Builder's CLI without provider-specific tooling.

### The three pipes

| Pipe | Local view | Cloud sink |
|---|---|---|
| Logs | `my-agent logs <name>` | Provider log service (CloudWatch, Cloud Logging, etc.) or Loki/Datadog |
| Metrics | `my-agent metrics <name>` | Prometheus-compatible endpoint, or provider metrics |
| Traces | `my-agent trace <event-id>` | OTLP sink (Tempo, Honeycomb, Datadog APM) |

### OTel everywhere

Runtime agents emit OTel by default. The spec's `observability` section chooses the sink. For zero-config users: the provider-native sink (CloudWatch for AWS, Cloud Logging for GCP, App Insights for Azure). For opinionated users: configure Grafana Cloud, Datadog, Honeycomb with credentials.

### Unified log tail

Regardless of backend, `my-agent logs pr-summarizer` streams logs in one format:

```
09:32:14.123  INFO    evt:a8f9  webhook received from github.com/you/repo
09:32:14.201  INFO    evt:a8f9  dispatched to skill:pr-summary session:chat:slack:C01...
09:32:15.442  INFO    evt:a8f9  session:... tool call Read(CONTRIBUTING.md) allowed
09:32:16.180  INFO    evt:a8f9  session:... assistant message (412 tokens)
09:32:16.192  INFO    evt:a8f9  slack.postMessage channel=C01... ts=1702...
09:32:16.203  INFO    evt:a8f9  turn complete (cost: $0.0032, duration: 1.95s)
```

Internally the adapter polls/streams from the provider and rewrites into this uniform format. Users never learn CloudWatch's filter DSL unless they want to.

### Cost log

A dedicated, high-priority log stream that tracks every LLM call's cost. Buffered 10 seconds, then flushed to provider + local cache. Enables `my-agent cost` to show real-time spend without querying the provider for each invocation.

### Audit export

Every agent's audit log (tool calls, permission decisions, event dispatches) can be exported to:

- **Provider-managed** (CloudTrail, Cloud Logging with sink to GCS, Azure Monitor)
- **S3/GCS** (JSONL, daily rotation)
- **SIEM** (Splunk HEC, Datadog, Elastic)

Required for SOC 2 / HIPAA / etc. Not optional in regulated environments.

---

## 11. Lifecycle Operations

What the CLI can do to a deployed agent.

### `my-agent build <name>`

Build the container / package for a spec. Does not deploy.

```bash
$ my-agent build pr-summarizer
  → validating spec...                 ✓
  → resolving refs (skills, plugins)...✓
  → building container...              ✓ (sha256:abc123...)
  → Image ready: pr-summarizer:0.3.1
```

Useful in CI or before a deploy to catch build issues early.

### `my-agent deploy <name>`

Build + plan + apply. Interactive confirmation unless `--yes`.

### `my-agent plan <name>`

Compute diff; show changes; don't apply.

### `my-agent apply <name>`

Apply a plan from a previous `plan`. Good for review flows (plan in dev, apply in prod).

### `my-agent status <name>`

Compact health:
```
pr-summarizer (prod)
  Target:        cloud-run (us-central1)
  Version:       0.3.1    Revision: 14    Deployed: 2h ago
  Status:        healthy                  Up: 1d 23h
  Active:        3 sessions
  Events:        1.2K/day (rate ~14/hr)
  Cost:          $1.24 today  $18.03 MTD  Budget: $100/mo
  Last event:    3 min ago (github.pull_request)
  Alerts:        0 firing
```

### `my-agent update <name>`

Push a new version. Default: blue/green with smoke test, auto-rollback on failure.

### `my-agent rollback <name> [--to <version>]`

Flip traffic to a prior revision. Instant.

### `my-agent destroy <name>`

Tear down. Confirm with a matching name for safety. Preserves audit log by default.

```bash
$ my-agent destroy pr-summarizer
! Destroying 'pr-summarizer' will remove:
  - cloud-run service, secrets, storage, webhook registrations
  - 1,428 session transcripts (retained 30 days per spec)

  Preserve audit log? [Y/n] y
  Confirm by typing the agent name: pr-summarizer

  [1/5] Draining...        ✓
  [2/5] Removing webhook... ✓
  ...
  Destroyed.
```

### `my-agent list`

All agents in the current workspace and their state.

### `my-agent diff <name>`

Spec changes vs last deployed version.

### `my-agent shell <name>`

If the provider supports it (Cloud Run Jobs with exec, ECS Exec, K8s `kubectl exec`), drop into a shell in a running instance. For debugging only; not for mutations.

### `my-agent replay <name> --from <time>`

Replay events from a time window against the deployed agent (requires adapter replay support).

---

## 12. State Management

Just like Terraform: the Builder needs to know what it deployed where.

### State file

```json
// ~/.my-agent/state/pr-summarizer.json
{
  "apiVersion": "my-agent/v1",
  "name": "pr-summarizer",
  "specHash": "sha256:def456...",
  "specVersion": "0.3.1",
  "deployedAt": "2026-04-15T14:32:18Z",
  "provider": "gcp",
  "target": "cloud-run",
  "region": "us-central1",
  "resources": {
    "service": { "name": "pr-summarizer", "url": "https://...", "revision": "pr-summarizer-00014-abc" },
    "secrets": [ { "name": "slack-bot-token", "version": "3" }, ... ],
    "storage": { "bucket": "gs://my-agent-sessions-pr-summarizer" },
    "serviceAccount": "pr-summarizer@my-agent.iam.gserviceaccount.com",
    "webhooks": [ { "provider": "github", "id": "12345", "url": "https://..." } ]
  },
  "controlPlane": {
    "endpoint": "https://.../_ctrl",
    "tokenKeychainRef": "my-agent-control:pr-summarizer"
  }
}
```

### Local vs remote state

- **Local** (default): files in `~/.my-agent/state/`. Simple, personal.
- **Remote** (teams): S3 / GCS / Azure Blob backend. Locking via object conditional writes. Multi-user safe.

```yaml
# ~/.my-agent/config.yaml
state:
  backend: "s3"
  config:
    bucket: "my-agent-state"
    prefix: "prod/"
    lockTable: "my-agent-locks"       # DynamoDB (or equivalent)
```

### Drift detection

State ≠ reality is common:

- Someone clicked the cloud console and changed a setting
- An IAM policy expired
- A secret got deleted
- A webhook was manually removed from GitHub

Periodic `my-agent drift <name>` reads the real state, compares to local state, reports differences. Optional: auto-correct with `my-agent apply`.

### Lockless read, locked write

Reads (`status`, `logs`) need no lock. Writes (`deploy`, `update`, `rollback`, `destroy`) acquire a lock for the agent's key. Prevents two users racing each other.

---

## 13. Multi-Environment

Real teams have dev, staging, prod.

### Per-environment specs

Option 1: separate files:
```
agents/
├── pr-summarizer.dev.yaml
├── pr-summarizer.staging.yaml
└── pr-summarizer.prod.yaml
```

Option 2: overlay (preferred):
```
agents/
├── pr-summarizer/
│   ├── base.yaml
│   ├── overlays/
│   │   ├── dev.yaml
│   │   ├── staging.yaml
│   │   └── prod.yaml
```

The Builder merges base + overlay. Use Kustomize-style patches or a simpler deep-merge.

### Environment-aware CLI

```bash
my-agent deploy pr-summarizer --env staging
my-agent promote pr-summarizer --from staging --to prod
```

`promote` copies the staging state (spec + image) to prod; no rebuild required. Atomic.

### Separation at the cloud layer

- Different projects/accounts per environment (the strong boundary)
- Or different service names, same project (the weak boundary; not recommended for prod)

The Builder knows which cloud identity to use per environment:

```yaml
# ~/.my-agent/config.yaml
environments:
  dev:
    provider: gcp
    project: "myteam-dev"
    account: "dev@myteam.iam.gserviceaccount.com"
  prod:
    provider: gcp
    project: "myteam-prod"
    account: "prod@myteam.iam.gserviceaccount.com"
    approvals:
      required: 1                     # require review before apply
      reviewers: ["ops-team"]
```

### Progressive rollout

For critical prod agents:

```yaml
spec:
  runtime:
    rollout:
      strategy: canary
      stages:
        - traffic: 10%
          duration: 10m
          successCriteria: { errorRate: <0.5%, p99Latency: <3s }
        - traffic: 50%
          duration: 30m
        - traffic: 100%
```

Provider must support traffic splitting (Cloud Run and AWS App Runner do natively; Lambda via aliases; Fly via machine groups).

---

## 14. Cost Estimation & Governance

You don't want the first thing a new user experiences to be a $3,000 surprise.

### Pre-deploy estimate

`my-agent plan` shows projected cost before apply:

```
Estimated cost for pr-summarizer on cloud-run (us-central1):

  Cloud Run requests (event-driven, ~14 events/hr estimated)
    ~ 336 requests/day @ $0.000024  ≈ $0.24/month

  Cloud Run compute time (avg 2.1s per request, 512MB)
    ~ 706s/day, 0.5 vCPU-sec + 0.5 GiB-sec  ≈ $0.18/month

  Secret Manager (5 secrets, ~200 reads/day)
    ≈ $0.05/month

  Cloud Logging (~50 MB/day logs)
    ≈ $0.25/month

  LLM API calls (estimated 300K input + 80K output tokens/month)
    @ claude-opus-4-6 pricing: input $15/M, output $75/M
    ≈ $4.50 + $6.00 = $10.50/month

  TOTAL: ~$11.22/month (infrastructure) + LLM usage

  Daily budget: $0.50 (from spec)    Status: within budget
```

Cost estimator pulls live prices from the provider (or uses a curated snapshot). Updated weekly.

### Budget enforcement

Per `costControls` in the spec. The runtime tracks spend; when crossing thresholds:

- **Alert** at 50%, 80%, 100%
- **Throttle** at 100% (rate-limit, return canned "at capacity" responses)
- **Pause** the agent at a configurable multiple

Cost data is the agent's responsibility to track (every LLM call has known cost; provider costs can be queried asynchronously).

### Organization-level policies

```yaml
# ~/.my-agent/config.yaml
governance:
  policies:
    - name: "no-production-without-approval"
      when: "env == 'prod'"
      require:
        - "spec.permissions.mode != 'bypass'"
        - "approvers.count >= 1"
    - name: "budget-cap"
      when: "*"
      assert:
        - "spec.costControls.monthlyTotalBudgetUSD <= 500"
    - name: "required-labels"
      when: "*"
      require:
        - "metadata.labels.owner != null"
        - "metadata.labels.env in ['dev', 'staging', 'prod']"
```

Policies run in `my-agent plan`. Violations block apply unless overridden by an approver.

### Audit + compliance

Every deploy, update, destroy generates an audit record with:
- Who (CLI user identity)
- What (spec hash, target)
- When (timestamp)
- Why (commit message / note)
- Outcome

Exportable for compliance. The audit log is its own append-only store (S3 with object lock, or similar).

---

## 15. End-to-End CLI UX

The full command surface. Organized by user journey.

### Getting started

```
my-agent                          # Launch Builder REPL (interactive)
my-agent init                     # Wizard: pick a template, fill in basics
my-agent doctor                   # Diagnose local setup
my-agent login <provider>         # Sign into a cloud provider
my-agent login anthropic          # Set API key
```

### Authoring

```
my-agent new <name> [--template X]   # Scaffold a new AgentSpec
my-agent edit <name>                  # Open $EDITOR on spec
my-agent validate <name>              # Validate spec
my-agent skill new <skill-name>       # Scaffold a new skill
my-agent test <name>                  # Run locally against dev LLM
```

### Deploying

```
my-agent plan <name> [--env E]
my-agent apply <name> [--env E]
my-agent deploy <name> [--env E]     # plan + apply (with confirmation)
my-agent diff <name>
my-agent rollback <name> [--to V]
my-agent promote <name> --from X --to Y
my-agent destroy <name>
```

### Operating

```
my-agent list
my-agent status [<name>]
my-agent logs <name> [--since T] [--follow]
my-agent metrics <name>
my-agent trace <event-id>
my-agent shell <name>
my-agent cost [<name>]
my-agent drift <name>
my-agent replay <name> --from T --to T
```

### Managing extensions

```
my-agent plugin list/install/remove/update
my-agent mcp list/add/remove
my-agent skill list/new/delete
my-agent provider list/install
my-agent channel list/add/remove
my-agent event-source list/add/remove
```

### Administration

```
my-agent secret list/rotate/revoke
my-agent workspace init/list/switch
my-agent state pull/push/show
my-agent upgrade
```

### Total surface

~50 commands. Organized so `my-agent help` reveals them hierarchically, not as a flat wall of text. Each subcommand has its own `-h`/`--help`.

### Tab completion

Shipped for bash, zsh, fish, PowerShell. Auto-installed by the curl installer; manual with `my-agent completion install`.

---

## 16. New Implementation Phases

This work adds two phases to `IMPLEMENTATION_PLAN.md` and reshapes Phase 7 (Distribution).

### Phase 8 — Deployment Engine Core (5–7 weeks)

**Goal**: `my-agent deploy` works for one provider end-to-end.

- **M8.1** AgentSpec schema + validator (1 week)
- **M8.2** Runtime mode (same binary, minimal bundle) (1 week)
- **M8.3** Container build pipeline (1 week)
- **M8.4** First provider: GCP Cloud Run (2 weeks)
- **M8.5** State store (local + S3 backend) (1 week)
- **M8.6** Plan/apply with rollback (1 week)
- **M8.7** Control plane protocol + /_ctrl endpoints (1 week)

**Exit criteria**: user runs `my-agent deploy pr-summarizer --target cloud-run`; the agent lives in GCP and handles a webhook end-to-end.

### Phase 9 — Multi-Provider & Builder Agent (5–7 weeks)

**Goal**: Builder Agent makes it conversational, and multiple providers are available.

- **M9.1** AWS provider (Fargate + Lambda) (2 weeks)
- **M9.2** Cloudflare Workers provider (1 week)
- **M9.3** Fly.io provider (1 week)
- **M9.4** Azure provider (1–2 weeks)
- **M9.5** Kubernetes provider (1–2 weeks)
- **M9.6** Builder-mode prompt + tools + flow (2 weeks)
- **M9.7** Cost estimator + governance policies (1 week)
- **M9.8** Multi-environment + progressive rollout (1 week)

**Exit criteria**: user conversationally builds + deploys an agent to any supported provider; cost estimates match within 20% of actual bill at 30 days.

### Phase 7 (revised) — Distribution

- Add: Docker base image publishing
- Add: Terraform provider (power users who prefer IaC over the CLI wizard)
- Add: GitHub Action for CI deploys
- Add: Helm chart for K8s
- Add: Provider-specific starter templates (aws-quickstart, gcp-quickstart, cloudflare-quickstart)

### Total timeline update

Original: ~8 months for v1.0 (local only).
**New**: ~12 months for v1.0 (with deployment).

Alternative: **ship local v1.0 at month 8**, deployment at **v2.0 six months later**. That's probably wiser — validates the local product before piling on the deployment complexity.

### Release train (updated)

- v0.1–v0.9 — as before (local-only)
- **v1.0 — local GA** (month 8)
- v1.1–v1.9 — ecosystem buildup; collect deployment feedback
- **v2.0 — Deployment GA** (month 14–15)
- v2.1+ — additional providers, advanced features (progressive rollout, policies, observability integrations)

---

## 17. Worked Examples

### 17.1 The GitHub PR summarizer (the canonical demo)

Shown in §1. 5-minute experience from install to live.

### 17.2 On-call bot

**User goal**: "When PagerDuty alerts, spawn an agent that checks our three main dashboards, greps recent commits, and posts initial investigation to Slack #oncall."

Builder walks through:
- Event source: PagerDuty webhook (user pastes webhook URL destination; Builder generates one)
- Tools needed: Read, Grep, mcp__grafana (for dashboard screenshots), mcp__github (for recent commits)
- Channel: Slack #oncall
- Target: always-on (Fly Machine, because cold-starts during incidents = bad)
- Permissions: read-only
- Cost: ~$4/mo infrastructure + ~$30/mo LLM (assuming 5 incidents/week)

Deploy time: ~8 minutes (Fly signup + provisioning). Result: PagerDuty incidents get an AI-drafted initial triage in Slack within 30 seconds.

### 17.3 Multi-channel customer support

**User goal**: "Support bot on WhatsApp, Telegram, and Slack, backed by our knowledge base (notion)."

Builder:
- 3 channels, unified skill `support-respond`
- MCP server for Notion
- Memory: per-user, persisted
- Target: AWS Fargate (because WhatsApp requires stable egress IP for Meta's webhook verification; Fargate with NAT gateway gives that)
- WhatsApp: walks through Meta template registration (~2 day wait flagged up front)
- Cost: ~$25/mo (Fargate always-on + NAT)

Deploy: 2 days total (Meta approval gates).

### 17.4 Streaming fraud triage (high-scale)

**User goal**: "Kafka topic `transactions.flagged` has 500 events/sec. For each, run a 30-second investigation. If fraud confidence > 0.8, auto-block."

Builder:
- Event source: Kafka (SASL/SCRAM, consumer group)
- Skill: `fraud-triage`
- Session coalescing by `user_id` (so the same user's flags go to one session; agent sees a pattern)
- Write access: `mcp__risk__block-user` only
- Target: AWS Fargate with autoscaling (2–20 tasks based on Kafka lag)
- Observability: Datadog (user-configured)
- Cost: $200–800/mo depending on flag volume

Deploy: ~20 minutes (VPC setup needs manual network config that Builder can't fully automate; it surfaces exact steps).

### 17.5 Fleet of IoT triage agents

**User goal**: "1000 factory sensors on MQTT; flag anomalies; trigger per-device workflows."

Builder:
- One spec, many sessions (per-device session keyed by topic)
- Filter in normalizer: only process when `anomaly=true` (drops 99% of messages)
- Target: GKE Autopilot (existing K8s footprint)
- Cost: ~$40/mo (Autopilot pod time + egress)

Deploy: ~15 minutes.

---

## 18. Pitfalls

### Architectural

- **❌ Making the Builder and Runtime diverge.** Same codebase, different entrypoint. If you split them into two projects you'll ship bugs that only appear in production.
- **❌ Baking cloud providers into the core.** Provider packages are hot-swappable; the core must stay provider-agnostic. Test with an in-memory provider in CI.
- **❌ Skipping the plan phase.** Deploys without plan are destructive. Always show what will change; always require confirmation; always support `--yes` for CI.
- **❌ Storing state locally only.** Teams will try to share state by committing `~/.my-agent/state/` to git. Remote state from day one with a sensible local default.

### UX

- **❌ Asking too many setup questions.** The Builder should infer provider, region, sizing, networking. Ask only when user intent genuinely affects outcome.
- **❌ Dumping raw cloud errors at the user.** Translate: "IAM permission denied: run/admin" → "Your account can't create Cloud Run services. Run `gcloud projects add-iam-policy-binding ...` or use an account with the `roles/run.admin` role."
- **❌ Opaque deploys.** Narrate. Every step. Users tolerate 3-minute deploys when they can see progress; they hate 30-second deploys that look silent.

### Deployment

- **❌ No rollback path.** Every deploy must produce a rollback plan. Test it in CI — deploy v1, deploy v2, rollback to v1, assert the rollback worked.
- **❌ Orphaned resources on failure.** Transactional deploys only. Compensating actions on failure. Audit: at the end of every month, list resources not in state and alert.
- **❌ Secrets leaking into images.** Image scanning in CI. Refuse to build if a secret is baked in. Never log resolved secrets.
- **❌ Deploy key reuse.** Each deploy generates a fresh control plane JWT signing key. Old keys are revoked after the N-minute grace window.

### Provider-specific

- **❌ Long-lived WebSocket channels on Lambda / Cloud Functions.** Cold starts, max execution time. The Builder should refuse and suggest an always-on target.
- **❌ State-heavy workloads on Workers.** Durable Objects work, but there are limits. Test your session model against target before recommending.
- **❌ Cross-region chatter.** Agent in us-central1 + Kafka in us-east-1 = latency + egress costs. Builder co-locates by default; warns on drift.
- **❌ IAM overreach.** Easy to grant `*` permissions to make it "just work." Reject in policy; auto-generate least-privilege role with only the APIs the spec actually uses.

### Governance

- **❌ No cost caps by default.** Every new spec gets a sensible default budget (say, $50/mo per environment). User can raise it explicitly. Prevents surprise bills for experimenters.
- **❌ Prod deploys without approval.** Required approvers (`governance.policies`) must block `--yes` unless a reviewer signs off. CI integration with PRs.
- **❌ Missing audit on destroy.** Audit the destroy event with extra prejudice. Preserve the audit log after resource teardown.

### Operational

- **❌ No drift detection.** Drift happens. Silent drift is worse than loud drift. Run drift checks nightly; alert on non-zero.
- **❌ Unscheduled runtime upgrades.** If a new `my-agent` version changes the runtime, deployed agents keep their old version until explicitly upgraded. Never force-push a new runtime behind the user's back.
- **❌ Poor disaster recovery.** If a region dies, what does the user do? Spec must be redeployable from source; state store must be regional-replicated. Practice recovery.

---

## Closing Thought

The seven docs leading to this one built up the pieces: engine, extensions, events, sources, channels, implementation plan. This doc joins them into a product: **an agent you talk to that builds, deploys, and operates agents.**

The trick, as always, is the recurring pattern — contract, registry, lifecycle, scoped permissions, declarative config. Providers follow it. Runtime mode follows it. The control plane follows it. Nothing is a special case. Everything is a composition of the same primitives.

What the user sees: one CLI, one conversation, one YAML file, one agent in the cloud doing their work. Every other detail — VPC, IAM, image registry, log pipeline, secret rotation, health checks, rollout strategy — is *delivered but hidden*. Visible when they want to see it. Invisible when they don't.

That inversion — complexity present but optional — is the difference between "platform for experts" and "platform for anyone who can describe what they want." The former has 10,000 users. The latter has 10,000,000.

Build toward the latter. Start with Phase 1 tomorrow. Don't let the deployment ambition derail the local product — local ships first, deployment ships after. Both paths lead to the same destination: **the user describes it, the agent builds it, and it just runs.**
