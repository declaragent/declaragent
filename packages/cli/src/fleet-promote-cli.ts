/**
 * `declaragent fleet promote <path>` + `declaragent fleet demote <id>` —
 * convert a single-agent directory into a fleet-of-one (and back).
 *
 * Promote flow (FLEET_PLAN.md §7):
 *   1. Detect target. Refuse if `<path>` is already a fleet or not a
 *      single-agent directory.
 *   2. Dry-run (default) prints the mv/rewrite plan. `--apply` mutates.
 *   3. Moves per-agent files under `agents/<id>/`, writes `fleet.yaml`,
 *      updates root `package.json` (adds `"workspaces": ["agents/*"]`),
 *      drops `PROMOTED.md`.
 *
 * Demote flow (§14.10) is the strict inverse:
 *   - Refuse for fleets with N > 1 agent.
 *   - Move `agents/<id>/*` back to the fleet root.
 *   - Delete `fleet.yaml` + `PROMOTED.md`.
 *   - Remove the `workspaces` field from root `package.json`.
 *
 * @since 1.2.0
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { findFleetRoot } from '@declaragent/core';
import { parse as parseYaml } from 'yaml';
import type { FleetFS } from './fleet-scaffold.js';
import { DEFAULT_FLEET_FS, FleetScaffoldError } from './fleet-scaffold.js';

export interface FleetPromoteIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetPromoteIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/**
 * Files that belong to a single agent and get moved into `agents/<id>/`
 * during promote. `.env` / `.env.example` stay at the root (shared
 * across every agent in the fleet, per §7.1). `package.json` stays at
 * the root with a rewritten `workspaces` field.
 */
const PER_AGENT_FILES = [
  'agent.yaml',
  'capabilities.yaml',
  'event-sources.yaml',
  'rpc-peers.yaml',
  'channels.yaml',
  'tenants.yaml',
  'secrets.yaml',
] as const;

/** Directories that live inside a single agent and are moved as a unit. */
const PER_AGENT_DIRS = ['skills'] as const;

/** Files that stay at the fleet root. */
const SHARED_ROOT_FILES = new Set(['.env', '.env.example', '.gitignore', 'bun.lock']);

/**
 * Filenames we warn about during promote — their contents may reference
 * paths we're about to move, but we don't auto-rewrite them.
 */
const WARN_PATTERNS: ReadonlyArray<{ match: RegExp; reason: string }> = [
  { match: /^Dockerfile$/, reason: 'Dockerfile may reference agent.yaml at the repo root' },
  { match: /\.dockerfile$/i, reason: 'Dockerfile-variant may reference moved paths' },
  { match: /deploy.*\.ya?ml$/i, reason: 'deploy YAML may reference moved paths' },
  { match: /cloud-run.*\.ya?ml$/i, reason: 'Cloud Run YAML may reference moved paths' },
];

export interface FleetPromoteArgs {
  /** Absolute or cwd-relative path to the single-agent directory. */
  path: string;
  /** When true (or when neither flag is set), print the plan without touching disk. */
  dryRun?: boolean;
  /** When true, mutate disk. Exactly one of `dryRun` / `apply` must be effective. */
  apply?: boolean;
  /** Skip the git-dirty refusal (not wired here — surfaced as a hook for the CLI layer). */
  force?: boolean;
  /**
   * Agent id for the new fleet entry. Defaults to the single-agent
   * `agent.yaml → name:` field. Must be a URL-safe identifier.
   */
  id?: string;
}

export interface FleetPromoteDeps {
  io?: FleetPromoteIO;
  fs?: FleetFS;
  cwd?: string;
}

/** One step in the promote plan — kept explicit so the dry-run output is reviewable. */
interface PromoteStep {
  readonly kind: 'mv' | 'rewrite' | 'write' | 'warn';
  readonly message: string;
}

