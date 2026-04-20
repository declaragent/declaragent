import type { ChaosTargetRuntime } from '../types.js';

/**
 * Phase 6 slice-7 `partition-broker` fault.
 *
 * Drops network to/from a broker for a window. For in-process runs
 * (Redpanda via Docker Compose) the default partitioner shells out to
 * `docker network disconnect` / `connect`. Callers can also supply an
 * in-memory `BrokerPartitioner` that stubs the disconnect + reconnect
 * hooks for unit tests.
 */

export interface BrokerPartitioner {
  partition(broker: string, durationMs: number): Promise<void>;
}

export interface PartitionBrokerFaultOptions {
  partitioner: BrokerPartitioner;
}

export function createPartitionBrokerFault(
  opts: PartitionBrokerFaultOptions,
): Required<Pick<ChaosTargetRuntime, 'partitionBroker'>> {
  async function partitionBroker(broker: string, durationMs: number): Promise<void> {
    await opts.partitioner.partition(broker, durationMs);
  }
  return { partitionBroker };
}

/**
 * Test partitioner — toggles a flag for `durationMs`. Consumers that
 * want to observe the window check `isPartitioned(broker)` before
 * attempting a broker operation.
 */
export class InMemoryBrokerPartitioner implements BrokerPartitioner {
  private readonly partitioned = new Set<string>();

  isPartitioned(broker: string): boolean {
    return this.partitioned.has(broker);
  }

  async partition(broker: string, durationMs: number): Promise<void> {
    this.partitioned.add(broker);
    try {
      await new Promise<void>((r) => setTimeout(r, durationMs));
    } finally {
      this.partitioned.delete(broker);
    }
  }
}
