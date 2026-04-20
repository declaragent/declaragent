export {
  ExtensionConflictError,
  ExtensionNotFoundError,
  createExtensionRegistry,
} from './registry.js';
export type { CreateRegistryOptions } from './registry.js';
export { toolExtension } from './tool-extension.js';
export type {
  Extension,
  ExtensionContext,
  ExtensionDescriptor,
  ExtensionKind,
  ExtensionPayloads,
  ExtensionRegistry,
  ExtensionSource,
} from './types.js';