export async function fleetPromote(
  args: FleetPromoteArgs,
  deps: FleetPromoteDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fs = deps.fs ?? DEFAULT_FLEET_FS;
  const cwd = deps.cwd ?? process.cwd();

  const sourcePath = isAbsolute(args.path) ? args.path : pathResolve(cwd, args.path);

  // Mode resolution: dryRun default when neither flag is set.
  const apply = args.apply === true && args.dryRun !== true;
  const dryRun = !apply;
  if (args.apply === true && args.dryRun === true) {
    io.err('✗ `fleet promote` takes either --dry-run or --apply, not both\n');
    return 1;
  }

  try {
    const plan = buildPromotePlan({ sourcePath, id: args.id, fs });
    for (const step of plan.steps) {
      const tag = stepTag(step.kind);
      io.out(`  ${tag} ${step.message}\n`);
    }

    if (dryRun) {
      io.out(`\n(dry-run) ${plan.steps.length} step(s). Re-run with --apply to execute.\n`);
      return 0;
    }

    applyPromotePlan(plan);
    io.out(`\n✓ promoted ${sourcePath} to a fleet-of-one with agent id "${plan.agentId}"\n`);
    io.out('  next: `declaragent fleet validate` + `declaragent fleet run`\n');
    return 0;
  } catch (err) {
    if (err instanceof FleetScaffoldError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ ${msg}\n`);
    return 1;
  }
}

export interface FleetDemoteArgs {
  /** Agent id to demote. Must match the one entry in a fleet-of-one. */
  id?: string;
  /** Reserved for future use (skip the git-dirty check). */
  force?: boolean;
}

export interface FleetDemoteDeps {
  io?: FleetPromoteIO;
  fs?: FleetFS;
  cwd?: string;
  /** Override fleet root discovery — tests supply an absolute path. */
  fleetRoot?: string;
}

export async function fleetDemote(
  args: FleetDemoteArgs,
  deps: FleetDemoteDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fs = deps.fs ?? DEFAULT_FLEET_FS;

  const fleetRoot = deps.fleetRoot ?? (await findFleetRoot(deps.cwd ?? process.cwd()));
  if (!fleetRoot) {
    io.err('✗ no fleet.yaml found in this directory or any parent.\n');
    return 1;
  }

  try {
    applyDemote({ fleetRoot, id: args.id, fs });
    io.out(`✓ demoted fleet at ${fleetRoot} back to a single-agent directory\n`);
    return 0;
  } catch (err) {
    if (err instanceof FleetScaffoldError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ ${msg}\n`);
    return 1;
  }
}

// ── Promote internals ──────────────────────────────────────────────────

interface PromotePlan {
  readonly sourcePath: string;
  readonly agentId: string;
  readonly agentDir: string;
  readonly steps: readonly PromoteStep[];
  readonly moves: readonly { from: string; to: string }[];
  readonly packageJsonAction: { kind: 'create' } | { kind: 'rewrite'; existing: string };
}

interface BuildPlanArgs {
  sourcePath: string;
  id?: string | undefined;
  fs: FleetFS;
}

