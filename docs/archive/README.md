# Archived plan docs

These documents are **frozen for historical provenance**. They describe planning and
release work that has since been superseded by the current canonical docs. They are kept
so the reasoning behind shipped decisions stays auditable — but they are **not** a source
of truth about what the project is today.

> **For current status, always start at [`../STATUS.md`](../STATUS.md).** It names the
> live canonical plan, the active backlog, the scoreboard, and the real package versions.

Links inside these archived files may now be stale (paths moved, versions advanced).
That is expected; do not "fix" them — they reflect the state at the time they were written.

## What superseded each doc

| Archived doc | Superseded by | Why |
| --- | --- | --- |
| `PHASE_2_PLAN.md` | [`../SPEC_AND_PLAN.md`](../SPEC_AND_PLAN.md) | Pre-0.6.0 phased build plan; the spec is now the single source of requirements. |
| `PHASE_3_PLAN.md` | [`../SPEC_AND_PLAN.md`](../SPEC_AND_PLAN.md) | Pre-0.6.0 phased build plan. |
| `PHASE_4_PLAN.md` | [`../SPEC_AND_PLAN.md`](../SPEC_AND_PLAN.md) | Pre-0.6.0 phased build plan. |
| `PHASE_5_PLAN.md` | [`../SPEC_AND_PLAN.md`](../SPEC_AND_PLAN.md) | Pre-0.6.0 phased build plan. |
| `PHASE_6_PLAN.md` | [`../SPEC_AND_PLAN.md`](../SPEC_AND_PLAN.md) | Pre-0.6.0 phased build plan. |
| `PHASE_7_PLAN.md` | [`../SPEC_AND_PLAN.md`](../SPEC_AND_PLAN.md) | Pre-0.6.0 phased build plan (incl. the original Cloud Run deploy section). |
| `MASTER_PLAN.md` | [`../SPEC_AND_PLAN.md`](../SPEC_AND_PLAN.md) | The spec explicitly marks this historical (see `SPEC_AND_PLAN.md` "Background design docs"). |
| `IMPLEMENTATION_PLAN.md` | [`../SPEC_AND_PLAN.md`](../SPEC_AND_PLAN.md) | The spec explicitly marks this historical. |
| `PATCH_0_5_2_PLAN.md` | Shipped 0.7.x (changesets + CHANGELOGs) | 0.5.2 patch planning; long shipped. |
| `RELEASE_0_6_0_PLAN.md` | Shipped 0.7.x + [`../ENTERPRISE_PRODUCTION_PLAN.md`](../ENTERPRISE_PRODUCTION_PLAN.md) | 0.6.0 release plan; all slices shipped, enterprise work moved on. |
| `RELEASE_0_6_0_READINESS.md` | Shipped 0.7.x | 0.6.0 readiness checklist; the release shipped. |
| `POST_DEMO_BACKLOG.md` | [`../POST_ENTERPRISE_BACKLOG.md`](../POST_ENTERPRISE_BACKLOG.md) | Older backlog; the post-enterprise backlog is the active tracker. |
| `PRODUCTION_SCALE_PLAN.md` | [`../ENTERPRISE_PRODUCTION_PLAN.md`](../ENTERPRISE_PRODUCTION_PLAN.md) + [`../POST_ENTERPRISE_BACKLOG.md`](../POST_ENTERPRISE_BACKLOG.md) | Pre-enterprise scale planning, folded into the enterprise plan + backlog. |
| `USABILITY_PLAN.md` | [`../ENTERPRISE_PRODUCTION_PLAN.md`](../ENTERPRISE_PRODUCTION_PLAN.md) + [`../POST_ENTERPRISE_BACKLOG.md`](../POST_ENTERPRISE_BACKLOG.md) | Pre-enterprise usability planning, folded into the enterprise plan + backlog. |
| `VERSIONING.md` | [`../STATUS.md`](../STATUS.md) + [`../COMPAT.md`](../COMPAT.md) | Version facts now live in STATUS.md; the 1.0 compat surface in COMPAT.md. |

## What was deliberately NOT archived

The following remain canonical or actively referenced and stay in `docs/`:

- `SPEC_AND_PLAN.md` — canonical requirements + phased plan.
- `POST_ENTERPRISE_BACKLOG.md` — active follow-up backlog.
- `FIRST_PRINCIPLES_AUDIT.md`, `FIRST_PRINCIPLES_VALIDATION.md` — current evidence ledgers.
- `ZERO_TRUST_DEFAULT_MIGRATION.md` — the live 0.8.0 migration plan.
- `THREAT_MODEL.md`, `PEN_TEST_SIGNOFF.md` — current security docs.
- `ENTERPRISE_PRODUCTION_PLAN.md` — the 12-item enterprise tracker (closed, but cited).
- `AGENT_RPC_PLAN.md`, `BUILDER_PLAN.md`, `CONTROL_PLANE_PLAN.md`, `FLEET_PLAN.md`,
  `OTEL_SETUP.md`, and the background design docs — still referenced by code and other docs.
