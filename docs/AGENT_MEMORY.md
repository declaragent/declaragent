# Agent memory — opt-in long-term recall (mode 3)

> **Audience:** operators who want an agent to remember durable facts across
> *sessions* and *process restarts*, not just within one transcript.
> **TL;DR:** turn on `agent.yaml#memory.enabled` and the agent gains three
> tools — `memory_write`, `memory_read`, `memory_search` — backed by a
> per-agent SQLite namespace. It is **strictly opt-in**: with the block
> absent the tool set is byte-for-byte unchanged.

This is **mode 3** on the durability ladder. It complements — it does not
replace — the two transcript-scoped modes in
[`AGENT_DURABILITY.md`](./AGENT_DURABILITY.md):

| Mode | What persists | Scope | Opt-in |
| --- | --- | --- | --- |
| 1 · stateless-reactive | the in-turn tool loop only | one event | default |
| 2 · session-pinned (`sessionKey`) | the transcript | one keyed conversation | `sessionKey` on a route |
| **3 · long-term memory** | **named key/value records** | **the agent (cross-session)** | **`memory.enabled`** |

Modes 1 and 2 are about the *transcript* — the messages the engine replays
each turn, bounded by `maxTokens`. Mode 3 is a separate, addressable store the
agent reads and writes **on purpose**, by key. A memory written in one session
is readable in the next, and after a daemon restart, because it lives in a
SQLite file alongside `sessions.db`.

---

## Turning it on

```yaml
# agent.yaml
name: support-bot
model: claude-sonnet-4-5
memory:
  enabled: true
  namespace: support   # optional; defaults to the agent id ("support-bot")
```

- `enabled` (**required** when the block is present) — boolean. `false` (or an
  absent block) registers **no** memory tools.
- `namespace` (optional) — the per-agent isolation boundary. Two agents that
  share a namespace share memories; by default each agent uses its own id, so
  agents are isolated unless you deliberately point them at the same namespace.

The block is validated strictly: a non-boolean `enabled` or an unknown sub-key
fails `declaragent up` with a path-anchored config error rather than silently
passing through.

---

## The tools

When enabled, the host (`declaragent up`) constructs the store and registers
three tools, bound to the store + resolved namespace, into the same runtime
tool set as the built-ins:

| Tool | Input | Behaviour |
| --- | --- | --- |
| `memory_write` | `{ key, value, tags? }` | Upsert a durable record. Re-writing a key overwrites its value + tags. |
| `memory_read` | `{ key }` | Fetch one record by exact key. A miss returns `{ found: false }` (not an error) so the model can branch. Read-only. |
| `memory_search` | `{ query, tags? }` | Substring match against each record's key OR value, optionally narrowed to records carrying **all** of `tags`. An empty `query` with no `tags` returns everything. Read-only. |

The model is told, via each tool's description, to use `memory_write` for facts
worth remembering across conversations (user preferences, decisions, runbook
steps) — not for transient working state.

### Permissioning

Permission keys are namespace-scoped so operators can glob:

```yaml
permissions:
  allow:
    - memory_read:support/*        # read any key in the support namespace
    - memory_write:support/note-*  # write only note-* keys
  deny:
    - memory_write:*               # block all writes by default
```

- `memory_write` / `memory_read` → `<namespace>/<key>`
- `memory_search` → `<namespace>`

---

## Storage & lifecycle

- **Where.** A single SQLite file, `memory.db`, in the declaragent config
  directory — alongside `sessions.db`. One handle is shared across every agent
  an `up`-process hosts; the **namespace** column keys records per-agent, so a
  shared connection is correct and collision-free.
- **When opened.** Lazily, on the **first** agent that enables memory. If no
  agent opts in, the store is never opened and the file is never created — the
  disabled path allocates nothing.
- **Persistence.** Records are on disk, so they survive across sessions and
  across process restarts. WAL + `synchronous = NORMAL` mirror the session
  store's durability posture.
- **Schema.** A single `memories(namespace, key, value, tags_json, created_at,
  updated_at)` table, primary key `(namespace, key)`. Overwrites preserve
  `created_at` and bump `updated_at`.

---

## Back-compat guarantee

Memory is **disabled by default**. With `memory` absent (or `enabled: false`):

- no `MemoryStore` is constructed,
- no memory tools are registered,
- the runtime tool list and its ordering are **byte-for-byte identical** to a
  build without this feature.

The memory tools flow exclusively through the runtime's `extra`-tools channel,
so the built-in tool registry (`BUILTIN_TOOLS`) is untouched.

---

## Explicitly FUTURE / out of scope

The following are **not** part of mode 3 and are deliberately left for later
work:

- **Semantic / embedding recall.** `memory_search` today is exact substring +
  tag matching. Vector / embedding-based "find the most relevant memory" is
  future work.
- **Automatic transcript summarization & pruning.** Memory here is written and
  read *explicitly by the model via tools*. The engine does **not**
  automatically distil a long transcript into memories, nor prune the
  transcript against them. That auto-curation loop is future work.

Until those land, mode 3 is a precise, operator-auditable key/value store the
agent manages on purpose — which is exactly what most "give the agent memory"
asks actually need.