function buildPromotePlan(args: BuildPlanArgs): PromotePlan {
  const { sourcePath, fs } = args;

  if (!fs.exists(sourcePath) || !fs.isDir(sourcePath)) {
    throw new FleetScaffoldError(
      `fleetPromote: source path ${sourcePath} does not exist or is not a directory`,
    );
  }
  if (fs.exists(join(sourcePath, 'fleet.yaml'))) {
    throw new FleetScaffoldError(
      `fleetPromote: ${sourcePath} already contains fleet.yaml — it's already a fleet`,
    );
  }
  const agentYamlPath = join(sourcePath, 'agent.yaml');
  if (!fs.exists(agentYamlPath)) {
    throw new FleetScaffoldError(
      `fleetPromote: ${sourcePath} has no agent.yaml — not a single-agent directory`,
    );
  }

  const sourceName = readNameField(fs.readFile(agentYamlPath));
  const agentId = args.id ?? sourceName;
  if (!isAgentId(agentId)) {
    throw new FleetScaffoldError(
      `fleetPromote: agent id "${agentId}" must be a URL-safe identifier (a-z0-9-_)`,
    );
  }

  const agentDir = join(sourcePath, 'agents', agentId);
  const moves: { from: string; to: string }[] = [];
  const steps: PromoteStep[] = [];

  // 1. Per-agent files (if present at the root).
  for (const file of PER_AGENT_FILES) {
    const from = join(sourcePath, file);
    if (!fs.exists(from)) continue;
    const to = join(agentDir, file);
    moves.push({ from, to });
    steps.push({ kind: 'mv', message: `${from} → ${to}` });
  }

  // 2. Per-agent directories.
  for (const dir of PER_AGENT_DIRS) {
    const from = join(sourcePath, dir);
    if (!fs.exists(from) || !fs.isDir(from)) continue;
    const to = join(agentDir, dir);
    moves.push({ from, to });
    steps.push({ kind: 'mv', message: `${from}/ → ${to}/` });
  }

  // 3. Markdown files specific to the agent. Anything at the root that's
  //    a `*.md` (README, PROMPTING, etc.) moves — the fleet itself gets a
  //    fresh PROMOTED.md below. Skip PROMOTED.md itself so re-promotes
  //    are well-behaved, even though promote already refused above on
  //    fleet.yaml presence.
  for (const entry of fs.readdir(sourcePath)) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === 'PROMOTED.md') continue;
    const from = join(sourcePath, entry.name);
    const to = join(agentDir, entry.name);
    moves.push({ from, to });
    steps.push({ kind: 'mv', message: `${from} → ${to}` });
  }

  // 4. Warn on files we don't rewrite.
  for (const entry of fs.readdir(sourcePath)) {
    if (!entry.isFile) continue;
    const match = WARN_PATTERNS.find((p) => p.match.test(entry.name));
    if (!match) continue;
    steps.push({
      kind: 'warn',
      message: `${join(sourcePath, entry.name)} — ${match.reason} (not rewritten)`,
    });
  }
  // GitHub workflows under `.github/workflows/` referencing moved paths.
  const workflowsDir = join(sourcePath, '.github', 'workflows');
  if (fs.exists(workflowsDir) && fs.isDir(workflowsDir)) {
    for (const entry of fs.readdir(workflowsDir)) {
      if (!entry.isFile) continue;
      if (!/\.ya?ml$/i.test(entry.name)) continue;
      steps.push({
        kind: 'warn',
        message: `${join(workflowsDir, entry.name)} — may reference moved paths (not rewritten)`,
      });
    }
  }

  // 5. Note the shared-root files we deliberately leave in place.
  for (const sharedName of SHARED_ROOT_FILES) {
    const p = join(sourcePath, sharedName);
    if (!fs.exists(p)) continue;
    steps.push({ kind: 'write', message: `${p} (unchanged; shared across fleet)` });
  }

  // 6. Rewrite/create package.json.
  const pkgPath = join(sourcePath, 'package.json');
  const pkgExisted = fs.exists(pkgPath);
  const packageJsonAction: PromotePlan['packageJsonAction'] = pkgExisted
    ? { kind: 'rewrite', existing: fs.readFile(pkgPath) }
    : { kind: 'create' };
  steps.push({
    kind: 'rewrite',
    message: pkgExisted
      ? `${pkgPath} (add "workspaces": ["agents/*"])`
      : `${pkgPath} (new; minimal root package.json)`,
  });

  // 7. Write fleet.yaml + PROMOTED.md.
  steps.push({ kind: 'write', message: `${join(sourcePath, 'fleet.yaml')} (new)` });
  steps.push({ kind: 'write', message: `${join(sourcePath, 'PROMOTED.md')} (new)` });

  return {
    sourcePath,
    agentId,
    agentDir,
    steps,
    moves,
    packageJsonAction,
  };
}

