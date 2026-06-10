/**
 * WS1 — resolve the runtime tool list + permission gate for a headless
 * runtime (`up`, `fleet run`, daemon) from an agent's declared `tools.defaults`
 * and `permissions.rules`.
 *
 * Before this, every headless runtime handed the model the full built-in set
 * (Read/Write/Edit/Glob/Grep/Bash/Agent) behind a `mode:'bypass'` gate — so an
 * agent that declared `tools.defaults: [Read, Glob, Grep]` still got Bash, and
 * a prompt injection in untrusted input could run arbitrary shell. This module
 * makes the declared set authoritative:
 *
 *   - built-in tools: only those named in `tools.defaults` are exposed; an
 *     unknown built-in name FAILS BOOT (typo protection).
 *   - MCP tools: exposed when they match a declared `mcp__…` glob; a glob that
 *     matches nothing WARNS (an MCP hiccup must not brick boot).
 *   - capability tools (SendMessage / RequestAgent / memory_*) and
 *     plugin-contributed tools are auto-exempt — they are enabled by their own
 *     config (channels / rpc-peers / memory / installed plugins), so they are
 *     always included and allowed without needing a `tools.defaults` entry.
 *
 * The returned gate runs in `'default'` mode: declared/exempt tools get a
 * synthesized `allow` rule, operator `permissions.rules` are appended (an
 * explicit `deny` always wins), and any tool with no matching allow resolves to
 * `prompt` — which a headless runtime (no prompter) treats as a denial.
 */

import {
  type PermissionGate,
  type PermissionRule,
  type Tool,
  createPermissionGate,
  globMatches,
} from '@declaragent/core';
import { BUILTIN_TOOLS } from './builtin-tools.js';

/** Tools enabled by runtime capability config, not by `tools.defaults`. */
export const CAPABILITY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'SendMessage',
  'RequestAgent',
  'memory_read',
  'memory_write',
  'memory_search',
]);

/** Escape hatch: `DECLARAGENT_TOOLS_LEGACY=on` restores pre-WS1 all-tools behavior. */
export const TOOLS_LEGACY_ENV = 'DECLARAGENT_TOOLS_LEGACY';

export interface ResolveRuntimeToolsOptions {
  /** Tool names from `agent.yaml#tools.defaults`. */
  declared: readonly string[];
  /** Permission rules from `agent.yaml#permissions.rules`. */
  permissionRules?: readonly PermissionRule[];
  /** Built-in tools (defaults to {@link BUILTIN_TOOLS}). */
  builtins?: readonly Tool[];
  /** MCP tools, namespaced `mcp__<server>__<tool>`. */
  mcpTools?: readonly Tool[];
  /** Capability + plugin tools — always included and allowed (auto-exempt). */
  extra?: readonly Tool[];
  /** Force legacy all-tools mode (defaults to reading {@link TOOLS_LEGACY_ENV}). */
  legacy?: boolean;
}

export interface ResolveRuntimeToolsResult {
  /** The tool list to hand the engine, ordered builtins → MCP → capability/plugin. */
  tools: Tool[];
  /** The permission gate compiled from the declared set + operator rules. */
  gate: PermissionGate;
  /** Non-fatal advisories (unknown MCP glob, legacy mode, …) for the caller to log. */
  warnings: string[];
}

function isMcpGlob(name: string): boolean {
  return name.startsWith('mcp__');
}

function allowAll(tool: Tool): PermissionRule {
  return { pattern: `${tool.name}:**`, decision: 'allow' };
}

function legacyEnabled(opts: ResolveRuntimeToolsOptions): boolean {
  if (opts.legacy !== undefined) return opts.legacy;
  const v = process.env[TOOLS_LEGACY_ENV];
  return v === 'on' || v === '1' || v === 'true';
}

/**
 * Resolve the runtime tool list + permission gate. Throws
 * {@link AgentToolConfigError} if `tools.defaults` names an unknown built-in.
 */
