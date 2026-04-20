import type { ChannelInstance, ChannelRegistry } from './types.js';

export class ChannelRegistryError extends Error {
  constructor(
    message: string,
    readonly code: 'duplicate-id' | 'not-found',
  ) {
    super(message);
    this.name = 'ChannelRegistryError';
  }
}

/**
 * Default in-memory `ChannelRegistry`. Keyed by `ChannelInstance.id`;
 * adapters that allow multiple instances of the same `type` (two Telegram
 * bots, two Slack workspaces) register under distinct ids. The registry
 * is passive — it does not start or stop instances; the daemon owns the
 * lifecycle.
 */
export function createChannelRegistry(): ChannelRegistry {
  const instances = new Map<string, ChannelInstance>();

  return {
    register(instance: ChannelInstance): void {
      if (instances.has(instance.id)) {
        throw new ChannelRegistryError(
          `channel id '${instance.id}' is already registered`,
          'duplicate-id',
        );
      }
      instances.set(instance.id, instance);
    },
    unregister(id: string): void {
      instances.delete(id);
    },
    get(id: string): ChannelInstance | undefined {
      return instances.get(id);
    },
    list(): readonly ChannelInstance[] {
      return Array.from(instances.values());
    },
  };
}
