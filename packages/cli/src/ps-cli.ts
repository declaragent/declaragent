/**
 * `declaragent ps` — list agents currently up.
 *
 * Primary data source (0.6.x): the per-agent control socket at
 * `~/.declaragent/<agent-id>/control.sock`. Each agent's socket
 * responds to `status` with a fresh pid/uptime/sources/lastEventAt
 * tuple — so `ps` reflects the daemon's real state rather than a
 * snapshot `up` wrote once at boot.
 *
 * Fallback: the `up-state.json` snapshot. This is still the only way
 * to learn "which agents exist" in the first place (one state file
 * catalogs every agent the up-process hosts), and it's the sole path
 * when the socket has been removed or the daemon crashed without
 * cleaning up.
 *
 * @since 0.4.1 / rewired for control-socket 0.6.x
 */

import type { ControlSocketStatus } from '@declaragent/core';
import {
  resolveAgentControlSocketPath,
  tryFetchControlSocketStatus,
} from './control-socket-client.js';
import type { UpAgentSummary } from './up-lifecycle.js';
import { reapStaleState } from './up-lifecycle.js';

export interface PsIO {
  out: (s: string) => void;
}

const STDIO_IO: PsIO = { out: (s) => process.stdout.write(s) };

export interface PsDeps {
  io?: PsIO;
  /** Override the socket-path resolver (tests). */
  resolveSocket?: (agentId: string) => string;
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
    const resolveSocket = deps.resolveSocket ?? ((id) => resolveAgentControlSocketPath(id));
    // Try the live socket first; fall through to the state-file
    // snapshot when it's unreachable (daemon crashed, stale state,
    // or the agent predates 0.6.x). `tryFetchControlSocketStatus`
    // absorbs connect-timeout / error-response / missing-socket so
    // this path stays linear.
    const liveStatus = await tryFetchControlSocketStatus(resolveSocket(agent.id));
    if (liveStatus) {
      io.out(formatAgentLive(agent, liveStatus));
    } else {
      io.out(formatAgentSnapshot(agent));
    }
  }

  return 0;
}

function formatAgentLive(agent: UpAgentSummary, status: ControlSocketStatus): string {
  const lines: string[] = [];
  lines.push(`  ${agent.id}  (live via control socket)`);
  lines.push(`    path: ${agent.path}`);
  lines.push(`    pid: ${status.pid}`);
  const uptime = humanizeMs(status.uptimeMs);
  lines.push(`    uptime: ${uptime}`);
  if (status.sources.length === 0) {
    lines.push('    sources: (skill-only)');
  } else {
    lines.push(`    sources: ${status.sources.length}`);
    for (const s of status.sources) {
      // Prefer the snapshot's richer summary line when it exists; fall
      // back to `type/id` from the live socket.
      const snapshotMatch = agent.sources.find((x) => x.id === s.id);
      lines.push(`      • ${snapshotMatch ? snapshotMatch.summary : `${s.type} (${s.id})`}`);
    }
  }
  if (status.lastEventAt !== undefined) {
    lines.push(`    last event: ${relativeTime(new Date(status.lastEventAt))}`);
  } else {
    lines.push('    last event: (none yet)');
  }
  return `${lines.join('\n')}\n`;
}

function formatAgentSnapshot(agent: UpAgentSummary): string {
  const lines: string[] = [];
  lines.push(`  ${agent.id}  (snapshot)`);
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

function humanizeMs(ms: number): string {
  if (ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
