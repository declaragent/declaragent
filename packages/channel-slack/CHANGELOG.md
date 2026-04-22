# @declaragent/channel-slack

## 3.0.0

### Patch Changes

- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
  - @declaragent/core@0.4.0

## 2.0.1

### Patch Changes

- Fix external adapter discovery regression introduced in 0.5.0. All nine shipped source + channel packages default-exported the **factory function** (`createKafkaAdapter`, `createSlackAdapter`, etc.) rather than the adapter instance, so slice 1's discovery (which did `mod.default ?? mod`) rejected them with "did not export an EventSourceAdapter" at runtime.

  **Two-sided fix**:

  - **Core** (`adapter-discovery.ts`, `channels/adapter-discovery.ts`) now resolves the export permissively: if `mod.default` is already an adapter, use it; if it's a zero-arg factory, invoke it; otherwise walk named exports looking for an adapter-shaped value, preferring one whose `.type` matches the manifest's declared type. Covers every package shape we've seen in the wild.
  - **9 adapter packages** now default-export the adapter instance (`kafkaAdapter as default`, `slackAdapter as default`, …) — semantically correct and matches what slice 1's inline fixtures always did. The factory stays as a named export for callers who need to override options.

  Regression tests: `adapter-discovery.test.ts` + `channels/adapter-discovery.test.ts` each gain a factory-default-export case that would have caught the bug pre-ship.

- Updated dependencies
  - @declaragent/core@0.3.1

## 2.0.0

### Patch Changes

- Updated dependencies [da8f330]
- Updated dependencies [579362c]
- Updated dependencies [778f505]
- Updated dependencies [a4ba7a4]
- Updated dependencies [9a6c64f]
  - @declaragent/core@0.3.0

## 1.0.0

### Patch Changes

- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
  - @declaragent/core@0.2.0