function applyPromotePlan(plan: PromotePlan): void {
  const { sourcePath, agentId, agentDir, moves, packageJsonAction } = plan;

  // 1. Prepare the destination.
  mkdirSync(agentDir, { recursive: true });

  // 2. Execute moves. Use renameSync on the real fs — it's atomic within
  //    a filesystem and preserves metadata.
  for (const { from, to } of moves) {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }

  // 3. Rewrite the moved agent.yaml if the caller supplied a custom id.
  //    The addAgentFromPath helper we leaned on in slice 2 did this work
  //    inline during copy, but since we're doing renames (not copies) we
  //    rewrite in place now.
  const movedAgentYaml = join(agentDir, 'agent.yaml');
  if (existsSync(movedAgentYaml)) {
    const yamlText = readFileSync(movedAgentYaml, 'utf-8');
    const rewritten = rewriteAgentYamlName(yamlText, agentId);
    if (rewritten !== yamlText) writeFileSync(movedAgentYaml, rewritten, 'utf-8');
  }
  const movedCapabilities = join(agentDir, 'capabilities.yaml');
  if (existsSync(movedCapabilities)) {
    const yamlText = readFileSync(movedCapabilities, 'utf-8');
    const rewritten = rewriteCapabilitiesAgent(yamlText, agentId);
    if (rewritten !== yamlText) writeFileSync(movedCapabilities, rewritten, 'utf-8');
  }

  // 4. package.json — rewrite existing or create minimal.
  const pkgPath = join(sourcePath, 'package.json');
  if (packageJsonAction.kind === 'rewrite') {
    const pkg = parsePackageJson(packageJsonAction.existing);
    pkg.workspaces = ['agents/*'];
    pkg.private = pkg.private ?? true;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  } else {
    const pkg: Record<string, unknown> = {
      name: agentId,
      private: true,
      type: 'module',
      workspaces: ['agents/*'],
    };
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  }

  // 5. Write fleet.yaml.
  writeFileSync(join(sourcePath, 'fleet.yaml'), renderFleetOfOneManifest(agentId), 'utf-8');

  // 6. Write PROMOTED.md.
  writeFileSync(join(sourcePath, 'PROMOTED.md'), renderPromotedNote(agentId, sourcePath), 'utf-8');
}

// ── Demote internals ───────────────────────────────────────────────────

interface ApplyDemoteArgs {
  fleetRoot: string;
  id?: string | undefined;
  fs: FleetFS;
}

