---
'@declaragent/cli': patch
---

Fleet slice 10 — docs-site `reference/fleet` + `cookbook/fleet-starter`.

First public documentation of the v1.2 fleet surface. Two new pages
wired into the sidebar + linked from the reference + cookbook indices.

**`docs-site/docs/reference/fleet.mdx`**

- When to use a fleet vs keep the single-agent layout.
- Directory layout + promote/demote invariant.
- Full `fleet.yaml` v1 schema with per-section field tables
  (top-level, agent entry, environments, deploy strategies).
- Config precedence order (per-agent → env override → fleet-root →
  defaults).
- Every CLI verb in one table (new / add / promote / demote / run /
  deploy / list / validate / capabilities / graph / peers / status).
- Promote + demote walkthrough, "when NOT to promote", and the risks
  the flow flags (CI workflow paths, Dockerfiles, published npm).
- Version skew decision matrix (match / older / newer / rejected)
  with the `EVERSION_SKEW` error code.
- The ten §14 design decisions as a lookup table.
- Mermaid sequence diagram for the rolling deploy health-gate +
  rollback flow.

**`docs-site/docs/cookbook/fleet-starter.mdx`**

- End-to-end walkthrough of the `templates/fleet-starter/` template
  (scaffold → validate → explore → run → deploy → day-two ops).
- Single-process dev loop via `fleet run`.
- Cross-process swap to Kafka (memory → kafka in `rpc-peers.yaml` +
  `capabilities.yaml`).
- Opt-in version-skew wiring.
- Cost estimate table per agent + deployed.

**Sidebar + index wiring**

- `sidebars.ts` — `reference/fleet` added after `reference/rpc`;
  `cookbook/fleet-starter` added to the Templates sub-category.
- `reference/index.mdx` gains a table row linking to the new page.
- `cookbook/index.mdx` gains a table row for `fleet-starter`.

**Verification.** `cd docs-site && bun run build` — static build
completes cleanly; no new warnings beyond the pre-existing
`vscode-languageserver-types` notice that ships with Docusaurus.

**Next.** Slice 11 — soak + release candidate.
