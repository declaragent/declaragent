#!/usr/bin/env bun
/**
 * Phase 7 slice 5 — template verifier.
 *
 * Walks every directory under `templates/` and asserts:
 *
 *   1. Every `*.yaml` / `*.yml` / `*.json` file parses without throwing.
 *   2. Every skill file referenced from `agent.yaml` exists on disk.
 *   3. `.env.example` references every env var mentioned in the
 *      template's YAML as `${env:FOO}`. Missing vars print as failures.
 *   4. Fleet templates (detected by a top-level `fleet.yaml`): every
 *      `fleet.yaml → agents[].path` points at a real directory, and
 *      each of those dirs is verified as a nested single-agent
 *      template (skills + agent.yaml.name invariant — §14.4 — checked,
 *      but .env.example + README.md requirements are satisfied by the
 *      fleet root). @since 1.2.0
 *
 * Exits 0 on clean verification, 1 on any failure. Intended to run
 * both locally (`bun run scripts/verify-templates.ts`) and in CI via
 * `.github/workflows/templates-verify.yml`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(import.meta.dir, '..');
const TEMPLATES_DIR = join(REPO_ROOT, 'templates');

interface TemplateFailure {
  template: string;
  file: string;
  message: string;
}

const failures: TemplateFailure[] = [];

function fail(template: string, file: string, message: string): void {
  failures.push({ template, file, message });
}

function listTemplates(): string[] {
  const entries = readdirSync(TEMPLATES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function collectEnvRefs(text: string): Set<string> {
  const refs = new Set<string>();
  const re = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    if (name) refs.add(name);
  }
  return refs;
}

function parseEnvExampleKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    keys.add(line.slice(0, eq).trim());
  }
  return keys;
}

interface AgentDirectoryOptions {
  /**
   * When true, skip the top-level `.env.example` + `README.md` checks.
   * Used when the agent directory is nested under a fleet template —
   * those artifacts live at the fleet root and cover every member.
   */
  readonly nestedInFleet?: boolean;
  /**
   * When set, the agent directory's `agent.yaml.name` must equal this
   * value (§14.4 invariant). Failing an equality check surfaces as a
   * verification failure rather than a runtime surprise.
   */
  readonly expectedAgentName?: string;
  /**
   * Extra env keys the caller has already collected from a parent
   * `.env.example` (e.g. the fleet root). Keys here satisfy
   * `${env:FOO}` refs even when the nested agent dir doesn't ship its
   * own `.env.example`.
   */
  readonly extraEnvKeys?: ReadonlySet<string>;
}

