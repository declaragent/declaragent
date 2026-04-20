/**
 * `fleet.yaml` loader.
 *
 *   - {@link findFleetRoot} walks up from a cwd looking for a fleet.yaml.
 *     Single-agent mode when nothing is found (back-compat — §1 "no fleet
 *     detection").
 *   - {@link loadFleet} parses + validates the manifest, flattens every
 *     environment's `inherit:` chain, resolves agent paths to absolutes,
 *     and enforces the `fleet.yaml.agents[].id == agent.yaml.name`
 *     invariant from §14.4.
 *
 * Tenants / secrets / channels are referenced but not loaded here —
 * slice 0 only populates `peers` + per-agent `capabilities` because the
 * aggregator needs them. Later slices will extend this loader.
 *
 * @since 1.2.0
 */

import { access, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  type LoadedCapabilities,
  type LoadedPeers,
  loadCapabilitiesConfig,
  loadPeersConfig,
} from '../rpc/index.js';
import {
  DEFAULT_FLEET_ENVIRONMENT_ID,
  type FleetEnvironment,
  type FleetEnvironmentOverride,
  type FleetManifest,
  FleetManifestError,
  fleetManifestSchema,
} from './manifest-schema.js';
import {
  FleetConfigError,
  type LoadedAgentEntry,
  type LoadedEnvironment,
  type LoadedFleet,
} from './types.js';

const FLEET_MANIFEST_FILENAME = 'fleet.yaml';

/**
 * Walk up from `cwd` looking for a `fleet.yaml`. Returns the absolute
 * path to the directory containing it, or `undefined` when the walk
 * reaches the filesystem root. Stops at the first match — nested fleets
 * are not supported (§11 touches the daemon not the loader).
 */
