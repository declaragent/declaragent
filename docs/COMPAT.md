# Declaragent — Compatibility & the 1.0 contract

**Status today: everything is `0.x`. Breaking changes are allowed between minor versions.**
This document defines what the project *intends* to freeze at `1.0`, and what `0.x` still
explicitly reserves the right to break before then. It is a statement of intent, not a
guarantee in force today.

For current versions and the live scoreboard, see [`STATUS.md`](./STATUS.md).

---

## What 1.0 will freeze (the back-compat surface)

Once `1.0` ships, the following surfaces follow SemVer: additive/compatible changes in
minor releases, breaking changes only in a new major. Each surface has an authoritative
schema source in code (linked read-only — this doc does not redefine them).

### 1. `agent.yaml` schema

The declarative agent definition: identity, tools, skills, plugins, event sources, channels,
permissions, secrets, deployment.

- **Authoritative loader:** [`packages/core/src/agents/load-agent.ts`](../packages/core/src/agents/load-agent.ts)
  (`loadAgent`, around line 575). The fields it parses and validates are the frozen surface.
- **1.0 promise:** fields documented as stable keep their meaning and shape. New optional
  fields may be added in minors. Removing or repurposing a field, or tightening validation
  in a way that rejects a previously-valid file, is a major-version change.

### 2. `fleet.yaml` schema

The multi-agent fleet manifest: `agents[]`, `hosts[]`, `controlPlane:`, transport selection.

- **Authoritative schema:** [`packages/core/src/fleet/manifest-schema.ts`](../packages/core/src/fleet/manifest-schema.ts).
- **1.0 promise:** same rules as `agent.yaml`. The cross-host `hosts[]` and `controlPlane:`
  blocks are part of the frozen surface.

### 3. CLI verb surface

The stable command surface operators script against. These verbs and their documented flags
are frozen at 1.0 (additional flags may be added; existing flags keep their meaning):

- `declaragent init`
- `declaragent auth login`
- `declaragent up [-d]`
- `declaragent ps` / `declaragent logs` / `declaragent down`
- `declaragent events list` / `declaragent audit verify` / `declaragent dlq list`
- `declaragent fleet audit-rpc [--suggest-enable] [--strict] [--json]`
- `declaragent fleet render --format k8s|helm`
- `declaragent fleet run`
- `declaragent fleet ps` / `events` / `dlq` / `logs [--host <name>] [--json]`
- `declaragent fleet deploy [--canary --canary-wait-ms <n>]`
- `declaragent deploy gcp-cloud-run`

Verb surface enumerated from [`../CLAUDE.md`](../CLAUDE.md) "What works end-to-end". The
`d9t` alias binary mirrors the same verbs (brand consolidation is tracked separately in
PROD_PARITY_ACTIONS.md P2-14).

### 4. Audit-record schema

The hash-chained, tamper-evident audit log. Downstream SIEM/compliance consumers depend on
this shape, so it is part of the frozen surface.

- **Authoritative types:** [`packages/core/src/audit/types.ts`](../packages/core/src/audit/types.ts)
  — the `TenantAuditRecord` union (around line 240), `StoredAuditEntry` (around line 290, the
  on-disk row with `seq` / `prevHash` / `recordHash`), and `VerifyReport` (around line 300).
- **Hash chain:** [`packages/core/src/audit/chain-verify.ts`](../packages/core/src/audit/chain-verify.ts)
  — `recordHash = SHA-256(prevHash + "\n" + serialized(record))`. The serialization and
  chaining algorithm is frozen; changing it would invalidate every existing chain.
- **1.0 promise:** new record *kinds* may be added to the union (consumers must tolerate
  unknown kinds). Renaming/removing a kind, changing an existing record's fields, or changing
  the hash-chain algorithm is a major-version change. (`TenantAuditRecordKind` is already
  annotated `@since 1.0.0` in the source.)

---

## What 0.x still reserves the right to break before 1.0

| Surface | Reserved break | Communicated via |
| --- | --- | --- |
| `rpc.auth.enabled` default | **0.8.0** flips the default to `true` when `rpc-peers.yaml` is present; fleets without an `auth:` block on every peer-using agent fail boot with `AUTH_REJECTED`. | [`ZERO_TRUST_DEFAULT_MIGRATION.md`](./ZERO_TRUST_DEFAULT_MIGRATION.md). Pre-flight inspector `declaragent fleet audit-rpc --suggest-enable [--strict]` already shipped at 0.7.3; recommended 2–3 weeks of `--strict` CI runs before taking 0.8.0. |
| Experimental transport tuning | Per-transport tuning knobs (batch sizes, queue-group naming, redelivery windows for JetStream / SQS / AMQP / MQTT) may be renamed or re-defaulted as soak data lands. | Changeset notes; transport sections of the relevant plan docs. |
| Conversational builder surface | `DECLARAGENT_BUILDER=on` authoring flows, recorded-conversation fixtures, and the builder tool surface are explicitly experimental. | Changeset notes; builder backlog items (#36–#38). |
| Internal control-socket protocol | The on-host control-socket wire protocol (used by `ps`/`logs`/`dlq`/cross-host fan-out) is an internal contract, not a public API. | No external guarantee in 0.x. |

---

## How a break is communicated

The zero-trust flip is the reference pattern every future breaking change follows:

1. **Changeset major bump** (or, in 0.x, a clearly-flagged minor) describing the break.
2. **A migration doc** (like [`ZERO_TRUST_DEFAULT_MIGRATION.md`](./ZERO_TRUST_DEFAULT_MIGRATION.md))
   with the before/after and a copy-pasteable upgrade path.
3. **A preview-mode flag and/or pre-flight inspector** shipped at least one minor ahead, so
   operators can detect and fix exposure before the default changes under them.

When `1.0` is cut, the four surfaces above move from "intended to freeze" to "frozen under
SemVer", and this table of reserved breaks shrinks to only what is still explicitly labeled
experimental.
