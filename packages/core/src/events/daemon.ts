import type { Database } from 'bun:sqlite';
import type { TenantAuditSink } from '../audit/types.js';
import type { ExtensionRegistry } from '../extension/types.js';
import { type PrometheusRegistry, createPrometheusRegistry } from '../observability/prometheus.js';
import type { LoadedTenant } from '../tenancy/config-loader.js';
import { type TenantRuntime, createTenantRuntime } from '../tenancy/runtime.js';
import { DEFAULT_TENANT_CONTEXT, type TenantContext } from '../tenancy/types.js';
import type { RunAgent, RunAgentResult } from '../types/agent.js';
import type { Logger } from '../types/logger.js';
import type { AgentSpec, SessionHandle } from '../types/session.js';
import { type CreateEventBusOptions, createEventBus } from './bus.js';
import type {
  DLQListControlParams,
  DLQRedriveControlParams,
  DLQShowControlParams,
  ReplayRangeParams,
  ReplayRangeResult,
} from './control-protocol.js';
import { type CreateEventDispatcherOptions, createEventDispatcher } from './dispatcher.js';
import { type CreateMailboxOptions, createMailbox } from './mailbox.js';
import { eventSourceExtension } from './source.js';
import { createEventStore } from './store.js';
import type {
  AgentEvent,
  DLQEntry,
  DispatchOutcome,
  EventBus,
  EventDispatcher,
  EventSourceAdapter,
  EventSourceInstance,
  SourceHealth,
  SourceMetrics,
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

/** One row from `event-sources.json` or an equivalent test fixture. */
export interface ConfiguredSource {
  /** Adapter type key (e.g. `"cron"`, `"webhook"`). Must match an entry in `adapters`. */
  type: string;
  /** Raw config passed through to `adapter.validateConfig` + `adapter.create`. */
  config: unknown;
}

export interface DaemonStatus {
  /** ms since `startDaemon()` resolved. */
  uptimeMs: number;
  /** When the daemon started (ms epoch). */
  startedAt: number;
  sources: Array<{
    id: string;
    type: string;
    health: SourceHealth;
    metrics: SourceMetrics;
  }>;
  busRecentCount: number;
  /** Size of the `mailbox.depth()` map the daemon tracks, if any. */
  mailbox: Array<{ agent: string; depth: number }>;
}

export interface DaemonShutdownOptions {
  /** Wait for in-flight publishes + dispatcher + engine turns to settle. Default true. */
  drain?: boolean;
  /** Hard cap on drain wait before we stop anyway. Default 30_000. */
  timeoutMs?: number;
}

export interface DaemonReloadOptions {
  /**
   * New desired source list. If omitted, the daemon calls its
   * `sourcesProvider` (if configured) to fetch the list. If neither is
   * supplied, reload is a no-op and returns all sources as unchanged.
   */
  sources?: readonly ConfiguredSource[];
  /** Per-source stop grace. Default 5_000. */
  timeoutMs?: number;
}

/**
 * Result of a reload. Keys are `"<type>:<config.id>"` — stable across
 * the diff so the control plane can report them verbatim.
 */
export interface DaemonReloadResult {
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
  unchanged: readonly string[];
}

/** Handle returned by `startDaemon`. */
export interface Daemon {
  readonly startedAt: number;
  readonly bus: EventBus;
  readonly dispatcher: EventDispatcher;
  readonly registry: ExtensionRegistry;
  /**
   * Phase 7 slice 0.2 — per-tenant runtime map. Always populated with at
   * least the implicit default tenant when no `tenants.yaml` is loaded.
   * Keyed by `tenant.id`.
   */
  readonly tenants: ReadonlyMap<string, TenantRuntime>;
  /** Live source instances keyed by their id. */
  readonly sources: ReadonlyMap<string, EventSourceInstance>;
  status(): Promise<DaemonStatus>;
  /**
   * Hot-reload source configuration. Diffs old vs new `ConfiguredSource`
   * entries by `(type, config.id)`; sources whose config is byte-identical
   * are left running, changed/removed ones are stopped, added/changed ones
   * are (re)created and started. The bus subscription, dispatcher state,
   * idempotency cache, and mailbox queues all survive the reload.
   */
  reload(options?: DaemonReloadOptions): Promise<DaemonReloadResult>;
  /** Injects an event from outside (used by `send-event` on the control plane). */
  sendEvent(event: AgentEvent): Promise<DispatchOutcome>;
  shutdown(opts?: DaemonShutdownOptions): Promise<void>;
  /** Resolves once shutdown is complete. Useful for CLI entrypoints to await. */
  waitForShutdown(): Promise<void>;
  // ── Slice 12: DLQ + replay control-plane surface ─────────────────────
  /**
   * Replay events from a specific source instance's underlying transport
   * over `[fromMs, toMs]`. When `params.dispatch` is true, each replayed
   * event is also routed through `sendEvent` with a fresh id.
   */
  replayRange(params: ReplayRangeParams): Promise<ReplayRangeResult>;
  /** List DLQ entries for a source. Fails cleanly if the adapter doesn't expose DLQ access. */
  dlqList(params: DLQListControlParams): Promise<readonly DLQEntry[]>;
  /** Fetch a single DLQ entry by its adapter-specific id. */
  dlqShow(params: DLQShowControlParams): Promise<DLQEntry | undefined>;
  /** Redrive a DLQ'd message back to the source's primary queue/topic. */
  dlqRedrive(params: DLQRedriveControlParams): Promise<void>;
}

export interface StartDaemonOptions {
  /**
   * Required if you want persistence (EventStore + Mailbox). When omitted,
   * the daemon runs with in-memory bus only — useful for tests that don't
   * exercise SQLite.
   */
  db?: Database;
  /** Registry to load sources into. Defaults to a fresh registry. */
  registry: ExtensionRegistry;
  /**
   * Adapter lookup table: `type` → adapter. The daemon consults this to
   * instantiate each entry in `sources`.
   */
  adapters: Readonly<Record<string, EventSourceAdapter<unknown>>>;
  /** Configured event source entries (typically from `event-sources.json`). */
  sources?: readonly ConfiguredSource[];
  /**
   * Engine entrypoint. Required when the dispatcher may route to
   * session/new-session/skill/sub-agent targets. Tests that only exercise
   * broadcast targets can pass a stub.
   */
  runAgent?: RunAgent;
  /** Factories used by the dispatcher. */
  resolveSession?: (id: string) => SessionHandle | undefined | Promise<SessionHandle | undefined>;
  createSession?: (spec?: Partial<AgentSpec>) => SessionHandle | Promise<SessionHandle>;
  createChildSession?: (
    parentId: string,
    spec?: Partial<AgentSpec>,
  ) => SessionHandle | Promise<SessionHandle>;
  /** Optional logger. Defaults to a noop logger. */
  logger?: Logger;
  /** Override bus options. */
  busOptions?: CreateEventBusOptions;
  /** Override dispatcher options (cache size/ttl, etc.). */
  dispatcherOptions?: Partial<CreateEventDispatcherOptions>;
  /** Override mailbox options. Ignored when `db` is not supplied. */
  mailboxOptions?: Partial<CreateMailboxOptions>;
  /** Agent names to include in `status.mailbox`. */
  trackedMailboxAgents?: readonly string[];
  /**
   * Called by `reload()` when no explicit `sources` arg is supplied.
   * Typical host binding: re-reads `event-sources.json`. Tests usually
   * pass sources directly and omit this.
   */
  sourcesProvider?: () => readonly ConfiguredSource[] | Promise<readonly ConfiguredSource[]>;
  /**
   * Phase 7 slice 0.2. Per-tenant config (typically the `tenants` array
   * from `loadTenantsConfig`). When omitted, the daemon runs in single-
   * tenant mode with the implicit {@link DEFAULT_TENANT_CONTEXT}, and
   * every Phase-1-through-5 behaviour is preserved bit-for-bit.
   *
   * When supplied, the daemon builds one {@link TenantRuntime} per entry
   * (each with its own {@link EventBus} bound to that tenant's scope)
   * and attaches the dispatcher to every tenant bus. Inbound events
   * injected via {@link Daemon.sendEvent} are routed by `meta.tenantId`
   * to the matching runtime's bus.
   */
  tenants?: readonly LoadedTenant[];
  /**
   * Optional factory producing a per-tenant audit sink. When supplied,
   * each tenant's {@link TenantRuntime.quotas} reports breaches through
   * the returned sink.
   */
  tenantAudit?: (tenant: TenantContext) => Pick<TenantAuditSink, 'record'>;
  /**
   * Phase 7 slice 0.4 — per-tenant metrics strategy.
   *
   *  - `'per-tenant'` (default when `tenants` is supplied) auto-builds
   *    one {@link PrometheusRegistry} per tenant, stamped with
   *    `constLabels: { tenant_id: tenant.id }`, and surfaces it on
   *    {@link TenantRuntime.metrics}. Dashboards keyed on `tenant_id`
   *    (see `packages/testkit/alerts/`) light up without further wiring.
   *  - `'shared'` reuses a single registry — useful when the daemon
   *    serves `shared-with-filter` buses and adapters stamp the tenant
   *    label themselves.
   *  - `'none'` opts out entirely.
   */
  tenantMetricsStrategy?: 'per-tenant' | 'shared' | 'none';
  /**
   * Override the registry factory. Defaults to
   * {@link createPrometheusRegistry}. Exposed primarily so tests can
   * spy on the constLabels the daemon stamps.
   */
  createTenantMetricsRegistry?: (tenant: TenantContext) => PrometheusRegistry;
  /** Seen by `status().startedAt`. Tests can freeze this. */
  now?: () => number;
}

export async function startDaemon(options: StartDaemonOptions): Promise<Daemon> {
  const logger = options.logger ?? NOOP_LOGGER;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const bus = createEventBus({ logger, ...(options.busOptions ?? {}) });

  const store = options.db ? createEventStore({ db: options.db }) : undefined;
  const mailbox = options.db
    ? createMailbox({ db: options.db, bus, ...(options.mailboxOptions ?? {}) })
    : undefined;

  const runAgent: RunAgent =
    options.runAgent ??
    (async (): Promise<RunAgentResult> => ({
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }));

  const dispatcher = createEventDispatcher({
    registry: options.registry,
    runAgent,
    logger,
    ...(store !== undefined && { store }),
    ...(options.resolveSession !== undefined && { resolveSession: options.resolveSession }),
    ...(options.createSession !== undefined && { createSession: options.createSession }),
    ...(options.createChildSession !== undefined && {
      createChildSession: options.createChildSession,
    }),
    ...options.dispatcherOptions,
  });

  // Attach the dispatcher to the primary bus (sources + single-tenant
  // default publish here). In multi-tenant mode we additionally attach
  // per-tenant buses below so events stamped with a tenantId land in the
  // dispatcher regardless of which bus they were published on.
  const detachHandles: Array<() => void> = [];
  detachHandles.push(dispatcher.attach(bus));

  // Always populate at least the default tenant runtime so downstream
  // consumers (CLI verbs, admin surface) can iterate over a single uniform
  // map regardless of whether a tenants.yaml is loaded. The default
  // runtime shares the primary bus via `sharedBus` so sources + the
  // single-tenant path stay bit-for-bit compatible with Phase 5.
  const tenants = new Map<string, TenantRuntime>();
  const metricsStrategy: 'per-tenant' | 'shared' | 'none' =
    options.tenantMetricsStrategy ??
    (options.tenants && options.tenants.length > 0 ? 'per-tenant' : 'none');
  const buildTenantRegistry =
    options.createTenantMetricsRegistry ??
    ((tenant: TenantContext) =>
      createPrometheusRegistry({
        constLabels: { tenant_id: tenant.id },
      }));
  const sharedMetricsRegistry: PrometheusRegistry | undefined =
    metricsStrategy === 'shared' ? createPrometheusRegistry() : undefined;

  if (options.tenants && options.tenants.length > 0) {
    for (const loaded of options.tenants) {
      const audit = options.tenantAudit?.(loaded.context);
      const metrics =
        metricsStrategy === 'per-tenant'
          ? buildTenantRegistry(loaded.context)
          : sharedMetricsRegistry;
      const runtime = createTenantRuntime({
        tenant: loaded.context,
        registry: options.registry,
        ...(loaded.extensions !== undefined && { extensionScope: loaded.extensions }),
        ...(audit !== undefined && { audit }),
        ...(metrics !== undefined && { metrics }),
        logger,
      });
      tenants.set(loaded.context.id, runtime);
      detachHandles.push(dispatcher.attach(runtime.bus));
    }
  } else {
    const defaultRuntime = createTenantRuntime({
      tenant: DEFAULT_TENANT_CONTEXT,
      registry: options.registry,
      logger,
      sharedBus: bus,
      ...(sharedMetricsRegistry !== undefined && { metrics: sharedMetricsRegistry }),
    });
    tenants.set(DEFAULT_TENANT_CONTEXT.id, defaultRuntime);
  }

  // Live sources keyed by `<type>:<config.id>` — matches the diff keys
  // used by reload(). Each entry holds the ConfiguredSource as loaded
  // plus the instance + extension descriptor id so reload can precisely
  // stop/restart only what diverged.
  interface LoadedSource {
    spec: ConfiguredSource;
    instance: EventSourceInstance;
    extensionId: string;
  }
  const loaded = new Map<string, LoadedSource>();
  // Public-facing map keyed by instance id (the Daemon interface field).
  const sources = new Map<string, EventSourceInstance>();

  async function registerSource(spec: ConfiguredSource): Promise<LoadedSource> {
    const adapter = options.adapters[spec.type];
    if (!adapter) {
      throw new Error(`startDaemon: no adapter registered for source type "${spec.type}"`);
    }
    const extension = await eventSourceExtension(adapter, {
      config: spec.config,
      source: { type: 'built-in' },
      bus,
      logger,
    });
    await options.registry.register(extension);
    const entry: LoadedSource = {
      spec,
      instance: extension.payload,
      extensionId: extension.descriptor.id,
    };
    loaded.set(sourceKey(spec), entry);
    sources.set(entry.instance.id, entry.instance);
    return entry;
  }

  async function unregisterSource(key: string, timeoutMs: number): Promise<void> {
    const entry = loaded.get(key);
    if (!entry) return;
    // Unregister via the registry so deactivate() → stop() fires the
    // whole lifecycle. Guarded with a timeout so a hung source can't
    // block reload indefinitely.
    const raceTimeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs),
    );
    const raced = await Promise.race([
      options.registry.unregister(entry.extensionId).then(() => 'ok' as const),
      raceTimeout,
    ]);
    if (raced === 'timeout') {
      logger.warn('daemon.reload.stop.timeout', { key, timeoutMs });
      // Best-effort direct stop so the old timer doesn't linger.
      try {
        await entry.instance.stop('reload-timeout');
      } catch {
        // ignore
      }
    }
    loaded.delete(key);
    sources.delete(entry.instance.id);
  }

  for (const spec of options.sources ?? []) {
    await registerSource(spec);
  }

  let shutdownPromise: Promise<void> | null = null;
  let resolveShutdownDone: () => void = () => {};
  const shutdownDone = new Promise<void>((resolve) => {
    resolveShutdownDone = resolve;
  });

  async function doShutdown(opts: DaemonShutdownOptions = {}): Promise<void> {
    const drain = opts.drain ?? true;
    const timeoutMs = opts.timeoutMs ?? 30_000;

    logger.info('daemon.shutdown.start', { drain, timeoutMs });

    // 1. Pause every source so no new events enter the bus.
    await Promise.allSettled(
      [...sources.values()].map(async (src) => {
        try {
          await src.pause();
        } catch (err) {
          logger.warn('daemon.shutdown.source.pause.error', {
            id: src.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    // 2. Drain the bus + dispatcher with a hard timeout.
    if (drain) {
      const raceTimeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      await Promise.race([Promise.all([bus.drained(), dispatcher.draining()]), raceTimeout]);
    }

    // 3. Stop every source. Registry unregister walks deactivate() → stop().
    for (const [id, src] of sources) {
      try {
        await src.stop('daemon-shutdown');
      } catch (err) {
        logger.warn('daemon.shutdown.source.stop.error', {
          id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    sources.clear();

    // 4. Detach the dispatcher from every bus it's attached to (primary
    //    + per-tenant in multi-tenant mode).
    for (const detach of detachHandles) detach();
    // 5. Close every tenant runtime. Reserved hook for future slice-9
    //    chaos wiring; today these are no-ops.
    for (const [, runtime] of tenants) {
      try {
        await runtime.close();
      } catch (err) {
        logger.warn('daemon.shutdown.tenant.close.error', {
          tenantId: runtime.tenant.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('daemon.shutdown.done');
    resolveShutdownDone();
  }

  async function doReload(opts: DaemonReloadOptions = {}): Promise<DaemonReloadResult> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const newSources =
      opts.sources ?? (options.sourcesProvider ? await options.sourcesProvider() : undefined);

    if (!newSources) {
      return {
        added: [],
        removed: [],
        changed: [],
        unchanged: [...loaded.keys()],
      };
    }

    const newByKey = new Map<string, ConfiguredSource>();
    for (const spec of newSources) {
      const key = sourceKey(spec);
      if (newByKey.has(key)) {
        throw new Error(`daemon.reload: duplicate source key "${key}"`);
      }
      newByKey.set(key, spec);
    }

    const oldKeys = new Set(loaded.keys());
    const newKeys = new Set(newByKey.keys());

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];

    for (const key of newKeys) {
      const prior = loaded.get(key);
      const next = newByKey.get(key) as ConfiguredSource;
      if (!prior) {
        added.push(key);
      } else if (configEqual(prior.spec.config, next.config)) {
        unchanged.push(key);
      } else {
        changed.push(key);
      }
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) removed.push(key);
    }

    logger.info('daemon.reload.start', {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length,
    });

    // 1) Stop removed + changed. Do this first so a changed source's old
    //    timer / HTTP route is free before we bind the new one.
    for (const key of [...removed, ...changed]) {
      await unregisterSource(key, timeoutMs);
    }

    // 2) Register added + changed.
    for (const key of [...added, ...changed]) {
      const spec = newByKey.get(key) as ConfiguredSource;
      try {
        await registerSource(spec);
      } catch (err) {
        logger.error('daemon.reload.register.error', {
          key,
          err: err instanceof Error ? err.message : String(err),
        });
        // Keep going — better to have a partial reload than to leave the
        // daemon in an indeterminate half-restart state.
      }
    }

    logger.info('daemon.reload.done', {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    });

    return { added, removed, changed, unchanged };
  }

  async function computeStatus(): Promise<DaemonStatus> {
    const sourceRows = await Promise.all(
      [...sources.values()].map(async (src) => ({
        id: src.id,
        type: src.type,
        health: await src.health(),
        metrics: src.metrics(),
      })),
    );
    const mailboxRows: Array<{ agent: string; depth: number }> = [];
    if (mailbox) {
      for (const agent of options.trackedMailboxAgents ?? []) {
        mailboxRows.push({ agent, depth: await mailbox.depth(agent) });
      }
    }
    return {
      uptimeMs: now() - startedAt,
      startedAt,
      sources: sourceRows,
      busRecentCount: bus.recent().length,
      mailbox: mailboxRows,
    };
  }

  const isMultiTenant = (options.tenants?.length ?? 0) > 0;

  return {
    startedAt,
    bus,
    dispatcher,
    registry: options.registry,
    tenants,
    sources,
    async status(): Promise<DaemonStatus> {
      return computeStatus();
    },
    async reload(opts?: DaemonReloadOptions): Promise<DaemonReloadResult> {
      return doReload(opts);
    },
    async sendEvent(event: AgentEvent): Promise<DispatchOutcome> {
      // Tenant-aware routing. The dispatcher itself is tenant-agnostic —
      // every tenant's bus enforces its own scope when sources publish.
      // `sendEvent` bypasses the bus (it's the control-plane entry point)
      // so we validate the tenant stamp explicitly here and reject
      // cross-tenant injection attempts.
      if (isMultiTenant) {
        const targetTenantId = event.meta?.tenantId;
        if (targetTenantId !== undefined && !tenants.has(targetTenantId)) {
          logger.warn('daemon.sendEvent.unknown.tenant', {
            eventId: event.id,
            tenantId: targetTenantId,
          });
          return {
            kind: 'rejected',
            reason: 'unauthorized',
            details: `unknown tenant "${targetTenantId}"`,
          };
        }
      }
      return dispatcher.handle(event);
    },
    async shutdown(opts?: DaemonShutdownOptions): Promise<void> {
      if (!shutdownPromise) shutdownPromise = doShutdown(opts);
      return shutdownPromise;
    },
    async waitForShutdown(): Promise<void> {
      await shutdownDone;
    },
    async replayRange(params: ReplayRangeParams): Promise<ReplayRangeResult> {
      const source = sources.get(params.sourceId);
      if (!source) {
        throw new Error(`replay: no live source with id "${params.sourceId}"`);
      }
      if (!source.replay) {
        throw new Error(
          `replay: source "${params.sourceId}" (type "${source.type}") does not support replay`,
        );
      }
      const filter = compileReplayFilter(params.filterExpr);
      const replayParams: Parameters<NonNullable<EventSourceInstance['replay']>>[0] = {
        fromMs: params.fromMs,
        ...(params.toMs !== undefined && { toMs: params.toMs }),
        ...(params.limit !== undefined && { limit: params.limit }),
        ...(filter !== undefined && { filter }),
      };
      let replayed = 0;
      let dispatched = 0;
      const outcomes: Array<{ eventId: string; outcome: DispatchOutcome }> = [];
      for await (const event of source.replay(replayParams)) {
        replayed += 1;
        if (params.dispatch !== false) {
          const outcome = await dispatcher.handle(event);
          dispatched += 1;
          outcomes.push({ eventId: event.id, outcome });
        }
      }
      return { replayed, dispatched, outcomes };
    },
    async dlqList(params: DLQListControlParams): Promise<readonly DLQEntry[]> {
      const source = sources.get(params.sourceId);
      if (!source) throw new Error(`dlq-list: no live source with id "${params.sourceId}"`);
      if (!source.listDLQ) {
        throw new Error(
          `dlq-list: source "${params.sourceId}" (type "${source.type}") does not expose DLQ access`,
        );
      }
      const { sourceId: _drop, ...rest } = params;
      return source.listDLQ(rest);
    },
    async dlqShow(params: DLQShowControlParams): Promise<DLQEntry | undefined> {
      const source = sources.get(params.sourceId);
      if (!source) throw new Error(`dlq-show: no live source with id "${params.sourceId}"`);
      if (!source.showDLQ) {
        throw new Error(
          `dlq-show: source "${params.sourceId}" (type "${source.type}") does not expose DLQ access`,
        );
      }
      return source.showDLQ(params.entryId);
    },
    async dlqRedrive(params: DLQRedriveControlParams): Promise<void> {
      const source = sources.get(params.sourceId);
      if (!source) throw new Error(`dlq-redrive: no live source with id "${params.sourceId}"`);
      if (!source.redriveDLQ) {
        throw new Error(
          `dlq-redrive: source "${params.sourceId}" (type "${source.type}") does not support redrive`,
        );
      }
      await source.redriveDLQ(params.entryId);
    },
  };
}

/**
 * Compile a filter expression for `replayRange`. The slice-12 flavor is
 * a narrow subset — string containment on a JSON-serialized event —
 * which is enough for the CLI's `--filter` flag and stays well short of
 * executing arbitrary JS.
 *
 * Syntax:
 *   `kind=webhook.received` → matches events whose serialized form
 *   contains the substring `"kind":"webhook.received"` (shorthand for
 *   kind equality — cheap and good enough).
 *   Anything else is treated as a literal substring match.
 *
 * Richer filter grammar (JSONPath, boolean AND/OR) can land in a
 * follow-up without breaking the wire protocol — the expression is
 * shipped as a plain string.
 */
function compileReplayFilter(
  expr: string | undefined,
): ((event: AgentEvent) => boolean) | undefined {
  if (!expr) return undefined;
  const eq = /^kind=([A-Za-z0-9._-]+)$/.exec(expr);
  if (eq) {
    const want = eq[1];
    return (event: AgentEvent) => event.kind === want;
  }
  return (event: AgentEvent) => JSON.stringify(event).includes(expr);
}

/**
 * `<type>:<config.id>` — the diff key used by reload. The adapter's
 * `id` convention is that `config.id` is always a non-empty string.
 * Adapters that don't follow this convention can't participate in hot
 * reload; they need to be torn down and restarted wholesale.
 */
function sourceKey(spec: ConfiguredSource): string {
  const cfg = spec.config as Record<string, unknown> | null | undefined;
  const id = cfg?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      `daemon: source config for type "${spec.type}" must have a non-empty string "id" field for reload to work`,
    );
  }
  return `${spec.type}:${id}`;
}

/**
 * Stable equality check for two source configs. JSON.stringify is
 * adequate here because config values come from JSON/YAML files — they
 * only contain primitives, arrays, and plain objects. We sort keys so
 * `{a:1,b:2}` and `{b:2,a:1}` compare equal.
 */
function configEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}
