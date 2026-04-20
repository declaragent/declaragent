export type PermissionMode = 'default' | 'plan' | 'bypass' | 'auto';

export interface PermissionRule {
  pattern: string;
  decision: 'allow' | 'deny';
}

export interface PermissionDecision {
  outcome: 'allow' | 'deny' | 'prompt';
  matchedRule?: PermissionRule;
  reason?: string;
}

export interface PermissionCheckOptions {
  readonly?: boolean;
}

export interface PermissionGate {
  readonly mode: PermissionMode;
  check(
    toolName: string,
    key: string,
    options?: PermissionCheckOptions,
  ): Promise<PermissionDecision>;
  recordDenial(toolName: string): void;
  denialsInSession(): number;
  scope(options: { allowSubset: PermissionRule[] }): PermissionGate;
}
