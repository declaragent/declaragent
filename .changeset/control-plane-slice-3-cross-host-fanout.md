---
'@declaragent/cli': patch
'@declaragent/core': patch
---

feat(control-plane): Slice 3 — cross-host `fleet ps/events/dlq/logs` fan-out (#50)

Adds `fleet.yaml#hosts[]` config block — one `{name, url, auth?: {bearer}, timeoutMs?}` entry per remote `up` process. When present, four new `declaragent fleet` verbs fan out across every host's HTTP control-plane endpoints, merge by timestamp, and tag each row with its host (and `agentId` when the host is itself multi-agent):

- `declaragent fleet ps [--host <name>] [--json]`
- `declaragent fleet events [...filters] [--all] [--json]`
- `declaragent fleet dlq [...filters] [--all] [--json]` — read-only (drop/requeue still single-host)
- `declaragent fleet logs [--host] [--agent] [--max-lines] [--json]` — snapshot-only; `-f` follow deferred to Slice 6

Per-host bearer tokens support `env:NAME` / `file:/path` / literal strings. One host failure is isolated to a tagged trailer; survivors keep flowing. No `hosts:` block = no behaviour change.
