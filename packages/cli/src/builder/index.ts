/**
 * Public entry point for the agent-builder toolkit.
 *
 * Phase 1 exports: types + Zod schemas, scope helpers, git helpers, the
 * `DeclaraAddSkill` tool, and the registration loader. Later phases
 * widen this surface — keep the re-export list flat so `index.ts` is
 * the one place a caller looks.
 *
 * @since 0.2.0
 */

export {
  BuilderConflictError,
  BuilderError,
  BuilderScopeError,
  BuilderSecretLeakError,
  BuilderValidationError,
  addPeerInputSchema,
  addSecretInputSchema,
  addSkillInputSchema,
  agentIdSchema,
  agentUriSchema,
  applyChangeInputSchema,
  auditVerifyInputSchema,
  authPlaybookInputSchema,
  dlqShowInputSchema,
  eventKindSchema,
  eventsTailInputSchema,
  fleetAddInputSchema,
  fleetStatusInputSchema,
  formatZodError,
  jsonSchemaLikeSchema,
  peerTransportInputSchema,
  proposalStepInputSchema,
  proposalStepKindSchema,
  proposeChangeInputSchema,
  secretProviderSchema,
  secretRefSchema,
  skillNameSchema,
} from './types.js';
export type {
  AddPeerInput,
  AddPeerOutput,
  AddSecretInput,
  AddSecretOutput,
  AddSkillInput,
  AddSkillOutput,
  ApplyChangeInput,
  ApplyChangeOutput,
  ApplyStepResult,
  AuditVerifyInput,
  AuditVerifyOutput,
  AuthPlaybookInput,
  AuthPlaybookOutput,
  DlqEntry,
  DlqShowInput,
  DlqShowOutput,
  EventsTailInput,
  EventsTailOutput,
  EventsTailRecord,
  FleetAddInput,
  FleetAddOutput,
  FleetStatusInput,
  FleetStatusOutput,
  ProposeChangeInput,
  ProposeChangeOutput,
  SecretProvider,
} from './types.js';

export {
  assertWithinScope,
  findAgentRoot,
  isWithinScope,
  resolveScopeRoot,
  resolveScopeRootSync,
} from './scope.js';
export type { ScopeCheckOptions } from './scope.js';

export {
  GitUnavailableError,
  captureHead,
  initRepo,
  isGitRepo,
  revertPaths,
  runGitRaw,
} from './git.js';
export type { GitRunResult, InitRepoOptions } from './git.js';

export { appendSkillToAgentYaml, createAddSkillTool, runAddSkill } from './add-skill.js';
export type { DeclaraAddSkillContext, RunAddSkillOptions } from './add-skill.js';

export {
  appendEnvExampleEntry,
  createAddSecretTool,
  deriveEnvVar,
  runAddSecret,
} from './add-secret.js';
export type { DeclaraAddSecretContext, RunAddSecretOptions } from './add-secret.js';

export { createApplyChangeTool } from './apply-change.js';
export type { DeclaraApplyChangeContext } from './apply-change.js';

export { appendPeerEntry, createAddPeerTool, runAddPeer } from './add-peer.js';
export type { DeclaraAddPeerContext, RunAddPeerOptions } from './add-peer.js';

export { createFleetAddTool, runFleetAdd } from './fleet-add.js';
export type { DeclaraFleetAddContext, RunFleetAddOptions } from './fleet-add.js';

export { createProposeChangeTool } from './propose-change.js';
export type { DeclaraProposeChangeContext } from './propose-change.js';

export {
  DEFAULT_PROPOSAL_TTL_MS,
  PROPOSAL_STEP_KINDS,
  ProposalRegistry,
  renderProposal,
} from './proposals.js';
export type {
  AppliedProposalMeta,
  Proposal,
  ProposalEvent,
  ProposalListener,
  ProposalResolution,
  ProposalStatus,
  ProposalStep,
  ProposalStepKind,
  RegisterProposalInput,
} from './proposals.js';

export { createAuthPlaybookTool } from './auth-playbook.js';

export { createAuditVerifyTool, runAuditVerify } from './audit-verify.js';
export type { DeclaraAuditVerifyContext, RunAuditVerifyOptions } from './audit-verify.js';

export { createDlqShowTool, runDlqShow } from './dlq-show.js';
export type { DeclaraDlqShowContext, RunDlqShowOptions } from './dlq-show.js';

export { createEventsTailTool, runEventsTail } from './events-tail.js';
export type { DeclaraEventsTailContext, RunEventsTailOptions } from './events-tail.js';

export { createFleetStatusTool, runFleetStatus } from './fleet-status.js';
export type { DeclaraFleetStatusContext, RunFleetStatusOptions } from './fleet-status.js';

export { runUndo } from './undo.js';
export type { RunUndoOptions, RunUndoOutput } from './undo.js';

export { renderHistory, runHistory } from './history.js';
export type { HistoryEntry, RunHistoryOptions, RunHistoryOutput } from './history.js';

/**
 * Default permission-rule floor for the builder. Blocks the two
 * deploy verbs outright so a rogue model can't `Bash:declaragent
 * deploy ...` straight to prod (BUILDER_PLAN §5.4). Callers merge
 * this into `createPermissionGate({ rules: [...] })`.
 */
export const DEFAULT_DEPLOY_DENY_RULES: ReadonlyArray<{
  pattern: string;
  decision: 'deny';
}> = [
  { pattern: 'Bash:declaragent deploy*', decision: 'deny' },
  { pattern: 'Bash:declaragent fleet deploy*', decision: 'deny' },
];

export {
  AUTH_PLAYBOOKS,
  AUTH_PLAYBOOK_PROVIDERS,
  getAuthPlaybook,
  isAuthPlaybookProvider,
} from './auth-playbooks.js';
export type { AuthPlaybookProvider } from './auth-playbooks.js';

export {
  SECRET_PATTERNS,
  detectSecret,
  formatLeakWarning,
  redactSecrets,
} from './secret-guard.js';
export type { RedactResult, SecretFinding, SecretPattern } from './secret-guard.js';

export { builderEnabled, getBuilderTools } from './register.js';
export type { BuilderRegistrationOptions } from './register.js';

export {
  createRecordingProvider,
  defaultRecordingPath,
  recordingEnabled,
} from './recording-provider.js';
export type {
  RecordedEntry,
  RecordingProviderHandle,
  RecordingProviderOptions,
} from './recording-provider.js';
