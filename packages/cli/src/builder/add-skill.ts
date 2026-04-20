/**
 * `DeclaraAddSkill` builder tool — the hot path for "give this agent a
 * new skill." See BUILDER_PLAN.md §3.3.
 *
 * Happy path:
 *   1. Validate input against {@link addSkillInputSchema}.
 *   2. Resolve the target agent root (explicit input or scope default).
 *   3. Confirm `agent.yaml` exists there.
 *   4. Assemble frontmatter + body, round-trip through core's
 *      `parseSkillFrontmatter` so we emit exactly what the loader accepts.
 *   5. Reject duplicates (skill file already exists OR already listed
 *      in `agent.yaml`).
 *   6. Reject suspected leaked secrets in the body (phase-1 stub — the
 *      full pattern list moves to `secret-guard.ts` in phase 2).
 *   7. Write `<agentPath>/skills/<name>.md`.
 *   8. When `addToAgentYaml !== false`, surgically append to the
 *      `skills:` sequence via `yaml.parseDocument` so comments + field
 *      ordering in `agent.yaml` survive.
 *
 * @since 0.2.0
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { SkillFrontmatterError, parseSkillFrontmatter } from '@declaragent/core';
import type { Tool, ToolEvent } from '@declaragent/core';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { assertWithinScope } from './scope.js';
import { detectSecret } from './secret-guard.js';
import {
  type AddSkillInput,
  type AddSkillOutput,
  BuilderConflictError,
  BuilderSecretLeakError,
  BuilderValidationError,
  addSkillInputSchema,
  formatZodError,
} from './types.js';

// ── Internal runner (exported for tests) ───────────────────────────────

export interface RunAddSkillOptions {
  /**
   * Scope root resolved for the session. Passed in rather than
   * re-resolved so the tool mirrors how the rest of the runtime threads
   * session-level config through the tool layer.
   */
  scopeRoot: string;
}

