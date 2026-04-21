/**
 * Shared types + Zod input schemas for the agent-builder toolkit.
 *
 * See `docs/BUILDER_PLAN.md` §3 for the public tool contracts. Phase 1
 * only materialises the `DeclaraAddSkill` input; later slices extend
 * this file with source/channel/secret/peer schemas.
 *
 * @since 0.2.0
 */

import { z } from 'zod';

// ── Shared fragments ───────────────────────────────────────────────────

/**
 * Skill name rule per BUILDER_PLAN §3.3: `[a-z0-9][a-z0-9_-]*`.
 * Lowercase, starts with alnum, only alnum / hyphen / underscore after.
 */
export const skillNameSchema = z
  .string()
  .min(1, 'skill name is required')
  .max(64, 'skill name exceeds 64 characters')
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'skill name must match [a-z0-9][a-z0-9_-]*');

/**
 * A JSON-schema-shaped object. We don't re-validate the full meta-schema
 * here — the existing skill loader in core does that at load time. This
 * matches how `parseSkillFrontmatter` treats inputs/outputs (opaque
 * mappings).
 */
export const jsonSchemaLikeSchema = z.record(z.string(), z.unknown());

// ── DeclaraAddSkill ────────────────────────────────────────────────────

export const addSkillInputSchema = z.object({
  /** Absolute agent root. Defaults to the session's scope root. */
  agentPath: z.string().optional(),
  name: skillNameSchema,
  description: z.string().min(1, 'skill description is required'),
  inputs: z.record(z.string(), jsonSchemaLikeSchema).optional(),
  outputs: jsonSchemaLikeSchema.optional(),
  body: z.string().min(1, 'skill body is required'),
  /** Default true. When false, writes the skill file only. */
  addToAgentYaml: z.boolean().optional(),
  /** Scope-breach override. Still routed through the proposal flow (Phase 3). */
  confirmOutsideScope: z.boolean().optional(),
});

export type AddSkillInput = z.infer<typeof addSkillInputSchema>;

export interface AddSkillOutput {
  readonly ok: true;
  /** Absolute paths of every file written / touched. */
  readonly writes: readonly string[];
  readonly skillPath: string;
  readonly agentYamlUpdated: boolean;
}

// ── DeclaraAddSecret ───────────────────────────────────────────────────

/**
 * Providers supported by `@declaragent/core`'s secrets loader. Keep in
 * sync with `providerConfigSchema` in core/secrets/config-loader.ts —
 * the cli-side check is defence-in-depth; the loader is the final
 * authority at agent load time.
 */
export const secretProviderSchema = z.enum(['env', 'vault', 'aws-sm', 'gcp-sm', 'k8s']);
export type SecretProvider = z.infer<typeof secretProviderSchema>;

/**
 * A secret *reference* — what the agent will later resolve at runtime.
 * Examples:
 *   - env:GITHUB_TOKEN
 *   - vault:kv/data/my-agent/gh-token
 *   - aws-sm:prod/my-agent/gh-token
 * We accept either the bare resource name OR a `provider:name` prefix;
 * when both are supplied the prefix in `ref` must match `provider`.
 */
export const secretRefSchema = z
  .string()
  .min(1, 'secret ref is required')
  .max(256, 'secret ref exceeds 256 characters')
  // Reject whitespace + YAML-breaking characters. Colon is permitted
  // because many refs use `provider:name` form.
  .regex(/^[A-Za-z0-9._:/+-]+$/, 'secret ref may only contain [A-Za-z0-9._:/+-]');

export const addSecretInputSchema = z.object({
  ref: secretRefSchema,
  provider: secretProviderSchema,
  /** Free-form note — which tool / source / channel consumes this ref. */
  usedBy: z.string().max(128).optional(),
  /** Restrict resolution to a specific tenant. Optional for single-tenant agents. */
  tenantScope: z.string().max(64).optional(),
  /** Absolute scope override (see addSkillInputSchema.agentPath). */
  agentPath: z.string().optional(),
  confirmOutsideScope: z.boolean().optional(),
});

export type AddSecretInput = z.infer<typeof addSecretInputSchema>;

export interface AddSecretOutput {
  readonly ok: true;
  /** Actionable next step for the user — render as a system line in the REPL. */
  readonly hint: string;
  /** The env-var name we either created or confirmed in `.env.example`. */
  readonly envVar: string;
  /** Absolute paths of every file touched. */
  readonly writes: readonly string[];
}

