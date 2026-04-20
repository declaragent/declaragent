/**
 * Process-local pending-RPC registry. Owned by the producer-side daemon:
 * every outbound `RequestAgent({ mode: 'sync' })` call registers here,
 * every inbound response envelope settles here.
 *
 * Bounded (default 10k) with LRU eviction on overflow. Capacity breaches
 * surface to the caller as an `RpcBusyError` so the LLM can back off.
 * Process shutdown aborts every pending entry with an `RpcAbandonedError`.
 *
 * @since 1.1.0
 */

import { RpcAbandonedError, RpcBusyError, RpcTimeoutError } from '@declaragent/core';
import type { RpcError } from '@declaragent/core';

export const DEFAULT_PENDING_CAPACITY = 10_000;

export type PendingSettleValue =
  | { status: 'ok'; data: unknown }
  | { status: 'error'; error: RpcError };

export interface PendingEntry {
  correlationId: string;
  deadlineMs: number;
  registeredAtMs: number;
}

export interface RegisterOptions {
  correlationId: string;
  /** Absolute ms-epoch deadline for the request. */
  deadlineMs: number;
}

/**
 * @since 1.1.0
 */
export interface PendingRegistry {
  /**
   * Return a promise that resolves when the correlation is settled. On
   * timeout, rejects with `RpcTimeoutError`. On `abandon()`, rejects with
   * `RpcAbandonedError`. On overflow, rejects synchronously via
   * `RpcBusyError`.
   */
  register(opts: RegisterOptions): Promise<PendingSettleValue>;
  /**
   * Settle a pending entry. Returns `true` if the correlation was
   * registered + live (i.e. the response is matched); `false` if no
   * entry exists (stale response).
   */
  settle(correlationId: string, value: PendingSettleValue): boolean;
  /** Reject every live entry with `RpcAbandonedError`. Used on shutdown. */
  abandon(): void;
  /** Current in-flight count. */
  size(): number;
}

export interface CreatePendingRegistryOptions {
  capacity?: number;
  /** Injected clock; production uses `Date.now`. */
  now?: () => number;
  /** Injected timer scheduler; production uses `setTimeout`/`clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface InternalEntry extends PendingEntry {
  resolve: (value: PendingSettleValue) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createPendingRegistry(opts: CreatePendingRegistryOptions = {}): PendingRegistry {
  const capacity = opts.capacity ?? DEFAULT_PENDING_CAPACITY;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

  if (capacity <= 0) {
    throw new Error('PendingRegistry capacity must be > 0');
  }

  const entries = new Map<string, InternalEntry>();

  function removeEntry(correlationId: string, entry: InternalEntry): void {
    entries.delete(correlationId);
    clearTimer(entry.timer);
  }

  function evictOldestIfAtCapacity(): boolean {
    if (entries.size < capacity) return false;
    // Map preserves insertion order; first key is the oldest.
    const iter = entries.keys().next();
    if (iter.done) return false;
    const oldest = entries.get(iter.value);
    if (!oldest) return false;
    removeEntry(iter.value, oldest);
    oldest.reject(new RpcBusyError(capacity));
    return true;
  }

  return {
    register({ correlationId, deadlineMs }): Promise<PendingSettleValue> {
      if (entries.has(correlationId)) {
        return Promise.reject(
          new Error(`pending-registry: correlationId ${correlationId} already registered`),
        );
      }

      // Reject eagerly on overflow rather than silently evicting a
      // live request. Callers decide retry/backoff policy.
      if (entries.size >= capacity) {
        evictOldestIfAtCapacity();
      }

      return new Promise<PendingSettleValue>((resolve, reject) => {
        const delay = Math.max(0, deadlineMs - now());
        const timer = setTimer(() => {
          const entry = entries.get(correlationId);
          if (!entry) return;
          entries.delete(correlationId);
          entry.reject(new RpcTimeoutError(correlationId, delay));
        }, delay);

        const entry: InternalEntry = {
          correlationId,
          deadlineMs,
          registeredAtMs: now(),
          resolve,
          reject,
          timer,
        };
        entries.set(correlationId, entry);
      });
    },

    settle(correlationId, value): boolean {
      const entry = entries.get(correlationId);
      if (!entry) return false;
      removeEntry(correlationId, entry);
      entry.resolve(value);
      return true;
    },

    abandon(): void {
      for (const [correlationId, entry] of entries.entries()) {
        clearTimer(entry.timer);
        entry.reject(new RpcAbandonedError(correlationId));
      }
      entries.clear();
    },

    size(): number {
      return entries.size;
    },
  };
}
