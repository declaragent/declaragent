/**
 * Runtime-loaded fleet shapes.
 *
 * `loadFleet()` returns a `LoadedFleet` — the parsed manifest plus every
 * environment resolved (with `inherit` applied), agent paths made absolute,
 * and per-agent `agent.yaml.name` validated against the manifest's `id`
 * (§14.4).
 *
 * Heavy shared configs (`tenants.yaml`, `secrets.yaml`, etc.) are loaded
 * lazily — slice 0 populates `peers` + per-agent `capabilities` because the
 * aggregator depends on them; later slices wire tenants/secrets/channels
 * once the loader + daemon paths actually consume them.
 *
 * @since 1.2.0
 */

import type { LoadedCapabilities, LoadedPeers } from '../rpc/index.js';
import type {
  FleetAgentEntry,
  FleetEnvironment,
  FleetEnvironmentOverride,
  FleetManifest,
} from './manifest-schema.js';

export class FleetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetConfigError';
  }
}

/**
 * An environment after `inherit:` chains have been flattened. Fields
 * from the parent env appear here, overridden by the child's own values.
 */
export interface LoadedEnvironment {
  readonly id: string;
  /** Absolute paths, resolved relative to the fleet root. */
  readonly tenantsRef?: string;
  readonly peersRef?: string;
  readonly secretsRef?: string;
  readonly channelsRef?: string;
  readonly envFiles: readonly string[];
  /** Merged per-agent overrides — parent entries replaced by child wins. */
  readonly overrides: ReadonlyMap<string, FleetEnvironmentOverride>;
  /**
   * Names of the environments that were flattened into this one, in
   * oldest → newest order. Always ends with `id`. Useful for error
   * messages ("inherited from shared").
   */
  readonly inheritChain: readonly string[];
}

export interface LoadedAgentEntry {
  readonly id: string;
  /** Absolute path to the agent directory. */
  readonly path: string;
  /** Absolute path to `<path>/agent.yaml`. */
  readonly agentYamlPath: string;
  /** Name read from `agent.yaml`. Always equal to `id` after validation. */
  readonly name: string;
  readonly entry: FleetAgentEntry;
  readonly env: string;
  readonly capabilities?: LoadedCapabilities;
}

export interface LoadedFleet {
  readonly manifest: FleetManifest;
  /** Absolute path to the fleet root (the dir containing `fleet.yaml`). */
  readonly root: string;
  /** Absolute path to `<root>/fleet.yaml`. */
  readonly manifestPath: string;
  readonly agents: readonly LoadedAgentEntry[];
  readonly agentsById: ReadonlyMap<string, LoadedAgentEntry>;
  readonly environments: ReadonlyMap<string, LoadedEnvironment>;
  /** Loaded when any environment in use resolves `peersRef` to a readable file. */
  readonly peers?: LoadedPeers;
}

export type { FleetEnvironment };