export async function findFleetRoot(cwd: string): Promise<string | undefined> {
  let dir = pathResolve(cwd);
  // Walk until `dirname` is a fixed point (`/` on POSIX, drive roots on Windows).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(dir, FLEET_MANIFEST_FILENAME);
    try {
      await access(candidate);
      return dir;
    } catch {
      // fall through
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadFleetOptions {
  /**
   * Absolute path to the fleet root (directory containing `fleet.yaml`).
   * Must be absolute — call {@link findFleetRoot} if you start from a cwd.
   */
  root: string;
  /**
   * When true, skip loading per-agent `capabilities.yaml` files even if
   * they exist. Useful for pure-manifest validation (§6.2 `fleet list`).
   */
  skipCapabilities?: boolean;
  /**
   * When true, skip loading `peers.yaml`. Default false — the aggregator
   * needs peers to resolve edges.
   */
  skipPeers?: boolean;
}

export async function loadFleet(options: LoadFleetOptions): Promise<LoadedFleet> {
  if (!isAbsolute(options.root)) {
    throw new FleetConfigError(`loadFleet: root must be absolute, got "${options.root}"`);
  }
  const root = options.root;
  const manifestPath = join(root, FLEET_MANIFEST_FILENAME);

  const manifest = await parseManifestFile(manifestPath);

  // 1. Resolve environments, flattening inherit chains. Every agent must
  //    reference one that resolves; cycles are rejected.
  const environments = resolveEnvironments(manifest, root);

  // 2. Validate + load each agent entry. We load agent.yaml's `name`
  //    field to enforce §14.4, and optionally load capabilities.yaml.
  const agents: LoadedAgentEntry[] = [];
  const agentsById = new Map<string, LoadedAgentEntry>();
  const seenIds = new Set<string>();
  for (const entry of manifest.agents) {
    if (seenIds.has(entry.id)) {
      throw new FleetConfigError(`duplicate agent id "${entry.id}" in fleet.yaml`);
    }
    seenIds.add(entry.id);

    const agentPath = resolveUnderRoot(root, entry.path);
    await assertDirectory(agentPath, `agent "${entry.id}" path`);

    const agentYamlPath = join(agentPath, 'agent.yaml');
    const name = await readAgentName(agentYamlPath, entry.id);
    if (name !== entry.id) {
      throw new FleetConfigError(
        `agent id mismatch: fleet.yaml declares "${entry.id}" but ${agentYamlPath} has name "${name}" (see FLEET_PLAN.md §14.4)`,
      );
    }

    const envId = entry.env ?? DEFAULT_FLEET_ENVIRONMENT_ID;
    if (!environments.has(envId)) {
      throw new FleetConfigError(
        `agent "${entry.id}" references environment "${envId}" which is not declared in fleet.yaml`,
      );
    }

    let capabilities: LoadedCapabilities | undefined;
    if (!options.skipCapabilities) {
      capabilities = await maybeLoadCapabilities(agentPath, entry.id);
    }

    // Validate deploy.target resolves to a declared target.
    if (entry.deploy) {
      const targets = manifest.deploy?.targets ?? {};
      if (!Object.hasOwn(targets, entry.deploy.target)) {
        throw new FleetConfigError(
          `agent "${entry.id}" deploys to target "${entry.deploy.target}" which is not declared in deploy.targets{}`,
        );
      }
    }

    const loaded: LoadedAgentEntry = {
      id: entry.id,
      path: agentPath,
      agentYamlPath,
      name,
      entry,
      env: envId,
      ...(capabilities !== undefined && { capabilities }),
    };
    agents.push(loaded);
    agentsById.set(loaded.id, loaded);
  }

  // 3. Optional fleet-level peers load. We use the first env that
  //    declares a `peersRef` — the manifest can point multiple envs at
  //    the same file, but in slice 0 we aggregate a single fleet-level
  //    peer table. Per-env peer tables land in a later slice.
  let peers: LoadedPeers | undefined;
  if (!options.skipPeers) {
    peers = await loadFleetPeers(environments);
  }

  return {
    manifest,
    root,
    manifestPath,
    agents,
    agentsById,
    environments,
    ...(peers !== undefined && { peers }),
  };
}

// ── Internals ──────────────────────────────────────────────────────────

async function parseManifestFile(path: string): Promise<FleetManifest> {
  let rawText: string;
  try {
    rawText = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FleetManifestError(`no fleet manifest at ${path}`);
    }
    throw err;
  }

  const ext = extname(path).toLowerCase();
  let parsed: unknown;
  try {
    parsed = ext === '.json' ? JSON.parse(rawText) : parseYaml(rawText);
  } catch (err) {
    throw new FleetManifestError(
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = fleetManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new FleetManifestError(
      `fleet manifest validation failed: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

function resolveEnvironments(
  manifest: FleetManifest,
  root: string,
): Map<string, LoadedEnvironment> {
  const declared = manifest.environments;

  if (!declared || Object.keys(declared).length === 0) {
    // Implicit default environment — no shared configs, no overrides.
    const env: LoadedEnvironment = {
      id: DEFAULT_FLEET_ENVIRONMENT_ID,
      envFiles: [],
      overrides: new Map(),
      inheritChain: [DEFAULT_FLEET_ENVIRONMENT_ID],
    };
    return new Map([[DEFAULT_FLEET_ENVIRONMENT_ID, env]]);
  }

  // DFS-flatten each environment. Cycles are rejected.
  const resolved = new Map<string, LoadedEnvironment>();
  for (const id of Object.keys(declared)) {
    if (resolved.has(id)) continue;
    flattenEnvironment(id, declared, root, resolved, new Set());
  }
  return resolved;
}

function flattenEnvironment(
  id: string,
  declared: Record<string, FleetEnvironment>,
  root: string,
  resolved: Map<string, LoadedEnvironment>,
  visiting: Set<string>,
): LoadedEnvironment {
  const cached = resolved.get(id);
  if (cached) return cached;
  if (visiting.has(id)) {
    throw new FleetConfigError(
      `environment "${id}" has a circular inherit chain: ${[...visiting, id].join(' → ')}`,
    );
  }
  const raw = declared[id];
  if (!raw) {
    throw new FleetConfigError(`unknown environment "${id}"`);
  }
  visiting.add(id);

  let parent: LoadedEnvironment | undefined;
  if (raw.inherit) {
    if (!Object.hasOwn(declared, raw.inherit)) {
      throw new FleetConfigError(
        `environment "${id}" inherits from unknown environment "${raw.inherit}"`,
      );
    }
    parent = flattenEnvironment(raw.inherit, declared, root, resolved, visiting);
  }

  const tenantsRef =
    raw.tenantsRef !== undefined ? resolveUnderRoot(root, raw.tenantsRef) : parent?.tenantsRef;
  const peersRef =
    raw.peersRef !== undefined ? resolveUnderRoot(root, raw.peersRef) : parent?.peersRef;
  const secretsRef =
    raw.secretsRef !== undefined ? resolveUnderRoot(root, raw.secretsRef) : parent?.secretsRef;
  const channelsRef =
    raw.channelsRef !== undefined ? resolveUnderRoot(root, raw.channelsRef) : parent?.channelsRef;

  const envFiles =
    raw.envFiles !== undefined
      ? raw.envFiles.map((p) => resolveUnderRoot(root, p))
      : (parent?.envFiles ?? []);

  const overrides = new Map<string, FleetEnvironmentOverride>(parent?.overrides ?? new Map());
  if (raw.overrides) {
    for (const [agentId, ov] of Object.entries(raw.overrides)) {
      overrides.set(agentId, ov);
    }
  }

  const inheritChain = parent ? [...parent.inheritChain, id] : [id];

  const loaded: LoadedEnvironment = {
    id,
    ...(tenantsRef !== undefined && { tenantsRef }),
    ...(peersRef !== undefined && { peersRef }),
    ...(secretsRef !== undefined && { secretsRef }),
    ...(channelsRef !== undefined && { channelsRef }),
    envFiles,
    overrides,
    inheritChain,
  };
  visiting.delete(id);
  resolved.set(id, loaded);
  return loaded;
}

async function readAgentName(agentYamlPath: string, agentId: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(agentYamlPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FleetConfigError(`agent "${agentId}" has no agent.yaml at ${agentYamlPath}`);
    }
    throw err;
  }

  const ext = extname(agentYamlPath).toLowerCase();
  let parsed: unknown;
  try {
    parsed = ext === '.json' ? JSON.parse(raw) : parseYaml(raw);
  } catch (err) {
    throw new FleetConfigError(
      `agent "${agentId}" agent.yaml is not valid YAML/JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Only the `name` field matters here — the full agent.yaml schema lives
  // elsewhere. A shallow parse keeps slice 0 independent of the full loader.
  const schema = z.object({ name: z.string().min(1) }).passthrough();
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new FleetConfigError(
      `agent "${agentId}" agent.yaml missing required "name" field (${agentYamlPath})`,
    );
  }
  return result.data.name;
}

async function maybeLoadCapabilities(
  agentPath: string,
  agentId: string,
): Promise<LoadedCapabilities | undefined> {
  for (const name of ['capabilities.yaml', 'capabilities.yml', 'capabilities.json']) {
    const p = join(agentPath, name);
    try {
      await access(p);
    } catch {
      continue;
    }
    const loaded = await loadCapabilitiesConfig(p);
    if (loaded.config.agent !== `agent://${agentId}`) {
      throw new FleetConfigError(
        `agent "${agentId}" capabilities.yaml declares agent "${loaded.config.agent}" — expected "agent://${agentId}"`,
      );
    }
    return loaded;
  }
  return undefined;
}

async function loadFleetPeers(
  environments: ReadonlyMap<string, LoadedEnvironment>,
): Promise<LoadedPeers | undefined> {
  // Pick the first env that declares a peersRef. Slice 0 aggregates one
  // fleet-level peer table; per-env peer tables are a future slice.
  const seen = new Set<string>();
  for (const env of environments.values()) {
    if (env.peersRef === undefined || seen.has(env.peersRef)) continue;
    seen.add(env.peersRef);
    // An ENOENT on a referenced peers file propagates as a real fleet
    // config error — we don't swallow it to a "no peers" silent path.
    return await loadPeersConfig(env.peersRef);
  }
  return undefined;
}

function resolveUnderRoot(root: string, p: string): string {
  return isAbsolute(p) ? p : pathResolve(root, p);
}

async function assertDirectory(p: string, label: string): Promise<void> {
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FleetConfigError(`${label} does not exist: ${p}`);
    }
    throw err;
  }
  if (!s.isDirectory()) {
    throw new FleetConfigError(`${label} is not a directory: ${p}`);
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

// Helper re-exports for tests that want the defaults.
export { FLEET_MANIFEST_FILENAME };
