import type { Logger } from '../types/logger.js';
import type { PermissionGate } from '../types/permission.js';
import type {
  Extension,
  ExtensionContext,
  ExtensionDescriptor,
  ExtensionKind,
  ExtensionRegistry,
} from './types.js';

export interface CreateRegistryOptions {
  logger: Logger;
  permissions: PermissionGate;
  configDir: string;
}

export class ExtensionConflictError extends Error {
  readonly code = 'EEXTCONFLICT';
  constructor(
    public readonly id: string,
    public readonly existing: ExtensionDescriptor,
    public readonly incoming: ExtensionDescriptor,
  ) {
    super(
      `extension id "${id}" already registered by ${describeSource(existing.source)}; ` +
        `cannot register from ${describeSource(incoming.source)}`,
    );
  }
}

export class ExtensionNotFoundError extends Error {
  readonly code = 'ENOEXT';
  constructor(public readonly id: string) {
    super(`extension "${id}" is not registered`);
  }
}

function describeSource(source: ExtensionDescriptor['source']): string {
  switch (source.type) {
    case 'built-in':
      return 'built-in';
    case 'user':
      return 'user';
    case 'team':
      return `team(${source.path})`;
    case 'plugin':
      return `plugin(${source.pluginId}@${source.pluginVersion})`;
  }
}

interface Entry {
  ext: Extension;
  /** Insertion order — preserved across reload so byKind output is stable. */
  order: number;
}

export function createExtensionRegistry(options: CreateRegistryOptions): ExtensionRegistry {
  const entries = new Map<string, Entry>();
  let nextOrder = 0;

  const ctx: ExtensionContext = {
    // Filled in below — registry refers to itself.
    registry: undefined as unknown as ExtensionRegistry,
    logger: options.logger,
    permissions: options.permissions,
    configDir: options.configDir,
  };

  const registry: ExtensionRegistry = {
    async register(ext) {
      const { id } = ext.descriptor;
      const existing = entries.get(id);
      if (existing) {
        throw new ExtensionConflictError(id, existing.ext.descriptor, ext.descriptor);
      }
      await ext.activate(ctx);
      entries.set(id, { ext, order: nextOrder++ });
      options.logger.debug('extension.register', {
        id,
        kind: ext.descriptor.kind,
        source: ext.descriptor.source.type,
      });
    },

    async unregister(id) {
      const entry = entries.get(id);
      if (!entry) throw new ExtensionNotFoundError(id);
      try {
        await entry.ext.deactivate?.();
      } finally {
        entries.delete(id);
        options.logger.debug('extension.unregister', { id });
      }
    },

    list() {
      return sortedEntries(entries).map((e) => e.ext.descriptor);
    },

    byKind<K extends ExtensionKind>(kind: K): readonly Extension<K>[] {
      const out: Extension<K>[] = [];
      for (const e of sortedEntries(entries)) {
        if (e.ext.descriptor.kind === kind) {
          out.push(e.ext as Extension<K>);
        }
      }
      return out;
    },

    get(id) {
      return entries.get(id)?.ext;
    },

    async reload(id) {
      const entry = entries.get(id);
      if (!entry) throw new ExtensionNotFoundError(id);
      await entry.ext.deactivate?.();
      await entry.ext.activate(ctx);
      options.logger.debug('extension.reload', { id });
    },
  };

  ctx.registry = registry;
  return registry;
}

function sortedEntries(entries: Map<string, Entry>): Entry[] {
  return Array.from(entries.values()).sort((a, b) => a.order - b.order);
}
