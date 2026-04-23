---
'@declaragent/core': patch
'@declaragent/cli': patch
---

feat(control-plane): fleet.yaml controlPlane block + fleet logs -f live multi-host SSE

Sprint 5 post-enterprise backlog: two deliverables on the cross-host
control-plane surface shipped in 0.7.4 (#50).

**#17 — `fleet.yaml`-level `controlPlane:` block.** Single source of
truth for how every agent on a fleet's hosts exposes its control-plane
HTTP listener. When set, the fleet-level block wins over per-agent
`agent.yaml#controlPlane` blocks (deprecation warning on overrides).
When absent, legacy per-agent fallback is preserved bit-for-bit —
`up-cli` picks the first agent's block with auth enabled and warns
about any others. Orthogonal to the `hosts[]` block (#50): `hosts[]`
is the CLIENT-side address book the CLI fans out TO;
`controlPlane:` is the SERVER-side config each host exposes.

  - `fleet.yaml#controlPlane` accepts the same auth discriminated
    union as `agent.yaml#controlPlane.auth`
    (`{enabled:false} | oidc | oauth2-client`), plus the
    `bindAddress` + `idleTimeout` advisory hints.
  - New `parseControlPlaneAuth` + `controlPlaneAuthSchema` exports on
    `@declaragent/core` so the fleet loader doesn't duplicate the
    discriminated-union narrowing.
  - New pure `resolveControlPlaneAuth` helper in
    `packages/cli/src/fleet-control-plane-resolver.ts` — unit-testable
    precedence logic decoupled from the `up-cli` happy path.

**Slice 6a — `fleet logs -f` live multi-host SSE.** Follow-mode
counterpart to the snapshot-only `fleet logs` shipped in 0.7.4.
`tailLogsMultiHost` opens one long-lived SSE connection per
configured host, renders each frame as `[host/agent] <text>`, and
survives mid-stream disconnects with per-host exponential backoff
(500ms → 30s cap). `SIGINT`/`SIGTERM` tears every socket down
cleanly via the returned handle's `stop()`. Streams are ordered by
arrival — no timestamp merge layer.
