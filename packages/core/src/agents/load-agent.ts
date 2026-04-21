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
 * Fields we actively consume from `agent.yaml`. The schema is
 * `passthrough()` so scaffolded configs can carry forward-compat
 * keys (channels, sources, plugins refs) without tripping validation
 * — consumers that need those keys add their own loader.
 */
const agentYamlSchema = z
  .object({
    name: z.string().min(1, 'agent.yaml: "name" is required'),
    model: z.string().min(1, 'agent.yaml: "model" is required'),
    systemPrompt: z.string().min(1, 'agent.yaml: "systemPrompt" is required'),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    subagentDepthCap: z.number().int().nonnegative().optional(),
    skills: z.array(z.string()).optional(),
    tools: z
      .object({
        defaults: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AgentYaml = z.infer<typeof agentYamlSchema>;

export interface LoadedAgent {
  readonly spec: AgentSpec;
  readonly skills: readonly Skill[];
  /** Tool names declared under `tools.defaults`. CLI resolves to actual `Tool` objects. */
  readonly toolNames: readonly string[];
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
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    ...(cfg.temperature !== undefined && { temperature: cfg.temperature }),
    ...(cfg.maxTokens !== undefined && { maxTokens: cfg.maxTokens }),
    ...(cfg.subagentDepthCap !== undefined && { subagentDepthCap: cfg.subagentDepthCap }),
  };

  return {
    spec,
    skills: skillLoad.skills,
    toolNames: cfg.tools?.defaults ?? [],
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
