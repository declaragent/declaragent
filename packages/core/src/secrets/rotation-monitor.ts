/**
 * Phase 6 slice-3 rotation monitor.
 *
 * Periodically polls every provider's `metadata()` for a caller-supplied
 * list of refs, compares `lastRotatedAt` to the configured thresholds,
 * and fires a callback for stale secrets. This is the "no live secret
 * has rotated in > N days" signal feeding `security.rules.yaml`
 * (`SecretRotationOverdue`).
 *
 * The monitor NEVER resolves secret values — only metadata. That keeps
 * the periodic poll from populating caches with plaintext and makes it
 * safe to run on a timer alongside the rest of the daemon.
 */

import type { TenantContext } from '../tenancy/types.js';
import { DEFAULT_TENANT_CONTEXT } from '../tenancy/types.js';
import type { Logger } from '../types/logger.js';
import type { SecretMetadata, SecretProvider } from './types.js';

export interface RotationMonitorOptions {
  /** Providers to poll. Typically the output of `loadSecretsConfig`. */
  providers: readonly SecretProvider[];
  /**
   * Paths to check per provider type. Keyed on `SecretProviderType`; the
   * values are the portion of a ref AFTER the type prefix (e.g.
   * `"secret/data/acme/kafka"` for a Vault ref).
   */
  watchList: Readonly<Record<string, readonly string[]>>;
  /** Poll interval. Default 1h. */
  checkIntervalMs?: number;
  /** Warn after this many days without rotation. Default 90. */
  warnAfterDays?: number;
  /** Error after this many days without rotation. Default 180. */
  errorAfterDays?: number;
  /** Tenant context handed to `metadata()`. */
  tenant?: TenantContext;
  /** Fired when a secret is past `warnAfterDays`. */
  onStale?: (event: RotationStaleEvent) => void;
  /** Fired when `metadata()` throws for a given ref. */
  onError?: (event: RotationErrorEvent) => void;
  logger?: Logger;
  /** Clock override for tests. */
  now?: () => number;
  /** Setter/clearer override for tests. */
  // biome-ignore lint/suspicious/noExplicitAny: interval handle type differs by runtime
  setInterval?: (fn: () => void, ms: number) => any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  clearInterval?: (handle: any) => void;
}

export interface RotationStaleEvent {
  providerType: string;
  providerName: string;
  ref: string;
  lastRotatedAt: number;
  ageDays: number;
  severity: 'warn' | 'error';
  metadata: SecretMetadata;
}

export interface RotationErrorEvent {
  providerType: string;
  providerName: string;
  ref: string;
  error: Error;
}

export interface RotationMonitorHandle {
  /** Run one poll cycle immediately. Useful for tests + manual operators. */
  check(): Promise<void>;
  /** Stop the periodic poll. */
  close(): void;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startRotationMonitor(options: RotationMonitorOptions): RotationMonitorHandle {
  const tenant = options.tenant ?? DEFAULT_TENANT_CONTEXT;
  const warnAfterMs = (options.warnAfterDays ?? 90) * MS_PER_DAY;
  const errorAfterMs = (options.errorAfterDays ?? 180) * MS_PER_DAY;
  const checkIntervalMs = options.checkIntervalMs ?? 3_600_000;
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;

  async function checkOne(provider: SecretProvider, refPath: string): Promise<void> {
    if (!provider.metadata) return;
    try {
      const metadata = await provider.metadata(refPath, {
        tenant,
        requester: 'rotation-monitor',
      });
      if (metadata.lastRotatedAt === undefined || metadata.lastRotatedAt === 0) return;
      const age = now() - metadata.lastRotatedAt;
      const ageDays = Math.floor(age / MS_PER_DAY);
      if (age >= errorAfterMs) {
        options.onStale?.({
          providerType: provider.type,
          providerName: provider.name,
          ref: `${provider.type}:${refPath}`,
          lastRotatedAt: metadata.lastRotatedAt,
          ageDays,
          severity: 'error',
          metadata,
        });
      } else if (age >= warnAfterMs) {
        options.onStale?.({
          providerType: provider.type,
          providerName: provider.name,
          ref: `${provider.type}:${refPath}`,
          lastRotatedAt: metadata.lastRotatedAt,
          ageDays,
          severity: 'warn',
          metadata,
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.logger?.warn('rotation-monitor.metadata.error', {
        providerType: provider.type,
        providerName: provider.name,
        ref: refPath,
        err: error.message,
      });
      options.onError?.({
        providerType: provider.type,
        providerName: provider.name,
        ref: `${provider.type}:${refPath}`,
        error,
      });
    }
  }

  async function check(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const provider of options.providers) {
      const paths = options.watchList[provider.type] ?? [];
      for (const p of paths) tasks.push(checkOne(provider, p));
    }
    await Promise.all(tasks);
  }

  const handle = setIntervalFn(() => {
    void check().catch((err: unknown) => {
      options.logger?.error('rotation-monitor.tick.error', {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, checkIntervalMs);
  // Node's setInterval returns a Timeout with unref(); Bun's is similar.
  // Don't hold the process open just for the monitor.
  (handle as { unref?: () => void }).unref?.();

  return {
    check,
    close() {
      clearIntervalFn(handle);
    },
  };
}