export async function runAddSkill(
  input: AddSkillInput,
  options: RunAddSkillOptions,
): Promise<AddSkillOutput> {
  const agentPath = resolve(input.agentPath ?? options.scopeRoot);

  assertWithinScope(agentPath, options.scopeRoot, {
    ...(input.confirmOutsideScope !== undefined && {
      confirmOutsideScope: input.confirmOutsideScope,
    }),
  });

  const agentYamlPath = join(agentPath, 'agent.yaml');
  try {
    const s = await stat(agentYamlPath);
    if (!s.isFile()) {
      throw new BuilderValidationError(`${agentYamlPath} is not a file`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BuilderValidationError(
        `no agent.yaml at ${agentYamlPath} — point agentPath at an agent directory`,
      );
    }
    throw err;
  }

  const skillRelPath = join('skills', `${input.name}.md`);
  const skillAbsPath = join(agentPath, skillRelPath);

  // Scope the skill destination too — a caller can't bypass scope by
  // passing an in-scope agentPath and then a traversal-laden skill name
  // (the name schema already blocks `/` and `.`, but defence in depth).
  assertWithinScope(skillAbsPath, options.scopeRoot, {
    ...(input.confirmOutsideScope !== undefined && {
      confirmOutsideScope: input.confirmOutsideScope,
    }),
  });

  const secret = detectSecret(input.body);
  if (secret) throw new BuilderSecretLeakError(secret.label);

  // Duplicate-file check. We do not want to clobber an existing skill
  // silently — if the model wants to rewrite one, it should go through
  // Edit / Write with user consent.
  try {
    await stat(skillAbsPath);
    throw new BuilderConflictError(
      `skill file already exists at ${skillAbsPath} — delete it first or pick a different name`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const composed = composeSkillFile({
    name: input.name,
    description: input.description,
    ...(input.inputs !== undefined && { inputs: input.inputs }),
    ...(input.outputs !== undefined && { outputs: input.outputs }),
    body: input.body,
  });

  // Round-trip through the core loader. If this rejects, we've emitted
  // something the runtime would refuse at load time — fail early with
  // the loader's own error so the user sees the real reason.
  try {
    parseSkillFrontmatter(composed, skillAbsPath);
  } catch (err) {
    if (err instanceof SkillFrontmatterError) {
      throw new BuilderValidationError(`assembled skill would fail to load: ${err.message}`);
    }
    throw err;
  }

  const writes: string[] = [];

  await mkdir(dirname(skillAbsPath), { recursive: true });
  await writeFile(skillAbsPath, composed, 'utf-8');
  writes.push(skillAbsPath);

  let agentYamlUpdated = false;
  if (input.addToAgentYaml !== false) {
    const { changed } = await appendSkillToAgentYaml(agentYamlPath, skillRelPath);
    if (changed) {
      writes.push(agentYamlPath);
      agentYamlUpdated = true;
    }
  }

  return {
    ok: true,
    writes,
    skillPath: skillAbsPath,
    agentYamlUpdated,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

interface ComposeOptions {
  name: string;
  description: string;
  inputs?: Record<string, Record<string, unknown>>;
  outputs?: Record<string, unknown>;
  body: string;
}

function composeSkillFile(opts: ComposeOptions): string {
  const frontmatter: Record<string, unknown> = {
    name: opts.name,
    description: opts.description,
  };
  if (opts.inputs !== undefined) frontmatter.inputs = opts.inputs;
  if (opts.outputs !== undefined) frontmatter.outputs = opts.outputs;

  const fm = stringifyYaml(frontmatter).trimEnd();
  const body = opts.body.endsWith('\n') ? opts.body : `${opts.body}\n`;
  return `---\n${fm}\n---\n\n${body}`;
}

/**
 * Surgical append to `agent.yaml`'s `skills:` list, preserving comments
 * and surrounding key order via `yaml.parseDocument` (CST-aware).
 *
 * Returns `{ changed: true }` when the file was rewritten. Returns
 * `{ changed: false }` when the target ref was already present — the
 * caller treats this as idempotent, not as an error, because the skill
 * file itself is newly written and the yaml listing is just bookkeeping.
 *
 * Rejects when `skills` exists but is neither null nor a sequence —
 * that's a malformed agent.yaml and we don't want to coerce it
 * silently.
 */
export async function appendSkillToAgentYaml(
  agentYamlPath: string,
  skillRelPath: string,
): Promise<{ changed: boolean }> {
  const raw = await readFile(agentYamlPath, 'utf-8');
  const doc = parseDocument(raw);

  // Parse errors on the agent.yaml we're about to edit — surface the
  // loader's message so the user can fix the upstream problem.
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const detail = first ? first.message : 'unknown parse error';
    throw new BuilderValidationError(`agent.yaml is not valid YAML: ${detail}`);
  }

  const targetRef = normaliseSkillRef(skillRelPath);
  const node = doc.get('skills', true) as unknown;

  if (node === null || node === undefined) {
    doc.set('skills', [targetRef]);
  } else {
    // `isSeq` check via duck-typing — `yaml`'s exported type-guards
    // vary by version, and we only need .items + .add().
    const maybeSeq = node as {
      items?: ReadonlyArray<{ value?: unknown } | unknown>;
      add?: (v: unknown) => void;
    };
    if (!Array.isArray(maybeSeq.items) || typeof maybeSeq.add !== 'function') {
      throw new BuilderValidationError(
        `agent.yaml "skills" must be a YAML list (got ${typeof node})`,
      );
    }
    const existing = maybeSeq.items.map((it) => {
      if (typeof it === 'string') return it;
      if (it && typeof it === 'object' && 'value' in (it as Record<string, unknown>)) {
        return (it as { value: unknown }).value;
      }
      return undefined;
    });
    if (existing.includes(targetRef)) {
      return { changed: false };
    }
    maybeSeq.add(targetRef);
  }

  // yaml's Document stringifier preserves comments + most formatting
  // choices captured during parse. Trailing newline matches the rest
  // of the repo's yaml emission style.
  const next = doc.toString();
  const nextNormalised = next.endsWith('\n') ? next : `${next}\n`;
  await writeFile(agentYamlPath, nextNormalised, 'utf-8');
  return { changed: true };
}

function normaliseSkillRef(skillRelPath: string): string {
  // Keep forward slashes regardless of host separator — the skill
  // loader resolves paths relative to agent.yaml using node:path, but
  // a forward-slash ref is portable and matches every template we ship.
  return skillRelPath.split(/[\\/]/).filter(Boolean).join('/');
}

// ── Public Tool ────────────────────────────────────────────────────────

export interface DeclaraAddSkillContext {
  /** Scope root for this REPL session — set by `register.ts`. */
  scopeRoot: string;
}

/**
 * Build a `Tool` bound to a session's scope root. Registered at REPL
 * startup (behind `DECLARAGENT_BUILDER=on` — see `register.ts`).
 */
export function createAddSkillTool(
  ctx: DeclaraAddSkillContext,
): Tool<AddSkillInput, AddSkillOutput> {
  return {
    name: 'DeclaraAddSkill',
    description:
      'Author a new skill for an agent. Validates frontmatter, writes ' +
      '<agentPath>/skills/<name>.md, and appends the ref to agent.yaml ' +
      '(preserving comments). Refuses to write if the body looks like it contains a secret.',
    inputSchema: {
      type: 'object',
      properties: {
        agentPath: {
          type: 'string',
          description:
            'Absolute path to the target agent root. Defaults to the session scope root.',
        },
        name: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9_-]*$',
          description: 'Skill name — used as the file basename.',
        },
        description: { type: 'string' },
        inputs: { type: 'object' },
        outputs: { type: 'object' },
        body: { type: 'string', description: 'Markdown skill body (post-frontmatter).' },
        addToAgentYaml: { type: 'boolean', default: true },
        confirmOutsideScope: { type: 'boolean', default: false },
      },
      required: ['name', 'description', 'body'],
    },
    readonly: false,
    permissionKey(input) {
      const scopeKey =
        input.agentPath !== undefined
          ? relative(ctx.scopeRoot, resolve(input.agentPath)) || '.'
          : '.';
      return `${scopeKey}:${input.name}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<AddSkillOutput>> {
      const parsed = addSkillInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAddSkill: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        if (toolCtx.abortSignal.aborted) {
          yield { type: 'error', error: { code: 'ABORTED', message: 'DeclaraAddSkill aborted' } };
          return;
        }
        const out = await runAddSkill(parsed.data, { scopeRoot: ctx.scopeRoot });
        yield { type: 'result', output: out };
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code:
              err && typeof err === 'object' && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'E_BUILDER',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
        };
      }
    },
  };
}
