/**
 * Pure scaffolding helpers for `declaragent init --fleet` and
 * `declaragent fleet add`. The functions here own the "what files does a
 * new fleet (or a new agent added to one) look like" question; the CLI
 * verbs on top just glue parsing to these helpers.
 *
 * Every function takes a minimal FS surface so tests can run against a
 * tmpdir (or an in-memory shim) without monkey-patching fs.
 *
 * @since 1.2.0
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * File-system surface used by the scaffolder. Production callers pass
 * {@link DEFAULT_FLEET_FS}; tests inject a memory-backed shim.
 */
export interface FleetFS {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  readdir: (path: string) => readonly { name: string; isFile: boolean; isDir: boolean }[];
  /** True iff `path` is a directory. */
  isDir: (path: string) => boolean;
}

export const DEFAULT_FLEET_FS: FleetFS = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, 'utf-8'),
  writeFile: (p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c, 'utf-8');
  },
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

export class FleetScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetScaffoldError';
  }
}

// ── Scaffold a new fleet ───────────────────────────────────────────────

export interface ScaffoldFleetOptions {
  /** Absolute path at which to create the fleet root. */
  root: string;
  /** Fleet name — populated into `fleet.yaml` and root `package.json`. */
  name: string;
  /**
   * When true, overwrite any pre-existing scaffolded files. Default
   * false — the scaffolder aborts rather than clobber a populated dir.
   */
  force?: boolean;
  /**
   * `@declaragent/core` semver range to pin into the scaffold's
   * `package.json`. Default `^1.2.0` per FLEET_PLAN.md §4.1.
   */
  coreVersion?: string;
}

export interface ScaffoldFleetResult {
  /** Files we wrote, relative paths for human output. */
  written: readonly string[];
  /** Files that already existed + were left alone (force=false only). */
  skipped: readonly string[];
}

/**
 * Create a new fleet at `root`. Writes the minimum complete scaffold
 * from FLEET_PLAN.md §2:
 *
 *   fleet.yaml, package.json, .gitignore, .env.example, rpc-peers.yaml,
 *   README.md, + empty `agents/.gitkeep`.
 *
 * `bun install`, lockfile creation, and other out-of-process work stay
 * out of this helper — the CLI layer decides when to run them.
 */
export function scaffoldFleet(
  options: ScaffoldFleetOptions,
  fs: FleetFS = DEFAULT_FLEET_FS,
): ScaffoldFleetResult {
  if (!isAbsolute(options.root)) {
    throw new FleetScaffoldError(`scaffoldFleet: root must be absolute, got "${options.root}"`);
  }
  if (!isFleetName(options.name)) {
    throw new FleetScaffoldError(
      `scaffoldFleet: fleet name "${options.name}" must be a URL-safe identifier (a-z0-9-_)`,
    );
  }

  const coreVersion = options.coreVersion ?? '^1.2.0';
  const targets: Array<{ path: string; contents: string }> = [
    { path: join(options.root, 'fleet.yaml'), contents: renderFleetManifest(options.name) },
    {
      path: join(options.root, 'package.json'),
      contents: `${JSON.stringify(renderRootPackageJson(options.name, coreVersion), null, 2)}\n`,
    },
    { path: join(options.root, '.gitignore'), contents: FLEET_GITIGNORE },
    { path: join(options.root, '.env.example'), contents: FLEET_ENV_EXAMPLE },
    { path: join(options.root, 'rpc-peers.yaml'), contents: FLEET_RPC_PEERS_STUB },
    { path: join(options.root, 'README.md'), contents: renderFleetReadme(options.name) },
    { path: join(options.root, 'agents', '.gitkeep'), contents: '' },
  ];

  if (!options.force) {
    // Refuse to overwrite fleet.yaml or package.json if either already
    // exists — those two are the ones operators invest work in. The
    // other stubs are treated as "skip but don't abort" below.
    for (const critical of ['fleet.yaml', 'package.json']) {
      const p = join(options.root, critical);
      if (fs.exists(p)) {
        throw new FleetScaffoldError(
          `refusing to overwrite ${p} — pass --force to replace the existing scaffold.`,
        );
      }
    }
  }

  const written: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    if (!options.force && fs.exists(t.path)) {
      skipped.push(t.path);
      continue;
    }
    fs.writeFile(t.path, t.contents);
    written.push(t.path);
  }
  return { written, skipped };
}

// ── Add an agent to an existing fleet ──────────────────────────────────

