import {
  existsSync,
  mkdirSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultTemplatesDir } from './fleet-add-cli.js';

/**
 * Single-agent starter templates that `declaragent init` can scaffold.
 *
 * Each name maps 1:1 to a directory under the repo's `templates/<name>/`
 * (shipped inside the npm package by the prepack copy step). The unpacker
 * copies that directory's real contents into the user's `outDir` — there
 * are no hardcoded stubs.
 *
 * The one-line descriptions below are kept inline (not read from disk) so
 * the Ink template picker can render synchronously and offline.
 */
export const TEMPLATE_NAMES = [
  'concierge',
  'oncall-escalator',
  'pr-review',
  'kafka-pipeline',
  'multi-tenant-starter',
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export function isTemplateName(value: string): value is TemplateName {
  return (TEMPLATE_NAMES as readonly string[]).includes(value);
}

/**
 * One-line descriptions for the template picker. Kept here (rather than
 * read from each template's README) so {@link listTemplates} and
 * {@link getTemplateDescription} stay pure + offline — the Ink picker
 * calls them synchronously during render.
 */
const TEMPLATE_DESCRIPTIONS: Record<TemplateName, string> = {
  concierge: 'Minimal Slack Q&A bot. One channel, one skill.',
  'oncall-escalator': 'Alertmanager webhook → Slack DM on-call escalator.',
  'pr-review': 'GitHub PR reviewer that posts inline comments.',
  'kafka-pipeline': 'Kafka source + JSON-path routing + daily token budget.',
  'multi-tenant-starter': 'Per-tenant routing + quotas + residency primitives.',
};

export function listTemplates(): ReadonlyArray<{ name: TemplateName; description: string }> {
  return TEMPLATE_NAMES.map((name) => ({ name, description: TEMPLATE_DESCRIPTIONS[name] }));
}

export function getTemplateDescription(name: TemplateName): string {
  return TEMPLATE_DESCRIPTIONS[name];
}

/** A directory entry returned by {@link UnpackFS.readdir}. */
export interface UnpackDirEntry {
  name: string;
  isFile: boolean;
  isDir: boolean;
}

/**
 * Minimal FS surface the unpacker needs. Tests inject an in-memory map.
 *
 * `readFile`/`readdir`/`isDir` are required to copy a real template tree;
 * `DEFAULT_FS` implements them over `node:fs`.
 */
export interface UnpackFS {
  exists: (path: string) => boolean;
  writeFile: (path: string, contents: string) => void;
  readFile: (path: string) => string;
  readdir: (path: string) => readonly UnpackDirEntry[];
  /** True iff `path` is a directory. */
  isDir: (path: string) => boolean;
}

const DEFAULT_FS: UnpackFS = {
  exists: (p) => existsSync(p),
  writeFile: (p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    nodeWriteFileSync(p, c, 'utf8');
  },
  readFile: (p) => nodeReadFileSync(p, 'utf8'),
  readdir: (p) =>
    readdirSync(p, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDir: entry.isDirectory(),
    })),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

export interface UnpackOptions {
  template: TemplateName;
  outDir: string;
  providerId: string;
  /** Env var for the chosen provider (e.g. `ANTHROPIC_API_KEY`). */
  providerEnvVar: string;
  force: boolean;
  multiTenant: boolean;
  /** Used only when `multiTenant` is true. */
  tenantId?: string;
  /**
   * Override the templates root directory. Defaults to
   * {@link defaultTemplatesDir} so installed packages resolve their
   * bundled `templates/` and the monorepo resolves the repo-root source.
   * Tests inject a fixture root.
   */
  templatesDir?: string;
}

export interface UnpackResult {
  written: string[];
  skipped: string[];
}

export class TemplateUnpackError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'TemplateUnpackError';
  }
}

/**
 * Copy the real `templates/<template>/` tree into `outDir`.
 *
 * Pure except for the injected `fs` handle — tests pass a fake backed by
 * a `Map`. The set of files written is whatever the template ships, so a
 * template gains/loses files without touching this code.
 *
 * Transformations applied while copying:
 *  - `{{provider}}` / `{{envVar}}` tokens are substituted **defensively**:
 *    real templates carry no placeholders, so verbatim copies are the
 *    norm, but a template may opt in to either token and it Just Works.
 *  - When `multiTenant` and a `tenants.yaml` is shipped, an explicit
 *    `opts.tenantId` rewrites the first `id:` entry so the picker's
 *    tenant choice is reflected. Non-multi-tenant runs skip `tenants.yaml`.
 *  - A project-scope `.mcp.json` is written **only if the template does
 *    not ship one**, preserving the prior "git-tracked MCP server list"
 *    affordance without clobbering a template-provided config.
 *
 * Idempotency: every target is checked with `exists`; unless `force`, any
 * collision aborts with `TemplateUnpackError` before the first write.
 */
