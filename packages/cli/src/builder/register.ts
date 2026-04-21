/**
 * Builder-tool loader. Only callers that opt in (REPL with
 * `DECLARAGENT_BUILDER=on`) should include the result in the engine's
 * tool array — a production agent should never load the builder
 * toolkit (BUILDER_PLAN §10, risk "Tool proliferation").
 *
 * Phase 1 registers exactly one tool (`DeclaraAddSkill`). Phases 2–6
 * extend this function to return the full toolkit; the gating + scope
 * plumbing stays here so app.tsx only needs to call `getBuilderTools`
 * once.
 *
 * @since 0.2.0
 */

import type { TenantAuditSink, Tool } from '@declaragent/core';
import { createAddChannelTool } from './add-channel.js';
import { createAddMCPTool } from './add-mcp.js';
import { createAddPeerTool } from './add-peer.js';
import { createAddPluginTool } from './add-plugin.js';
import { createAddSecretTool } from './add-secret.js';
import { createAddSkillTool } from './add-skill.js';
import { createAddSourceTool } from './add-source.js';
import { createApplyChangeTool } from './apply-change.js';
import { createAuditVerifyTool } from './audit-verify.js';
import { createAuthPlaybookTool } from './auth-playbook.js';
import { createDlqShowTool } from './dlq-show.js';
import { createEventsTailTool } from './events-tail.js';
import { createFleetAddTool } from './fleet-add.js';
import { createFleetStatusTool } from './fleet-status.js';
import { ProposalRegistry } from './proposals.js';
import { createProposeChangeTool } from './propose-change.js';

export interface BuilderRegistrationOptions {
  /**
   * Absolute scope root resolved at session startup. See
   * `resolveScopeRoot` in `./scope.ts`.
   */
  scopeRoot: string;
  /**
   * Session-scoped proposal registry. When omitted a fresh one is
   * created — useful for tests / one-off invocations. Production
   * callers (the REPL) pass one in so they can subscribe a listener
   * for rendering and reuse the same state machine across turns.
   */
  registry?: ProposalRegistry;
  /**
   * Audit sink for `DeclaraApplyChange` + `/history`. Optional —
   * tests may leave it undefined. The REPL wires one via
   * `createSqliteAuditSink({ path: auditDbPath() })`.
   */
  auditSink?: TenantAuditSink;
  /** Tenant id for audit records. Defaults to core's `DEFAULT_TENANT_ID`. */
  tenantId?: string;
}

/**
 * True iff the host environment has opted into builder tools. The REPL
 * calls this before deciding whether to expose any builder-only
 * surface. Production deploys default to `false` — builder tools are
 * authoring tools, not runtime tools.
 */
export function builderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DECLARAGENT_BUILDER === 'on';
}

/**
 * Returns the builder tools, each pre-bound to the session's scope
 * root. Returns an empty array when {@link builderEnabled} is false so
 * the caller can always `.concat(getBuilderTools(...))` safely.
 */
export function getBuilderTools(options: BuilderRegistrationOptions): Tool[] {
  if (!builderEnabled()) return [];
  const registry = options.registry ?? new ProposalRegistry();
  return [
    createAddSkillTool({ scopeRoot: options.scopeRoot }),
    createAddSecretTool({ scopeRoot: options.scopeRoot }),
    createAddSourceTool({ scopeRoot: options.scopeRoot }),
    createAddChannelTool({ scopeRoot: options.scopeRoot }),
    createAddMCPTool({ scopeRoot: options.scopeRoot }),
    createAddPluginTool({ scopeRoot: options.scopeRoot }),
    createAuthPlaybookTool(),
    createProposeChangeTool({ registry }),
    createApplyChangeTool({
      registry,
      scopeRoot: options.scopeRoot,
      ...(options.auditSink !== undefined && { auditSink: options.auditSink }),
      ...(options.tenantId !== undefined && { tenantId: options.tenantId }),
    }),
    createFleetAddTool({ scopeRoot: options.scopeRoot }),
    createAddPeerTool({ scopeRoot: options.scopeRoot }),
    createEventsTailTool(),
    createFleetStatusTool({ scopeRoot: options.scopeRoot }),
    createAuditVerifyTool(),
    createDlqShowTool(),
  ];
}