// ── DeclaraFleetAdd ────────────────────────────────────────────────────

/**
 * Agent id rule — matches `addAgentFromTemplate`'s internal regex
 * (case-insensitive there, but we lock to lowercase here so builder-
 * generated fleets stay consistent with slice-2 template ids).
 */
export const agentIdSchema = z
  .string()
  .min(1, 'agent id is required')
  .max(64, 'agent id exceeds 64 characters')
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'agent id must match [a-z0-9][a-z0-9_-]*');

export const fleetAddInputSchema = z.object({
  template: z.string().min(1, 'template name is required'),
  /** Agent id written to `fleet.yaml`. Template default is used when omitted. */
  id: agentIdSchema.optional(),
  force: z.boolean().optional(),
  /** Absolute fleet root. When omitted the tool falls back to the session scope root. */
  fleetRoot: z.string().optional(),
  confirmOutsideScope: z.boolean().optional(),
});

export type FleetAddInput = z.infer<typeof fleetAddInputSchema>;

export interface FleetAddOutput {
  readonly ok: true;
  readonly agentId: string;
  readonly agentPath: string;
  readonly manifestPath: string;
  readonly writes: readonly string[];
}

// ── DeclaraAddSource ───────────────────────────────────────────────────

/**
 * Source type. Keep the union in sync with the three in-process
 * adapters shipped by core (webhook / cron / file-watch) plus the
 * external-broker types that have published source packages. The
 * builder validates in-process types strictly and lets external types
 * through without adapter-level checks — the daemon / `declaragent
 * run <dir>` path reports them as `unknownTypes` at startup.
 */
export const sourceTypeSchema = z.enum([
  'webhook',
  'cron',
  'file-watch',
  'kafka',
  'nats',
  'sqs',
  'amqp',
  'mqtt',
]);

export type SourceType = z.infer<typeof sourceTypeSchema>;

/**
 * Stable source id. Daemon diff keys + event-store correlation depend
 * on this being unique per agent; we enforce the same pattern the
 * scaffolder uses so hand-authored + builder-authored ids look alike.
 */
export const sourceIdSchema = z
  .string()
  .min(1, 'source id is required')
  .max(64, 'source id exceeds 64 characters')
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'source id must match [a-z0-9][a-z0-9_-]*');

export const addSourceInputSchema = z.object({
  type: sourceTypeSchema,
  /**
   * Stable id surfaced in events + logs. The runtime accepts sources
   * without an id for some types (cron auto-derives one), but the
   * builder always stamps one so config diffs are predictable.
   */
  id: sourceIdSchema,
  /**
   * Adapter-specific config. Not validated here — the tool round-trips
   * the assembled entry through `validateEventSourcesConfig` with the
   * in-process adapter map, which is the authoritative gate.
   */
  config: z.record(z.string(), z.unknown()),
  /** Absolute agent root. Defaults to the session scope root. */
  agentPath: z.string().optional(),
  confirmOutsideScope: z.boolean().optional(),
});

export type AddSourceInput = z.infer<typeof addSourceInputSchema>;

export interface AddSourceOutput {
  readonly ok: true;
  readonly type: string;
  readonly id: string;
  /** Absolute path to the event-sources.yaml we wrote. */
  readonly eventSourcesPath: string;
  readonly writes: readonly string[];
  /**
   * True iff the type has no in-process adapter (kafka / nats / …).
   * Surfaces as a hint in the REPL so the user knows this source
   * won't fire under `declaragent run <dir>` without the external
   * broker package + credentials.
   */
  readonly external: boolean;
}

// ── DeclaraAddChannel ──────────────────────────────────────────────────

/**
 * Channel types declaragent ships first-party adapters for. Unknown
 * types are accepted structurally — the `declaragent channels
 * validate` verb remains the authoritative gate, since it can discover
 * third-party adapters the builder has no way to load.
 */
export const channelTypeSchema = z.enum(['slack', 'telegram', 'discord', 'whatsapp']);
export type ChannelType = z.infer<typeof channelTypeSchema>;

/**
 * Channel id — unique across the user's channels config. Same pattern
 * as source ids for consistency.
 */
export const channelIdSchema = z
  .string()
  .min(1, 'channel id is required')
  .max(64, 'channel id exceeds 64 characters')
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'channel id must match [a-z0-9][a-z0-9_-]*');

