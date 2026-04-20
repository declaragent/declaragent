/**
 * `fleet.yaml` v1 Zod schema — the manifest for a multi-agent monorepo.
 *
 * Declares the agents in the fleet, their environments, shared config
 * references (tenants / peers / secrets / channels), and deploy targets.
 * Every fleet-aware CLI verb reads this.
 *
 * See `docs/FLEET_PLAN.md` §3 for the field-by-field rationale. Strict
 * mode is enabled on every object — unknown keys fail load rather than
 * silently no-op.
 *
 * @since 1.2.0
 */

import { z } from 'zod';

export class FleetManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetManifestError';
  }
}

// ── Agent entry ────────────────────────────────────────────────────────

const agentIdPattern = /^[a-z0-9][a-z0-9_-]*$/i;

const agentDeploySchema = z
  .object({
    /** Key into `deploy.targets{}`. Validated at load time. */
    target: z.string().min(1),
    minInstances: z.number().int().nonnegative().optional(),
    maxInstances: z.number().int().positive().optional(),
  })
  .strict();

const agentEntrySchema = z
  .object({
    /**
     * Must match `agents/<id>/agent.yaml.name`. §14.4 — one source of
     * truth across envelopes, audit records, logs, and metrics.
     */
    id: z.string().min(1).regex(agentIdPattern, 'agent id must be URL-safe'),
    /** Directory containing `agent.yaml`, relative to the fleet root. */
    path: z.string().min(1),
    /**
     * Environment key. Must resolve to an entry in `environments{}`.
     * When the manifest omits `environments`, the implicit `default`
     * environment is used and every agent's `env` must equal `default`.
     */
    env: z.string().min(1).optional(),
    deploy: agentDeploySchema.optional(),
    /** Per-agent session DB override (§14.2). Relative to fleet root. */
    sessionDb: z.string().min(1).optional(),
    /** Per-agent audit DB override (§14.2). Relative to fleet root. */
    auditDb: z.string().min(1).optional(),
  })
  .strict();

// ── Environment ────────────────────────────────────────────────────────

const environmentOverrideSchema = z
  .object({
    /** Fleet-root `secrets.yaml` scopes the agent is allowed to see. */
    secretScopes: z.array(z.string().min(1)).optional(),
    /** Override the env files for this agent in this environment. */
    envFiles: z.array(z.string().min(1)).optional(),
  })
  .strict();

const environmentSchema = z
  .object({
    /**
     * Inherit all fields from another environment. Overrides compose on
     * top of the inherited environment. Cycles are rejected.
     */
    inherit: z.string().min(1).optional(),
    tenantsRef: z.string().min(1).optional(),
    peersRef: z.string().min(1).optional(),
    secretsRef: z.string().min(1).optional(),
    channelsRef: z.string().min(1).optional(),
    /** `.env` files injected into every agent in the environment. */
    envFiles: z.array(z.string().min(1)).optional(),
    /** Per-agent overrides keyed on agent id. */
    overrides: z.record(z.string(), environmentOverrideSchema).optional(),
  })
  .strict();

// ── Deploy ─────────────────────────────────────────────────────────────

const deployStrategySchema = z.enum(['rolling', 'all-or-nothing', 'per-agent']);

const deployHealthGateSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    probe: z.string().min(1).optional(),
  })
  .strict();

/**
 * Deploy target config. Kept open (`passthrough`) — per-target adapters
 * validate their own additional fields in slice 5.
 */
const deployTargetSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();

const deploySchema = z
  .object({
    strategy: deployStrategySchema.optional(),
    rollbackOnFailure: z.boolean().optional(),
    healthGate: deployHealthGateSchema.optional(),
    targets: z.record(z.string(), deployTargetSchema).optional(),
  })
  .strict();

// ── RPC knobs ──────────────────────────────────────────────────────────

const rpcSchema = z
  .object({
    /** §14.8 — opt-in `x-fleet-version` envelope header stamping. */
    stampFleetVersion: z.boolean().optional(),
    /** Receiver-side gate; rejects callers older than this version. */
    minFleetVersion: z.string().min(1).optional(),
  })
  .strict();

// ── Runtime pin ────────────────────────────────────────────────────────

const runtimeSchema = z
  .object({
    declaragent: z.string().min(1).optional(),
    bun: z.string().min(1).optional(),
  })
  .strict();

// ── Top level ──────────────────────────────────────────────────────────

export const fleetManifestSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    description: z.string().optional(),
    runtime: runtimeSchema.optional(),
    /**
     * Zero agents is valid — `declaragent init --fleet` scaffolds an
     * empty manifest that `declaragent fleet add` populates. `fleet
     * validate` emits an informational finding when the list is empty
     * (slice 1 does not enforce > 0).
     */
    agents: z.array(agentEntrySchema),
    environments: z.record(z.string(), environmentSchema).optional(),
    deploy: deploySchema.optional(),
    rpc: rpcSchema.optional(),
  })
  .strict();

export type FleetManifest = z.infer<typeof fleetManifestSchema>;
export type FleetAgentEntry = z.infer<typeof agentEntrySchema>;
export type FleetEnvironment = z.infer<typeof environmentSchema>;
export type FleetEnvironmentOverride = z.infer<typeof environmentOverrideSchema>;
export type FleetDeploy = z.infer<typeof deploySchema>;
export type FleetDeployTargetConfig = z.infer<typeof deployTargetSchema>;
export type FleetDeployStrategy = z.infer<typeof deployStrategySchema>;
export type FleetDeployHealthGate = z.infer<typeof deployHealthGateSchema>;
export type FleetRpcConfig = z.infer<typeof rpcSchema>;
export type FleetRuntimePin = z.infer<typeof runtimeSchema>;

/** Implicit environment used when the manifest omits `environments{}`. */
export const DEFAULT_FLEET_ENVIRONMENT_ID = 'default';
