import type { ExtensionRegistry } from '../extension/types.js';
import type { HookRegistry } from '../hooks/types.js';
import { lookupSkill, runSkill } from '../skills/runner.js';
import type { RunAgent, RunAgentResult } from '../types/agent.js';
import type { Logger } from '../types/logger.js';
import type { AgentSpec, SessionHandle } from '../types/session.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { PerTargetRateLimiter, type RateLimitSpec } from './rate-limiter.js';
import type { EventStore } from './store.js';
import type {
  AgentEvent,
  DispatchOutcome,
  EventBus,
  EventDispatcher,
  EventSourceTag,
  EventTarget,
} from './types.js';

export const DEFAULT_IDEMPOTENCY_CACHE_SIZE = 10_000;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CAUSED_BY_DEPTH_LIMIT = 5;
export const DEFAULT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

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

/**
 * Host-provided factories. Tests usually stub these with in-memory
 * sessions; the daemon (slice 9) wires them to the real session store.
 */
export interface DispatcherSessionFactories {
  /** Look up a session that already exists. Returns undefined to reject with `no-handler`. */
  resolveSession?(
    sessionId: string,
  ): SessionHandle | undefined | Promise<SessionHandle | undefined>;
  /** Mint a brand-new session for `target: new-session`. */
  createSession?(spec?: Partial<AgentSpec>): SessionHandle | Promise<SessionHandle>;
  /** Mint a child session of `parentSessionId` for `target: sub-agent` + skills. */
  createChildSession?(
    parentSessionId: string,
    spec?: Partial<AgentSpec>,
  ): SessionHandle | Promise<SessionHandle>;
  /**
   * Session pinning (Item A step 1). Look up an existing durable session
   * by its stable `sessionKey` (e.g. per Slack thread / per tenant / per
   * entity). Returns `undefined` when no pinned session exists yet, in
   * which case the dispatcher falls back to {@link createSessionForKey}.
   * Wired by the host to the SQLite session store; absent in tests that
   * don't exercise the pinned skill path. See `docs/AGENT_DURABILITY.md`.
   * @since 0.7.6
   */
  resolveSessionByKey?(
    sessionKey: string,
  ): SessionHandle | undefined | Promise<SessionHandle | undefined>;
  /**
   * Session pinning (Item A step 1). Create-and-persist a brand-new
   * durable session for `sessionKey` when {@link resolveSessionByKey} found
   * none. The host keys the session so a later event with the same
   * `sessionKey` resolves the same transcript.
   * @since 0.7.6
   */
  createSessionForKey?(
    sessionKey: string,
    spec?: Partial<AgentSpec>,
  ): SessionHandle | Promise<SessionHandle>;
}

export interface CreateEventDispatcherOptions extends DispatcherSessionFactories {
  registry: ExtensionRegistry;
  runAgent: RunAgent;
  hookRegistry?: HookRegistry;
  logger?: Logger;
  /** Max entries in the idempotency cache (LRU). Default 10_000. */
  idempotencyCacheSize?: number;
  /** Idempotency cache TTL. Default 10 min. */
  idempotencyTtlMs?: number;
  /** Depth of `causedBy` chain to walk for loop detection. Default 5. */
  causedByDepthLimit?: number;
  /**
   * Lookup for historic events when walking `causedBy` chains. In slice 2
   * the default is `bus.recent()`, supplied at `attach()` time. If a
   * `store` is configured (slice 8), the store is preferred so loop
   * detection survives restarts.
   */
  lookupEvent?(id: string): AgentEvent | undefined | Promise<AgentEvent | undefined>;
  /**
   * Persistent event store. When supplied, the dispatcher records every
   * event before dispatch and updates the outcome after. Cross-restart
   * dedup uses `store.findDuplicate` before hitting the in-memory cache.
   */
  store?: EventStore;
  /**
   * Window used for `(idempotencyKey, source_type)` dedup against the
   * persistent store. Default 24h per §8 of PHASE_3_PLAN.
   */
  dedupWindowMs?: number;
  /**
   * Slice 14. Optional per-target rate limit. When omitted, no rate
   * limiting is applied. When supplied, each matching target is
   * checked against its token bucket; exceeded → `{ kind: 'rejected',
   * reason: 'rate-limit' }`.
   */
  rateLimits?: RateLimitSpec;
  /**
   * Per-target circuit breaker factory. Called the first time a given
   * skill target is routed; subsequent invocations reuse the returned
   * breaker. Return `undefined` to disable breaker protection for a
   * specific target. When the option itself is omitted, no breakers
   * are consulted and behavior matches pre-0.6 dispatch.
   *
   * Scope: currently guards `target.type === 'skill'` only. `sub-agent`
   * and session targets fall through without breaker protection. A
   * broken skill short-circuits to `{ kind: 'rejected', reason:
   * 'circuit-open' }` until the breaker flips to `half-open` and a
   * probe succeeds.
   *
   * @since 0.6.0-slice.3
   */
  targetBreaker?(targetName: string): CircuitBreaker | undefined;
}