export function resolveRuntimeTools(opts: ResolveRuntimeToolsOptions): ResolveRuntimeToolsResult {
  const builtins = opts.builtins ?? BUILTIN_TOOLS;
  const mcpTools = opts.mcpTools ?? [];
  const extra = opts.extra ?? [];
  const declared = opts.declared;
  const warnings: string[] = [];

  const builtinByName = new Map(builtins.map((t) => [t.name, t]));
  const extraNames = new Set(extra.map((t) => t.name));

  // Capability/plugin tools are always included + allowed.
  const includedExtra: Tool[] = [...extra];
  const allowRules: PermissionRule[] = extra.map(allowAll);

  // Full-bypass escape hatch for rollout.
  if (legacyEnabled(opts)) {
    const includedBuiltins = builtins.filter((t) => !extraNames.has(t.name));
    warnings.push(
      `${TOOLS_LEGACY_ENV} is set — exposing ALL built-in + MCP tools and bypassing tools.defaults enforcement. Unset it to enforce the declared tool set.`,
    );
    return {
      tools: [...includedBuiltins, ...mcpTools, ...includedExtra],
      gate: createPermissionGate({ mode: 'bypass', rules: [] }),
      warnings,
    };
  }

  const includedBuiltins: Tool[] = [];
  const includedMcp: Tool[] = [];

  if (declared.length === 0) {
    // No tools.defaults: preserve backward compatibility ahead of the 0.8.0
    // default flip, but warn loudly and still build a real (non-bypass) gate.
    for (const t of builtins) {
      if (!extraNames.has(t.name)) {
        includedBuiltins.push(t);
        allowRules.push(allowAll(t));
      }
    }
    for (const t of mcpTools) {
      includedMcp.push(t);
      allowRules.push(allowAll(t));
    }
    warnings.push(
      'agent.yaml declares no tools.defaults — exposing all built-in tools (including Bash/Write/Edit). Declare tools.defaults to restrict the agent; this implicit-all default changes in 0.8.0.',
    );
  } else {
    const unknown: string[] = [];
    const mcpGlobs: string[] = [];
    for (const name of declared) {
      if (isMcpGlob(name)) {
        mcpGlobs.push(name);
        continue;
      }
      const builtin = builtinByName.get(name);
      if (builtin) {
        if (!extraNames.has(name)) includedBuiltins.push(builtin);
        allowRules.push({ pattern: `${name}:**`, decision: 'allow' });
        continue;
      }
      if (CAPABILITY_TOOL_NAMES.has(name) || extraNames.has(name)) {
        // Capability/plugin tool — already included via `extra`; declaring is harmless.
        allowRules.push({ pattern: `${name}:**`, decision: 'allow' });
        continue;
      }
      unknown.push(name);
    }
    if (unknown.length > 0) {
      const knownBuiltins = builtins.map((t) => t.name).join(', ');
      throw new AgentToolConfigError(
        `agent.yaml tools.defaults names unknown tool(s): ${unknown.join(', ')}. Known built-ins: ${knownBuiltins}. MCP tools use a "mcp__<server>__<tool>" glob; capability tools (SendMessage/RequestAgent/memory_*) are auto-enabled.`,
      );
    }
    for (const glob of mcpGlobs) {
      const matched = mcpTools.filter((t) => globMatches(glob, t.name));
      if (matched.length === 0) {
        warnings.push(
          `tools.defaults glob "${glob}" matched no MCP tools (server unavailable, or no such tool).`,
        );
        continue;
      }
      for (const t of matched) {
        if (!includedMcp.includes(t)) {
          includedMcp.push(t);
          allowRules.push(allowAll(t));
        }
      }
    }
  }

  const rules: PermissionRule[] = [...allowRules, ...(opts.permissionRules ?? [])];
  return {
    tools: [...includedBuiltins, ...includedMcp, ...includedExtra],
    gate: createPermissionGate({ mode: 'default', rules }),
    warnings,
  };
}

/** Thrown when `tools.defaults` references a tool name the runtime doesn't know. */
export class AgentToolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentToolConfigError';
  }
}
