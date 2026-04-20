import type { TenantAuditSink } from '../audit/types.js';
import type { TenantContext, TenantQuotas } from './types.js';

/**
 * Phase 6 slice-6 quota tracker.
 *
 * Lightweight in-memory counters keyed by quota kind. When a quota is
 * breached the tracker fires a typed error AND writes a
 * `quota_exceeded` audit record (when a sink is wired). Callers catch
 * the error + translate it into a user-facing refusal.
 *
 * Quotas tracked:
 *   - `maxActiveSessions`       — gauge
 *   - `maxConcurrentToolCalls`  — gauge
 *   - `maxEventIngressPerSec`   — rolling 1-second window
 *   - `dailyTokenUSD`           — daily rolling sum
 *
 * Cost is a simple mutex around counters; no external state. The
 * daemon re-creates the tracker on each tenant runtime assembly.
 */

export class QuotaExceededError extends Error {
  readonly code = 'EQUOTA';
  constructor(
    readonly tenantId: string,
    readonly quota: keyof TenantQuotas,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(
      `tenant ${tenantId} exceeded quota ${String(quota)} (limit=${limit}, observed=${observed})`,
    );
    this.name = 'QuotaExceededError';
  }
}

export interface QuotaTracker {
  /** Increment active sessions (call on spawn). */
  acquireSession(): void;
  /** Decrement active sessions (call on exit). */
  releaseSession(): void;
  /** Acquire one concurrent tool-call slot. Throws on breach. */
  acquireToolCall(): void;
  releaseToolCall(): void;
  /** Call once per inbound event. Throws when ingress rate is too high. */
  trackIngress(): void;
  /** Add a spend amount in USD; throws when the daily cap is breached. */
  addTokenSpendUSD(amount: number): void;
  /** Snapshot current counters — diagnostics only. */
  snapshot(): QuotaSnapshot;
}

export interface QuotaSnapshot {
  activeSessions: number;
  concurrentToolCalls: number;
  ingressInCurrentSecond: number;
  dailyTokenUSD: number;
}

export interface CreateQuotaTrackerOptions {
  tenant: TenantContext;
  /** Sink that receives `quota_exceeded` records on breach. */
  audit?: Pick<TenantAuditSink, 'record'>;
  /** Clock override for tests (ms-epoch). */
  now?: () => number;
}

export function createQuotaTracker(options: CreateQuotaTrackerOptions): QuotaTracker {
  const quotas = options.tenant.quotas ?? {};
  const now = options.now ?? Date.now;

  let activeSessions = 0;
  let concurrentToolCalls = 0;

  // Ingress rate — counted per wall-clock second; resets on the
  // second boundary.
  let ingressSecond = Math.floor(now() / 1000);
  let ingressCount = 0;

  // Daily USD spend — rolled at local-midnight for simplicity; good
  // enough for alerting. Precise billing lives in a separate ledger.
  let spendDayStart = startOfUtcDay(now());
  let spendTotalUSD = 0;

  function startOfUtcDay(ms: number): number {
    const d = new Date(ms);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  async function emit(quota: keyof TenantQuotas, limit: number, observed: number): Promise<void> {
    if (!options.audit) return;
    try {
      await options.audit.record({
        kind: 'quota_exceeded',
        ts: now(),
        tenantId: options.tenant.id,
        quota,
        limit,
        observed,
      });
    } catch {
      // Audit failures never bubble up — the breach error is the
      // load-bearing signal.
    }
  }

  function tripIfExceeded(
    quotaKey: keyof TenantQuotas,
    limit: number | undefined,
    observed: number,
  ): void {
    if (limit === undefined) return;
    if (observed > limit) {
      void emit(quotaKey, limit, observed);
      throw new QuotaExceededError(options.tenant.id, quotaKey, limit, observed);
    }
  }

  function acquireSession(): void {
    const next = activeSessions + 1;
    tripIfExceeded('maxActiveSessions', quotas.maxActiveSessions, next);
    activeSessions = next;
  }

  function releaseSession(): void {
    if (activeSessions > 0) activeSessions -= 1;
  }

  function acquireToolCall(): void {
    const next = concurrentToolCalls + 1;
    tripIfExceeded('maxConcurrentToolCalls', quotas.maxConcurrentToolCalls, next);
    concurrentToolCalls = next;
  }

  function releaseToolCall(): void {
    if (concurrentToolCalls > 0) concurrentToolCalls -= 1;
  }

  function trackIngress(): void {
    const sec = Math.floor(now() / 1000);
    if (sec !== ingressSecond) {
      ingressSecond = sec;
      ingressCount = 0;
    }
    const next = ingressCount + 1;
    tripIfExceeded('maxEventIngressPerSec', quotas.maxEventIngressPerSec, next);
    ingressCount = next;
  }

  function addTokenSpendUSD(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const day = startOfUtcDay(now());
    if (day !== spendDayStart) {
      spendDayStart = day;
      spendTotalUSD = 0;
    }
    const next = spendTotalUSD + amount;
    tripIfExceeded('dailyTokenUSD', quotas.dailyTokenUSD, next);
    spendTotalUSD = next;
  }

  function snapshot(): QuotaSnapshot {
    return {
      activeSessions,
      concurrentToolCalls,
      ingressInCurrentSecond: ingressCount,
      dailyTokenUSD: spendTotalUSD,
    };
  }

  return {
    acquireSession,
    releaseSession,
    acquireToolCall,
    releaseToolCall,
    trackIngress,
    addTokenSpendUSD,
    snapshot,
  };
}