export const addChannelInputSchema = z.object({
  type: channelTypeSchema,
  id: channelIdSchema,
  /**
   * Adapter-specific config. Keys vary per channel — slack wants
   * `token` / `signingSecret` refs; telegram wants `botToken`. We
   * don't re-validate here; the post-write `loadChannelsConfig`
   * round-trip surfaces anything structurally broken.
   */
  config: z.record(z.string(), z.unknown()),
  confirmOutsideScope: z.boolean().optional(),
});

export type AddChannelInput = z.infer<typeof addChannelInputSchema>;

export interface AddChannelOutput {
  readonly ok: true;
  readonly type: string;
  readonly id: string;
  /** Absolute path to the channels config file. */
  readonly channelsPath: string;
  readonly writes: readonly string[];
  /**
   * Hint the REPL surfaces to the user — reminds them channels are
   * user-global (not in the agent's scope root) and points at the
   * matching playbook for credential setup.
   */
  readonly hint: string;
}

// ── DeclaraAddMCP ──────────────────────────────────────────────────────

/**
 * MCP server name. Namespaces the contributed tools as
 * `mcp__<name>__<tool>`, so the pattern must be filesystem-clean and
 * case-insensitive across the Claude UI.
 */
export const mcpNameSchema = z
  .string()
  .min(1, 'mcp server name is required')
  .max(64, 'mcp server name exceeds 64 characters')
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'mcp server name must match [a-z0-9][a-z0-9_-]*');

export const addMCPInputSchema = z.object({
  name: mcpNameSchema,
  /** Executable binary — absolute path or command on PATH. */
  command: z.string().min(1, 'mcp command is required'),
  /** Command-line args passed to the binary. */
  args: z.array(z.string()).optional(),
  /** Env vars merged on top of the process env when spawning the server. */
  env: z.record(z.string(), z.string()).optional(),
  /** MCP protocol version. Defaults to `2024-11-05` server-side. */
  protocolVersion: z.string().optional(),
});

export type AddMCPInput = z.infer<typeof addMCPInputSchema>;

export interface AddMCPOutput {
  readonly ok: true;
  readonly name: string;
  readonly mcpConfigPath: string;
  readonly writes: readonly string[];
  /** Tool namespace the MCP server will contribute as. */
  readonly toolPrefix: string;
  /** Hint surfaced to the user (restart + protocol version). */
  readonly hint: string;
}

// ── DeclaraAddPlugin ───────────────────────────────────────────────────

export const addPluginInputSchema = z.object({
  /**
   * Path to the plugin directory (containing `plugin.json`). Absolute or
   * relative to `agentPath` / scope root. The tool reads the manifest,
   * records the declared permissions in the consent log, and writes a
   * store entry.
   */
  pluginPath: z.string().min(1, 'pluginPath is required'),
  /**
   * Scope-breach override. Plugins typically live outside the agent
   * scope root (global npm package), so the default is permissive —
   * the proposal flow is where the user confirms the consent.
   */
  confirmOutsideScope: z.boolean().optional(),
});

export type AddPluginInput = z.infer<typeof addPluginInputSchema>;

export interface AddPluginOutput {
  readonly ok: true;
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly pluginStorePath: string;
  readonly writes: readonly string[];
  readonly consentedPermissions: readonly string[];
  readonly hint: string;
}

// ── DeclaraAddPeer ─────────────────────────────────────────────────────

/**
 * Agent address — `agent://<id>` per `peerEntrySchema` in
 * `@declaragent/core`. We keep validation loose here (just the
 * prefix) and let core's full schema reject anything stricter at
 * apply time.
 */
export const agentUriSchema = z.string().regex(/^agent:\/\/.+/, 'agent must be `agent://<id>`');

/**
 * Peer transport shape — `readonly` object, kind-first so the model
 * can construct entries without hunting for the discriminant. We do
 * NOT re-validate the transport payload here: `peersConfigSchema` in
 * core runs at the tail end of the append, which is the authoritative
 * gate.
 */
export const peerTransportInputSchema = z
  .object({
    kind: z.enum(['memory', 'kafka', 'nats', 'sqs', 'amqp', 'mqtt']),
  })
  .passthrough();

export const addPeerInputSchema = z.object({
  agent: agentUriSchema,
  transports: z.array(peerTransportInputSchema).min(1, 'at least one transport is required'),
  /** Absolute fleet root. Defaults to the session scope root (must be a fleet). */
  fleetRoot: z.string().optional(),
  confirmOutsideScope: z.boolean().optional(),
});

