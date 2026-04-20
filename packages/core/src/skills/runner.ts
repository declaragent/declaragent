import type { ExtensionRegistry } from '../extension/types.js';
import type { HookRegistry } from '../hooks/types.js';
import type { RunAgent, RunAgentResult, TurnContext } from '../types/agent.js';
import type { SessionHandle } from '../types/session.js';
import { interpolate } from './template.js';
import { type Skill, SkillNotFoundError } from './types.js';

export interface RunSkillOptions {
  /** Registry to look the skill up in. Slice 6 populates this from disk + plugins. */
  registry: ExtensionRegistry;
  /** Variables for `{{var}}` interpolation against the skill prompt. */
  inputs?: Readonly<Record<string, unknown>>;
  /** Optional hook registry; receives `skill.before` / `skill.after`. */
  hooks?: HookRegistry;
  /** Engine entry point. Provided by the host (CLI, slice 7). */
  runAgent: RunAgent;
  /** Sub-agent session factory. The skill runs as a child of the caller's turn. */
  createChildSession: () => SessionHandle;
  /** Caller's turn context — used so sub-agent telemetry attributes back. */
  turn: TurnContext;
}

/**
 * Invoke a skill by name. Steps:
 *   1. Resolve the skill via `registry.byKind('skill')` (lookup-name match).
 *   2. Fire `skill.before` — its `inputs` override (if any) replaces ours.
 *   3. Render `prompt` with the (possibly overridden) inputs.
 *   4. Spawn a sub-agent via `runAgent` with the rendered prompt as the user message.
 *      If the skill declared a `model`, the child session's spec uses it.
 *   5. Fire `skill.after` with the result and elapsed time.
 */
export async function runSkill(name: string, options: RunSkillOptions): Promise<RunAgentResult> {
  const skill = lookupSkill(options.registry, name);
  if (!skill) throw new SkillNotFoundError(name);

  let inputs: Readonly<Record<string, unknown>> = options.inputs ?? {};
  if (options.hooks) {
    const override = await options.hooks.fire('skill.before', {
      name: skill.lookupName,
      inputs,
      turn: options.turn,
    });
    if (override?.inputs) inputs = override.inputs;
  }

  const rendered = interpolate(skill.prompt, inputs);
  const childSession = options.createChildSession();

  if (skill.frontmatter.model) {
    await childSession.updateSpec({ model: skill.frontmatter.model });
  }

  const started = performance.now();
  const result = await options.runAgent({
    session: childSession,
    userMessage: rendered,
    depth: options.turn.depth + 1,
    causedBy: `skill:${skill.lookupName}`,
  });
  const durationMs = performance.now() - started;

  if (options.hooks) {
    await options.hooks.fire('skill.after', {
      name: skill.lookupName,
      inputs,
      output: result.lastAssistantMessage?.content ?? null,
      durationMs,
      turn: options.turn,
    });
  }

  return result;
}

export function lookupSkill(registry: ExtensionRegistry, name: string): Skill | undefined {
  for (const ext of registry.byKind('skill')) {
    if (ext.payload.lookupName === name) return ext.payload;
  }
  return undefined;
}