export interface AddAgentOptions {
  /** Absolute path to the fleet root (the dir containing `fleet.yaml`). */
  fleetRoot: string;
  /**
   * Template name (key into `templatesDir`). If the template's
   * `agent.yaml` declares `name: X` we use X as the default id.
   */
  template: string;
  /** Absolute path to the templates directory. */
  templatesDir: string;
  /**
   * Override the id. Must match `/^[a-z0-9][a-z0-9_-]*$/i`. When
   * supplied, we rewrite `agent.yaml → name` + `capabilities.yaml → agent`.
   */
  id?: string;
  force?: boolean;
}

export interface AddAgentResult {
  /** Absolute path to the new agent directory. */
  agentPath: string;
  /** Final id used for the agent entry (either `options.id` or the template's name). */
  agentId: string;
  /** Files we wrote under the agent dir. */
  written: readonly string[];
  /** The updated `fleet.yaml` path (always `fleetRoot/fleet.yaml`). */
  manifestPath: string;
}

export function addAgentFromTemplate(
  options: AddAgentOptions,
  fs: FleetFS = DEFAULT_FLEET_FS,
): AddAgentResult {
  const fleetRoot = options.fleetRoot;
  if (!isAbsolute(fleetRoot)) {
    throw new FleetScaffoldError(
      `addAgentFromTemplate: fleetRoot must be absolute, got "${fleetRoot}"`,
    );
  }
  const manifestPath = join(fleetRoot, 'fleet.yaml');
  if (!fs.exists(manifestPath)) {
    throw new FleetScaffoldError(
      `addAgentFromTemplate: no fleet.yaml at ${manifestPath} (run \`declaragent init --fleet <name>\` first)`,
    );
  }

  const templateDir = pathResolve(options.templatesDir, options.template);
  if (!fs.exists(templateDir) || !fs.isDir(templateDir)) {
    throw new FleetScaffoldError(
      `addAgentFromTemplate: template "${options.template}" not found at ${templateDir}`,
    );
  }

  // Discover the template's declared name from its agent.yaml — used as
  // the default agent id when the caller doesn't override.
  const templateAgentYamlPath = join(templateDir, 'agent.yaml');
  if (!fs.exists(templateAgentYamlPath)) {
    throw new FleetScaffoldError(
      `addAgentFromTemplate: template "${options.template}" has no agent.yaml`,
    );
  }
  const templateAgentYaml = fs.readFile(templateAgentYamlPath);
  const templateName = readNameField(templateAgentYaml);
  const agentId = options.id ?? templateName;
  if (!isAgentId(agentId)) {
    throw new FleetScaffoldError(
      `addAgentFromTemplate: agent id "${agentId}" must be a URL-safe identifier`,
    );
  }

  // Parse the current manifest + check for id collision.
  const manifestText = fs.readFile(manifestPath);
  const parsedManifest = parseYaml(manifestText);
  if (!isManifestShape(parsedManifest)) {
    throw new FleetScaffoldError(
      `addAgentFromTemplate: ${manifestPath} is not a valid fleet manifest (missing agents[])`,
    );
  }
  const existing = parsedManifest.agents?.find((a) => a.id === agentId);
  if (existing) {
    throw new FleetScaffoldError(
      `addAgentFromTemplate: fleet already has an agent with id "${agentId}" at ${existing.path}`,
    );
  }

  const agentPath = join(fleetRoot, 'agents', agentId);
  if (!options.force && fs.exists(agentPath)) {
    throw new FleetScaffoldError(
      `addAgentFromTemplate: refusing to overwrite ${agentPath} — pass --force to replace it.`,
    );
  }

  // Walk the template tree and write every file into the agent dir,
  // rewriting `name:`/`agent:` as needed.
  const written: string[] = [];
  copyDir(
    templateDir,
    agentPath,
    fs,
    (relPath, contents) => {
      if (relPath === 'agent.yaml') {
        return rewriteAgentYamlName(contents, agentId);
      }
      if (relPath === 'capabilities.yaml') {
        return rewriteCapabilitiesAgent(contents, agentId);
      }
      return contents;
    },
    written,
  );

  // Append the agent entry to `fleet.yaml`. We take a surgical, text-
  // preserving approach: append a new block under the existing
  // `agents:` key so comments + formatting in the file are retained.
  const updatedManifest = appendAgentEntry(manifestText, agentId, `./agents/${agentId}`);
  fs.writeFile(manifestPath, updatedManifest);

  return { agentPath, agentId, written, manifestPath };
}

// ── Add an existing directory as a fleet agent ─────────────────────────

export interface AddAgentFromPathOptions {
  fleetRoot: string;
  /** Absolute path to the existing single-agent directory. */
  sourceDir: string;
  /** Explicit id; defaults to the source agent.yaml's `name` field. */
  id?: string;
  force?: boolean;
}

