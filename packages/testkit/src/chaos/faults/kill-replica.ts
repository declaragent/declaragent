import type { ChaosTargetRuntime } from '../types.js';

/**
 * Phase 6 slice-7 `kill-replica` fault.
 *
 * Pure in-process test helper: callers register replica handles (each
 * exposing an async `shutdown`) and the fault looks them up by id.
 * For real infrastructure (Kubernetes pod-kill, Docker Compose stop),
 * swap in a {@link ReplicaKiller} that shells out to `kubectl` /
 * `docker`.
 *
 * Keeping the interface narrow (one `killReplica(id)` call) lets the
 * driver stay infrastructure-free and lets tests verify the
 * orchestration without actually tearing down processes.
 */

export interface ReplicaKiller {
  kill(replicaId: string): Promise<void>;
}

export interface KillReplicaFaultOptions {
  killer: ReplicaKiller;
  /** Fired after the kill so tests can assert visible effects. */
  onKilled?: (replicaId: string) => void;
}

export function createKillReplicaFault(
  opts: KillReplicaFaultOptions,
): Required<Pick<ChaosTargetRuntime, 'killReplica'>> {
  async function killReplica(replicaId: string): Promise<void> {
    await opts.killer.kill(replicaId);
    opts.onKilled?.(replicaId);
  }
  return { killReplica };
}

/**
 * In-memory registry of replicas. Lets tests register pseudo-replicas
 * with `shutdown` hooks; the fault looks them up by id and drives
 * their shutdown.
 */
export class InMemoryReplicaKiller implements ReplicaKiller {
  private readonly replicas = new Map<string, () => Promise<void>>();

  register(replicaId: string, shutdown: () => Promise<void>): void {
    this.replicas.set(replicaId, shutdown);
  }

  async kill(replicaId: string): Promise<void> {
    const shutdown = this.replicas.get(replicaId);
    if (!shutdown) throw new Error(`kill-replica: unknown replica id "${replicaId}"`);
    await shutdown();
    this.replicas.delete(replicaId);
  }
}
