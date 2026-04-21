/**
 * `declaragent ps` — list agents currently up.
 *
 * Mirrors `docker compose ps`: reads the up-state snapshot, confirms
 * the owning pid is still alive (reaps stale state otherwise), and
 * prints a human-readable table. Exit 0 with "nothing up" when
 * nothing is running — scripts can test the exit code.
 *
 * @since 0.4.1
 */

import type { UpAgentSummary } from './up-lifecycle.js';
import { reapStaleState } from './up-lifecycle.js';

export interface PsIO {
  out: (s: string) => void;
}

const STDIO_IO: PsIO = { out: (s) => process.stdout.write(s) };

export interface PsDeps {
  io?: PsIO;
}

export async function ps(deps: PsDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const state = reapStaleState();
  if (state === null) {
    io.out('nothing up.\n');
    return 0;
  }

  const upSince = relativeTime(new Date(state.startedAt));
  io.out(`up since ${upSince} — pid ${state.pid}, manifest ${state.manifestPath}\n\n`);

  for (const agent of state.agents) {
    io.out(formatAgent(agent));
  }

  return 0;
}

function formatAgent(agent: UpAgentSummary): string {
  const lines: string[] = [];
  lines.push(`  ${agent.id}`);
  lines.push(`    path: ${agent.path}`);
  if (agent.sources.length === 0) {
    lines.push('    sources: (skill-only)');
  } else {
    lines.push(`    sources: ${agent.sources.length}`);
    for (const s of agent.sources) {
      lines.push(`      • ${s.summary}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function relativeTime(start: Date): string {
  const ms = Date.now() - start.getTime();
  if (ms < 0) return start.toISOString();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
