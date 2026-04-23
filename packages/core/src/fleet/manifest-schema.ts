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

/**
 * Slice 8 of 0.6.0 adds `'canary'`: deploy the FIRST agent in the plan,
 * soak for {@link canaryWaitMs}, re-run health checks, then deploy the
 * rest only if the canary stays healthy. On canary failure every
 * deployed agent rolls back.
 */
const deployStrategySchema = z.enum(['rolling', 'all-or-nothing', 'per-agent', 'canary']);

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

// ── Hosts (CONTROL_PLANE_PLAN.md Slice 3) ──────────────────────────────

/**
 * One remote `up` host's HTTP control-plane endpoint. When a fleet has
 * one or more `hosts[]`, the CLI verbs `fleet ps / events / dlq / logs`
 * fan out across every host's `/status`, `/events`, `/dlq`, `/logs`
 * endpoints and merge results. Back-compat: no `hosts:` block → local
 * single-host behaviour (unchanged).
 *
 * Secret references use the same `env:NAME` / `file:/path` syntax as
 * the rest of the control-plane config. Plain strings are treated as
 * literal tokens — fine for dev, discouraged for checked-in manifests.
 *
 * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #50
 */
const fleetHostAuthSchema = z
  .object({
    /**
     * Bearer token for the `Authorization: Bearer <token>` header.
     * Supports `env:NAME`, `file:/abs/path`, or a literal string.
     */
    bearer: z.string().min(1),
  })
  .strict();

const fleetHostSchema = z
  .object({
    /** Operator-chosen host identifier. Must be URL-safe — used in `--host <name>`. */
    name: z.string().min(1).regex(agentIdPattern, 'host name must be URL-safe'),
    /**
     * Base URL of the remote `up` process's control-plane HTTP listener
     * (the port bound by `observability.metricsPort`, default 9464).
     * Include scheme — `http://` for loopback or behind a trusted proxy,
     * `https://` when the remote is TLS-terminated.
     */
    url: z.string().url(),
    auth: fleetHostAuthSchema.optional(),
    /** Per-request timeout in ms. Default 5000. */
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export type FleetHost = z.infer<typeof fleetHostSchema>;
export type FleetHostAuth = z.infer<typeof fleetHostAuthSchema>;

// ── Fleet-level controlPlane (POST_ENTERPRISE_BACKLOG.md #17) ──────────

/**
 * Fleet-level `controlPlane:` block. Governs HOW EACH HOST exposes its
 * in-process control-plane HTTP listener (the port bound by `up` +
 * served to cross-host fan-out clients). This is distinct from
 * `hosts[]` (which is what the CLI fans OUT *to*): `hosts[]` is the
 * client-side address book; `controlPlane:` is the server-side config
 * that every agent on this fleet's hosts boots with.
 *
 * Precedence (#17):
 *   1. `fleet.yaml#controlPlane` present → ALL agents on each host
 *      share this config. Per-agent `agent.yaml#controlPlane` is
 *      ignored with a deprecation warning (one per conflicting agent).
 *   2. `fleet.yaml#controlPlane` absent → fall back to the per-agent
 *      path: `up-cli` picks the FIRST agent with `controlPlane.auth.enabled`
 *      and warns about any others. (Legacy 0.7.x behaviour.)
 *
 * Shape mirrors `agent.yaml#controlPlane` so operators don't learn a
 * new schema. The auth block accepts the same discriminated union
 * (`enabled: false` / oidc / oauth2-client) as `agent.yaml`. We keep
 * it `passthrough()` here — the authoritative shape still lives in
 * `load-agent.ts`; the CLI validates the narrower discriminant on
 * consumption (see `resolveFleetControlPlaneAuth`). That indirection
 * keeps the fleet schema independent of the agent schema module.
 *
 * @since 0.7.5 — POST_ENTERPRISE_BACKLOG.md #17
 */
const fleetControlPlaneSchema = z
  .object({
    /**
     * Bind address hint for the in-process HTTP listener. Matches the
     * `observability.bindAddress` knob in `agent.yaml`. When omitted,
     * `up` binds `127.0.0.1` unless auth is enabled (which relaxes to
     * accept non-loopback Host headers per `up-cli.ts`'s existing
     * `allowRemote` branch). This field is advisory at the schema
     * layer; the CLI is the source of truth for bind semantics.
     */
    bindAddress: z.string().min(1).optional(),
    /**
     * Per-request idle timeout override for the control-plane listener.
     * Mirrors `observability.idleTimeout`. Streaming routes (`/logs`)
     * always bypass this (see `STREAMING_ROUTE_PATHS`).
     */
    idleTimeout: z.number().int().nonnegative().optional(),
    /**
     * Same shape as `agent.yaml#controlPlane.auth` — accepts the
     * discriminated union `{ enabled: false } | oidc | oauth2-client`.
     * Kept `passthrough()` so the fleet loader doesn't duplicate the
     * agent-yaml auth schema; the consumer (`up-cli.ts`) runs it
     * through the same narrowing the agent loader uses.
     */
    auth: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type FleetControlPlane = z.infer<typeof fleetControlPlaneSchema>;

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
    /**
     * Optional list of remote `up` hosts — populated when the fleet is
     * deployed across multiple machines. Drives the cross-host fan-out
     * for `declaragent fleet ps / events / dlq / logs`. See Slice 3 of
     * `docs/CONTROL_PLANE_PLAN.md` (#50).
     *
     * Names must be unique.
     *
     * @since 0.7.4
     */
    hosts: z
      .array(fleetHostSchema)
      .optional()
      .refine(
        (hosts) => {
          if (!hosts) return true;
          const names = new Set<string>();
          for (const h of hosts) {
            if (names.has(h.name)) return false;
            names.add(h.name);
          }
          return true;
        },
        { message: 'fleet.hosts[].name must be unique' },
      ),
    /**
     * Fleet-wide `controlPlane:` block — see {@link fleetControlPlaneSchema}.
     * Orthogonal to {@link fleetManifestSchema.shape.hosts}: `hosts[]`
     * is what the CLI fans out TO; `controlPlane:` is how EACH agent
     * on this fleet's hosts exposes its in-process HTTP listener.
     *
     * When present, wins over per-agent `agent.yaml#controlPlane`
     * blocks — the `up` daemon warns about any per-agent overrides
     * and applies the fleet-level config to the process-wide listener.
     *
     * @since 0.7.5 — POST_ENTERPRISE_BACKLOG.md #17
     */
    controlPlane: fleetControlPlaneSchema.optional(),
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