function applyDemote(args: ApplyDemoteArgs): void {
  const { fleetRoot, fs } = args;
  const manifestPath = join(fleetRoot, 'fleet.yaml');
  if (!fs.exists(manifestPath)) {
    throw new FleetScaffoldError(`fleetDemote: ${manifestPath} does not exist — nothing to demote`);
  }

  const manifest = parseYaml(fs.readFile(manifestPath));
  if (!isManifestWithAgents(manifest)) {
    throw new FleetScaffoldError(
      `fleetDemote: ${manifestPath} is not a valid fleet manifest (missing agents[])`,
    );
  }
  const agents = manifest.agents ?? [];
  if (agents.length === 0) {
    throw new FleetScaffoldError(
      'fleetDemote: fleet has zero agents — nothing to demote. Delete fleet.yaml manually.',
    );
  }
  if (agents.length > 1) {
    const ids = agents.map((a) => String(a.id ?? '<unknown>')).join(', ');
    throw new FleetScaffoldError(
      `fleetDemote: fleet has ${agents.length} agents (${ids}). \`fleet demote\` only supports fleet-of-one; for N>1 use \`fleet remove <id>\` + manual extraction (see FLEET_PLAN.md §14.10).`,
    );
  }

  const only = agents[0];
  if (!only) throw new FleetScaffoldError('fleetDemote: empty agents[] after length check');
  const onlyId = String(only.id ?? '');
  const expectedId = args.id ?? onlyId;
  if (args.id !== undefined && args.id !== onlyId) {
    throw new FleetScaffoldError(
      `fleetDemote: requested id "${args.id}" does not match the sole fleet member "${onlyId}"`,
    );
  }
  if (!isAgentId(expectedId)) {
    throw new FleetScaffoldError(
      `fleetDemote: agent id "${expectedId}" must be a URL-safe identifier`,
    );
  }

  const agentDir = join(fleetRoot, 'agents', expectedId);
  if (!fs.exists(agentDir) || !fs.isDir(agentDir)) {
    throw new FleetScaffoldError(
      `fleetDemote: expected ${agentDir} to be a directory but it is missing`,
    );
  }

  // 1. Move every child of agents/<id>/ back up to the fleet root.
  for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
    const from = join(agentDir, entry.name);
    const to = join(fleetRoot, entry.name);
    if (existsSync(to)) {
      throw new FleetScaffoldError(
        `fleetDemote: refusing to clobber existing ${to} at the fleet root`,
      );
    }
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }

  // 2. Remove the now-empty agents/ tree + fleet.yaml + PROMOTED.md.
  rmSync(join(fleetRoot, 'agents'), { recursive: true, force: true });
  rmSync(manifestPath, { force: true });
  const promotedNote = join(fleetRoot, 'PROMOTED.md');
  if (existsSync(promotedNote)) rmSync(promotedNote, { force: true });

  // 3. Strip `workspaces` + `fleet:*` scripts from the root package.json.
  const pkgPath = join(fleetRoot, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = parsePackageJson(readFileSync(pkgPath, 'utf-8'));
    const { workspaces: _ws, ...rest } = pkg;
    writeFileSync(pkgPath, `${JSON.stringify(rest, null, 2)}\n`, 'utf-8');
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
function isAgentId(value: string): boolean {
  return AGENT_ID_RE.test(value);
}

function stepTag(kind: PromoteStep['kind']): string {
  if (kind === 'mv') return 'mv    ';
  if (kind === 'rewrite') return 'rewrite';
  if (kind === 'write') return 'write ';
  return 'warn  ';
}

function readNameField(yamlText: string): string {
  const parsed = parseYaml(yamlText);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const name = (parsed as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  throw new FleetScaffoldError('agent.yaml is missing a top-level `name:` field — cannot promote');
}

function rewriteAgentYamlName(yamlText: string, newName: string): string {
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
  if (!re.test(yamlText)) return yamlText;
  return yamlText.replace(re, `agent: agent://${newId}`);
}

interface ManifestWithAgents {
  agents?: Array<{ id?: unknown; path?: unknown }>;
}
function isManifestWithAgents(value: unknown): value is ManifestWithAgents {
  if (!value || typeof value !== 'object') return false;
  const agents = (value as { agents?: unknown }).agents;
  if (agents === undefined) return false;
  return Array.isArray(agents);
}

function parsePackageJson(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FleetScaffoldError('package.json root is not an object — refusing to rewrite');
  }
  return parsed as Record<string, unknown>;
}

function renderFleetOfOneManifest(agentId: string): string {
  return `version: 1
name: ${agentId}
description: "Fleet-of-one promoted from a single-agent directory."

agents:
  - id: ${agentId}
    path: ./agents/${agentId}

environments:
  default:
    peersRef: ./rpc-peers.yaml
`;
}

function renderPromotedNote(agentId: string, sourcePath: string): string {
  return `# Promoted to a fleet

This directory was converted from a single-agent layout into a
fleet-of-one on ${new Date().toISOString().slice(0, 10)} by
\`declaragent fleet promote ${sourcePath}\`.

- Agent id: \`${agentId}\`
- Manifest: \`./fleet.yaml\`
- Agent files moved under: \`./agents/${agentId}/\`

## Inverse

\`\`\`bash
declaragent fleet demote ${agentId}
\`\`\`

Fleet-of-one demote restores the original single-agent layout. See
\`docs/FLEET_PLAN.md\` §7 + §14.10 for the full contract.
`;
}
