import type { ExtensionDescriptor } from '../extension/types.js';
import type { JSONSchema } from '../types/tool.js';

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Free-form regex/glob hints used by future auto-suggest (slice 7+). */
  triggers?: readonly string[];
  /** JSON-schema fragments per input variable. Used by templating + the model's structured input. */
  inputs?: Readonly<Record<string, JSONSchema>>;
  /** Optional structured output schema for the skill's response. */
  outputs?: JSONSchema;
  /** Override the session model just for this skill. */
  model?: string;
}

/** Where a skill came from. Determines descriptor source + lookup namespacing. */
export type SkillTier =
  | { type: 'user' }
  | { type: 'team'; path: string }
  | { type: 'plugin'; pluginId: string; pluginVersion: string }
  | { type: 'built-in' };

export interface Skill {
  /** Registry descriptor (`skill:user:pr-review`, `skill:plugin:foo:bar`, …). */
  descriptor: ExtensionDescriptor & { kind: 'skill' };
  /**
   * The string a user types to invoke the skill. User/team/built-in skills
   * are unqualified (`pr-review`); plugin skills are namespaced
   * (`<plugin-id>:pr-review`).
   */
  lookupName: string;
  tier: SkillTier;
  frontmatter: SkillFrontmatter;
  /** Markdown body (post-frontmatter). Templating happens at run-time. */
  prompt: string;
  /** Absolute path of the source file, surfaced in diagnostics. */
  filePath: string;
}

/** Input to the loader: each entry is one tier on disk. */
export interface SkillSourceLocation {
  tier: SkillTier;
  /** Directory whose `*.md` files become skills. */
  dir: string;
}

export class SkillFrontmatterError extends Error {
  readonly code = 'ESKILLFM';
  constructor(
    public readonly filePath: string,
    message: string,
  ) {
    super(`${filePath}: ${message}`);
    this.name = 'SkillFrontmatterError';
  }
}

export class SkillTemplateError extends Error {
  readonly code = 'ESKILLTPL';
  constructor(message: string) {
    super(message);
    this.name = 'SkillTemplateError';
  }
}

export class SkillNotFoundError extends Error {
  readonly code = 'ENOSKILL';
  readonly skillName: string;
  constructor(skillName: string) {
    super(`skill "${skillName}" not found`);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}
