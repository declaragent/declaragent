import type { PermissionMode } from '@declaragent/core';

export type SlashCommand =
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'cost' }
  | { kind: 'rules' }
  | { kind: 'mode'; mode: PermissionMode }
  | { kind: 'plan' } // alias of mode plan (no args)
  | { kind: 'planPropose'; description: string } // `/plan <description>` — builder-toolkit flow
  | { kind: 'model'; model?: string; refresh?: boolean }
  | { kind: 'clear' }
  | { kind: 'compact' }
  | { kind: 'memory' }
  | { kind: 'init'; template?: string; force?: boolean }
  | { kind: 'resume'; sessionId?: string }
  | { kind: 'sessions' }
  | { kind: 'proposalYes'; phrase?: string }
  | { kind: 'proposalNo' }
  | { kind: 'proposalEdit'; stepNumber: number; replacement: string }
  | { kind: 'proposalEditInvalid'; reason: string }
  | { kind: 'diff'; path?: string }
  | { kind: 'scope' }
  | { kind: 'fleetGraph'; format?: 'mermaid' | 'dot' | 'json' }
  | { kind: 'undo' }
  | { kind: 'history'; limit?: number }
  | { kind: 'prompt'; path: string }
  | { kind: 'promptInvalid'; reason: string }
  | { kind: 'unknown'; name: string };

export const SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  { name: '/help', description: 'List all slash commands' },
  { name: '/cost', description: 'Show token usage and estimated cost' },
  { name: '/rules', description: 'Show current permission mode + rules' },
  {
    name: '/mode <default|plan|bypass|auto>',
    description: 'Switch permission mode',
  },
  {
    name: '/plan [<description>]',
    description:
      'No args: shortcut for /mode plan. With args: ask the builder to propose a plan via DeclaraProposeChange (no execution until /yes).',
  },
  {
    name: '/yes [<phrase>]',
    description:
      'Confirm the active proposal. Deploy / audit-erase / scope-breach proposals require the exact phrase shown in the prompt.',
  },
  { name: '/no', description: 'Reject the active proposal.' },
  {
    name: '/edit <n> <replacement>',
    description: 'Revise step <n> of the active proposal.',
  },
  {
    name: '/diff [<path>]',
    description: 'Show `git diff` scoped to the current scope root (or the given path).',
  },
  { name: '/scope', description: 'Print the current builder scope root.' },
  {
    name: '/fleet graph [mermaid|dot|json]',
    description: "Render the fleet's peer graph inline (default format: mermaid).",
  },
  {
    name: '/undo',
    description:
      'Revert the last DeclaraApplyChange via scoped `git checkout`. Requires git + the apply captured a HEAD.',
  },
  {
    name: '/history [<limit>]',
    description: 'Render recent builder actions from the audit chain (default: 50 entries).',
  },
  {
    name: '/model [<id>|refresh]',
    description: 'Show/switch active model. `refresh` bypasses the 24h cache.',
  },
  { name: '/clear', description: 'Clear scrollback and start a fresh session' },
  { name: '/compact', description: 'Compact transcript (stub in v0.1)' },
  { name: '/memory', description: 'Show CLAUDE.md from cwd, if present' },
  {
    name: '/init [<template>] [--force]',
    description:
      'Scaffold an agent config (agent.yaml + skills + .env.example) into the current directory. Default template: concierge.',
  },
  {
    name: '/prompt <path>',
    description:
      "Read a file and submit its contents as your next user message, verbatim. Stopgap for long or multi-line prompts that ink-text-input's paste can't handle.",
  },
  { name: '/sessions', description: 'List persisted sessions' },
  { name: '/resume <id>', description: 'Resume a persisted session by id' },
  { name: '/exit', description: 'Quit the REPL (also: /quit)' },
];

const VALID_MODES: PermissionMode[] = ['default', 'plan', 'bypass', 'auto'];

function isPermissionMode(s: string): s is PermissionMode {
  return (VALID_MODES as string[]).includes(s);
}

/**
 * Parse a slash command string. Returns null if `input` does not start with `/`.
 * Unknown commands return `{ kind: 'unknown' }` so the caller can surface a
 * friendly error.
 */
