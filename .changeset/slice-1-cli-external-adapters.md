---
'@declaragent/cli': minor
---

`declaragent up` now discovers external event-source adapter packages from `<agentDir>/node_modules/@declaragent/source-*`, `<cwd>/node_modules/@declaragent/source-*`, and the user config dir. Previously only the three built-in adapters (`webhook`, `cron`, `file-watch`) were available — community adapters shipped as npm packages with `declaragent.kind: 'event-source-adapter'` in their package.json are now bound automatically.

Built-ins take precedence on type collision. A broken adapter package is skipped with a `adapter-discovery.package-failed` warning instead of killing boot — healthy siblings still load. Two packages claiming the same type throw, because users need to see the conflict.
