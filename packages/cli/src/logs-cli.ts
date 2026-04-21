/**
 * `declaragent logs [-f] [<agent-id>]` — tail per-agent event logs.
 *
 * Default: print the tail of every active agent's log (50 lines each),
 * prefixed with the agent id. `-f` follows new appends across all
 * matched logs. Passing a specific `<agent-id>` narrows the output to
 * just that file.
 *
 * Uses the state snapshot to discover which agents are currently up;
 * falls back to "nothing up" when no state is present. Follow mode
 * watches the file for appends via `fs.watch` (good enough for our
 * JSON-line logs; we don't need `fs.watchFile` polling).
 *
 * @since 0.4.1
 */

import { existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import type { UpAgentSummary } from './up-lifecycle.js';
import { reapStaleState, upLogPath, upLogsDir } from './up-lifecycle.js';

export interface LogsIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: LogsIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface LogsArgs {
  /** Filter to one agent id. When undefined, show all. */
  agentId?: string;
  /** Follow mode — keep tailing new appends until the process is killed. */
  follow?: boolean;
  /** Tail window (lines per agent). Default 50. */
  tailLines?: number;
}

export interface LogsDeps {
  io?: LogsIO;
  /** Override the signal installer — tests skip the SIGINT handler. */
  installSignals?: (onStop: () => void) => () => void;
}

export async function logs(args: LogsArgs, deps: LogsDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const state = reapStaleState();

  // Log files persist across up/down cycles — tailing them must stay
  // available when nothing is currently up (the post-mortem case).
  // When state is present we use the bound-agent list for the "tail
  // all" case + enforce the filter; when state is absent we fall back
  // to whatever log files exist on disk.
  const candidates = state
    ? filterAgents(state.agents, args.agentId)
    : fallbackAgentsFromDisk(args.agentId);

  if (candidates.length === 0) {
    if (args.agentId !== undefined) {
      io.err(
        `no log file for "${args.agentId}" at ${upLogPath(args.agentId)}. Bring an agent up first, or pick a different id.\n`,
      );
    } else {
      io.out('no log files under ~/.declaragent/logs/.\n');
    }
    return 1;
  }

  const tailLines = args.tailLines ?? 50;
  for (const agent of candidates) {
    io.out(`── ${agent.id} ──\n`);
    printTail(io, agent.id, tailLines);
  }

  if (!args.follow) return 0;

  io.out('\n(following new events — Ctrl+C to stop)\n');

  // Follow mode: one fs.watch per agent log. Track byte position so
  // we only emit new appends, not re-reads of the full file.
  const cleanups: Array<() => void> = [];
  let stopped = false;
  for (const agent of candidates) {
    const cleanup = followOne(agent.id, (line) => {
      if (!stopped) io.out(`[${agent.id}] ${line}\n`);
    });
    cleanups.push(cleanup);
  }

  const waitForStop = new Promise<void>((resolveStop) => {
    const onStop = (): void => {
      if (stopped) return;
      stopped = true;
      for (const fn of cleanups) fn();
      resolveStop();
    };
    const uninstall = deps.installSignals?.(onStop) ?? installDefaultSignal(onStop);
    // Make sure our uninstall runs even if onStop is triggered some
    // other way (rare; safe to call twice).
    void Promise.resolve().then(() => {
      if (stopped) uninstall();
    });
  });

  await waitForStop;
  return 0;
}

function filterAgents(agents: readonly UpAgentSummary[], id: string | undefined): UpAgentSummary[] {
  if (id === undefined) return [...agents];
  return agents.filter((a) => a.id === id);
}

/**
 * Build a minimal UpAgentSummary list from whatever log files exist
 * in `~/.declaragent/logs/`. Used when `up-state.json` is absent
 * (post-`down` post-mortem case). Only the `id` field is meaningful
 * here — path + sources default to empty.
 */
function fallbackAgentsFromDisk(filter: string | undefined): UpAgentSummary[] {
  const dir = upLogsDir();
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const ids = files.filter((f) => f.endsWith('.log')).map((f) => f.replace(/\.log$/, ''));
  const matches = filter === undefined ? ids : ids.filter((id) => id === filter);
  return matches.map((id) => ({ id, path: '', sources: [] }));
}

function printTail(io: LogsIO, agentId: string, tailLines: number): void {
  const path = upLogPath(agentId);
  if (!existsSync(path)) {
    io.out('  (no log file yet)\n');
    return;
  }
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((line) => line.length > 0);
  const window = lines.slice(-tailLines);
  for (const line of window) {
    io.out(`  ${line}\n`);
  }
}

function followOne(agentId: string, onLine: (line: string) => void): () => void {
  const path = upLogPath(agentId);
  if (!existsSync(path)) return () => {};

  let position = statSync(path).size;

  const watcher = watch(path, (eventType) => {
    if (eventType !== 'change') return;
    try {
      const size = statSync(path).size;
      if (size < position) {
        // File truncated (unusual for our append-only log). Reset.
        position = 0;
      }
      if (size === position) return;
      const raw = readFileSync(path, 'utf8');
      const tail = raw.slice(position, size);
      position = size;
      for (const line of tail.split('\n')) {
        if (line.length === 0) continue;
        onLine(line);
      }
    } catch {
      // File rotated / removed — silently stop emitting; the user
      // will see the gap.
    }
  });

  return () => {
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
}

function installDefaultSignal(onStop: () => void): () => void {
  const handler = (): void => onStop();
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}
