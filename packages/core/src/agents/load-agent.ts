/**
 * Standalone loader for a scaffolded agent directory.
 *
 * The fleet manifest loader at `packages/core/src/fleet/manifest-loader.ts`
 * touches each agent's `agent.yaml` only shallowly — it extracts the
 * `name` field to enforce §14.4 and moves on. {@link loadAgent} fills
 * the gap: given a directory, parse the full `agent.yaml` schema,
 * walk `skills/*.md`, and return a runtime-ready `AgentSpec` plus the
 * loaded skills and declared tool names.
 *
 * Non-goals (for now):
 *   - Does NOT load channels.yaml / event-sources.yaml / secrets.yaml.
 *     Those belong to adjacent loaders; the `declaragent run` CLI
 *     verb composes them as needed.
 *   - Does NOT resolve tool names into concrete `Tool` objects. The
 *     CLI layer holds the `BUILTIN_TOOLS` registry; this loader just
 *     surfaces the name list for the caller to map.
 *
 * @since 0.3.3
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadSkills } from '../skills/loader.js';
import type { Skill } from '../skills/types.js';
import type { AgentSpec } from '../types/session.js';

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

/**
 * `controlPlane.auth.allowLoopback` — scalar bool OR a trusted-proxy
 * descriptor for reverse-proxy deploys. The object form lets the
 * middleware honour `X-Forwarded-For` only from peers the operator has
 * vetted; see `POST_ENTERPRISE_BACKLOG.md #7` for the threat model.
 *
 * @since 0.7.2
 */
