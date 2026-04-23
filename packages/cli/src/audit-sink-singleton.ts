/**
 * Process-wide singleton registry for `createSqliteAuditSink` handles.
 *
 * Background: `up-cli`'s boot opens one sink and threads it into the
 * `/audit` route, `startAuditExportLoop`, and every per-agent
 * `createToolRateLimitGate`. That in-process dedup was already in
 * place (see `up-cli.ts` — `sharedAuditSink`). What was missing was
 * a *module-level* guarantee so future callers (e.g. a sibling `fleet
 * run` started in the same process, or a new `/audit` sub-route in a
 * control-plane plugin) don't silently open a second handle on the
 * same SQLite file — doubling connections and fragmenting the WAL
 * stat cache.
 *
 * Contract:
 *   - `getOrOpenSharedAuditSink({ path })` returns a single handle per
 *     absolute `path`, opening it lazily on first call. The sink is
 *     cached in module state keyed by `path`.
 *   - `releaseSharedAuditSink(path)` drops the cache entry + closes
 *     the underlying sink. Callers that opened via the singleton MUST
 *     release on shutdown so the cache is empty between test runs and
 *     between `up`/`down` cycles.
 *   - Concurrent callers racing the first open share the same promise
 *     — no double-open.
 *
 * Ref-counted extension (POST_ENTERPRISE_BACKLOG.md #40, 0.7.3):
 *
 *   - `acquireTenantAuditSink({ path, owner })` is the preferred entry
 *     for multi-caller scenarios (`up-cli` + `fleet-run` in the same
 *     process, or a sibling subcommand spawned in-process by tests).
 *     Each successful acquire bumps a refcount keyed by `owner`.
 *   - `releaseTenantAuditSink({ path, owner })` decrements. Only the
 *     LAST release actually closes the underlying sink — partial
 *     teardowns leave the handle open for the other caller.
 *   - `owner` strings are namespaces, not identities: passing the
 *     same `owner` twice is idempotent (second acquire is a no-op,
 *     second release is a no-op). Callers that want true n-reference
 *     semantics should generate unique owner tokens.
 *
 * The legacy `getOrOpenSharedAuditSink` / `releaseSharedAuditSink` API
 * is a thin wrapper that uses a fixed `owner = '__legacy__'` — so the
 * existing `up-cli` callsite keeps working while `fleet-run` opts into
 * the ref-counted API directly.
 *
 * Not a leak: `releaseSharedAuditSink` is idempotent (second call is a
 * no-op) so the up-lifecycle can call it unconditionally from
 * `stopAll`.
 *
 * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #52
 * @since 0.7.3 — ref-counted multi-owner extension (#40)
 */

import { createSqliteAuditSink } from '@declaragent/core';
import type { TenantAuditSink } from '@declaragent/core';

export interface SharedAuditSinkOptions {
  /**
   * Absolute path to the SQLite audit DB. Callers should pass the
   * resolved `auditDbPath()` — the singleton cache is keyed verbatim,
   * so two different relative strings pointing at the same file will
   * NOT dedupe.
   */
  path: string;
}

export interface TenantAuditSinkLease extends SharedAuditSinkOptions {
  /**
   * Namespace token identifying the acquiring caller. Same-owner
   * re-acquire is idempotent — pick a stable string like `'up-cli'`,
   * `'fleet-run'`, or a unique id per instance if you need strict
   * n-reference counting.
   */
  owner: string;
}

interface CacheEntry {
  opening: Promise<TenantAuditSink>;
  sink: TenantAuditSink | null;
  /** Set of owners currently holding a reference. */
  owners: Set<string>;
}

const cache = new Map<string, CacheEntry>();

const LEGACY_OWNER = '__legacy__';

/**
 * Return the shared `TenantAuditSink` for `path`, opening it if this
 * is the first caller. Concurrent calls while the first `open()` is
 * in flight share the same promise.
 *
 * Uses the legacy single-owner namespace. Prefer
 * {@link acquireTenantAuditSink} when multiple callers (e.g. `up-cli`
 * and an in-process `fleet-run`) share the same sink — the ref-counted
 * API closes the underlying handle only after EVERY owner releases.
 */
export async function getOrOpenSharedAuditSink(
  options: SharedAuditSinkOptions,
): Promise<TenantAuditSink> {
  return acquireTenantAuditSink({ path: options.path, owner: LEGACY_OWNER });
}

/**
 * Acquire a ref-counted lease on the shared `TenantAuditSink` for
 * `path`. Multiple callers passing the same `path` receive the SAME
 * handle; the underlying sink is closed only after every `owner`
 * releases.
 *
 * Same-owner re-acquire is idempotent (owner already in the set →
 * just returns the existing handle).
 */
export async function acquireTenantAuditSink(
  options: TenantAuditSinkLease,
): Promise<TenantAuditSink> {
  const { path, owner } = options;
  const existing = cache.get(path);
  if (existing) {
    existing.owners.add(owner);
    if (existing.sink) return existing.sink;
    return existing.opening;
  }
  const opening = createSqliteAuditSink({ path });
  const entry: CacheEntry = { opening, sink: null, owners: new Set([owner]) };
  cache.set(path, entry);
  try {
    entry.sink = await opening;
    return entry.sink;
  } catch (err) {
    // Purge the cache on open-failure so the next caller can retry
    // instead of getting a rejected promise forever.
    cache.delete(path);
    throw err;
  }
}

/**
 * Close + forget the shared sink for `path`. Idempotent — safe to
 * call from an error branch that may or may not have opened the sink.
 *
 * Routes through the legacy owner namespace, so it is equivalent to
 * `releaseTenantAuditSink({ path, owner: '__legacy__' })`. If other
 * owners hold refs on the same path, the underlying sink stays open.
 */
export async function releaseSharedAuditSink(path: string): Promise<void> {
  await releaseTenantAuditSink({ path, owner: LEGACY_OWNER });
}

/**
 * Release a ref-counted lease. The underlying sink is closed only
 * when the last owner releases. Releasing an owner that never
 * acquired (or already released) is a silent no-op.
 */
export async function releaseTenantAuditSink(options: TenantAuditSinkLease): Promise<void> {
  const { path, owner } = options;
  const entry = cache.get(path);
  if (!entry) return;
  const had = entry.owners.delete(owner);
  if (!had) return;
  if (entry.owners.size > 0) return;
  // Last owner released — close + evict.
  cache.delete(path);
  try {
    const sink = entry.sink ?? (await entry.opening);
    await sink.close();
  } catch {
    // Best-effort — close() on a partially-open DB can throw; we'd
    // rather drop the cache entry than leave stale state around.
  }
}

/**
 * Test-only: drop every cached entry without closing. Used by the
 * audit-sink-singleton test to guarantee a clean start between cases.
 * Do NOT call from production code — use {@link releaseSharedAuditSink}
 * so the underlying SQLite handle is actually closed.
 */
export function __resetSharedAuditSinkCache(): void {
  cache.clear();
}

/**
 * Test-only: inspect whether a given path is currently cached.
 */
export function __hasSharedAuditSink(path: string): boolean {
  return cache.has(path);
}

/**
 * Test-only: inspect the current ref count for `path`. Returns 0
 * when the path is not cached.
 */
export function __auditSinkRefCount(path: string): number {
  return cache.get(path)?.owners.size ?? 0;
}