export function addAgentFromPath(
  options: AddAgentFromPathOptions,
  fs: FleetFS = DEFAULT_FLEET_FS,
): AddAgentResult {
  if (!isAbsolute(options.fleetRoot)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: fleetRoot must be absolute, got "${options.fleetRoot}"`,
    );
  }
  if (!isAbsolute(options.sourceDir)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: sourceDir must be absolute, got "${options.sourceDir}"`,
    );
  }
  if (!fs.exists(options.sourceDir) || !fs.isDir(options.sourceDir)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: source directory ${options.sourceDir} does not exist`,
    );
  }
  const sourceAgentYaml = join(options.sourceDir, 'agent.yaml');
  if (!fs.exists(sourceAgentYaml)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: ${options.sourceDir} has no agent.yaml — not a single-agent directory`,
    );
  }
  const manifestPath = join(options.fleetRoot, 'fleet.yaml');
  if (!fs.exists(manifestPath)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: no fleet.yaml at ${manifestPath} (run \`declaragent init --fleet <name>\` first)`,
    );
  }

  const sourceName = readNameField(fs.readFile(sourceAgentYaml));
  const agentId = options.id ?? sourceName;
  if (!isAgentId(agentId)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: agent id "${agentId}" must be a URL-safe identifier`,
    );
  }

  const manifestText = fs.readFile(manifestPath);
  const parsedManifest = parseYaml(manifestText);
  if (!isManifestShape(parsedManifest)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: ${manifestPath} is not a valid fleet manifest (missing agents[])`,
    );
  }
  if (parsedManifest.agents?.some((a) => a.id === agentId)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: fleet already has an agent with id "${agentId}"`,
    );
  }

  const agentPath = join(options.fleetRoot, 'agents', agentId);
  if (!options.force && fs.exists(agentPath)) {
    throw new FleetScaffoldError(
      `addAgentFromPath: refusing to overwrite ${agentPath} — pass --force to replace it.`,
    );
  }

  const written: string[] = [];
  copyDir(
    options.sourceDir,
    agentPath,
    fs,
    (relPath, contents) => {
      if (relPath === 'agent.yaml') return rewriteAgentYamlName(contents, agentId);
      if (relPath === 'capabilities.yaml') return rewriteCapabilitiesAgent(contents, agentId);
      return contents;
    },
    written,
  );

  const updatedManifest = appendAgentEntry(manifestText, agentId, `./agents/${agentId}`);
  fs.writeFile(manifestPath, updatedManifest);

  return { agentPath, agentId, written, manifestPath };
}

// ── Internals ──────────────────────────────────────────────────────────

function copyDir(
  src: string,
  dest: string,
  fs: FleetFS,
  rewrite: (relPath: string, contents: string) => string,
  writtenOut: string[],
  relBase = '',
): void {
  for (const entry of fs.readdir(src)) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDir) {
      copyDir(from, to, fs, rewrite, writtenOut, rel);
      continue;
    }
    if (!entry.isFile) continue; // skip symlinks / devices
    const raw = fs.readFile(from);
    const rewritten = rewrite(rel, raw);
    fs.writeFile(to, rewritten);
    writtenOut.push(to);
  }
}

function readNameField(yamlText: string): string {
  // Shallow parse — we only need the top-level `name:` field.
  const parsed = parseYaml(yamlText);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const name = (parsed as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  throw new FleetScaffoldError('template agent.yaml is missing a top-level `name:` field');
}

function rewriteAgentYamlName(yamlText: string, newName: string): string {
  // Find the first top-level (column-0) `name:` and rewrite its value.
  // Nested occurrences inside string-literal blocks are preserved by
  // the column-0 anchor.
  const re = /^name:\s*[^\n]*$/m;
  if (!re.test(yamlText)) {
    throw new FleetScaffoldError(
      'agent.yaml has no top-level `name:` line — refusing to rewrite blindly',
    );
  }
  return yamlText.replace(re, `name: ${newName}`);
}

function rewriteCapabilitiesAgent(yamlText: string, newId: string): string {
  const re = /^agent:\s*[^\n]*$/m;
  if (!re.test(yamlText)) {
    throw new FleetScaffoldError(
      'capabilities.yaml has no top-level `agent:` line — refusing to rewrite blindly',
    );
  }
  return yamlText.replace(re, `agent: agent://${newId}`);
}

interface ParsedManifestShape {
  agents?: Array<{ id?: unknown; path?: unknown }>;
}

function isManifestShape(value: unknown): value is ParsedManifestShape {
  if (!value || typeof value !== 'object') return false;
  const agents = (value as { agents?: unknown }).agents;
  if (agents === undefined) return false;
  return Array.isArray(agents);
}

