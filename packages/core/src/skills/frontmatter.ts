import { parse as parseYAML } from 'yaml';
import type { JSONSchema } from '../types/tool.js';
import { type SkillFrontmatter, SkillFrontmatterError } from './types.js';

/**
 * Split a markdown file into YAML frontmatter (between leading `---`
 * fences) and the body. If no fence is present, returns the whole input
 * as the body and `null` frontmatter.
 *
 * Mirrors the de-facto convention used by gray-matter / Jekyll / Astro
 * but without the heavyweight dep — the format we accept is constrained
 * (leading fences, no escape sequences in fences).
 */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  // Allow an optional UTF-8 BOM + optional leading whitespace before the
  // opening fence so editors that normalize files don't break the parse.
  const stripped = raw.replace(/^\uFEFF/, '');
  if (!stripped.startsWith('---')) {
    return { frontmatter: null, body: raw };
  }
  // Match `---` then a newline, capture until the next `---` on its own line.
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: null, body: raw };
  }
  const fm = match[1] ?? '';
  const body = stripped.slice(match[0].length);
  return { frontmatter: fm, body };
}

export function parseSkillFrontmatter(
  raw: string,
  filePath: string,
): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === null) {
    throw new SkillFrontmatterError(
      filePath,
      'missing YAML frontmatter (file must start with `---`)',
    );
  }
  let data: unknown;
  try {
    data = parseYAML(frontmatter);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillFrontmatterError(filePath, `invalid YAML: ${message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new SkillFrontmatterError(filePath, 'frontmatter must be a YAML mapping');
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new SkillFrontmatterError(filePath, 'missing required string field "name"');
  }
  if (typeof obj.description !== 'string') {
    throw new SkillFrontmatterError(filePath, 'missing required string field "description"');
  }

  const fm: SkillFrontmatter = {
    name: obj.name,
    description: obj.description,
  };

  if (obj.triggers !== undefined) {
    if (!Array.isArray(obj.triggers) || !obj.triggers.every((t) => typeof t === 'string')) {
      throw new SkillFrontmatterError(filePath, '"triggers" must be a list of strings');
    }
    fm.triggers = obj.triggers as string[];
  }

  if (obj.inputs !== undefined) {
    if (typeof obj.inputs !== 'object' || obj.inputs === null || Array.isArray(obj.inputs)) {
      throw new SkillFrontmatterError(filePath, '"inputs" must be a YAML mapping');
    }
    const inputs: Record<string, JSONSchema> = {};
    for (const [k, v] of Object.entries(obj.inputs as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new SkillFrontmatterError(filePath, `inputs.${k} must be a JSON-schema mapping`);
      }
      inputs[k] = v as JSONSchema;
    }
    fm.inputs = inputs;
  }

  if (obj.outputs !== undefined) {
    if (typeof obj.outputs !== 'object' || obj.outputs === null) {
      throw new SkillFrontmatterError(filePath, '"outputs" must be a JSON-schema mapping');
    }
    fm.outputs = obj.outputs as JSONSchema;
  }

  if (obj.model !== undefined) {
    if (typeof obj.model !== 'string') {
      throw new SkillFrontmatterError(filePath, '"model" must be a string');
    }
    fm.model = obj.model;
  }

  return { frontmatter: fm, body: body.trimStart() };
}
