/**
 * Fleet — the v1.2 multi-agent monorepo shape. See `docs/FLEET_PLAN.md`.
 *
 * @since 1.2.0
 */

export {
  DEFAULT_FLEET_ENVIRONMENT_ID,
  FleetManifestError,
  fleetManifestSchema,
} from './manifest-schema.js';
export type {
  FleetAgentEntry,
  FleetDeploy,
  FleetDeployHealthGate,
  FleetDeployStrategy,
  FleetDeployTargetConfig,
  FleetEnvironment,
  FleetEnvironmentOverride,
  FleetHost,
  FleetHostAuth,
  FleetManifest,
  FleetRpcConfig,
  FleetRuntimePin,
} from './manifest-schema.js';
export { FLEET_MANIFEST_FILENAME, findFleetRoot, loadFleet } from './manifest-loader.js';
export type { LoadFleetOptions } from './manifest-loader.js';
export { FleetConfigError } from './types.js';
export type { LoadedAgentEntry, LoadedEnvironment, LoadedFleet } from './types.js';
export { aggregateCapabilities, aggregatePeers } from './aggregator.js';
export type {
  AggregatedCapability,
  AggregatedCapabilityTable,
  AggregatedPeerEntry,
  AggregatedPeerReport,
} from './aggregator.js';
export {
  FLEET_VERSION_ENV,
  FLEET_VERSION_HEADER,
  checkFleetVersionSkew,
  compareFleetVersions,
  injectFleetVersionEnv,
  parseFleetVersion,
  readFleetVersionFromEnv,
  readFleetVersionHeader,
  stampFleetVersionHeader,
} from './version-skew.js';
export type {
  FleetVersionSkewInput,
  FleetVersionSkewResult,
  FleetVersionSkewStatus,
  ParsedFleetVersion,
} from './version-skew.js';
