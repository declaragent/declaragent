---
'@declaragent/cli': minor
---

Fleet slice 6 — `declaragent fleet graph` + `declaragent fleet peers [--verify]`.

Two read-only verbs that surface the aggregated inter-agent RPC
topology. Slot into the slice-1 read-only verb family; neither boots a
daemon.

```bash
declaragent fleet graph                    # mermaid (default)
declaragent fleet graph --format=dot       # graphviz
declaragent fleet graph --format=json      # structured edges for CI
declaragent fleet peers                    # print aggregated rpc-peers.yaml
declaragent fleet peers --verify           # + reachability check
declaragent fleet peers --verify --json    # machine-readable report
```

**`packages/cli/src/fleet-graph-cli.ts`**

- `buildGraph(fleet): GraphModel` — pure, test-friendly transform from a
  `LoadedFleet` into `{ nodes, edges }`. Nodes per agent (plus any
  external peer the fleet talks to), edges from every potential caller
  to each peer target tagged with transport kind + single-capability
  label when the callee declares exactly one.
- `renderMermaid` / `renderDot` / `renderJson` — format emitters.
  Mermaid edges are color-coded per transport (memory=blue, kafka=red,
  nats=green, sqs=amber, amqp=violet, mqtt=pink) via `linkStyle`.
- `fleetGraph(args, deps)` — CLI verb. Default format is mermaid.

**`packages/cli/src/fleet-peers-cli.ts`**

- `buildPeersReport(fleet, {verify})` — pure transform. Classifies each
  peer + transport as `reachable`, `unreachable`, `external`, or
  `not-yet-probed`. Memory peers verify by checking that the named
  agent declares matching capabilities on the expected topic;
  non-memory peers are deferred to a follow-up slice with live broker
  wiring. External peers are informational only.
- `fleetPeers(args, deps)` — CLI verb. Prints grouped sections
  (reachable / not-yet-probed / unreachable / external). `--verify`
  makes the verb exit non-zero on any in-fleet peer that fails to
  resolve (dangling id or missing matching memory transport). `--json`
  emits a machine-readable report keyed the same way.

**Tests.** 19 new tests across `fleet-graph-cli.test.ts` and
`fleet-peers-cli.test.ts` covering `buildGraph` shape, mermaid / dot /
json emitter well-formedness, verb exit codes, `--verify` behavior on
dangling vs external peers, and `--json` parse shape.

**Not in scope for slice 6.** Live broker probing (kafka, nats, sqs,
amqp, mqtt) — slice 7 extends `fleet peers --verify` once broker
adapters ship. Caller annotations on peers are still the slice-6
approximation: every in-fleet agent is a potential caller of any peer
target. A later slice replaces the approximation with explicit caller
manifests once `capabilities.yaml` grows a `calls:` block.

**Next.** Slice 7 all-or-nothing deploys + version-skew wiring.