const controlPlaneAllowLoopbackSchema = z.union([
  z.boolean(),
  z
    .object({
      trustedProxies: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

/**
 * Exported zod schema for a `controlPlane.auth` block. Shape is the
 * same discriminated union used in `agent.yaml#controlPlane.auth`:
 *
 *   - `{ enabled: false }` — disabled/back-compat (or absent block).
 *   - `oidc` provider — verifies incoming Bearer tokens against an IdP.
 *   - `oauth2-client` provider — PKCE / client-credentials flow.
 *
 * Exposed so adjacent loaders (fleet-level `controlPlane:` block in
 * `fleet.yaml`, POST_ENTERPRISE_BACKLOG.md #17) can validate an
 * identically-shaped object without duplicating the union.
 *
 * @since 0.7.5
 */
export const controlPlaneAuthSchema = z.union([
  z
    .object({
      enabled: z.literal(false).optional(),
    })
    .passthrough(),
  z
    .object({
      enabled: z.literal(true),
      allowLoopback: controlPlaneAllowLoopbackSchema.optional(),
      routeScopes: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
      provider: z.literal('oidc'),
      issuer: z.string().min(1),
      audience: z.string().min(1),
      jwksUri: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      enabled: z.literal(true),
      allowLoopback: controlPlaneAllowLoopbackSchema.optional(),
      routeScopes: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
      provider: z.literal('oauth2-client'),
      tokenEndpoint: z.string().min(1),
      clientId: z.string().min(1),
      clientSecretRef: z.string().min(1),
      jwksUri: z.string().min(1).optional(),
      issuer: z.string().min(1).optional(),
      audience: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional(),
    })
    .strict(),
]);

/**
 * `controlPlane.auth.routeScopes` — per-route scope override map.
 * Keys are exact request pathnames (`/audit`, `/events`, …); values
 * are required-scope arrays. Empty arrays mean "no extra scope
 * required beyond the verifier's floor" — allowed but useless, so
 * we accept and warn downstream rather than fail validation.
 *
 * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #6
 */
const controlPlaneRouteScopesSchema = z.record(z.string().min(1), z.array(z.string().min(1)));

/**
 * Fields we actively consume from `agent.yaml`. The schema is
 * `passthrough()` so scaffolded configs can carry forward-compat
 * keys (channels, sources, plugins refs) without tripping validation
 * — consumers that need those keys add their own loader.
 */
/**
 * Only `name` is hard-required. `model` + `systemPrompt` are optional
 * because `declaragent init` scaffolds a slim yaml that relies on
 * runtime defaults (provider's configured model; a generic system
 * prompt derived from the agent name). Raw templates under
 * `templates/<name>/agent.yaml` include everything, but the wizard
 * normalises them into a smaller file. Both shapes must load.
 *
 * When `model` is absent, callers (the CLI) fall back to:
 *   `--model` flag > auth-config default > provider preset default.
 *
 * When `systemPrompt` is absent, we synthesise:
 *   "You are <name>. Help the user. Use your skills when appropriate."
 */
const agentYamlSchema = z
  .object({
    name: z.string().min(1, 'agent.yaml: "name" is required'),
    model: z.string().min(1).optional(),
    systemPrompt: z.string().min(1).optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    subagentDepthCap: z.number().int().nonnegative().optional(),
    /**
     * Max tool-use iterations per turn before the engine loop halts with
     * `stopReason: 'max_iterations'`. Optional positive integer; absent →
     * the engine falls back to `DEFAULT_MAX_ITERATIONS` (50). Surfaced on
     * {@link AgentSpec.maxIterations}, which the engine honours with
     * precedence `spec > EngineConfig > default`.
     *
     * @since 0.7.6
     */
    maxIterations: z
      .number()
      .int('agent.yaml: "maxIterations" must be an integer')
      .positive('agent.yaml: "maxIterations" must be a positive integer')
      .optional(),
    skills: z.array(z.string()).optional(),
    tools: z
      .object({
        defaults: z.array(z.string()).optional(),
        /**
         * Enterprise Production Plan §3 Item #7 — per-tool rate limit
         * config. Keys are tool names (`Bash`, `Write`, `mcp__github__list_issues`, …);
         * values are `{ rps, burst? }`. Omitted tools are uncapped.
         * `burst` defaults to `rps` at load time (see `ToolRateLimitGate`).
         *
         * @since 0.6.x
         */
        rateLimit: z
          .record(
            z.string().min(1),
            z.object({
              rps: z.number().positive(),
              burst: z.number().positive().optional(),
            }),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    /**
     * Enterprise Production Plan §3 Item #10 — SIEM audit export. When
     * `audit.export.kind` is set, the `up` daemon starts an in-process
     * loop that forwards new audit rows to the configured vendor on a
     * 10-second cadence. Secrets land in environment variables, not
     * this YAML — the loader reads `<vendor>Token` fields from
     * `process.env` when the `token` key is an `env:FOO` reference.
     *
     * @since 0.6.x
     */
    /**
     * Enterprise Production Plan §3 Item #4 — RPC envelope auth. Default
     * `enabled: false` is a deliberate opt-in for the transition — flipping
     * it to `true` means every envelope from a peer with an `auth:` block
     * in `rpc-peers.yaml` must carry a matching OIDC / OAuth2 token; a
     * bad or missing token routes to the DLQ under
     * `kind=rejected, reason=auth-rejected`. Peers without an `auth:` block
     * still follow the legacy `internal`/`hmac` path regardless of this
     * toggle.
     *
     * @since 0.7.x
     */
    rpc: z
      .object({
        auth: z
          .object({
            enabled: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    /**
     * Enterprise Production Plan §3 Item #5 — Managed control plane,
     * Slice 2 (CONTROL_PLANE_PLAN.md §9 PR 2). Optional OIDC / OAuth2
     * Client-Credentials middleware in front of the control-plane HTTP
     * listener. Default `enabled: false` preserves the current no-auth
     * posture; flipping to `true` means remote requests to `/metrics`,
     * `/status`, `/events`, `/dlq`, `/audit`, and `/logs` must carry a
     * Bearer token that validates against the configured issuer +
     * audience + scopes. Loopback requests bypass by default — set
     * `allowLoopback: false` for a zero-trust localhost posture.
     *
     * Shape mirrors `rpc-peers.yaml#auth` so operators can reuse the
     * same IdP for RPC envelope auth and control-plane auth without
     * learning two schemas.
     *
     * @since 0.7.x
     */
    controlPlane: z
      .object({
        auth: z
          .union([
            z
              .object({
                enabled: z.literal(false).optional(),
              })
              .passthrough(),
            z
              .object({
                enabled: z.literal(true),
                allowLoopback: controlPlaneAllowLoopbackSchema.optional(),
                routeScopes: controlPlaneRouteScopesSchema.optional(),
                provider: z.literal('oidc'),
                issuer: z.string().min(1),
                audience: z.string().min(1),
                jwksUri: z.string().min(1).optional(),
                scopes: z.array(z.string().min(1)).optional(),
              })
              .strict(),
            z
              .object({
                enabled: z.literal(true),
                allowLoopback: controlPlaneAllowLoopbackSchema.optional(),
                routeScopes: controlPlaneRouteScopesSchema.optional(),
                provider: z.literal('oauth2-client'),
                tokenEndpoint: z.string().min(1),
                clientId: z.string().min(1),
                clientSecretRef: z.string().min(1),
                jwksUri: z.string().min(1).optional(),
                issuer: z.string().min(1).optional(),
                audience: z.string().min(1).optional(),
                scopes: z.array(z.string().min(1)).optional(),
              })
              .strict(),
          ])
          .optional(),
      })
      .passthrough()
      .optional(),
    /**
     * Enterprise Production Plan §3 Item #8 — MCP supervisor wiring. The
     * supervisor wraps each MCP server with auto-recovery (ping health
     * check, exponential backoff, circuit breaker) and re-registers
     * tools on respawn. Defaults to `'all'` because supervision is
     * observational when nothing crashes — the overhead is one ping
     * per 10 s per server, and the recovery path only activates on
     * failure. Operators debugging a flaky stdio server can opt out
     * with `none` (bypasses the supervisor; raw client is used) or an
     * allow-list of server names.
     *
     * @since 0.7.x
     */
    mcp: z
      .object({
        supervised: z
          .union([z.literal('all'), z.literal('none'), z.array(z.string().min(1))])
          .optional(),
      })
      .passthrough()
      .optional(),
    audit: z
      .object({
        export: z
          .union([
            z.object({
              kind: z.literal('splunk'),
              hecUrl: z.string().min(1),
              token: z.string().min(1),
              index: z.string().optional(),
              source: z.string().optional(),
              sourcetype: z.string().optional(),
              host: z.string().optional(),
              name: z.string().optional(),
              batchSize: z.number().int().positive().optional(),
              intervalMs: z.number().int().positive().optional(),
            }),
            z.object({
              kind: z.literal('elastic'),
              baseUrl: z.string().min(1),
              index: z.string().optional(),
              auth: z.union([
                z.object({ kind: z.literal('apiKey'), apiKey: z.string().min(1) }),
                z.object({
                  kind: z.literal('basic'),
                  username: z.string().min(1),
                  password: z.string().min(1),
                }),
                z.object({ kind: z.literal('bearer'), token: z.string().min(1) }),
              ]),
              name: z.string().optional(),
              batchSize: z.number().int().positive().optional(),
              intervalMs: z.number().int().positive().optional(),
            }),
            z.object({
              kind: z.literal('datadog'),
              apiKey: z.string().min(1),
              site: z.string().optional(),
              intakeUrl: z.string().optional(),
              service: z.string().optional(),
              source: z.string().optional(),
              hostname: z.string().optional(),
              tags: z.string().optional(),
              name: z.string().optional(),
              batchSize: z.number().int().positive().optional(),
              intervalMs: z.number().int().positive().optional(),
            }),
          ])
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AgentYaml = z.infer<typeof agentYamlSchema>;

/**
 * Per-tool rate-limit config as loaded from `agent.yaml#tools.rateLimit`.
 * `burst` is normalised to a concrete value at load time (default = rps).
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #7
 */
export interface LoadedToolRateLimit {
  readonly rps: number;
  readonly burst: number;
}

/**
 * Loaded SIEM export config — zod-normalised shape of `agent.yaml#audit.export`.
 * The CLI maps this into the corresponding `createSplunkExporter` /
 * `createElasticExporter` / `createDatadogExporter` options.
 *
 * Secrets (tokens, api keys) may be passed inline OR via `env:FOO_BAR`
 * prefixes. The CLI resolves env refs at daemon-boot time; this loader
 * simply preserves the verbatim string so non-CLI consumers can do
 * their own secret resolution.
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #10
 */
export type LoadedAuditExport =
  | {
      kind: 'splunk';
      hecUrl: string;
      token: string;
      index?: string;
      source?: string;
      sourcetype?: string;
      host?: string;
      name?: string;
      batchSize?: number;
      intervalMs?: number;
    }
  | {
      kind: 'elastic';
      baseUrl: string;
      index?: string;
      auth:
        | { kind: 'apiKey'; apiKey: string }
        | { kind: 'basic'; username: string; password: string }
        | { kind: 'bearer'; token: string };
      name?: string;
      batchSize?: number;
      intervalMs?: number;
    }
  | {
      kind: 'datadog';
      apiKey: string;
      site?: string;
      intakeUrl?: string;
      service?: string;
      source?: string;
      hostname?: string;
      tags?: string;
      name?: string;
      batchSize?: number;
      intervalMs?: number;
    };

/**
 * MCP supervisor opt-in per `agent.yaml#mcp.supervised`.
 *
 *   - `'all'` (default): every MCP server is wrapped in
 *     {@link createMCPSupervisor} — ping health check + backoff + circuit
 *     breaker + tool re-registration on respawn.
 *   - `'none'`: raw `MCPClient` (no auto-recovery). Useful when debugging
 *     a flaky server where the supervisor's ping-probe itself is suspect.
 *   - `readonly string[]`: allow-list of server names to supervise; every
 *     other server stays on the raw-client path.
 *
 * @since 0.7.x — Enterprise Production Plan §3 Item #8
 */
export type LoadedMCPSupervised = 'all' | 'none' | readonly string[];

/**
 * Parsed + validated `agent.yaml#controlPlane.auth` block. Only present
 * when `enabled: true`; a disabled / absent block resolves to
 * `undefined` on {@link LoadedAgent.controlPlaneAuth} so callers can do
 * a single truthiness check.
 *
 * Shape mirrors `rpc-peers.yaml#auth` so operators can reuse the same
 * IdP for RPC envelope auth and control-plane auth.
 *
 * @since 0.7.x — Enterprise Production Plan §3 Item #5 Slice 2
 */
/**
 * Normalised form of `controlPlane.auth.allowLoopback`. Matches the
 * shape the observability middleware consumes (`ControlPlaneAllowLoopback`).
 *
 * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #7
 */
export type LoadedControlPlaneAllowLoopback =
  | boolean
  | { readonly trustedProxies: readonly string[] };

export type LoadedControlPlaneAuth =
  | {
      provider: 'oidc';
      allowLoopback?: LoadedControlPlaneAllowLoopback;
      routeScopes?: Readonly<Record<string, readonly string[]>>;
      issuer: string;
      audience: string;
      jwksUri?: string;
      scopes?: readonly string[];
    }
  | {
      provider: 'oauth2-client';
      allowLoopback?: LoadedControlPlaneAllowLoopback;
      routeScopes?: Readonly<Record<string, readonly string[]>>;
      tokenEndpoint: string;
      clientId: string;
      clientSecretRef: string;
      jwksUri?: string;
      issuer?: string;
      audience?: string;
      scopes?: readonly string[];
    };

/**
 * Parse + narrow a raw `controlPlane.auth` object into a
 * {@link LoadedControlPlaneAuth}. Returns `undefined` when the block
 * is absent or `enabled: false` — the caller boots the control-plane
 * listener without auth in that case.
 *
 * Throws a {@link z.ZodError} on a shape violation — callers are
 * expected to wrap with their own config-error class.
 *
 * Reused by `load-agent.ts` (per-agent block) AND the fleet-level
 * `controlPlane:` resolver (POST_ENTERPRISE_BACKLOG.md #17) so the
 * discriminated-union narrowing lives in one place.
 *
 * @since 0.7.5
 */
export function parseControlPlaneAuth(raw: unknown): LoadedControlPlaneAuth | undefined {
  if (raw === undefined || raw === null) return undefined;
  const cfg = controlPlaneAuthSchema.parse(raw);
  if (!cfg || !('enabled' in cfg) || cfg.enabled !== true || !('provider' in cfg)) {
    return undefined;
  }
  if (cfg.provider === 'oidc') {
    return {
      provider: 'oidc',
      ...(cfg.allowLoopback !== undefined && { allowLoopback: cfg.allowLoopback }),
      ...(cfg.routeScopes !== undefined && { routeScopes: cfg.routeScopes }),
      issuer: cfg.issuer,
      audience: cfg.audience,
      ...(cfg.jwksUri !== undefined && { jwksUri: cfg.jwksUri }),
      ...(cfg.scopes !== undefined && { scopes: cfg.scopes }),
    };
  }
  return {
    provider: 'oauth2-client',
    ...(cfg.allowLoopback !== undefined && { allowLoopback: cfg.allowLoopback }),
    ...(cfg.routeScopes !== undefined && { routeScopes: cfg.routeScopes }),
    tokenEndpoint: cfg.tokenEndpoint,
    clientId: cfg.clientId,
    clientSecretRef: cfg.clientSecretRef,
    ...(cfg.jwksUri !== undefined && { jwksUri: cfg.jwksUri }),
    ...(cfg.issuer !== undefined && { issuer: cfg.issuer }),
    ...(cfg.audience !== undefined && { audience: cfg.audience }),
    ...(cfg.scopes !== undefined && { scopes: cfg.scopes }),
  };
}

export interface LoadedAgent {
  readonly spec: AgentSpec;
  readonly skills: readonly Skill[];
  /** Tool names declared under `tools.defaults`. CLI resolves to actual `Tool` objects. */
  readonly toolNames: readonly string[];
  /**
   * Per-tool rate limits parsed from `tools.rateLimit`. Empty when the
   * block is omitted. CLI passes this straight to `createToolRateLimitGate`.
   */
  readonly toolRateLimits: Readonly<Record<string, LoadedToolRateLimit>>;
  /**
   * SIEM export config parsed from `audit.export`. Undefined when the
   * block is omitted. CLI hands this to {@link startAuditExportLoop}.
   * @since 0.6.x — Enterprise Production Plan §3 Item #10
   */
  readonly auditExport?: LoadedAuditExport;
  /**
   * RPC envelope auth opt-in. `false` (default) keeps the legacy
   * `internal`/`hmac` path; `true` tells `up` to build an
   * {@link AuthVerifyRegistry} from `rpc-peers.yaml` and plumb it into
   * `createAgentInboxAdapter`.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #4
   */
  readonly rpcAuthEnabled: boolean;
  /**
   * Tri-state posture the operator declared for `rpc.auth.enabled`:
   *
   *   - `'enabled'` — `rpc.auth.enabled: true` was set explicitly.
   *   - `'disabled'` — `rpc.auth.enabled: false` was set explicitly
   *     (intentional opt-out — honoured through 0.8.0 with a
   *     boot-time warning; see `docs/ZERO_TRUST_DEFAULT_MIGRATION.md` Path B).
   *   - `'absent'` — no `rpc.auth` block (or the block has no `enabled`
   *     key). The posture the 0.8.0 default flip changes: today this
   *     resolves to `rpcAuthEnabled: false`; with the 0.7.6 preview
   *     flag `DECLARAGENT_RPC_AUTH_DEFAULT=on` it resolves to
   *     `rpcAuthEnabled: true` when peers are declared, otherwise to
   *     an `AUTH_REJECTED` boot failure (pre-flight).
   *
   * @since 0.7.6 — `DECLARAGENT_RPC_AUTH_DEFAULT` preview mode
   *   (POST_ENTERPRISE_BACKLOG.md #5b prep for 0.8.0).
   */
  readonly rpcAuthPosture: 'enabled' | 'disabled' | 'absent';
  /**
   * MCP supervisor opt-in. Defaults to `'all'` (every MCP server is
   * wrapped in {@link createMCPSupervisor}).
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #8
   */
  readonly mcpSupervised: LoadedMCPSupervised;
  /**
   * Parsed `controlPlane.auth` block when `enabled: true`. `undefined`
   * when the block is absent or `enabled: false`, in which case the
   * CLI boots the control-plane listener without auth middleware
   * (back-compat).
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #5 Slice 2
   */
  readonly controlPlaneAuth?: LoadedControlPlaneAuth;
  readonly agentDir: string;
  readonly agentYamlPath: string;
  /** Lookup-name collisions surfaced by the skill loader; callers may warn. */
  readonly skillConflicts: ReadonlyArray<{
    readonly lookupName: string;
    readonly chosen: string;
    readonly shadowed: readonly string[];
  }>;
}

export interface LoadAgentOptions {
  /** Absolute or cwd-relative path to the agent root (the dir containing agent.yaml). */
  agentDir: string;
}

export async function loadAgent(options: LoadAgentOptions): Promise<LoadedAgent> {
  const agentDir = resolve(options.agentDir);
  const agentYamlPath = join(agentDir, 'agent.yaml');

  let rawText: string;
  try {
    rawText = await readFile(agentYamlPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AgentConfigError(
        `no agent.yaml at ${agentYamlPath}. Run \`declaragent init --template <name>\` to scaffold one, or pass a different dir.`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawText);
  } catch (err) {
    throw new AgentConfigError(
      `${agentYamlPath}: invalid YAML — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = agentYamlSchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentConfigError(
      `${agentYamlPath} failed validation: ${formatZodError(result.error)}`,
    );
  }
  const cfg = result.data;

  // Skills: walk <agentDir>/skills/*.md. We load unconditionally (not
  // gated on the `skills:` array in yaml) so the scaffolded `skills/`
  // dir is the canonical list — matches how the skill registry at
  // runtime resolves user-tier skills.
  const skillsDir = join(agentDir, 'skills');
  const skillLoad = await loadSkills({
    sources: [{ dir: skillsDir, tier: { type: 'user' } }],
  });

  if (skillLoad.errors.length > 0) {
    // Surface the first error; rest live in `skillLoad.errors` if the
    // caller wants them. Fail-hard here because a bad skill frontmatter
    // is an authoring bug, not a runtime condition.
    const first = skillLoad.errors[0];
    if (first) {
      throw new AgentConfigError(
        `skill at ${first.filePath} failed to load: ${first.error.message}`,
      );
    }
  }

  const spec: AgentSpec = {
    name: cfg.name,
    // Empty model signals "caller must resolve" — the CLI layer picks
    // from `--model` / auth config / provider preset default.
    model: cfg.model ?? '',
    systemPrompt:
      cfg.systemPrompt ??
      `You are "${cfg.name}", a declaragent-authored agent. Help the user. Use your skills when they apply to the user's request.`,
    ...(cfg.temperature !== undefined && { temperature: cfg.temperature }),
    ...(cfg.maxTokens !== undefined && { maxTokens: cfg.maxTokens }),
    ...(cfg.subagentDepthCap !== undefined && { subagentDepthCap: cfg.subagentDepthCap }),
    ...(cfg.maxIterations !== undefined && { maxIterations: cfg.maxIterations }),
  };

  // Normalise the rate-limit block. Missing `burst` defaults to `rps`
  // (matches ToolRateLimitGate behaviour — a full second of steady-state
  // calls absorbable without sleeping).
  const rawRateLimit = cfg.tools?.rateLimit;
  const toolRateLimits: Record<string, LoadedToolRateLimit> = {};
  if (rawRateLimit) {
    for (const [toolName, entry] of Object.entries(rawRateLimit)) {
      toolRateLimits[toolName] = {
        rps: entry.rps,
        burst: entry.burst ?? entry.rps,
      };
    }
  }

  // Audit export — passthrough. Zod has already validated the union;
  // the cast is safe because the schema shape matches LoadedAuditExport.
  const auditExport = cfg.audit?.export as LoadedAuditExport | undefined;

  // RPC auth tri-state posture — see LoadedAgent.rpcAuthPosture for the
  // three-way semantics. The scalar `rpcAuthEnabled` is kept for
  // back-compat (call sites that just need yes/no) and always tracks
  // the explicit `true` posture at load time. Preview-mode default
  // promotion (`DECLARAGENT_RPC_AUTH_DEFAULT=on`) is applied at the
  // CLI pre-boot layer, not here — the loader stays deterministic
  // regardless of ambient env so tests keep their fixtures honest.
  const rpcAuthKey = cfg.rpc?.auth;
  let rpcAuthPosture: 'enabled' | 'disabled' | 'absent' = 'absent';
  if (rpcAuthKey && 'enabled' in rpcAuthKey) {
    if (rpcAuthKey.enabled === true) rpcAuthPosture = 'enabled';
    else if (rpcAuthKey.enabled === false) rpcAuthPosture = 'disabled';
  }
  const rpcAuthEnabled = rpcAuthPosture === 'enabled';

  // MCP supervisor opt-in. Default 'all' — supervision is observational
  // when the server is healthy and only activates recovery paths on
  // failure.
  const mcpSupervised: LoadedMCPSupervised = cfg.mcp?.supervised ?? 'all';

  // Control-plane auth opt-in. Zod already normalised the discriminated
  // union; we only care about the `enabled: true` branches which carry
  // the provider-specific fields. Disabled / absent → undefined so the
  // CLI's truthiness check keeps the back-compat (no-middleware) path.
  const cpAuthCfg = cfg.controlPlane?.auth;
  let controlPlaneAuth: LoadedControlPlaneAuth | undefined;
  if (cpAuthCfg && cpAuthCfg.enabled === true && 'provider' in cpAuthCfg) {
    if (cpAuthCfg.provider === 'oidc') {
      controlPlaneAuth = {
        provider: 'oidc',
        ...(cpAuthCfg.allowLoopback !== undefined && {
          allowLoopback: cpAuthCfg.allowLoopback,
        }),
        ...(cpAuthCfg.routeScopes !== undefined && {
          routeScopes: cpAuthCfg.routeScopes,
        }),
        issuer: cpAuthCfg.issuer,
        audience: cpAuthCfg.audience,
        ...(cpAuthCfg.jwksUri !== undefined && { jwksUri: cpAuthCfg.jwksUri }),
        ...(cpAuthCfg.scopes !== undefined && { scopes: cpAuthCfg.scopes }),
      };
    } else {
      controlPlaneAuth = {
        provider: 'oauth2-client',
        ...(cpAuthCfg.allowLoopback !== undefined && {
          allowLoopback: cpAuthCfg.allowLoopback,
        }),
        ...(cpAuthCfg.routeScopes !== undefined && {
          routeScopes: cpAuthCfg.routeScopes,
        }),
        tokenEndpoint: cpAuthCfg.tokenEndpoint,
        clientId: cpAuthCfg.clientId,
        clientSecretRef: cpAuthCfg.clientSecretRef,
        ...(cpAuthCfg.jwksUri !== undefined && { jwksUri: cpAuthCfg.jwksUri }),
        ...(cpAuthCfg.issuer !== undefined && { issuer: cpAuthCfg.issuer }),
        ...(cpAuthCfg.audience !== undefined && { audience: cpAuthCfg.audience }),
        ...(cpAuthCfg.scopes !== undefined && { scopes: cpAuthCfg.scopes }),
      };
    }
  }

  return {
    spec,
    skills: skillLoad.skills,
    toolNames: cfg.tools?.defaults ?? [],
    toolRateLimits,
    ...(auditExport !== undefined && { auditExport }),
    rpcAuthEnabled,
    rpcAuthPosture,
    mcpSupervised,
    ...(controlPlaneAuth !== undefined && { controlPlaneAuth }),
    agentDir,
    agentYamlPath,
    skillConflicts: skillLoad.conflicts,
  };
}

/**
 * Compose a system prompt with the loaded skills' bodies appended.
 *
 * Why: until the engine integrates a first-class skill-invocation
 * channel (currently only `DeclaraAddSkill` uses the skill registry),
 * the most reliable way to let a runtime agent *use* its skills is
 * to include the skill bodies in the system prompt. The model reads
 * them, recognizes when a user ask matches a skill, and follows the
 * instructions inline.
 *
 * Output shape:
 *
 *   <original systemPrompt>
 *
 *   # Available skills
 *
 *   ## <skill-name>
 *   <skill.description>
 *   <skill.prompt>
 *
 *   ## <next-skill>
 *   ...
 *
 * When `skills` is empty, returns the original prompt unchanged.
 */
/**
 * Env var name that toggles the 0.8.0 zero-trust default flip as a
 * preview in 0.7.6+. Exported so the CLI layer can reference it by
 * the same constant rather than re-inlining the string.
 *
 * @since 0.7.6 — POST_ENTERPRISE_BACKLOG.md #5b prep
 */
export const RPC_AUTH_DEFAULT_ENV = 'DECLARAGENT_RPC_AUTH_DEFAULT';

/**
 * Read the preview-mode flag from a supplied env bag (defaults to
 * `process.env`). Returns `true` when the env var is set to `on`,
 * `true`, or `1` (case-insensitive). Any other value — absent, empty,
 * `off`, `false`, `0` — returns `false`.
 *
 * Exported so:
 *
 *   - the CLI pre-boot layer (`up`, `fleet run`) reads the same truth
 *     source as the inspector's `--dry-run-with-flag`.
 *   - tests can set the flag via an injected env bag without touching
 *     `process.env` (avoids leaking state across Bun's parallel
 *     describe blocks).
 *
 * @since 0.7.6 — POST_ENTERPRISE_BACKLOG.md #5b prep
 */
export function isRpcAuthDefaultFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[RPC_AUTH_DEFAULT_ENV];
  if (raw === undefined) return false;
  const normalised = raw.trim().toLowerCase();
  return normalised === 'on' || normalised === 'true' || normalised === '1';
}

/**
 * Resolve the effective `rpc.auth.enabled` value given the loader's
 * tri-state posture + whether peers are declared + whether the 0.8.0
 * preview flag is on. Returns:
 *
 *   - `{ enabled: true, reason: 'explicit' }` — agent set `enabled: true`.
 *   - `{ enabled: false, reason: 'explicit-optout' }` — agent set
 *     `enabled: false`. Honoured under the preview flag too (matches
 *     Path B in the migration doc).
 *   - `{ enabled: true, reason: 'flag-default' }` — posture `absent`,
 *     peers declared, flag on.
 *   - `{ enabled: false, reason: 'legacy-default' }` — posture `absent`,
 *     flag off (today's behaviour).
 *   - `{ enabled: false, reason: 'boot-fail' }` — posture `absent`,
 *     peers declared, flag on → the CLI is expected to reject this
 *     agent with `AUTH_REJECTED`.
 *
 * The CLI's pre-boot helper (`validateZeroTrustPreview`) maps the
 * `boot-fail` result into an `AUTH_REJECTED` error. `loadAgent` never
 * throws on this by itself — keeps the pure loader free of ambient
 * env coupling.
 *
 * "Peers declared" means either a fleet-root `rpc-peers.yaml` exists
 * OR a per-agent `<agentDir>/rpc-peers.yaml` exists. Agents with
 * neither never cross a wire boundary, so the flip is a no-op for
 * them (documented as the "memory-only" exemption in the migration
 * guide §2).
 *
 * @since 0.7.6 — POST_ENTERPRISE_BACKLOG.md #5b prep
 */
export type RpcAuthResolveReason =
  | 'explicit'
  | 'explicit-optout'
  | 'flag-default'
  | 'legacy-default'
  | 'boot-fail';

export interface ResolvedRpcAuth {
  readonly enabled: boolean;
  readonly reason: RpcAuthResolveReason;
}

export function resolveEffectiveRpcAuth(input: {
  readonly posture: 'enabled' | 'disabled' | 'absent';
  readonly peersDeclared: boolean;
  readonly flagOn: boolean;
}): ResolvedRpcAuth {
  if (input.posture === 'enabled') return { enabled: true, reason: 'explicit' };
  if (input.posture === 'disabled') return { enabled: false, reason: 'explicit-optout' };
  // posture === 'absent'
  if (!input.flagOn) return { enabled: false, reason: 'legacy-default' };
  if (!input.peersDeclared) return { enabled: false, reason: 'legacy-default' };
  // flag on + peers declared + no explicit opt-in = future boot failure.
  return { enabled: false, reason: 'boot-fail' };
}

export function composeSystemPromptWithSkills(
  basePrompt: string,
  skills: readonly Skill[],
): string {
  if (skills.length === 0) return basePrompt;

  const sections: string[] = [basePrompt.trimEnd(), '', '# Available skills', ''];
  for (const s of skills) {
    sections.push(`## ${s.lookupName}`);
    sections.push(s.frontmatter.description);
    sections.push('');
    sections.push(s.prompt.trim());
    sections.push('');
  }
  return sections.join('\n');
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}
