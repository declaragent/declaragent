import type { ChaosTargetRuntime } from '../types.js';

/**
 * Phase 6 slice-7 `partition-channel` fault.
 *
 * Prevents a channel adapter from reaching its platform (Slack,
 * Discord, WhatsApp, etc.) for a window. Implementation-wise the
 * usual test pattern is to flip a flag that the adapter's outbound
 * path checks + throws on; production deployments shell out to
 * network-layer tooling to drop outbound traffic.
 */

export interface ChannelPartitioner {
  partition(channelId: string, durationMs: number): Promise<void>;
}

export interface PartitionChannelFaultOptions {
  partitioner: ChannelPartitioner;
}

export function createPartitionChannelFault(
  opts: PartitionChannelFaultOptions,
): Required<Pick<ChaosTargetRuntime, 'partitionChannel'>> {
  async function partitionChannel(channelId: string, durationMs: number): Promise<void> {
    await opts.partitioner.partition(channelId, durationMs);
  }
  return { partitionChannel };
}

/** In-memory partitioner — same pattern as `InMemoryBrokerPartitioner`. */
export class InMemoryChannelPartitioner implements ChannelPartitioner {
  private readonly partitioned = new Set<string>();

  isPartitioned(channelId: string): boolean {
    return this.partitioned.has(channelId);
  }

  async partition(channelId: string, durationMs: number): Promise<void> {
    this.partitioned.add(channelId);
    try {
      await new Promise<void>((r) => setTimeout(r, durationMs));
    } finally {
      this.partitioned.delete(channelId);
    }
  }
}