export function createEventDispatcher(options: CreateEventDispatcherOptions): EventDispatcher {
  const {
    registry,
    runAgent,
    hookRegistry,
    logger = NOOP_LOGGER,
    resolveSession,
    createSession,
    createChildSession,
    resolveSessionByKey,
    createSessionForKey,
  } = options;
  const cacheSize = Math.max(1, options.idempotencyCacheSize ?? DEFAULT_IDEMPOTENCY_CACHE_SIZE);
  const ttlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const depthLimit = options.causedByDepthLimit ?? DEFAULT_CAUSED_BY_DEPTH_LIMIT;
  const dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const store = options.store;
  const rateLimiter =
    options.rateLimits && options.rateLimits.byTarget.length > 0
      ? new PerTargetRateLimiter({ spec: options.rateLimits })
      : null;

  const idempotency = new IdempotencyCache(cacheSize, ttlMs);
  const sessionChains = new Map<string, Promise<unknown>>();
  const inFlight = new Set<Promise<unknown>>();
  let attachedBus: EventBus | null = null;
  let externalLookup = options.lookupEvent;

  async function lookupAncestor(id: string): Promise<AgentEvent | undefined> {
    if (externalLookup) {
      const hit = await externalLookup(id);
      if (hit) return hit;
    }
    if (store) {
      const rec = await store.get(id);
      if (rec) return rec.event;
    }
    if (attachedBus) {
      return attachedBus.recent((e) => e.id === id)[0];
    }
    return undefined;
  }

  async function detectLoop(event: AgentEvent): Promise<boolean> {
    const currentTrigger = getTriggerId(event.source);
    if (!currentTrigger) return false;
    let ancestorId = event.meta?.causedBy;
    let depth = 0;
    const visited = new Set<string>();
    while (ancestorId && depth < depthLimit) {
      if (visited.has(ancestorId)) return true;
      visited.add(ancestorId);
      const ancestor = await lookupAncestor(ancestorId);
      if (!ancestor) return false;
      if (getTriggerId(ancestor.source) === currentTrigger) return true;
      ancestorId = ancestor.meta?.causedBy;
      depth += 1;
    }
    return false;
  }

  function runForSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Store a non-rejecting successor so the chain survives handler errors.
    sessionChains.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async function executeTarget(event: AgentEvent, target: EventTarget): Promise<DispatchOutcome> {
    switch (target.type) {
      case 'broadcast':
        return { kind: 'broadcast' };

      case 'session': {
        if (!resolveSession) {
          return rejected('no-handler', 'resolveSession factory not provided');
        }
        const session = await resolveSession(target.sessionId);
        if (!session) {
          return rejected('no-handler', `session "${target.sessionId}" not found`);
        }
        // `inject` and `queue` both serialize behind the per-session lock.
        // `replace` aborts the current turn before queuing a fresh one. True
        // mid-turn injection — appending a user message to an in-flight
        // turn — is out of scope for slice 2; the engine does not yet
        // expose the hooks for it. When it does, this is the one place to
        // change.
        const turnResult = await runForSession(session.id, async () => {
          return await runAgent({
            session,
            userMessage: frameEvent(event),
            ...(event.meta?.causedBy !== undefined && { causedBy: event.meta.causedBy }),
          });
        });
        return dispatched(session.id, turnResult);
      }

      case 'new-session': {
        if (!createSession) {
          return rejected('no-handler', 'createSession factory not provided');
        }
        const session = await createSession(target.agentSpec);
        const userMessage = target.initialPrompt
          ? `${target.initialPrompt}\n\n${frameEvent(event)}`
          : frameEvent(event);
        const turnResult = await runForSession(session.id, async () =>
          runAgent({
            session,
            userMessage,
            ...(event.meta?.causedBy !== undefined && { causedBy: event.meta.causedBy }),
          }),
        );
        return dispatched(session.id, turnResult);
      }

      case 'skill': {
        const skill = lookupSkill(registry, target.name);
        if (!skill) return rejected('no-handler', `skill "${target.name}" not registered`);

        // Session pinning (Item A step 1). When the route declared a
        // non-empty `sessionKey`, resolve-or-create one durable session
        // keyed by it and append the event as a NEW TURN on that session,
        // accumulating transcript across events. Empty strings are treated
        // as absent — the parser already rejects them, but the dispatcher
        // must not trust upstream. See `docs/AGENT_DURABILITY.md`.
        const sessionKey =
          typeof target.sessionKey === 'string' && target.sessionKey.length > 0
            ? target.sessionKey
            : undefined;
        if (sessionKey !== undefined) {
          if (!resolveSessionByKey && !createSessionForKey) {
            return rejected(
              'no-handler',
              'session-pinning factories (resolveSessionByKey / createSessionForKey) not provided',
            );
          }
          const existing = await resolveSessionByKey?.(sessionKey);
          const pinned = existing ?? (await createSessionForKey?.(sessionKey));
          if (!pinned) {
            return rejected(
              'no-handler',
              `pinned session for key "${sessionKey}" could not be resolved or created`,
            );
          }
          // Reuse the per-target circuit breaker for parity with the
          // unpinned path so a chronically failing pinned skill trips too.
          const pinnedBreaker = options.targetBreaker?.(target.name);
          if (pinnedBreaker && !pinnedBreaker.allow()) {
            return rejected(
              'circuit-open',
              `skill "${target.name}" breaker is ${pinnedBreaker.state}; cooldown in progress`,
            );
          }
          try {
            // Serialize behind the per-session lock and run the EVENT as a
            // new turn (mirrors the `session` / `new-session` cases). The
            // pinned conversation accumulates real event turns, not
            // re-rendered skill prompts — documented in AGENT_DURABILITY.md.
            const turnResult = await runForSession(pinned.id, async () =>
              runAgent({
                session: pinned,
                userMessage: frameEvent(event),
                ...(event.meta?.causedBy !== undefined && { causedBy: event.meta.causedBy }),
              }),
            );
            pinnedBreaker?.record(true);
            return dispatched(pinned.id, turnResult);
          } catch (err) {
            pinnedBreaker?.record(false);
            throw err;
          }
        }

        if (!createChildSession) {
          return rejected('no-handler', 'createChildSession factory not provided');
        }
        // Circuit-breaker gate (PR 3.1). Fail-fast when the target's
        // breaker is `open` so retries don't pile up while the skill is
        // known bad. `half-open` is treated as `closed` — the breaker's
        // own probe bookkeeping decides whether the probe succeeds.
        const breaker = options.targetBreaker?.(target.name);
        if (breaker && !breaker.allow()) {
          return rejected(
            'circuit-open',
            `skill "${target.name}" breaker is ${breaker.state}; cooldown in progress`,
          );
        }
        const parentId = originSessionId(event.source) ?? `__event:${event.id}`;
        try {
          const turnResult = await runSkill(target.name, {
            registry,
            inputs: { ...target.inputs, __event: frameEvent(event) },
            ...(hookRegistry !== undefined && { hooks: hookRegistry }),
            runAgent,
            createChildSession: () => {
              // runSkill expects a synchronous factory. We bridge by invoking
              // the host factory synchronously; if it returns a Promise the
              // factory is misconfigured for skill routing.
              const maybe = createChildSession(parentId);
              if (isPromise(maybe)) {
                throw new Error(
                  'createChildSession must return a SessionHandle synchronously for skill routing',
                );
              }
              return maybe;
            },
            turn: { sessionId: parentId, turnId: event.id, depth: 0 },
          });
          breaker?.record(true);
          return dispatched(parentId, turnResult);
        } catch (err) {
          breaker?.record(false);
          throw err;
        }
      }

      case 'sub-agent': {
        if (!createChildSession) {
          return rejected('no-handler', 'createChildSession factory not provided');
        }
        const child = await createChildSession(target.parentSessionId, target.spec);
        const turnResult = await runForSession(child.id, async () =>
          runAgent({
            session: child,
            userMessage: frameEvent(event),
            depth: 1,
            ...(event.meta?.causedBy !== undefined && { causedBy: event.meta.causedBy }),
          }),
        );
        return dispatched(child.id, turnResult);
      }
    }
  }

  async function handleInternal(event: AgentEvent): Promise<DispatchOutcome> {
    // 1. event.before — subscribers may rewrite or drop the event.
    let current = event;
    if (hookRegistry) {
      const override = await hookRegistry.fire('event.before', { event: current });
      if (override) {
        if (override.event === undefined) {
          // Dropping the event is modeled as a broadcast no-op: the bus
          // already delivered; the dispatcher just elects not to route.
          const outcome: DispatchOutcome = { kind: 'broadcast' };
          await hookRegistry.fire('event.after', { event: current, outcome });
          return outcome;
        }
        current = override.event;
      }
    }

    // 2. Idempotency check — in-memory first (cheap), then the persistent
    //    store (catches events seen before the process restarted).
    const firstSeenInMem = idempotency.lookup(
      current.id,
      current.meta?.idempotencyKey,
      current.source.type,
    );
    if (firstSeenInMem !== undefined) {
      const outcome: DispatchOutcome = {
        kind: 'duplicate',
        firstSeenAt: firstSeenInMem,
        eventId: current.id,
      };
      if (hookRegistry) {
        await hookRegistry.fire('event.after', { event: current, outcome });
      }
      return outcome;
    }
    if (store) {
      const prior = await store.findDuplicate(current, dedupWindowMs);
      if (prior) {
        const outcome: DispatchOutcome = {
          kind: 'duplicate',
          firstSeenAt: prior.event.timestamp,
          eventId: current.id,
        };
        // Remember in-memory so the next hit doesn't touch SQLite.
        idempotency.remember(
          current.id,
          current.meta?.idempotencyKey,
          current.source.type,
          prior.event.timestamp,
        );
        if (hookRegistry) {
          await hookRegistry.fire('event.after', { event: current, outcome });
        }
        return outcome;
      }
    }
    idempotency.remember(current.id, current.meta?.idempotencyKey, current.source.type, Date.now());
    if (store) {
      try {
        await store.record(current);
      } catch (err) {
        // Persistence is best-effort from the dispatcher's perspective;
        // we prefer delivering an event to silently dropping it when
        // SQLite is momentarily unhappy. Log and continue.
        logger.warn('event.store.record.error', {
          eventId: current.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Loop-break check on the (possibly rewritten) event.
    if (await detectLoop(current)) {
      const outcome: DispatchOutcome = {
        kind: 'rejected',
        reason: 'loop',
        details: `causedBy chain contains triggerId "${getTriggerId(current.source) ?? '<none>'}"`,
      };
      if (store) {
        try {
          await store.markOutcome(current.id, outcome);
          await store.upsertRejection(current.id, outcome.reason, outcome.details);
        } catch {
          // best-effort
        }
      }
      if (hookRegistry) {
        await hookRegistry.fire('event.after', { event: current, outcome });
      }
      return outcome;
    }

    // 4a. Rate-limit check (slice 14). Short-circuits before we spin up
    //     an expensive session/skill/sub-agent turn. Runs after dedup +
    //     loop detection so duplicate-suppressed events don't waste
    //     tokens.
    if (rateLimiter) {
      const decision = rateLimiter.allow(current.target);
      if (!decision.allowed) {
        const outcome: DispatchOutcome = {
          kind: 'rejected',
          reason: 'rate-limit',
          details: `target=${current.target.type}${
            decision.deniedByRule?.id ? `:${decision.deniedByRule.id}` : ''
          } ratePerSec=${decision.deniedByRule?.ratePerSec ?? '?'}`,
        };
        logger.warn('event.dispatch.rate-limited', {
          eventId: current.id,
          target: current.target.type,
          rule: decision.deniedByKey,
        });
        if (store) {
          try {
            await store.markOutcome(current.id, outcome);
            await store.upsertRejection(current.id, outcome.reason, outcome.details);
          } catch {
            // best-effort — matches the rest of the store path
          }
        }
        if (hookRegistry) {
          await hookRegistry.fire('event.after', { event: current, outcome });
        }
        return outcome;
      }
    }

    // 4b. Route by target.
    let outcome: DispatchOutcome;
    try {
      outcome = await executeTarget(current, current.target);
    } catch (err) {
      outcome = {
        kind: 'rejected',
        reason: 'invalid',
        details: err instanceof Error ? err.message : String(err),
      };
      logger.warn('event.dispatch.error', {
        eventId: current.id,
        kind: current.kind,
        err: outcome.details ?? '',
      });
    }

    // 5. Persist outcome (best-effort). Dispatched/broadcast/queued/rejected
    //    all flow through the same markOutcome call.
    if (store) {
      try {
        await store.markOutcome(current.id, outcome);
      } catch (err) {
        logger.warn('event.store.markOutcome.error', {
          eventId: current.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      // 5a. Dispatch DLQ (Slice 5 / PR 5.1) — every rejected outcome is
      //     upserted into rejected_events so operators can enumerate
      //     stuck events without scanning the much larger events table.
      //     The rate-limit short-circuit above (step 4a) ALSO flows
      //     through here because both paths converge on a single
      //     markOutcome call only in the target-routing path — so we
      //     additionally stamp the DLQ row there.
      if (outcome.kind === 'rejected') {
        try {
          await store.upsertRejection(current.id, outcome.reason, outcome.details);
        } catch (err) {
          logger.warn('event.store.upsertRejection.error', {
            eventId: current.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // 5b. If the event was successfully dispatched AFTER previously
      //     being rejected, clear its DLQ row so the list doesn't
      //     surface an already-healed event as stuck.
      if (outcome.kind === 'dispatched' || outcome.kind === 'broadcast') {
        try {
          await store.deleteRejection(current.id);
        } catch (err) {
          logger.warn('event.store.deleteRejection.error', {
            eventId: current.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 6. event.after — always runs once we have an outcome.
    if (hookRegistry) {
      try {
        await hookRegistry.fire('event.after', { event: current, outcome });
      } catch (err) {
        logger.warn('event.after.hook.error', {
          eventId: current.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return outcome;
  }

  return {
    attach(bus: EventBus): () => void {
      attachedBus = bus;
      // Slice 2 uses the bus's recent buffer as the default ancestor lookup;
      // slice 8 will replace this with the SQLite store.
      if (!externalLookup) {
        externalLookup = (id: string) => bus.recent((e) => e.id === id)[0];
      }
      const off = bus.subscribe('*', (event) => {
        // Discard the per-event outcome — it's consumed via `handle()` by
        // callers that care. The bus subscription exists so events flowing
        // through the bus are routed without the source having to call
        // `dispatcher.handle` directly.
        const p = handleInternal(event).catch((err) => {
          logger.error('event.dispatch.unexpected', {
            eventId: event.id,
            err: err instanceof Error ? err.message : String(err),
          });
        });
        inFlight.add(p);
        p.finally(() => inFlight.delete(p));
      });
      return () => {
        off();
        if (attachedBus === bus) attachedBus = null;
      };
    },

    async handle(event: AgentEvent): Promise<DispatchOutcome> {
      const p = handleInternal(event);
      inFlight.add(
        p.then(
          () => undefined,
          () => undefined,
        ),
      );
      try {
        return await p;
      } finally {
        for (const tracked of inFlight) {
          // Cleanup handled lazily; no-op here.
          void tracked;
        }
      }
    },

    async draining(): Promise<void> {
      while (inFlight.size > 0) {
        const snapshot = [...inFlight];
        await Promise.allSettled(snapshot);
        for (const p of snapshot) inFlight.delete(p);
      }
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function dispatched(sessionId: string, result: RunAgentResult): DispatchOutcome {
  // The engine does not currently surface the new turnId out of runAgent;
  // the turn id lives in the session ledger. Leaving turnId undefined is
  // acceptable per the DispatchOutcome type. Slice 8 can backfill via the
  // persisted event row when the engine starts returning it.
  void result;
  return { kind: 'dispatched', sessionId };
}

function rejected(
  reason: 'rate-limit' | 'unauthorized' | 'no-handler' | 'loop' | 'invalid' | 'circuit-open',
  details?: string,
): DispatchOutcome {
  return details !== undefined
    ? { kind: 'rejected', reason, details }
    : { kind: 'rejected', reason };
}

function getTriggerId(source: EventSourceTag): string | undefined {
  if ('triggerId' in source && typeof source.triggerId === 'string') return source.triggerId;
  return undefined;
}

function originSessionId(source: EventSourceTag): string | undefined {
  if (source.type === 'user') return source.sessionId;
  if (source.type === 'sub-agent') return source.parentSessionId;
  return undefined;
}

function isPromise(v: unknown): v is Promise<unknown> {
  return (
    typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
  );
}

/**
 * XML-ish wrapper around the event payload. Wrapping (rather than passing
 * raw JSON) signals to the model that "this is not user input" and makes
 * the source unambiguous. The format mirrors §3 of PHASE_3_PLAN.md.
 */
export function frameEvent(event: AgentEvent): string {
  const triggerId = getTriggerId(event.source);
  const attrs: string[] = [`source="${escapeAttr(event.source.type)}"`];
  if (triggerId) attrs.push(`trigger="${escapeAttr(triggerId)}"`);
  attrs.push(`id="${escapeAttr(event.id)}"`);
  if (event.meta?.causedBy) attrs.push(`caused-by="${escapeAttr(event.meta.causedBy)}"`);
  const payloadJson = safeStringify(event.payload);
  return `<event ${attrs.join(' ')}>\n  <payload>${escapeText(payloadJson)}</payload>\n</event>`;
}

function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeText(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── IdempotencyCache ─────────────────────────────────────────────────────

/**
 * Bounded LRU + TTL. Keys are event ids; an optional secondary `idempotencyKey`
 * is aliased to the same entry so `X-GitHub-Delivery` flowing on two separate
 * events still dedupes.
 */
class IdempotencyCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  lookup(eventId: string, idempotencyKey?: string, sourceType?: string): number | undefined {
    const now = Date.now();
    const primary = this.read(eventId, now);
    if (primary !== undefined) return primary;
    if (idempotencyKey && sourceType) {
      return this.read(idempotencyCacheKey(sourceType, idempotencyKey), now);
    }
    return undefined;
  }

  remember(
    eventId: string,
    idempotencyKey: string | undefined,
    sourceType: string,
    ts: number,
  ): void {
    this.write(eventId, ts);
    if (idempotencyKey) this.write(idempotencyCacheKey(sourceType, idempotencyKey), ts);
  }

  private read(key: string, now: number): number | undefined {
    const at = this.entries.get(key);
    if (at === undefined) return undefined;
    if (now - at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Touch for LRU: delete + reinsert so iteration order = recency.
    this.entries.delete(key);
    this.entries.set(key, at);
    return at;
  }

  private write(key: string, ts: number): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, ts);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function idempotencyCacheKey(sourceType: string, idempotencyKey: string): string {
  return `key:${sourceType}:${idempotencyKey}`;
}
