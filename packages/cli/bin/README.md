# `@declaragent/cli` npm install flow

This directory ships two tiny Node entry points so the npm package can
deliver the single-file `declaragent` binary produced by
`bun build --compile` without requiring Bun on the user's machine.

| File              | Role                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `postinstall.js`  | Runs after `npm install`. Detects `(os, arch)`, downloads the matching tarball + `.sha256` from the GitHub release, verifies the hash, and extracts `declaragent` into `bin/declaragent-binary/`. |
| `declaragent.js`  | Registered as the `bin` entry. Exec's `bin/declaragent-binary/declaragent`, forwarding argv + stdio. Prints a recovery hint if the binary isn't present. |

## Flow

```
npm install -g @declaragent/cli
 └─ npm runs bin/postinstall.js
     ├─ maps process.platform + process.arch → linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64
     ├─ GET <DECLARAGENT_BASE_URL>/download/v<version>/declaragent-<target>.tar.gz
     ├─ GET <DECLARAGENT_BASE_URL>/download/v<version>/declaragent-<target>.sha256
     ├─ sha256 verify
     ├─ tar -xzf into a temp dir
     └─ move `declaragent` into `bin/declaragent-binary/declaragent`

declaragent --version
 └─ npm dispatches to bin/declaragent.js
     └─ spawns bin/declaragent-binary/declaragent with argv + env
```

## Environment overrides

| Variable                        | Effect                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DECLARAGENT_NO_POSTINSTALL=1`  | Skip the download. `npm install` still succeeds; the launcher prints a re-run hint on first use. |
| `DECLARAGENT_BASE_URL=<url>`    | Replace the GitHub releases origin (use `file://<dir>` for offline / CI mirrors).                |
| `DECLARAGENT_VERSION=vX.Y.Z`    | Pin a specific tag. Defaults to `v<package.version>`.                                            |

## Windows

Windows isn't supported natively yet. The postinstall prints a hint and
exits 0 so `npm install` doesn't fail; users should run under WSL2.

## Reinstalling manually

```sh
cd $(npm root -g)/@declaragent/cli
node bin/postinstall.js
```
