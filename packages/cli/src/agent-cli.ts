/**
 * `declaragent agent validate [dir]` — WS10 config-integrity verb.
 *
 * Loads a scaffolded agent directory through the same path the runtime uses and
 * reports problems an operator would otherwise only discover at boot (or never,
 * for silently-dropped keys):
 *
 *   - hard schema errors (strict sub-blocks: memory / permissions /
 *     controlPlane.auth / rpc.auth) → reported as errors, exit 1.
 *   - unknown top-level keys (likely typos like `rcp:` for `rpc:`, which the
 *     passthrough schema swallows) → warnings.
 *   - tool-permission resolution: an unknown tool in `tools.defaults` is an
 *     error (it would fail boot); legacy/MCP advisories surface as warnings.
 *
 * `fleet validate` calls {@link validateAgentDir} for every member so a fleet
 * with a typo'd agent body fails fast instead of at runtime.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lintUnknownTopLevelKeys, loadAgent } from '@declaragent/core';
import { parse as parseYaml } from 'yaml';
import { AgentToolConfigError, resolveRuntimeTools } from './resolve-tools.js';

export interface ValidationFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface ValidateAgentResult {
  ok: boolean;
  findings: ValidationFinding[];
}

interface AgentCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: AgentCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/**
 * Validate a single agent directory. Pure-ish: returns findings rather than
 * printing, so `fleet validate` can aggregate across members.
 */
export async function validateAgentDir(agentDir: string): Promise<ValidateAgentResult> {
  const findings: ValidationFinding[] = [];

  // 1. Raw YAML parse for unknown-key linting (independent of zod's passthrough).
  let raw: unknown;
  try {
    const text = await readFile(join(agentDir, 'agent.yaml'), 'utf8');
    raw = parseYaml(text);
  } catch (err) {
    // Fall through — loadAgent below will produce the authoritative error; only
    // record here if the file is entirely unreadable and loadAgent can't run.
    raw = undefined;
    findings.push({
      severity: 'warning',
      code: 'agent.yaml-unreadable',
      message: `could not read agent.yaml for key-lint: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  for (const key of lintUnknownTopLevelKeys(raw)) {
    findings.push({
      severity: 'warning',
      code: 'unknown-key',
      message: `unknown top-level key "${key}" — likely a typo; it is parsed but consumed by nothing.`,
    });
  }

  // 2. Full schema load (throws on strict sub-block violations).
  let loaded: Awaited<ReturnType<typeof loadAgent>> | undefined;
  try {
    loaded = await loadAgent({ agentDir });
  } catch (err) {
    findings.push({
      severity: 'error',
      code: 'schema',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, findings };
  }

  // 3. Tool-permission resolution (unknown tool name → error; advisories → warn).
  try {
    const resolved = resolveRuntimeTools({
      declared: loaded.toolNames,
      permissionRules: loaded.permissionRules,
    });
    for (const w of resolved.warnings) {
      findings.push({ severity: 'warning', code: 'tools', message: w });
    }
  } catch (err) {
    if (err instanceof AgentToolConfigError) {
      findings.push({ severity: 'error', code: 'tools', message: err.message });
    } else {
      throw err;
    }
  }

  return { ok: findings.every((f) => f.severity !== 'error'), findings };
}

export interface AgentValidateArgs {
  dir?: string;
  json?: boolean;
}

/** CLI entry for `declaragent agent validate [dir] [--json]`. */
export async function agentValidate(
  args: AgentValidateArgs = {},
  deps: { io?: AgentCliIO } = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const dir = args.dir ?? process.cwd();
  const result = await validateAgentDir(dir);

  if (args.json) {
    io.out(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.findings.length === 0) {
    io.out('✓ agent validates clean.\n');
  } else {
    for (const f of result.findings) {
      const tag = f.severity === 'error' ? '✗' : '!';
      io.out(`${tag} [${f.code}] ${f.message}\n`);
    }
    if (result.ok) io.out('✓ no errors (warnings above are advisory).\n');
  }

  return result.ok ? 0 : 1;
}
