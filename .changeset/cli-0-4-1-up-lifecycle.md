---
'@declaragent/cli': patch
---

Docker-Compose-style lifecycle verbs + `d9t` alias.

**Four new verbs** replace the per-agent REPL path (`declaragent run <dir>`, removed) with a true multi-agent lifecycle story:

- `declaragent up [-d|--detach] [-f <path>]` — discovers `fleet.yaml` or `agent.yaml` in the cwd (or takes `-f` explicitly), loads every agent, brings their declared in-process sources (webhook / cron / file-watch) online via the same `startAgentSources` path that `run` used to drive, and persists a state snapshot at `~/.declaragent/up-state.json`. Default is foreground with a banner + Ctrl+C shutdown; `-d` detaches via `child_process.spawn({detached: true})` and returns the child pid. Re-running `up` while something's already up gracefully stops the old process first (reload semantics).
- `declaragent down` — sends SIGTERM to the pid recorded in `up.pid`, waits up to 5s for a clean exit, escalates to SIGKILL, and clears state. No-op + 0 exit when nothing is up.
- `declaragent ps` — reads the state snapshot, reaps stale state if the pid is dead, and prints the bound agents + their sources with a relative-time `up since …`.
- `declaragent logs [-f|--follow] [<agent-id>]` — tails `~/.declaragent/logs/<id>.log` (newline-delimited JSON appended by the `up` process's event subscriber). `-f` watches the files for appends via `fs.watch`.

**`d9t` alias** both `declaragent` and `d9t` now point at the same launcher. Existing scripts keep working; the shorter name is there when you want it.

**Removed** `declaragent run <dir>`. The skill-only REPL scope is covered by `declaragent up` for a bound, event-driven agent, and by the plain `declaragent` REPL for interactive builder work. The underlying modules (`run-agent-cli.ts`, `run-agent-sources.ts`) are still exported for downstream reuse.
