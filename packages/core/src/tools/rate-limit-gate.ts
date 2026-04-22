/**
 * Per-tool rate limiting (Enterprise Production Plan §3 Item #7).
 *
 * The provider-level limiter in `../providers/rate-limit.ts` caps how
 * fast we talk to the LLM. A tool — especially `Bash`, which can shell
 * out to `curl` — can still hammer downstream systems at whatever rate
 * the LLM's tool_use loop generates. Buyers want a per-tool ceiling.
 *
 * Mechanics are identical to the provider limiter: token bucket with a
 * configurable steady-state `rps` and `burst` capacity. We reuse
 * {@link ProviderTokenBucket} directly rather than reimplement. The
 * only new surface is:
 *   - A facade (`ToolRateLimitGate`) keyed on tool name so a single
 *     config object can manage N tools.
 *   - A `rate_limited` audit record that fires when the wait exceeds
 *     a configurable threshold (default 1 s). Short, pure-burst-absorption
 *     waits stay silent so the chain doesn't bloat.
 *
 * Injected clock + sleep are preserved so tests can drive time
 * deterministically — the provider limiter's tests use the same
 * pattern and this module mirrors them.
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #7
 */

import type { RateLimitedAuditRecord, TenantAuditSink } from '../audit/types.js';
import { ProviderTokenBucket } from '../providers/rate-limit.js';

/** Per-tool rate-limit configuration as surfaced in `agent.yaml`. */
export interface ToolRateLimitConfig {
  /** Steady-state rate in calls per second. Must be > 0. */
  rps: number;
  /**
   * Max calls the bucket can absorb without throttling. Defaults to
   * `rps` (i.e. a full second of steady-state calls). Operators who
   * want the classic "2× rps" burst behaviour set it explicitly.
   */
  burst?: number;
}

/** Context passed to `acquire()` — everything the audit record needs. */
export interface ToolRateLimitAcquireContext {
  /** Tenant on whose behalf the tool is running. Audit sinks are per-tenant. */
  tenantId: string;
  /** Session id, if available. Lets operators correlate stalls to a turn. */
  sessionId?: string;
  /** Correlation id of the originating event, when known. */
  correlationId?: string;
}

/** Options accepted by {@link createToolRateLimitGate}. */
export interface ToolRateLimitGateOptions {
  /** Tool name → config. Tools not in this map are uncapped. */
  limits: Readonly<Record<string, ToolRateLimitConfig>>;
  /**
   * Audit sink for `rate_limited` records. Optional — when absent, the
   * gate still throttles, it just doesn't record. The sink's `record()`
   * errors are swallowed (we never block a tool on audit persistence).
   */
  auditSink?: TenantAuditSink;
  /**
   * Waits shorter than this are silent. Default 1000 ms — matches the
   * spec's "emit a rate_limited audit record if the wait exceeds 1s".
   */
  auditThresholdMs?: number;
  /**
   * Injected wall clock. Default `Date.now`. Tests override for
   * deterministic time.
   */
  now?: () => number;
  /** Injected sleep. Default `setTimeout`. Tests override with a fake. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Fires whenever a tool call waited for a token. Mirrors the provider
   * wrapper's `onWait` — the CLI bumps Prometheus counters from here.
   */
  onWait?: (event: { tool: string; waitMs: number }) => void;
}

/**
 * Gate returned by {@link createToolRateLimitGate}.
 *
 * Thin facade: `acquire(tool, ctx)` consumes one token for `tool` and
 * returns the ms waited (0 = immediate). If the wait exceeds
 * `auditThresholdMs`, a `rate_limited` audit record is persisted.
 *
 * Tools that are not in the configured `limits` map bypass the gate
 * entirely — `acquire()` returns 0 without touching any state. This
 * preserves pre-rate-limit behaviour for unconfigured tools.
 */
export interface ToolRateLimitGate {
  /**
   * Reserve one slot for `toolName`. Returns the ms waited — callers
   * don't need to act on it; the gate's internal sleep has already
   * elapsed. Provided for metrics / diagnostics.
   */
  acquire(toolName: string, ctx: ToolRateLimitAcquireContext): Promise<number>;
  /** True when `toolName` has a configured limit. */
  has(toolName: string): boolean;
}

const DEFAULT_AUDIT_THRESHOLD_MS = 1_000;

export function createToolRateLimitGate(options: ToolRateLimitGateOptions): ToolRateLimitGate {
  const { limits, auditSink, onWait } = options;
  const auditThresholdMs = options.auditThresholdMs ?? DEFAULT_AUDIT_THRESHOLD_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep;

  const buckets = new Map<string, ProviderTokenBucket>();
  const configs = new Map<string, { rps: number; burst: number }>();
  for (const [toolName, cfg] of Object.entries(limits)) {
    if (!(cfg.rps > 0)) {
      throw new Error(`tools.rateLimit[${toolName}]: rps must be > 0 (got ${String(cfg.rps)})`);
    }
    const burst = Math.max(1, cfg.burst ?? cfg.rps);
    const bucketOpts: ConstructorParameters<typeof ProviderTokenBucket>[0] = {
      ratePerSec: cfg.rps,
      burst,
      now,
      ...(sleep !== undefined && { sleep }),
    };
    buckets.set(toolName, new ProviderTokenBucket(bucketOpts));
    configs.set(toolName, { rps: cfg.rps, burst });
  }

  async function acquire(toolName: string, ctx: ToolRateLimitAcquireContext): Promise<number> {
    const bucket = buckets.get(toolName);
    if (!bucket) return 0;
    const waitMs = await bucket.take();
    if (waitMs > 0 && onWait) {
      try {
        onWait({ tool: toolName, waitMs });
      } catch {
        // Metrics hook misbehaved; the tool call already waited. Swallow.
      }
    }
    if (waitMs > auditThresholdMs && auditSink) {
      const cfg = configs.get(toolName);
      if (cfg) {
        const record: RateLimitedAuditRecord & { tenantId: string } = {
          kind: 'rate_limited',
          ts: now(),
          tenantId: ctx.tenantId,
          tool: toolName,
          rps: cfg.rps,
          burst: cfg.burst,
          waitMs,
          ...(ctx.sessionId !== undefined && { sessionId: ctx.sessionId }),
          ...(ctx.correlationId !== undefined && { correlationId: ctx.correlationId }),
        };
        try {
          await auditSink.record(record);
        } catch {
          // Audit persistence must never block the tool loop.
        }
      }
    }
    return waitMs;
  }

  return {
    acquire,
    has(toolName) {
      return buckets.has(toolName);
    },
  };
}