export function parseSlash(input: string): SlashCommand | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return { kind: 'unknown', name: '' };
  const parts = trimmed.split(/\s+/);
  const name = parts[0] ?? '';
  const args = parts.slice(1);
  switch (name) {
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'exit':
    case 'quit':
      return { kind: 'exit' };
    case 'cost':
      return { kind: 'cost' };
    case 'rules':
      return { kind: 'rules' };
    case 'clear':
      return { kind: 'clear' };
    case 'compact':
      return { kind: 'compact' };
    case 'memory':
      return { kind: 'memory' };
    case 'plan': {
      // `/plan` (no args) stays as the mode-switch alias so muscle
      // memory from earlier releases survives. `/plan <description>`
      // hands off to the builder's propose flow.
      if (args.length === 0) return { kind: 'plan' };
      const description = args.join(' ').trim();
      if (description.length === 0) return { kind: 'plan' };
      return { kind: 'planPropose', description };
    }
    case 'yes': {
      const phrase = args.join(' ').trim();
      return phrase.length > 0 ? { kind: 'proposalYes', phrase } : { kind: 'proposalYes' };
    }
    case 'no':
      return { kind: 'proposalNo' };
    case 'edit': {
      // `/edit <n> <replacement>` — n is 1-indexed from the rendered
      // plan. Parse-failure surfaces as a dedicated kind so the REPL
      // can tell the user what it expected.
      if (args.length < 2) {
        return {
          kind: 'proposalEditInvalid',
          reason: 'usage: /edit <n> <replacement>',
        };
      }
      const firstArg = args[0];
      if (firstArg === undefined) {
        return {
          kind: 'proposalEditInvalid',
          reason: 'usage: /edit <n> <replacement>',
        };
      }
      const n = Number.parseInt(firstArg, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          kind: 'proposalEditInvalid',
          reason: `step number must be a positive integer, got "${firstArg}"`,
        };
      }
      const replacement = args.slice(1).join(' ').trim();
      if (replacement.length === 0) {
        return {
          kind: 'proposalEditInvalid',
          reason: 'replacement text is required',
        };
      }
      return { kind: 'proposalEdit', stepNumber: n, replacement };
    }
    case 'diff': {
      const path = args[0];
      return path !== undefined ? { kind: 'diff', path } : { kind: 'diff' };
    }
    case 'scope':
      return { kind: 'scope' };
    case 'undo':
      return { kind: 'undo' };
    case 'history': {
      const raw = args[0];
      if (raw === undefined) return { kind: 'history' };
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) return { kind: 'history' };
      return { kind: 'history', limit: n };
    }
    case 'fleet': {
      // `/fleet graph [mermaid|dot|json]` — only the `graph`
      // sub-command is live in phase 4. Other fleet verbs can slot in
      // here as later slices extend the builder.
      const sub = args[0];
      if (sub !== 'graph') {
        return { kind: 'unknown', name: 'fleet' };
      }
      const format = args[1];
      if (format === undefined) return { kind: 'fleetGraph' };
      if (format === 'mermaid' || format === 'dot' || format === 'json') {
        return { kind: 'fleetGraph', format };
      }
      return { kind: 'unknown', name: 'fleet graph' };
    }
    case 'model': {
      const arg = args[0];
      if (!arg) return { kind: 'model' };
      if (arg === 'refresh') return { kind: 'model', refresh: true };
      return { kind: 'model', model: arg };
    }
    case 'init': {
      // `/init [<template>] [--force]` — scaffold into cwd.
      const force = args.includes('--force') || args.includes('-f');
      const template = args.find((a) => !a.startsWith('-'));
      const out: { kind: 'init'; template?: string; force?: boolean } = { kind: 'init' };
      if (template !== undefined) out.template = template;
      if (force) out.force = true;
      return out;
    }
    case 'prompt': {
      const path = args.join(' ').trim();
      if (path.length === 0) {
        return { kind: 'promptInvalid', reason: 'usage: /prompt <path>' };
      }
      return { kind: 'prompt', path };
    }
    case 'sessions':
      return { kind: 'sessions' };
    case 'resume': {
      const sessionId = args[0];
      return sessionId ? { kind: 'resume', sessionId } : { kind: 'resume' };
    }
    case 'mode': {
      const arg = args[0];
      if (!arg || !isPermissionMode(arg)) {
        return { kind: 'unknown', name: 'mode' };
      }
      return { kind: 'mode', mode: arg };
    }
    default:
      return { kind: 'unknown', name };
  }
}
