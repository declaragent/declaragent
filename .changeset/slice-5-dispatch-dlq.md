---
'@declaragent/core': minor
'@declaragent/cli': minor
---

**Slice 5 of 0.6.0 production hardening — dispatch DLQ with requeue ledger.**

### Core (@declaragent/core)

New `rejected_events` SQLite table shipped as part of the event store schema. Narrow on purpose: event bodies stay in `events`, this overlay tracks only `event_id`, `rejection_reason`, `details`, `attempt_count`, `first_seen_ms`, `last_seen_ms`. Indexed by `rejection_reason` and `last_seen_ms` for fast admin queries.

`EventStore` grows four methods backed by the new table:

- `upsertRejection(eventId, reason, details, nowMs?)` — idempotent insert / update. First call creates the row with attempt=1; subsequent calls bump `attempt_count` + `last_seen_ms` while preserving `first_seen_ms`.
- `getRejection(eventId)` — single lookup.
- `listRejections({ reason?, sinceMs?, minAttempts?, limit? })` — newest-first enumeration with filter support.
- `deleteRejection(eventId)` — removes the ledger row (used automatically when a subsequent dispatch of the same event id succeeds).

Dispatcher changes: every `{ kind: 'rejected', … }` outcome now upserts a DLQ row (loop / rate-limit / target-execution errors / circuit-open / invalid). Dispatched + broadcast outcomes auto-delete any stale DLQ row for the event id so the list reflects only currently-stuck events.

### CLI (@declaragent/cli)

New `declaragent dlq --kind dispatch` surface (falls back to the legacy source DLQ when `--kind` is omitted):

| Verb | Description |
| --- | --- |
| `dlq list --kind dispatch [--reason <r>] [--min-attempts <n>] [--since <ms>] [--limit <n>]` | Enumerate rejected events, newest-first. |
| `dlq show --kind dispatch <eventId>` | JSON dump — rejection ledger + original event body + last outcome. |
| `dlq drop --kind dispatch <eventId>` | Acknowledge / abandon. Removes the DLQ row; leaves the event + outcome history intact. |

### Intentional deferral — active requeue

`dlq requeue --kind dispatch <eventId>` is **not wired** in 0.6.0. Active requeue requires a control socket on the running `up` process so the verb can publish the requeued event onto the live in-memory bus. `up` doesn't expose one today (metrics HTTP + signal-driven shutdown only). When the CLI detects `dlq requeue --kind dispatch`, it prints a clear deferral message + exit code 1.

This is why AGENTS.md §7 "Event dispatch DLQ" flips from ❌ to 🟡 rather than ✅: the *tracking* is complete, but the automated requeue loop is a follow-up. `dlq drop` is the current escape hatch for abandoning stuck events.

Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 5.
