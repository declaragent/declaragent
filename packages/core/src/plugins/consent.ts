import type { PermissionRule } from '../types/permission.js';
import type { PluginStore } from './store.js';

/**
 * Read every consented plugin from the store and return the union of
 * their `consentedPermissions` as `PermissionRule[]` (all `decision: 'allow'`).
 * The REPL merges these into the gate at startup so the user isn't
 * re-prompted for things they already approved at install time.
 *
 * Patterns that don't look like gate targets (e.g. `mcp:github`, used
 * to declare which MCP servers a plugin is allowed to talk to) pass
 * through unchanged — the gate will simply never match them, which is
 * the desired no-op.
 */
export async function consentedPermissionRules(store: PluginStore): Promise<PermissionRule[]> {
  const entries = await store.list();
  const rules: PermissionRule[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.consentedPermissions) continue;
    for (const pattern of entry.consentedPermissions) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      rules.push({ pattern, decision: 'allow' });
    }
  }
  return rules;
}