export type AddPeerInput = z.infer<typeof addPeerInputSchema>;

export interface AddPeerOutput {
  readonly ok: true;
  readonly agent: string;
  readonly peersPath: string;
  readonly writes: readonly string[];
  /**
   * True when the agent already had an entry and we merged into it;
   * false when a new entry was appended.
   */
  readonly merged: boolean;
}

// ── DeclaraProposeChange / DeclaraApplyChange ─────────────────────────

export const proposalStepKindSchema = z.enum([
  'addSkill',
  'addSecret',
  'addSource',
  'addChannel',
  'addMCP',
  'addPlugin',
  'addPeer',
  'addAgent',
  'editFile',
  'runCommand',
]);

export const proposalStepInputSchema = z.object({
  kind: proposalStepKindSchema,
  description: z.string().min(1, 'step description is required'),
  preview: z.string().optional(),
  /**
   * Kind-specific payload. Not validated here — the matching tool's
   * schema runs at apply time. Phase 3 ships dispatchers for
   * `addSkill` and `addSecret`; other kinds surface a clear
   * "not supported yet" error at apply time.
   */
  payload: z.unknown(),
});

export const proposeChangeInputSchema = z.object({
  summary: z.string().min(1, 'proposal summary is required').max(512),
  steps: z
    .array(proposalStepInputSchema)
    .min(1, 'at least one step is required')
    .max(32, 'too many steps — split into multiple proposals'),
  requiresExplicitYes: z.boolean().optional(),
});

export type ProposeChangeInput = z.infer<typeof proposeChangeInputSchema>;

export interface ProposeChangeOutput {
  readonly ok: true;
  readonly proposalId: string;
  readonly confirmed: boolean;
  readonly summary: string;
  /** Final step descriptions after any `/edit` revisions the user made. */
  readonly finalSteps: ReadonlyArray<{
    kind: string;
    description: string;
  }>;
  /** Which terminal transition resolved the proposal. */
  readonly reason: 'confirmed' | 'rejected' | 'expired';
}

export const applyChangeInputSchema = z.object({
  proposalId: z.string().min(1, 'proposalId is required'),
});

export type ApplyChangeInput = z.infer<typeof applyChangeInputSchema>;

export interface ApplyStepResult {
  readonly kind: string;
  readonly ok: boolean;
  readonly writes: readonly string[];
  /** Tool-specific output payload. Present only when `ok === true`. */
  readonly output?: unknown;
  /** Error message when `ok === false`. */
  readonly error?: string;
}

export interface ApplyChangeOutput {
  readonly ok: boolean;
  readonly proposalId: string;
  readonly results: readonly ApplyStepResult[];
  /** Git HEAD captured before execution. `undefined` when the tree isn't a git repo. */
  readonly gitHeadBefore: string | undefined;
  readonly auditCorrelationId: string;
  /** True when at least one step mutated the tree and an automatic revert was attempted. */
  readonly rolledBack: boolean;
}

// ── Phase-5 read-only inspection tools ─────────────────────────────────

/**
 * Event kinds known at plan-time. Kept in sync with
 * `@declaragent/core`'s `EventKind` union — the regex fallback in
 * `passthrough()` keeps compatibility with kinds added by downstream
 * forks.
 */
export const eventKindSchema = z.string().min(1);

export const eventsTailInputSchema = z.object({
  /** Max rows. Defaults to 20 (see runner). */
  last: z.number().int().positive().max(1000).optional(),
  /** Filter to one event kind (`webhook.received` / `trigger.fire` / …). */
  kind: eventKindSchema.optional(),
  /** Thread on a correlation id — matches the pattern in system-prompt guidance. */
  correlationId: z.string().min(1).max(128).optional(),
  /** Only events at or after this ms-epoch. */
  sinceMs: z.number().int().nonnegative().optional(),
});

export type EventsTailInput = z.infer<typeof eventsTailInputSchema>;

/**
 * Trimmed event record — we omit the full payload by default to keep
 * tool responses bounded. Payload snippets are elided with
 * `<payload:N bytes>` so the model sees the event shape + correlation
 * chain without getting drowned in binary bodies.
 *
 * `source` and `target` are surfaced as loose records because the
 * underlying `EventSourceTag` / `EventTarget` discriminated unions
 * vary their field set per adapter.
 */
