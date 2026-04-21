/**
 * `declaragent run [<dir>]` — load a scaffolded agent directory
 * (agent.yaml + skills/*.md) and drop into a REPL with that agent's
 * persona + skills live.
 *
 * This is the "did my builder output actually work?" verb. Until it
 * shipped (0.3.3), the only way to exercise a scaffolded agent
 * conversationally was a text-prompt hack — tell the builder REPL to
 * read the skill file and apply it. Users saw the builder persona
 * running the skill; now they see the scaffolded agent.
 *
 * **Scope — PR #1:**
 * - Loads `agent.yaml` + `skills/` via `@declaragent/core`'s
 *   `loadAgent()`.
 * - Composes the skill bodies into the system prompt so the model
 *   knows what it can do (via `composeSystemPromptWithSkills()`).
 * - Renders the existing `<App agentSpec={…}>` — same REPL UX,
 *   different persona.
 * - **Does NOT yet wire `event-sources.yaml`** — `--no-sources` is
 *   the only mode. Source-wiring lands in PR #2 so we can bound
 *   the surface area of the first ship.
 *
 * @since 0.3.3
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AgentConfigError,
  type AgentSpec,
  type LoadedAgent,
  composeSystemPromptWithSkills,
  loadAgent,
} from '@declaragent/core';
import { type StartAgentSourcesResult, startAgentSources } from './run-agent-sources.js';

export interface RunAgentArgs {
  dir?: string;
  model?: string;
  /**
   * Future-proof flag. Today the verb is skill-only regardless of
   * this value; PR #2 wires `event-sources.yaml` when `--no-sources`
   * is absent. Accepting the flag now lets downstream scripts pin
   * `--no-sources` without breaking.
   */
  noSources?: boolean;
}

export interface RunAgentDeps {
  /**
   * Factory the CLI injects — normally:
   *   (props) => render(<App {...props} />).waitUntilExit()
   * Returning a promise lets `runAgent` hold the stop-sources
   * cleanup until the REPL exits.
   */
  renderRepl?: (props: {
    agentSpec: AgentSpec;
    agentLabel: string;
    model?: string;
  }) => void | Promise<void>;
  /** Output sinks — tests swap these for capture buffers. */
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Cwd override. Tests inject a tmpdir; prod is `process.cwd()`. */
  cwd?: string;
  /**
   * Override the source-lifecycle starter. Default wires webhook /
   * cron / file-watch against the session event store. Tests stub
   * this out so they don't bind real ports.
   */
  startSources?: typeof startAgentSources;
}

const DEFAULT_DEPS: Required<Pick<RunAgentDeps, 'out' | 'err' | 'cwd'>> = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd(),
};

/**
 * CLI entry. Returns a numeric exit code; the index.tsx dispatcher
 * calls `process.exit()` on the result.
 */
export async function runAgent(args: RunAgentArgs, deps: RunAgentDeps = {}): Promise<number> {
  const out = deps.out ?? DEFAULT_DEPS.out;
  const err = deps.err ?? DEFAULT_DEPS.err;
  const cwd = deps.cwd ?? DEFAULT_DEPS.cwd;

  const rawDir = args.dir ?? '.';
  const agentDir = isAbsolute(rawDir) ? rawDir : resolve(cwd, rawDir);

  if (!existsSync(agentDir)) {
    err(`✗ no directory at ${agentDir}\n`);
    return 1;
  }

  let loaded: LoadedAgent;
  try {
    loaded = await loadAgent({ agentDir });
  } catch (e) {
    if (e instanceof AgentConfigError) {
      err(`✗ ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  if (loaded.skillConflicts.length > 0) {
    for (const c of loaded.skillConflicts) {
      err(
        `warning: skill "${c.lookupName}" is defined in multiple files — ` +
          `chose ${c.chosen}, shadowed ${c.shadowed.join(', ')}\n`,
      );
    }
  }

  // Model resolution: yaml → `--model` flag → leave empty and let
  // App's initialModel resolver pick from auth config / preset.
  const resolvedModel = loaded.spec.model || args.model || '';

  const agentSpec: AgentSpec = {
    ...loaded.spec,
    model: resolvedModel,
    systemPrompt: composeSystemPromptWithSkills(loaded.spec.systemPrompt, loaded.skills),
  };

  out(`running ${loaded.spec.name} from ${loaded.agentDir}\n`);
  out(`  model:  ${resolvedModel || '<from auth config / flag>'}\n`);
  out(
    `  skills: ${loaded.skills.length} loaded (${loaded.skills.map((s) => s.lookupName).join(', ') || 'none'})\n`,
  );
  if (loaded.toolNames.length > 0) {
    out(`  tools:  declared defaults = ${loaded.toolNames.join(', ')}\n`);
  }
  // Source lifecycle. Starts webhook/cron/file-watch in-process when
  // `event-sources.yaml` exists + `--no-sources` isn't set. Runtime
  // failures here are fatal — a scaffolded webhook that can't bind
  // its port is worth surfacing before the REPL takes user input.
  let sources: StartAgentSourcesResult | undefined;
  const eventSourcesPath = findEventSourcesConfig(loaded.agentDir);
  const skipSources = args.noSources === true;
  if (eventSourcesPath !== undefined && !skipSources) {
    try {
      const starter = deps.startSources ?? startAgentSources;
      sources = await starter({ configPath: eventSourcesPath });
    } catch (e) {
      err(`✗ could not start event sources: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  if (sources !== undefined && sources.started.length > 0) {
    out(`  sources: ${sources.started.length} active\n`);
    for (const s of sources.started) {
      out(`           — ${s.summary}\n`);
    }
    if (sources.unknownTypes.length > 0) {
      const listing = sources.unknownTypes.map((u) => u.type).join(', ');
      out(`  note:   skipped unknown / external source types: ${listing}\n`);
      out('           (install @declaragent/source-<type> + run via the daemon for those)\n');
    }
  } else if (skipSources && eventSourcesPath !== undefined) {
    out('  sources: disabled (--no-sources)\n');
  } else if (eventSourcesPath === undefined) {
    out('  sources: none declared (no event-sources.yaml at the scope root)\n');
  }

  if (deps.renderRepl === undefined) {
    // Without an injected renderer there's nothing left to do — the
    // CLI always injects one. Tests may leave this undefined to
    // verify load-side behavior without booting Ink. Stop any
    // sources we did start so tests don't leak ports.
    if (sources !== undefined) await sources.stop();
    return 0;
  }

  try {
    await deps.renderRepl({
      agentSpec,
      agentLabel: loaded.spec.name,
      ...(args.model !== undefined && { model: args.model }),
    });
  } finally {
    if (sources !== undefined) {
      try {
        await sources.stop();
      } catch (stopErr) {
        err(
          `warning: source shutdown had errors: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}\n`,
        );
      }
    }
  }
  return 0;
}

/**
 * Find the agent's event-sources config. Prefers yaml / yml over json
 * since every declaragent-shipped template uses yaml. Returns
 * `undefined` when no config is present; that's a valid shape — the
 * agent is skill-only.
 */
function findEventSourcesConfig(agentDir: string): string | undefined {
  for (const name of ['event-sources.yaml', 'event-sources.yml', 'event-sources.json']) {
    const p = join(agentDir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}
