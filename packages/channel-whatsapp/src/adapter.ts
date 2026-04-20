import type { ChannelAdapter, ChannelDependencies, ChannelInstance } from '@declaragent/core';
import { WHATSAPP_CAPABILITIES } from './capabilities.js';
import type { WhatsAppClient } from './client.js';
import { type WhatsAppChannelConfig, assertWhatsAppConfig } from './config.js';
import { WhatsAppChannelInstance, type WhatsAppFileCache } from './instance.js';

export interface WhatsAppAdapterOptions {
  /** Test seam: supply a pre-built `WhatsAppClient` stub. */
  client?: WhatsAppClient;
  /** Test seam: factory override. Overrides `client` when the adapter creates more than one instance. */
  createClient?(config: WhatsAppChannelConfig, deps: ChannelDependencies): WhatsAppClient;
  /** Test seam: optional media cache. */
  fileCache?: WhatsAppFileCache;
  /** Injected clock (deterministic tests). */
  now?: () => number;
}

/**
 * WhatsApp channel adapter. Registered under `type: 'whatsapp'`.
 * Produces a `WhatsAppChannelInstance` per configured entry.
 */
export function createWhatsAppAdapter(
  opts: WhatsAppAdapterOptions = {},
): ChannelAdapter<WhatsAppChannelConfig> {
  return {
    type: 'whatsapp',
    agentCompat: '>=0.0.1',
    capabilities: WHATSAPP_CAPABILITIES,
    validateConfig(cfg: unknown): asserts cfg is WhatsAppChannelConfig {
      assertWhatsAppConfig(cfg);
    },
    async create(cfg: WhatsAppChannelConfig, deps: ChannelDependencies): Promise<ChannelInstance> {
      const client = opts.client ?? opts.createClient?.(cfg, deps);
      const instanceOpts: ConstructorParameters<typeof WhatsAppChannelInstance>[0] = {
        config: cfg,
        deps,
      };
      if (client !== undefined) instanceOpts.client = client;
      if (opts.fileCache !== undefined) instanceOpts.fileCache = opts.fileCache;
      if (opts.now !== undefined) instanceOpts.now = opts.now;
      return new WhatsAppChannelInstance(instanceOpts);
    },
  };
}

/** Default adapter instance. */
export const whatsappAdapter = createWhatsAppAdapter();
