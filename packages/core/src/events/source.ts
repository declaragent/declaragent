import type { Extension, ExtensionRegistry, ExtensionSource } from '../extension/types.js';
import type { Logger } from '../types/logger.js';
import type {
  EventBus,
  EventSourceAdapter,
  EventSourceInstance,
  SourceDependencies,
} from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

export interface EventSourceExtensionOptions {
  /** Raw config value — passed to `adapter.validateConfig` and then `adapter.create`. */
  config: unknown;
  /** Provenance for the extension descriptor (built-in/user/team/plugin). */
  source: ExtensionSource;
  /** The bus this source publishes to. */
  bus: EventBus;
  /** Optional host logger. Defaults to noop. */
  logger?: Logger;
  /** Absolute path to the host config dir. Defaults to `process.cwd()`. */
  configDir?: string;
}

/**
 * Wrap an `EventSourceAdapter` + config as an `Extension<'event-source'>`.
 *
 * The wrapper is async because `adapter.create` does real work (parsing
 * the cron expression, opening file watchers, binding HTTP routes, etc.).
 * By the time this resolves the instance is ready to start but has NOT
 * yet been started — that happens inside the registry's `activate` call
 * so `registry.register` and liveness stay atomic.
 *
 * Hot reload (slice 10) discards the old extension, calls
 * `eventSourceExtension(adapter, opts)` again, and re-registers. No
 * mid-life mutation of an `EventSourceInstance` is supported.
 */
export async function eventSourceExtension(
  adapter: EventSourceAdapter<unknown>,
  opts: EventSourceExtensionOptions,
): Promise<Extension<'event-source'>> {
  adapter.validateConfig(opts.config);

  const deps: SourceDependencies = {
    bus: opts.bus,
    logger: opts.logger ?? NOOP_LOGGER,
    configDir: opts.configDir ?? process.cwd(),
  };

  const instance = await adapter.create(opts.config, deps);

  if (instance.type !== adapter.type) {
    // Defensive: the adapter is supposed to stamp its own type onto
    // every instance it produces. A mismatch means the adapter is
    // buggy; surface it loudly rather than silently registering a
    // source under the wrong key.
    throw new Error(
      `EventSourceAdapter type mismatch: adapter.type="${adapter.type}" but instance.type="${instance.type}"`,
    );
  }

  return {
    descriptor: {
      id: `event-source:${instance.type}:${instance.id}`,
      kind: 'event-source',
      source: opts.source,
    },
    payload: instance,
    async activate() {
      await instance.start();
    },
    async deactivate() {
      await instance.stop('extension-deactivate');
    },
  };
}

/** Convenience: every live `EventSourceInstance` in the registry. */
export function listEventSources(registry: ExtensionRegistry): readonly EventSourceInstance[] {
  return registry.byKind('event-source').map((e) => e.payload);
}

// ─── Phase-4 two-step registration ───────────────────────────────────────
// Phase 3's `eventSourceExtension()` couples adapter + config in a single
// call, which is fine when the daemon has a static in-process adapter
// table. Phase 4 wants to separate the two so slice 4 can discover
// adapters from `node_modules/@declaragent/source-*` without knowing
// which configs will reference them — and so config reloads can rebuild
// a specific instance without touching the adapter.
//
// Convention:
// - `adapterExtension(adapter, source)` → registers the adapter itself
//   (`kind: 'event-source-adapter'`, descriptor id
//   `event-source-adapter:<type>`).
// - `sourceInstanceExtension(registry, spec, deps)` → looks up the
//   adapter by `spec.type` in the registry, validates, builds, and
//   returns an `Extension<'event-source'>` ready to register.

export interface AdapterExtensionOptions {
  source: ExtensionSource;
}

/**
 * Wrap an `EventSourceAdapter` as an `Extension<'event-source-adapter'>`.
 *
 * Activation + deactivation are no-ops: adapters hold no runtime state of
 * their own (instances do). The descriptor id is `event-source-adapter:<type>`
 * so two adapters claiming the same type collide at register time.
 */
export function adapterExtension(
  adapter: EventSourceAdapter<unknown>,
  opts: AdapterExtensionOptions,
): Extension<'event-source-adapter'> {
  return {
    descriptor: {
      id: `event-source-adapter:${adapter.type}`,
      kind: 'event-source-adapter',
      source: opts.source,
    },
    payload: adapter,
    activate() {
      // Adapters are inert until a source instance is created from them.
    },
  };
}

/** Lookup an adapter by type from the registry. */
export function findAdapter(
  registry: ExtensionRegistry,
  type: string,
): EventSourceAdapter<unknown> | undefined {
  for (const ext of registry.byKind('event-source-adapter')) {
    if (ext.payload.type === type) return ext.payload;
  }
  return undefined;
}

export interface SourceInstanceSpec {
  type: string;
  config: unknown;
  source: ExtensionSource;
}

export interface SourceInstanceDeps extends SourceDependencies {
  // Exposed for symmetry; deps are already defined by SourceDependencies.
  // Kept as a named alias so the two-step API has a clear surface.
}

/**
 * Two-step counterpart to `eventSourceExtension`. Resolves the adapter
 * via the registry, validates the config, creates the instance, and
 * returns an `Extension<'event-source'>` the caller registers.
 *
 * Registration calls `start()`; `deactivate()` calls `stop('extension-deactivate')`.
 */
export async function sourceInstanceExtension(
  registry: ExtensionRegistry,
  spec: SourceInstanceSpec,
  deps: SourceInstanceDeps,
): Promise<Extension<'event-source'>> {
  const adapter = findAdapter(registry, spec.type);
  if (!adapter) {
    throw new Error(
      `sourceInstanceExtension: no adapter registered for source type "${spec.type}"`,
    );
  }

  // TS requires assertion-function call targets to be named declarations;
  // `adapter.validateConfig` is a method access, so we cast to a plain
  // throwing function. We don't need the `asserts` narrowing because the
  // config flows straight through to `adapter.create` which accepts it.
  (adapter.validateConfig as (c: unknown) => void)(spec.config);
  const instance = await adapter.create(spec.config, deps);

  if (instance.type !== adapter.type) {
    throw new Error(
      `EventSourceAdapter type mismatch: adapter.type="${adapter.type}" but instance.type="${instance.type}"`,
    );
  }

  return {
    descriptor: {
      id: `event-source:${instance.type}:${instance.id}`,
      kind: 'event-source',
      source: spec.source,
    },
    payload: instance,
    async activate() {
      await instance.start();
    },
    async deactivate() {
      await instance.stop('extension-deactivate');
    },
  };
}
