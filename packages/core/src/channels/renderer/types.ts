import type { ChannelCapabilities } from '../types.js';

/**
 * Runtime context handed to every platform renderer. Capabilities drive
 * capability-aware degradation; future slices may add a file-ref cache
 * (for Telegram `file_id` reuse) and locale hints here.
 */
export interface RendererContext {
  capabilities: ChannelCapabilities;
}
