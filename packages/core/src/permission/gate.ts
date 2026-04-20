import type {
  PermissionCheckOptions,
  PermissionDecision,
  PermissionGate,
  PermissionMode,
  PermissionRule,
} from '../types/permission.js';
import { compileGlob } from './glob.js';

export interface GateConfig {
  mode: PermissionMode;
  rules: PermissionRule[];
  /**
   * After this many denials in one session, the next denial is escalated.
   * The gate tracks the count; the engine loop decides what to do (default:
   * abort the turn with `permission_escalated`).
   */
  escalateAfterDenials?: number;
}

interface CompiledRule {
  rule: PermissionRule;
  test: (value: string) => boolean;
}

function compile(rules: PermissionRule[]): CompiledRule[] {
  return rules.map((rule) => {
    const regex = compileGlob(rule.pattern);
    return { rule, test: (v) => regex.test(v) };
  });
}

function findMatch(
  compiled: CompiledRule[],
  decision: 'allow' | 'deny',
  value: string,
): PermissionRule | undefined {
  for (const c of compiled) {
    if (c.rule.decision === decision && c.test(value)) {
      return c.rule;
    }
  }
  return undefined;
}

export const DEFAULT_DENIAL_ESCALATION = 3;

export function createPermissionGate(config: GateConfig): PermissionGate {
  const compiled = compile(config.rules);
  const escalateAfter = config.escalateAfterDenials ?? DEFAULT_DENIAL_ESCALATION;
  let denials = 0;

  const gate: PermissionGate = {
    mode: config.mode,

    async check(
      toolName: string,
      key: string,
      options?: PermissionCheckOptions,
    ): Promise<PermissionDecision> {
      const target = `${toolName}:${key}`;
      const isReadonly = options?.readonly === true;

      // Explicit deny beats everything, in every mode.
      const denyRule = findMatch(compiled, 'deny', target);
      if (denyRule) {
        return {
          outcome: 'deny',
          matchedRule: denyRule,
          reason: 'matched deny rule',
        };
      }

      const allowRule = findMatch(compiled, 'allow', target);

      switch (config.mode) {
        case 'bypass':
          // Explicit allow preserved for telemetry; otherwise allow by mode.
          return allowRule
            ? { outcome: 'allow', matchedRule: allowRule }
            : { outcome: 'allow', reason: 'bypass mode' };

        case 'plan':
          if (isReadonly) {
            return allowRule
              ? { outcome: 'allow', matchedRule: allowRule }
              : { outcome: 'prompt', reason: 'plan mode: read-only tool' };
          }
          return {
            outcome: 'deny',
            reason: 'plan mode: writes are disabled',
          };

        case 'auto':
        case 'default':
          if (allowRule) {
            return { outcome: 'allow', matchedRule: allowRule };
          }
          return { outcome: 'prompt', reason: 'no matching rule' };
      }
    },

    recordDenial(_toolName: string): void {
      denials += 1;
    },

    denialsInSession(): number {
      return denials;
    },

    /**
     * Build a child gate with a narrower allow list. Caller is responsible for
     * ensuring `allowSubset` is a true subset of the parent's allows; the gate
     * does not verify containment (glob subset is undecidable in general). All
     * parent deny rules are inherited unconditionally.
     */
    scope({ allowSubset }: { allowSubset: PermissionRule[] }): PermissionGate {
      const denyRules = config.rules.filter((r) => r.decision === 'deny');
      const allowRules = allowSubset.filter((r) => r.decision === 'allow');
      return createPermissionGate({
        mode: config.mode,
        rules: [...denyRules, ...allowRules],
        escalateAfterDenials: escalateAfter,
      });
    },
  };

  return gate;
}

export function shouldEscalate(
  gate: PermissionGate,
  threshold = DEFAULT_DENIAL_ESCALATION,
): boolean {
  return gate.denialsInSession() >= threshold;
}
