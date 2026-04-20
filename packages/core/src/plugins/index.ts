export { consentedPermissionRules } from './consent.js';
export { loadPlugin } from './loader.js';
export type { LoadPluginOptions } from './loader.js';
export {
  PluginManifestSchema,
  loadPluginManifest,
  parsePluginManifest,
} from './manifest.js';
export {
  DEFAULT_PLUGIN_STORE_FILE,
  createPluginStore,
} from './store.js';
export type { PluginStore } from './store.js';
export {
  PluginActivationError,
  PluginManifestError,
} from './types.js';
export type {
  PluginActivation,
  PluginManifest,
  PluginMCPServerSpec,
  PluginStoreEntry,
  PluginStoreShape,
} from './types.js';
