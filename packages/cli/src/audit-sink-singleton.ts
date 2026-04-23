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
 * Not a leak: `releaseSharedAuditSink` is idempotent (second call is a
 * no-op) so the up-lifecycle can call it unconditionally from
 * `stopAll`.
 *
 * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #52
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

interface CacheEntry {
  opening: Promise<TenantAuditSink>;
  sink: TenantAuditSink | null;
}

const cache = new Map<string, CacheEntry>();

/**
 * Return the shared `TenantAuditSink` for `path`, opening it if this
 * is the first caller. Concurrent calls while the first `open()` is
 * in flight share the same promise.
 */
export async function getOrOpenSharedAuditSink(
  options: SharedAuditSinkOptions,
): Promise<TenantAuditSink> {
  const { path } = options;
  const existing = cache.get(path);
  if (existing) {
    // Prefer the resolved handle — avoids awaiting through resolved
    // promises unnecessarily on the hot path.
    if (existing.sink) return existing.sink;
    return existing.opening;
  }
  const opening = createSqliteAuditSink({ path });
  const entry: CacheEntry = { opening, sink: null };
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
 */
export async function releaseSharedAuditSink(path: string): Promise<void> {
  const entry = cache.get(path);
  if (!entry) return;
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
