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
import { isAbsolute, resolve } from 'node:path';
import {
  AgentConfigError,
  type AgentSpec,
  type LoadedAgent,
  composeSystemPromptWithSkills,
  loadAgent,
} from '@declaragent/core';

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
  /** Factory the CLI injects — normally `(props) => render(<App {...props} />)`. */
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

  const agentSpec: AgentSpec = {
    ...loaded.spec,
    systemPrompt: composeSystemPromptWithSkills(loaded.spec.systemPrompt, loaded.skills),
  };

  out(`running ${loaded.spec.name} from ${loaded.agentDir}\n`);
  out(`  model:  ${loaded.spec.model}\n`);
  out(
    `  skills: ${loaded.skills.length} loaded (${loaded.skills.map((s) => s.lookupName).join(', ') || 'none'})\n`,
  );
  if (loaded.toolNames.length > 0) {
    out(`  tools:  declared defaults = ${loaded.toolNames.join(', ')}\n`);
  }
  if (args.noSources === false || args.noSources === undefined) {
    // PR #1 is skill-only regardless, but print a hint so the user
    // knows source-wiring isn't live yet.
    out(
      '  note:   event-sources.yaml is not wired in this release; REPL is conversational-test mode only.\n',
    );
  }

  if (deps.renderRepl === undefined) {
    // Without an injected renderer there's nothing left to do — the
    // CLI always injects one. Tests may leave this undefined to
    // verify load-side behavior without booting Ink.
    return 0;
  }

  await deps.renderRepl({
    agentSpec,
    agentLabel: loaded.spec.name,
    ...(args.model !== undefined && { model: args.model }),
  });
  return 0;
}
