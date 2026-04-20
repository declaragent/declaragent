import type { PermissionMode } from '@declaragent/core';

export type SlashCommand =
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'cost' }
  | { kind: 'rules' }
  | { kind: 'mode'; mode: PermissionMode }
  | { kind: 'plan' } // alias of mode plan
  | { kind: 'model'; model?: string; refresh?: boolean }
  | { kind: 'clear' }
  | { kind: 'compact' }
  | { kind: 'memory' }
  | { kind: 'resume'; sessionId?: string }
  | { kind: 'sessions' }
  | { kind: 'unknown'; name: string };

export const SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  { name: '/help', description: 'List all slash commands' },
  { name: '/cost', description: 'Show token usage and estimated cost' },
  { name: '/rules', description: 'Show current permission mode + rules' },
  {
    name: '/mode <default|plan|bypass|auto>',
    description: 'Switch permission mode',
  },
  { name: '/plan', description: 'Shortcut for /mode plan' },
  {
    name: '/model [<id>|refresh]',
    description: 'Show/switch active model. `refresh` bypasses the 24h cache.',
  },
  { name: '/clear', description: 'Clear scrollback and start a fresh session' },
  { name: '/compact', description: 'Compact transcript (stub in v0.1)' },
  { name: '/memory', description: 'Show CLAUDE.md from cwd, if present' },
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
    case 'plan':
      return { kind: 'plan' };
    case 'model': {
      const arg = args[0];
      if (!arg) return { kind: 'model' };
      if (arg === 'refresh') return { kind: 'model', refresh: true };
      return { kind: 'model', model: arg };
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