/**
 * Append `{ id, path }` to the `agents:` list, preserving trailing
 * comments, blank lines, and formatting in the rest of the file. The
 * rewrite keeps the original file shape intact for review-friendly
 * diffs — a full YAML round-trip would reformat the whole document.
 */
function appendAgentEntry(manifestText: string, id: string, path: string): string {
  // Strategy: find the line starting with `agents:`. Walk forward from
  // there until we hit a line that (a) is at column 0 and (b) doesn't
  // start with `#`, `agents`, or whitespace. Insert the new block right
  // before that line. If we hit EOF, append at the end.
  const lines = manifestText.split('\n');

  // Two shapes to handle:
  //   (a) `agents: []`      — freshly-scaffolded empty fleet. Replace
  //       that single line with a multi-line block.
  //   (b) `agents:` + list  — existing fleet with ≥ 1 entry. Insert
  //       before the first non-indented line after the block.
  const emptyIdx = lines.findIndex((line) => /^agents:\s*\[\s*\]\s*$/.test(line));
  if (emptyIdx !== -1) {
    const replacement = ['agents:', `  - id: ${id}`, `    path: ${path}`];
    return [...lines.slice(0, emptyIdx), ...replacement, ...lines.slice(emptyIdx + 1)].join('\n');
  }

  const agentsIdx = lines.findIndex((line) => /^agents:\s*$/.test(line));
  if (agentsIdx === -1) {
    throw new FleetScaffoldError(
      'fleet.yaml has no top-level `agents:` block — refusing to rewrite.',
    );
  }

  // Find the insertion point: the first line after agentsIdx that is
  // either EOF, or a column-0 non-comment key (signaling we've left the
  // agents block).
  let insertAt = lines.length;
  for (let i = agentsIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.length === 0) continue; // blank lines inside the list are fine
    const isListItem = /^\s+-\s/.test(line) || /^\s/.test(line);
    const isComment = line.startsWith('#');
    if (isListItem || isComment) continue;
    insertAt = i;
    break;
  }

  const block = [`  - id: ${id}`, `    path: ${path}`, ''];
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);

  // Make sure there's a trailing newline between the old content + new
  // block if the preceding line isn't already blank.
  if (before.length > 0 && before[before.length - 1] !== '') {
    before.push('');
  }
  return [...before, ...block, ...after].join('\n');
}

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
function isAgentId(value: string): boolean {
  return AGENT_ID_RE.test(value);
}

const FLEET_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
function isFleetName(value: string): boolean {
  return FLEET_NAME_RE.test(value);
}

// ── Stub contents for a freshly scaffolded fleet ───────────────────────

function renderFleetManifest(name: string): string {
  return `version: 1
name: ${name}
description: "Fleet scaffolded by \`declaragent init --fleet\`."

agents: []

environments:
  default:
    peersRef: ./rpc-peers.yaml
`;
}

function renderRootPackageJson(name: string, coreVersion: string): Record<string, unknown> {
  return {
    name,
    private: true,
    type: 'module',
    workspaces: ['agents/*'],
    scripts: {
      'fleet:run': 'declaragent fleet run',
      'fleet:validate': 'declaragent fleet validate',
      'fleet:deploy': 'declaragent fleet deploy',
      'fleet:list': 'declaragent fleet list',
    },
    dependencies: {
      '@declaragent/core': coreVersion,
    },
  };
}

function renderFleetReadme(name: string): string {
  return `# ${name}

Fleet scaffolded by \`declaragent init --fleet ${name}\`.

## Next steps

1. Add your first agent:
   \`\`\`bash
   declaragent fleet add --template rpc-server --id pr-reviewer
   \`\`\`
2. Validate the fleet:
   \`\`\`bash
   declaragent fleet validate
   \`\`\`
3. Run the fleet dev loop:
   \`\`\`bash
   declaragent fleet run
   \`\`\`

See the full CLI surface via \`declaragent --help\`.
`;
}

const FLEET_GITIGNORE = `node_modules/
dist/
.declaragent/
.env
.env.local
`;

const FLEET_ENV_EXAMPLE = `# Shared env for the fleet. Copy to .env and fill in real values.
# Per-agent overrides can live under agents/<id>/.env (gitignored).

# ANTHROPIC_API_KEY=
`;

const FLEET_RPC_PEERS_STUB = `version: 1
# Peer table for in-fleet + external agents. One entry per \`agent://\` peer.
# Populated automatically by \`declaragent fleet add\` when a template ships
# a peer entry.
peers: []
`;