export interface EventsTailRecord {
  readonly id: string;
  readonly kind: string;
  readonly timestamp: number;
  readonly correlationId?: string;
  readonly source: Record<string, unknown>;
  readonly target: Record<string, unknown>;
  readonly outcome?: Record<string, unknown>;
  readonly payloadPreview?: string;
}

export interface EventsTailOutput {
  readonly ok: true;
  readonly count: number;
  readonly events: readonly EventsTailRecord[];
  readonly storePath: string;
}

// ── DeclaraFleetStatus ─────────────────────────────────────────────────

export const fleetStatusInputSchema = z.object({
  history: z.boolean().optional(),
  historyLimit: z.number().int().positive().max(50).optional(),
  /** Override the fleet root — defaults to scope root. */
  fleetRoot: z.string().optional(),
});

export type FleetStatusInput = z.infer<typeof fleetStatusInputSchema>;

export interface FleetStatusOutput {
  readonly ok: true;
  readonly report: unknown;
}

// ── DeclaraAuditVerify ─────────────────────────────────────────────────

export const auditVerifyInputSchema = z.object({
  tenant: z.string().min(1).max(64).optional(),
});

export type AuditVerifyInput = z.infer<typeof auditVerifyInputSchema>;

export interface AuditVerifyOutput {
  readonly ok: boolean;
  readonly totalEntries: number;
  readonly verifiedEntries: number;
  readonly violations: ReadonlyArray<{
    seq: number;
    kind: string;
    message: string;
  }>;
  readonly auditDbPath: string;
}

// ── DeclaraDlqShow ─────────────────────────────────────────────────────

export const dlqShowInputSchema = z.object({
  /** Source id to filter on (matches `event.source.sourceId`). */
  sourceId: z.string().min(1).max(128).optional(),
  /** Max rows. Defaults to 20. */
  limit: z.number().int().positive().max(500).optional(),
});

export type DlqShowInput = z.infer<typeof dlqShowInputSchema>;

export interface DlqEntry {
  readonly id: string;
  readonly kind: string;
  readonly timestamp: number;
  readonly correlationId?: string;
  readonly source: Record<string, unknown>;
  readonly reason?: string;
  readonly outcomeAt?: number;
}

export interface DlqShowOutput {
  readonly ok: true;
  readonly count: number;
  readonly entries: readonly DlqEntry[];
  readonly storePath: string;
}

// ── DeclaraAuthPlaybook ────────────────────────────────────────────────

export const authPlaybookInputSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'github', 'slack', 'vault']),
});

export type AuthPlaybookInput = z.infer<typeof authPlaybookInputSchema>;

export interface AuthPlaybookOutput {
  readonly ok: true;
  readonly provider: string;
  /** Markdown content ready to render in the REPL. */
  readonly content: string;
}

// ── Error hierarchy ────────────────────────────────────────────────────

export class BuilderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BuilderError';
    this.code = code;
  }
}

export class BuilderValidationError extends BuilderError {
  constructor(message: string) {
    super('E_BUILDER_VALIDATION', message);
    this.name = 'BuilderValidationError';
  }
}

export class BuilderScopeError extends BuilderError {
  readonly offendingPath: string;
  readonly scopeRoot: string;
  constructor(offendingPath: string, scopeRoot: string) {
    super(
      'E_BUILDER_SCOPE',
      `path ${offendingPath} is outside scope ${scopeRoot}. Re-invoke with confirmOutsideScope: true to override (the user will be asked to confirm).`,
    );
    this.name = 'BuilderScopeError';
    this.offendingPath = offendingPath;
    this.scopeRoot = scopeRoot;
  }
}

export class BuilderConflictError extends BuilderError {
  constructor(message: string) {
    super('E_BUILDER_CONFLICT', message);
    this.name = 'BuilderConflictError';
  }
}

export class BuilderSecretLeakError extends BuilderError {
  readonly label: string;
  constructor(label: string) {
    super(
      'E_BUILDER_SECRET',
      `refusing to write — input appears to contain a ${label}. Use $(env:VAR) / \${env:VAR} references instead of pasting secrets.`,
    );
    this.name = 'BuilderSecretLeakError';
    this.label = label;
  }
}

/**
 * Format a Zod issue list into a single-line message. Mirrors the
 * `formatZodError` helper in `@declaragent/core/fleet/manifest-loader`
 * so error strings feel consistent across the stack.
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