export function unpackTemplate(opts: UnpackOptions, fs: UnpackFS = DEFAULT_FS): UnpackResult {
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir();
  const templateDir = join(templatesDir, opts.template);
  if (!fs.isDir(templateDir)) {
    throw new TemplateUnpackError(
      `template "${opts.template}" not found at ${templateDir}. Reinstall @declaragent/cli or pass an explicit templatesDir.`,
      templateDir,
    );
  }

  // Walk the real template tree into a flat list of {relative, contents}.
  const files = collectTemplateFiles(templateDir, fs);

  const targets: Array<{ path: string; contents: string }> = [];
  let shipsTenantsYaml = false;
  let shipsMcpJson = false;

  for (const file of files) {
    if (file.rel === 'tenants.yaml') {
      shipsTenantsYaml = true;
      // Only emit tenants.yaml in multi-tenant mode; single-tenant
      // scaffolds intentionally omit it.
      if (!opts.multiTenant) continue;
      const contents =
        opts.tenantId !== undefined
          ? rewriteFirstTenantId(file.contents, opts.tenantId)
          : file.contents;
      targets.push({ path: join(opts.outDir, file.rel), contents });
      continue;
    }
    if (file.rel === '.mcp.json') shipsMcpJson = true;
    targets.push({
      path: join(opts.outDir, file.rel),
      contents: applyPlaceholders(file.contents, opts.providerId, opts.providerEnvVar),
    });
  }

  // If multi-tenant was requested but the template ships no tenants.yaml,
  // surface a clear error rather than silently producing a non-tenant
  // scaffold.
  if (opts.multiTenant && !shipsTenantsYaml) {
    throw new TemplateUnpackError(
      `template "${opts.template}" does not ship a tenants.yaml — pick the multi-tenant-starter template for multi-tenant mode.`,
      join(templateDir, 'tenants.yaml'),
    );
  }

  // Preserve the prior "empty project-scope MCP config" affordance, but
  // never clobber a template-provided .mcp.json.
  if (!shipsMcpJson) {
    targets.push({
      path: join(opts.outDir, '.mcp.json'),
      contents: `${JSON.stringify({ version: 1, servers: [] }, null, 2)}\n`,
    });
  }

  if (!opts.force) {
    for (const t of targets) {
      if (fs.exists(t.path)) {
        throw new TemplateUnpackError(
          `refusing to overwrite "${t.path}" — pass --force to replace it.`,
          t.path,
        );
      }
    }
  }

  const written: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    if (!opts.force && fs.exists(t.path)) {
      skipped.push(t.path);
      continue;
    }
    fs.writeFile(t.path, t.contents);
    written.push(t.path);
  }
  return { written, skipped };
}

/** Recursively read every file under `dir`, returning POSIX-relative paths. */
function collectTemplateFiles(dir: string, fs: UnpackFS): Array<{ rel: string; contents: string }> {
  const out: Array<{ rel: string; contents: string }> = [];
  const walk = (current: string, relBase: string): void => {
    for (const entry of fs.readdir(current)) {
      const childAbs = join(current, entry.name);
      const childRel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDir) {
        walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile) continue; // skip symlinks / devices
      out.push({ rel: childRel, contents: fs.readFile(childAbs) });
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Substitute `{{provider}}`/`{{envVar}}` tokens when present. Real
 * templates carry none, so this is a no-op for them; kept so a template
 * can opt in without a code change.
 */
function applyPlaceholders(contents: string, providerId: string, providerEnvVar: string): string {
  let out = contents;
  if (out.includes('{{provider}}')) out = out.replaceAll('{{provider}}', providerId);
  if (out.includes('{{envVar}}')) out = out.replaceAll('{{envVar}}', providerEnvVar);
  return out;
}

/**
 * Rewrite the value of the first `id:` line in a shipped `tenants.yaml`
 * so the picker's tenant choice is reflected. Mirrors the surgical,
 * text-preserving rewrites in fleet-scaffold.ts.
 */
function rewriteFirstTenantId(yamlText: string, tenantId: string): string {
  // Match the first `- id: <value>` (indented list entry under tenants:).
  const re = /^(\s*-\s*id:\s*)[^\n]*$/m;
  if (re.test(yamlText)) {
    return yamlText.replace(re, `$1${tenantId}`);
  }
  // Fallback for a flat `id:` key.
  const flat = /^(\s*id:\s*)[^\n]*$/m;
  if (flat.test(yamlText)) {
    return yamlText.replace(flat, `$1${tenantId}`);
  }
  return yamlText;
}