function verifyAgentDirectory(
  name: string,
  dir: string,
  options: AgentDirectoryOptions = {},
): void {
  if (!statSync(dir).isDirectory()) return;

  const files = walkFiles(dir);
  const yamlFiles = files.filter((f) => /\.(ya?ml)$/i.test(f));
  const jsonFiles = files.filter((f) => f.endsWith('.json'));

  // 1. Parse every YAML file.
  const parsedYaml = new Map<string, unknown>();
  for (const file of yamlFiles) {
    const rel = relative(REPO_ROOT, file);
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (err) {
      fail(name, rel, `failed to read: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      parsedYaml.set(file, parseYaml(text));
    } catch (err) {
      fail(name, rel, `YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Parse every JSON file.
  for (const file of jsonFiles) {
    const rel = relative(REPO_ROOT, file);
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (err) {
      fail(name, rel, `failed to read: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      JSON.parse(text);
    } catch (err) {
      fail(name, rel, `JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. agent.yaml must exist and declare skills that resolve on disk.
  const agentYamlPath = join(dir, 'agent.yaml');
  let agent: unknown;
  try {
    agent = parseYaml(readFileSync(agentYamlPath, 'utf-8'));
  } catch (err) {
    const relPath = relative(dir, agentYamlPath) || 'agent.yaml';
    fail(
      name,
      relPath,
      `missing or unparseable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const declaredName = (agent as { name?: unknown })?.name;
  if (options.expectedAgentName !== undefined) {
    if (typeof declaredName !== 'string' || declaredName !== options.expectedAgentName) {
      fail(
        name,
        relative(REPO_ROOT, agentYamlPath),
        `agent.yaml.name "${String(declaredName)}" must equal fleet-declared id "${options.expectedAgentName}" (FLEET_PLAN.md §14.4)`,
      );
    }
  }
  const skills = (agent as { skills?: unknown })?.skills;
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (typeof skill !== 'string') continue;
      // Resolve relative to the agent directory (the template root for
      // single-agent templates; the agent's subdir for fleet members).
      const skillPath = join(dir, skill);
      try {
        if (!statSync(skillPath).isFile()) {
          fail(name, relative(REPO_ROOT, agentYamlPath), `skill path not a file: ${skill}`);
        }
      } catch {
        fail(name, relative(REPO_ROOT, agentYamlPath), `declared skill missing: ${skill}`);
      }
    }
  }

  // 4. .env.example coverage. Collect every `${env:FOO}` ref from all
  // YAML files and ensure each FOO is covered by either the agent's
  // own `.env.example` or one inherited from the fleet root.
  let envKeys = new Set<string>(options.extraEnvKeys ?? []);
  const envExamplePath = join(dir, '.env.example');
  if (existsSync(envExamplePath)) {
    for (const key of parseEnvExampleKeys(readFileSync(envExamplePath, 'utf-8'))) {
      envKeys.add(key);
    }
  } else if (!options.nestedInFleet) {
    fail(name, '.env.example', 'missing .env.example');
    envKeys = new Set<string>(options.extraEnvKeys ?? []);
  }
  const allRefs = new Set<string>();
  for (const file of yamlFiles) {
    try {
      const text = readFileSync(file, 'utf-8');
      for (const ref of collectEnvRefs(text)) allRefs.add(ref);
    } catch {
      // reading error already reported above.
    }
  }
  for (const ref of allRefs) {
    if (!envKeys.has(ref)) {
      fail(name, '.env.example', `missing entry for \${env:${ref}} used in YAML`);
    }
  }

  // 5. README.md exists. Fleet members reuse the fleet-root README,
  // so nested agent dirs skip this check.
  if (!options.nestedInFleet) {
    try {
      if (!statSync(join(dir, 'README.md')).isFile()) {
        fail(name, 'README.md', 'expected README.md to be a file');
      }
    } catch {
      fail(name, 'README.md', 'missing README.md');
    }
  }
}

/**
 * Slice 9. A fleet template is detected by a top-level `fleet.yaml`.
 * We parse the manifest (skipping Zod — the runtime loader handles
 * strict-shape validation), then recurse into every `agents[].path` as
 * a nested single-agent template, threading the fleet-root
 * `.env.example` keys through so fleet members don't need their own.
 */
function verifyFleetTemplate(name: string, dir: string): void {
  const fleetYamlPath = join(dir, 'fleet.yaml');
  let manifest: unknown;
  try {
    manifest = parseYaml(readFileSync(fleetYamlPath, 'utf-8'));
  } catch (err) {
    fail(
      name,
      'fleet.yaml',
      `missing or unparseable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const agents = (manifest as { agents?: unknown })?.agents;
  if (!Array.isArray(agents)) {
    fail(name, 'fleet.yaml', 'expected `agents:` to be an array');
    return;
  }

  // Fleet-root artifacts: top-level README + .env.example satisfy every
  // nested agent.
  try {
    if (!statSync(join(dir, 'README.md')).isFile()) {
      fail(name, 'README.md', 'expected README.md to be a file');
    }
  } catch {
    fail(name, 'README.md', 'missing README.md');
  }

  let rootEnvKeys = new Set<string>();
  const rootEnvPath = join(dir, '.env.example');
  if (existsSync(rootEnvPath)) {
    rootEnvKeys = parseEnvExampleKeys(readFileSync(rootEnvPath, 'utf-8'));
  } else {
    fail(name, '.env.example', 'missing .env.example (fleet-root shared env)');
  }

  // Parse + check every root-level YAML (fleet.yaml, rpc-peers.yaml, etc.)
  // before descending into agents.
  const rootFiles = readdirSync(dir, { withFileTypes: true });
  for (const entry of rootFiles) {
    if (!entry.isFile()) continue;
    if (!/\.(ya?ml|json)$/i.test(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(REPO_ROOT, full);
    try {
      const text = readFileSync(full, 'utf-8');
      if (entry.name.endsWith('.json')) {
        JSON.parse(text);
      } else {
        parseYaml(text);
      }
      for (const ref of collectEnvRefs(text)) {
        if (!rootEnvKeys.has(ref)) {
          fail(name, '.env.example', `missing entry for \${env:${ref}} used in ${entry.name}`);
        }
      }
    } catch (err) {
      fail(name, rel, `parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Descend into each declared agent subdirectory.
  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    const pathField = (entry as { path?: unknown }).path;
    if (typeof id !== 'string' || typeof pathField !== 'string') {
      fail(name, 'fleet.yaml', 'every agents[] entry must have string id + path fields');
      continue;
    }
    const agentDir = join(dir, pathField);
    try {
      if (!statSync(agentDir).isDirectory()) {
        fail(name, 'fleet.yaml', `agent "${id}" path "${pathField}" is not a directory`);
        continue;
      }
    } catch {
      fail(name, 'fleet.yaml', `agent "${id}" path "${pathField}" does not exist`);
      continue;
    }
    verifyAgentDirectory(`${name}/${id}`, agentDir, {
      nestedInFleet: true,
      expectedAgentName: id,
      extraEnvKeys: rootEnvKeys,
    });
  }
}

function verifyTemplate(name: string): void {
  const dir = join(TEMPLATES_DIR, name);
  if (!statSync(dir).isDirectory()) return;

  // Fleet templates (slice 9) are detected by a top-level `fleet.yaml`.
  // Every other template is a single-agent scaffold and goes through
  // the legacy verification path.
  if (existsSync(join(dir, 'fleet.yaml'))) {
    verifyFleetTemplate(name, dir);
    return;
  }
  verifyAgentDirectory(name, dir);
}

function main(): void {
  const names = listTemplates();
  if (names.length === 0) {
    console.error('no templates found under templates/');
    process.exit(1);
  }
  for (const name of names) {
    verifyTemplate(name);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} template failure(s):\n`);
    for (const f of failures) {
      console.error(`  [${f.template}] ${f.file} — ${f.message}`);
    }
    process.exit(1);
  }
  console.log(`verified ${names.length} template(s): ${names.join(', ')}`);
}

main();
