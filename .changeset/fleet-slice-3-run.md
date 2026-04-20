---
'@declaragent/cli': minor
---

Fleet slice 3 — `declaragent fleet run`.

Single-process multi-agent dev loop. Boots one memory bus + one worker
per agent, wires each agent's `capabilities.yaml → memory` transport
onto the shared bus, and dispatches incoming requests to a pluggable
handler. Inter-agent RPC round-trips in one process — no broker needed.

```bash
declaragent fleet run                 # every agent
declaragent fleet run --agent pr-reviewer --agent concierge   # subset
```

**`packages/cli/src/fleet-run.ts`**

- `startFleetDaemon({fleet, bus?, makeHandler?})` — test-driveable
  entry point. Returns a `FleetDaemon` with `agents` (per-worker
  metrics + topics), `bus`, `shutdown()`, `waitForShutdown()`. Partial
  boot failures stop the workers that did start before re-throwing so
  callers don't need cleanup logic in their error paths.
- `FleetAgentHandler` — per-agent request handler signature. The slice-3
  **defaultHandler** echoes `{ agent, capability, echoed: payload }`
  back to the caller so wiring is observable without an LLM provider.
  Slice 3.5 will plug the engine loop behind `makeHandler`.
- `fleetRun(args, deps)` — CLI verb. Loads the fleet (with
  `findFleetRoot` discovery), filters to `--agent` subset when
  supplied, prints the ready line, and installs `SIGINT`/`SIGTERM`
  handlers that call `daemon.shutdown()`.

**Transport scope.** Only `memory` transports are wired in this slice.
Agents whose `capabilities.yaml` declares a `kafka` / `nats` / `sqs`
/ `amqp` / `mqtt` transport are loaded cleanly (they surface in
`fleet list` + `fleet capabilities`) but the dev loop silently skips
them — production fleets wire those via their existing source adapters.

**CLI integration.** Added `fleet run` verb; help text updated.
`packages/cli/package.json` adds a `workspace:*` dep on
`@declaragent/plugin-agent-rpc` for the memory bus + respond hook.

**Tests.** 10 new tests in `fleet-run.test.ts` covering:

- per-worker subscription wiring (memory topics + client-only agents).
- full end-to-end RPC round-trip (concierge → pr-reviewer → response)
  via the actual `RequestAgent` producer tool + a shared bus.
- `makeHandler` override.
- handler exception → `HANDLER_ERROR` RPC response.
- clean shutdown unsubscribes from the bus.
- CLI verb's error paths (no fleet, empty fleet, no matching `--agent`).

**Not in scope for slice 3 (tracked for a follow-up):**

- File-watch hot reload per agent (§9 slice-3 bullet 4).
- Engine-loop integration — agents respond via the default echo stub.
- Per-agent `event-sources.yaml` wiring (the broader Phase-3 daemon is
  not yet hosted here; each agent's sources + dispatcher will land
  once `makeHandler` ties into the engine).
- Non-memory transports.

**Next.** Slices 4 / 5 / 6 parallelize — `fleet promote`, `fleet deploy`,
`fleet graph`/`fleet peers`.
