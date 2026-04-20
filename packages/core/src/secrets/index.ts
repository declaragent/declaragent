export type {
  SecretAccessAuditRecord,
  SecretAuditSink,
  SecretMetadata,
  SecretProvider,
  SecretProviderType,
  SecretResolveContext,
} from './types.js';
export { createEnvSecretProvider } from './providers/env.js';
export type { EnvSecretProviderOptions } from './providers/env.js';
export { createVaultProvider } from './providers/vault.js';
export type {
  VaultAppRoleAuth,
  VaultAuth,
  VaultProviderOptions,
  VaultTokenAuth,
} from './providers/vault.js';
export { createAwsSmProvider } from './providers/aws-sm.js';
export type {
  AwsCredentials,
  AwsSmProviderOptions,
} from './providers/aws-sm.js';
export { createGcpSmProvider } from './providers/gcp-sm.js';
export type { GcpSmProviderOptions } from './providers/gcp-sm.js';
export { createK8sProvider } from './providers/k8s.js';
export type { K8sProviderOptions } from './providers/k8s.js';
export {
  SecretsConfigError,
  loadSecretsConfig,
  rotationMonitorConfigSchema,
} from './config-loader.js';
export type {
  LoadSecretsOptions,
  LoadSecretsResult,
  ProviderConfig,
  RotationMonitorConfig,
  SecretsConfig,
} from './config-loader.js';
export { startRotationMonitor } from './rotation-monitor.js';
export type {
  RotationErrorEvent,
  RotationMonitorHandle,
  RotationMonitorOptions,
  RotationStaleEvent,
} from './rotation-monitor.js';
export { createTtlCache } from './ttl-cache.js';
export type { TtlCache, TtlCacheOptions } from './ttl-cache.js';
