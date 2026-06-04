/**
 * `declaragent fleet ps / events / dlq / logs` — cross-host fan-out.
 *
 * Slice 3 of `docs/CONTROL_PLANE_PLAN.md` / POST_ENTERPRISE_BACKLOG.md
 * #50. Reads `fleet.yaml.hosts[]`; when present, each verb runs N
 * parallel HTTP calls — one per host — against each host's
 * `/status`, `/events`, `/dlq`, `/logs` endpoint, merges, and renders.
 *
 * Back-compat: when `fleet.yaml.hosts` is absent or empty, each verb
 * prints a short pointer to the existing single-host path (`declaragent
 * ps` / `events list` / `dlq list`). We don't silently fall through —
 * operators deserve to know the single-host path lives under a
 * different verb tree.
 *
 * Design points:
 *
 *   - One bearer per host lives in `fleet.yaml.hosts[].auth.bearer`;
 *     supports `env:NAME` / `file:/path` / literal. Per-agent auth
 *     registry (Agent A's Sprint 4 #18) is a different concern —
 *     that gates incoming RPC AT each host. We do not cross streams.
 *   - Per-host failures are tagged + rendered in the trailer. One bad
 *     host NEVER blocks the aggregate.
 *   - `--host <name>` restricts to one host. `--json` emits a stable
 *     shape including per-host success/failure status.
 *   - `fleet logs` is NOT a live SSE tail in this Slice — the underlying
 *     `/logs` route is SSE-only and multi-stream interleaving wants a
 *     dedicated multiplexer (CONTROL_PLANE_PLAN.md Slice 6). Slice 3
 *     ships a snapshot-only `fleet logs` that reads the latest N lines
 *     per host via a short-lived SSE connection (terminates on the
 *     next heartbeat or after `maxLinesPerHost`). `-f` follow lands in
 *     Slice 6. The CLI prints a one-line hint when `-f` is passed.
 *
 * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #50
 */

import { readSync } from 'node:fs';
import { userInfo } from 'node:os';
import type {
  DlqMutationResponse,
  DlqResponseEntry,
  EventsResponseEntry,
  FleetHost,
  UpStatusSnapshot,
} from '@declaragent/core';
import { FleetConfigError, FleetManifestError, findFleetRoot, loadFleet } from '@declaragent/core';
import {
  type CrossHostClientOptions,
  type CrossHostControlPlaneClient,
  type GetDlqOpts,
  type GetEventsOpts,
  type HostError,
  type HostTaggedResult,
  createCrossHostControlPlaneClient,
  fanOut,
  partitionResults,
} from './cross-host-control-plane-client.js';
import { type MultiHostLogEvent, tailLogsMultiHost } from './fleet-logs-stream.js';

export interface FleetCrossHostIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetCrossHostIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

// ── Shared dependency shape ────────────────────────────────────────────

export interface FleetCrossHostDeps {
  io?: FleetCrossHostIO;
  cwd?: string;
  root?: string;
  /** Test hook — pre-resolved hosts. When set, the fleet loader is skipped. */
  hosts?: readonly FleetHost[];
  client?: CrossHostControlPlaneClient;
  /** Override `fetch` etc. for the default client. */
  clientOptions?: CrossHostClientOptions;
}

async function resolveHosts(
  deps: FleetCrossHostDeps,
  io: FleetCrossHostIO,
): Promise<readonly FleetHost[] | null> {
  if (deps.hosts) return deps.hosts;
  const root = deps.root ?? (await findFleetRoot(deps.cwd ?? process.cwd()));
  if (!root) {
    io.err('✗ no fleet.yaml found. Cross-host verbs need a fleet.yaml with a `hosts:` block.\n');
    return null;
  }
  try {
    const fleet = await loadFleet({ root });
    const hosts = fleet.manifest.hosts ?? [];
    return hosts;
  } catch (err) {
    if (err instanceof FleetManifestError || err instanceof FleetConfigError) {
      io.err(`✗ ${err.message}\n`);
    } else {
      io.err(`✗ failed to load fleet: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return null;
  }
}

function filterHosts(
  hosts: readonly FleetHost[],
  hostName: string | undefined,
  io: FleetCrossHostIO,
): readonly FleetHost[] | null {
  if (!hostName) return hosts;
  const match = hosts.find((h) => h.name === hostName);
  if (!match) {
    const declared = hosts.map((h) => h.name).join(', ') || '(none)';
    io.err(
      `✗ host "${hostName}" not declared in fleet.yaml#hosts. Declared hosts: ${declared}. Re-run without \`--host\` to fan out to all, or add it under fleet.yaml#hosts.\n`,
    );
    return null;
  }
  return [match];
}

function renderFailures(io: FleetCrossHostIO, failures: readonly HostError[]): void {
  if (failures.length === 0) return;
  io.err(`\n${failures.length} host(s) unreachable:\n`);
  for (const f of failures) {
    const code = f.status !== undefined ? ` (HTTP ${f.status})` : '';
    io.err(`  ✗ ${f.host}${code}: ${f.message}\n`);
  }
  io.err(
    "  Check each host's `endpoint`/`token` in fleet.yaml#hosts and that the remote control plane is up (`declaragent ps` on the host).\n",
  );
}

function client(deps: FleetCrossHostDeps): CrossHostControlPlaneClient {
  return deps.client ?? createCrossHostControlPlaneClient(deps.clientOptions ?? {});
}

// ── `fleet ps` ─────────────────────────────────────────────────────────

export interface FleetPsArgs {
  host?: string;
  json?: boolean;
}

export async function fleetPs(
  args: FleetPsArgs = {},
  deps: FleetCrossHostDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const hosts = await resolveHosts(deps, io);
  if (hosts === null) return 1;
  if (hosts.length === 0) {
    if (args.json === true) {
      io.out(`${JSON.stringify({ hosts: [], failures: [] }, null, 2)}\n`);
      return 0;
    }
    io.out('no `hosts:` block in fleet.yaml — use `declaragent ps` for the local view.\n');
    return 0;
  }
  const filtered = filterHosts(hosts, args.host, io);
  if (filtered === null) return 1;

  const c = client(deps);
  const results = await fanOut(filtered, (h) => c.getStatus(h));
  const { successes, failures } = partitionResults(results);

  if (args.json === true) {
    const body = {
      hosts: results.map((r) =>
        'ok' in r.result
          ? { host: r.host, ok: true, status: r.result.ok }
          : { host: r.host, ok: false, error: r.result.err },
      ),
      failures,
    };
    io.out(`${JSON.stringify(body, null, 2)}\n`);
    return failures.length > 0 ? 1 : 0;
  }

  if (successes.length === 0 && failures.length > 0) {
    io.err('✗ every host unreachable.\n');
    renderFailures(io, failures);
    return 1;
  }

  io.out('HOST'.padEnd(22));
  io.out('AGENTS'.padEnd(18));
  io.out('UPTIME'.padEnd(12));
  io.out('DISPATCHED'.padEnd(12));
  io.out('REJECTED'.padEnd(10));
  io.out('BREAKER\n');
  io.out(`${'─'.repeat(80)}\n`);
  for (const { host, value } of successes) {
    io.out(renderStatusRow(host, value));
  }
  renderFailures(io, failures);
  return failures.length > 0 ? 1 : 0;
}

function renderStatusRow(hostName: string, snap: UpStatusSnapshot): string {
  const agents = snap.agents;
  const first = agents[0]?.id ?? '(none)';
  const agentsCol = agents.length > 1 ? `${first},…(${agents.length})` : first;
  const maxUptime = agents.reduce((m, a) => Math.max(m, a.uptimeMs), 0);
  const uptime = humanizeMs(maxUptime);
  let dispatched = 0;
  let rejected = 0;
  let breakerOpen = 0;
  for (const a of agents) {
    dispatched += a.metrics.eventsDispatched;
    rejected += a.metrics.eventsRejected;
    breakerOpen += a.metrics.breakerOpen;
  }
  const breakerCol = breakerOpen > 0 ? `OPEN(${breakerOpen})` : '—';
  return (
    `${hostName.padEnd(22)}` +
    `${agentsCol.slice(0, 17).padEnd(18)}` +
    `${uptime.padEnd(12)}` +
    `${String(dispatched).padEnd(12)}` +
    `${String(rejected).padEnd(10)}` +
    `${breakerCol}\n`
  );
}

function humanizeMs(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// ── `fleet events` ─────────────────────────────────────────────────────

export interface FleetEventsListArgs {
  host?: string;
  kind?: string;
  since?: number | string;
  state?: 'circuit-open';
  outcome?: string;
  correlation?: string;
  limit?: number;
  /** When set, fan out across every agent on each host via host-side ?all=1. */
  all?: boolean;
  json?: boolean;
}

export async function fleetEventsList(
  args: FleetEventsListArgs = {},
  deps: FleetCrossHostDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const hosts = await resolveHosts(deps, io);
  if (hosts === null) return 1;
  if (hosts.length === 0) {
    io.out('no `hosts:` block in fleet.yaml — use `declaragent events list` for the local view.\n');
    return 0;
  }
  const filtered = filterHosts(hosts, args.host, io);
  if (filtered === null) return 1;

  const c = client(deps);
  const opts: GetEventsOpts = {
    ...(args.kind !== undefined && { kind: args.kind }),
    ...(args.since !== undefined && { since: args.since }),
    ...(args.state !== undefined && { state: args.state }),
    ...(args.outcome !== undefined && { outcome: args.outcome }),
    ...(args.correlation !== undefined && { correlation: args.correlation }),
    ...(args.limit !== undefined && { limit: args.limit }),
    ...(args.all === true && { all: true }),
  };

  const results = await fanOut(filtered, (h) => c.getEvents(h, opts));
  const { successes, failures } = partitionResults(results);

  type Tagged = { host: string; agentId?: string; entry: EventsResponseEntry };
  const rows: Tagged[] = [];
  for (const { host, value } of successes) {
    for (const e of value.events) {
      rows.push({
        host,
        ...(e.agentId !== undefined && { agentId: e.agentId }),
        entry: e,
      });
    }
  }
  // Merge-sort by ts DESC (ties broken by id DESC for determinism).
  rows.sort((a, b) => {
    if (a.entry.ts !== b.entry.ts) return b.entry.ts - a.entry.ts;
    return a.entry.id < b.entry.id ? 1 : a.entry.id > b.entry.id ? -1 : 0;
  });

  if (args.json === true) {
    const body = {
      events: rows.map((r) => ({ host: r.host, agentId: r.agentId, ...r.entry })),
      failures,
    };
    io.out(`${JSON.stringify(body, null, 2)}\n`);
    return failures.length > 0 ? 1 : 0;
  }

  if (rows.length === 0 && successes.length > 0) {
    io.out('no events.\n');
  } else if (rows.length === 0 && failures.length === hosts.length) {
    io.err('✗ every host unreachable.\n');
    renderFailures(io, failures);
    return 1;
  } else {
    io.out(`events (${rows.length}):\n`);
    for (const r of rows) {
      const tsIso = new Date(r.entry.ts).toISOString();
      const agentCol = r.agentId ? `${r.host}/${r.agentId}` : r.host;
      const outcome = formatOutcome(r.entry.outcome);
      io.out(
        `  ${tsIso}  ${r.entry.kind.padEnd(18)}  ${agentCol.padEnd(26)}  ${outcome.padEnd(28)}  ${r.entry.id}\n`,
      );
    }
  }
  renderFailures(io, failures);
  return failures.length > 0 ? 1 : 0;
}

function formatOutcome(outcome: EventsResponseEntry['outcome']): string {
  if (!outcome) return 'pending';
  switch (outcome.kind) {
    case 'dispatched':
      return `dispatched→${outcome.sessionId}`;
    case 'broadcast':
      return 'broadcast';
    case 'queued':
      return `queued:${outcome.reason}`;
    case 'duplicate':
      return `duplicate@${new Date(outcome.firstSeenAt).toISOString()}`;
    case 'rejected':
      return `rejected:${outcome.reason}${outcome.details ? ` (${outcome.details})` : ''}`;
  }
}

// ── `fleet dlq` ────────────────────────────────────────────────────────

export interface FleetDlqListArgs {
  host?: string;
  kind?: 'dispatch';
  reason?: string;
  minAttempts?: number;
  since?: number | string;
  limit?: number;
  all?: boolean;
  json?: boolean;
}

export async function fleetDlqList(
  args: FleetDlqListArgs = {},
  deps: FleetCrossHostDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const hosts = await resolveHosts(deps, io);
  if (hosts === null) return 1;
  if (hosts.length === 0) {
    io.out('no `hosts:` block in fleet.yaml — use `declaragent dlq list` for the local view.\n');
    return 0;
  }
  const filtered = filterHosts(hosts, args.host, io);
  if (filtered === null) return 1;

  const c = client(deps);
  const opts: GetDlqOpts = {
    ...(args.kind !== undefined && { kind: args.kind }),
    ...(args.reason !== undefined && { reason: args.reason }),
    ...(args.minAttempts !== undefined && { minAttempts: args.minAttempts }),
    ...(args.since !== undefined && { since: args.since }),
    ...(args.limit !== undefined && { limit: args.limit }),
    ...(args.all === true && { all: true }),
  };

  const results = await fanOut(filtered, (h) => c.getDlq(h, opts));
  const { successes, failures } = partitionResults(results);

  type Tagged = { host: string; agentId?: string; entry: DlqResponseEntry };
  const rows: Tagged[] = [];
  for (const { host, value } of successes) {
    for (const e of value.rejections) {
      rows.push({
        host,
        ...(e.agentId !== undefined && { agentId: e.agentId }),
        entry: e,
      });
    }
  }
  rows.sort((a, b) => b.entry.lastSeenMs - a.entry.lastSeenMs);

  if (args.json === true) {
    const body = {
      rejections: rows.map((r) => ({ host: r.host, agentId: r.agentId, ...r.entry })),
      failures,
    };
    io.out(`${JSON.stringify(body, null, 2)}\n`);
    return failures.length > 0 ? 1 : 0;
  }

  if (rows.length === 0 && successes.length > 0) {
    io.out('no DLQ entries.\n');
  } else if (rows.length === 0 && failures.length === hosts.length) {
    io.err('✗ every host unreachable.\n');
    renderFailures(io, failures);
    return 1;
  } else {
    io.out(`dlq rejections (${rows.length}):\n`);
    for (const r of rows) {
      const tsIso = new Date(r.entry.lastSeenMs).toISOString();
      const agentCol = r.agentId ? `${r.host}/${r.agentId}` : r.host;
      io.out(
        `  ${tsIso}  ${agentCol.padEnd(26)}  attempts=${String(r.entry.attemptCount).padEnd(3)}  reason=${r.entry.reason.padEnd(18)}  ${r.entry.eventId}\n`,
      );
    }
  }
  renderFailures(io, failures);
  return failures.length > 0 ? 1 : 0;
}

// ── `fleet logs` ───────────────────────────────────────────────────────

/**
 * Cross-host log tail. Two modes:
 *
 *   - **Snapshot** (default). Reads each host's `/logs?all=1` in a
 *     short-lived SSE read, collects the first `maxLinesPerHost` log
 *     lines across each stream, closes, merges by timestamp.
 *   - **Follow (`-f`)**. Opens long-lived SSE connections to each host
 *     in parallel and streams chunks live, tagged with `[host/agent]`
 *     as they arrive. See `fleet-logs-stream.ts` (Slice 6a).
 *
 * @since 0.7.4 — snapshot mode (Slice 3)
 * @since 0.7.5 — live follow mode (Slice 6a)
 */
export interface FleetLogsArgs {
  host?: string;
  agent?: string;
  follow?: boolean;
  /** Max log lines to keep per host before terminating. Default 100. */
  maxLinesPerHost?: number;
  /** Hard timeout per host's SSE read. Default 3s. */
  timeoutMsPerHost?: number;
  json?: boolean;
  /**
   * Install handler for SIGINT (and SIGTERM) — production default is
   * true so Ctrl+C cleans up every open stream. Tests set false and
   * call `handle.stop()` directly.
   */
  installSignalHandlers?: boolean;
}

export async function fleetLogs(
  args: FleetLogsArgs = {},
  deps: FleetCrossHostDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const hosts = await resolveHosts(deps, io);
  if (hosts === null) return 1;
  if (hosts.length === 0) {
    io.out(
      'no `hosts:` block in fleet.yaml — tail per-host logs via `declaragent ps` on each host.\n',
    );
    return 0;
  }
  const filtered = filterHosts(hosts, args.host, io);
  if (filtered === null) return 1;

  if (args.follow === true) {
    return fleetLogsFollow(filtered, args, deps, io);
  }

  const fetchImpl = deps.clientOptions?.fetchImpl ?? fetch;
  const env = deps.clientOptions?.env ?? (process.env as Record<string, string | undefined>);
  const maxLines = args.maxLinesPerHost ?? 100;
  const timeout = args.timeoutMsPerHost ?? 3000;

  const results = await fanOut(filtered, async (h) => {
    const query: { agent?: string } = {};
    if (args.agent !== undefined) query.agent = args.agent;
    return await readLogSnapshot(h, query, {
      fetchImpl,
      env,
      maxLines,
      timeoutMs: h.timeoutMs ?? timeout,
    });
  });
  const { successes, failures } = partitionResults(results);

  type Tagged = { host: string; agentId: string; ts: number; text: string };
  const rows: Tagged[] = [];
  for (const { host, value } of successes) {
    for (const line of value) {
      rows.push({ host, agentId: line.agentId ?? 'unknown', ts: line.ts, text: line.text });
    }
  }
  rows.sort((a, b) => a.ts - b.ts);

  if (args.json === true) {
    io.out(`${JSON.stringify({ logs: rows, failures }, null, 2)}\n`);
    return failures.length > 0 ? 1 : 0;
  }
  for (const r of rows) {
    const tsIso = new Date(r.ts).toISOString();
    io.out(`${tsIso}  [${r.host}/${r.agentId}]  ${r.text}\n`);
  }
  renderFailures(io, failures);
  return failures.length > 0 ? 1 : 0;
}

interface LogSnapshotLine {
  agentId: string | undefined;
  ts: number;
  text: string;
}

interface ReadLogSnapshotParams {
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  maxLines: number;
  timeoutMs: number;
}

async function readLogSnapshot(
  host: FleetHost,
  query: { agent?: string },
  params: ReadLogSnapshotParams,
): Promise<LogSnapshotLine[]> {
  const base = host.url.replace(/\/+$/, '');
  const sp = new URLSearchParams();
  if (query.agent) {
    sp.set('agent', query.agent);
  } else {
    sp.set('all', '1');
  }
  const url = `${base}/logs?${sp.toString()}`;
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
  };
  if (host.auth?.bearer) {
    // Lazy import to avoid the resolver cost on the happy-no-auth path.
    const { resolveBearerToken } = await import('./cross-host-control-plane-client.js');
    headers.authorization = `Bearer ${resolveBearerToken(host.auth.bearer, { env: params.env })}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await params.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const msg = `${res.status} ${res.statusText}`;
      const err = new Error(msg);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const lines: LogSnapshotLine[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (lines.length < params.maxLines) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines. Split on \n\n; keep the
      // trailing partial in the buffer.
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const frame of parts) {
        const parsed = parseSseFrame(frame);
        if (parsed) lines.push(parsed);
        if (lines.length >= params.maxLines) break;
      }
    }
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    return lines;
  } finally {
    clearTimeout(timer);
  }
}

function parseSseFrame(frame: string): LogSnapshotLine | null {
  const lines = frame.split('\n').filter((l) => l.length > 0);
  let event = 'message';
  let data: string | undefined;
  for (const l of lines) {
    if (l.startsWith(':')) continue;
    if (l.startsWith('event:')) {
      event = l.slice(6).trim();
    } else if (l.startsWith('data:')) {
      data = (data ? `${data}\n` : '') + l.slice(5).trimStart();
    }
  }
  if (event !== 'log' || data === undefined) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const ts =
      typeof parsed.ts === 'number'
        ? parsed.ts
        : typeof parsed.timestamp === 'number'
          ? parsed.timestamp
          : Date.now();
    const text =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.text === 'string'
          ? parsed.text
          : data;
    const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : undefined;
    return { agentId, ts, text };
  } catch {
    return { agentId: undefined, ts: Date.now(), text: data };
  }
}

// ── `fleet logs -f` — live multi-host SSE follow ───────────────────────

async function fleetLogsFollow(
  hosts: readonly import('@declaragent/core').FleetHost[],
  args: FleetLogsArgs,
  deps: FleetCrossHostDeps,
  io: FleetCrossHostIO,
): Promise<number> {
  const fetchImpl = deps.clientOptions?.fetchImpl ?? fetch;
  const env = deps.clientOptions?.env ?? (process.env as Record<string, string | undefined>);
  const installSignals = args.installSignalHandlers ?? true;
  const jsonMode = args.json === true;

  io.err(`tailing ${hosts.length} host(s). Ctrl+C to exit.\n`);

  const renderEvent = (event: MultiHostLogEvent): void => {
    if (jsonMode) {
      if (event.kind === 'log') {
        io.out(`${JSON.stringify({ kind: 'log', ...event.line })}\n`);
      } else {
        // Rename the inner `kind` so the envelope marker survives the spread.
        const { kind: eventKind, ...rest } = event.event;
        io.out(`${JSON.stringify({ kind: 'system', event: eventKind, ...rest })}\n`);
      }
      return;
    }
    if (event.kind === 'log') {
      const tsIso = new Date(event.line.ts).toISOString();
      const agentCol = event.line.agentId ?? 'unknown';
      io.out(`${tsIso}  [${event.line.host}/${agentCol}]  ${event.line.text}\n`);
      return;
    }
    // System notices go to stderr so stdout remains machine-parseable
    // (one log-line per newline) even in human-readable mode.
    const tag = event.event.kind.toUpperCase();
    io.err(`[${event.event.host}] ${tag}: ${event.event.message}\n`);
  };

  const handle = tailLogsMultiHost({
    hosts,
    ...(args.agent !== undefined && { agent: args.agent }),
    fetchImpl,
    env,
    onEvent: renderEvent,
  });

  if (installSignals) {
    const cleanup = async () => {
      await handle.stop();
      // Re-raise default behaviour so the shell reports the correct exit.
      process.exit(0);
    };
    process.once('SIGINT', () => {
      void cleanup();
    });
    process.once('SIGTERM', () => {
      void cleanup();
    });
  }

  // Block until every per-host loop has exited (today only via stop()).
  await handle.done;
  return 0;
}

// ── `fleet dlq drop` + `fleet dlq requeue` — cross-host mutations ──────
//
// Slice 6b of POST_ENTERPRISE_BACKLOG.md #50. Snapshot + live-tail ship in
// Slice 3 + Slice 6a. Mutations were deliberately deferred because they
// are destructive — bulk-fan-out of a destructive op without confirmation
// is the #19 hazard pattern (`?all=1` on reads) promoted to an existential
// foot-gun. The design here:
//
//   - Default is single-host. `--host <name>` targets one FleetHost.
//   - When `fleet.yaml` declares multiple hosts and `--host` is omitted
//     we ERROR OUT (exit 2 — "ambiguous target"). We do NOT silently
//     pick the first host; that conflicts with operator expectations
//     every single time the shell aliases drift.
//   - `--all-hosts` is an explicit opt-in for cross-host bulk. It
//     REQUIRES a confirmation prompt unless `--yes` is supplied. The
//     prompt reads from stdin synchronously so it works in `ssh`
//     pipelines without extra tooling (`< /dev/tty`-style workarounds).
//   - Per-host failures are isolated: one host 404-ing (id not present
//     there) doesn't stop a peer host's successful mutation. The exit
//     code surfaces partial success as non-zero so scripts can detect it.
//   - `host:` tag is added client-side when rendering: the HTTP route
//     response body already carries the op result, the CLI wraps it
//     with the FleetHost name from `fleet.yaml`.

export interface FleetDlqMutationArgs {
  /** Single-host targeting. Required when the fleet has >1 host unless `allHosts` is set. */
  host?: string;
  /** Kind of DLQ. Only `dispatch` honored today. */
  kind?: 'dispatch';
  /** Event id to mutate. Required. */
  id?: string;
  /** Cross-host fan-out opt-in. Requires confirmation unless `yes`. */
  allHosts?: boolean;
  /** Suppress the confirmation prompt when `allHosts` is set. */
  yes?: boolean;
  /** JSON renderer for CI pipelines. */
  json?: boolean;
}

export interface FleetDlqMutationDeps extends FleetCrossHostDeps {
  /**
   * Confirmation prompt hook. Default reads a single line from stdin
   * and returns true iff the user types `y` or `yes` (case-insensitive).
   * Tests inject a stub.
   */
  confirm?: (message: string) => boolean | Promise<boolean>;
  /** Test override for the audit record of "who asked for this". */
  initiator?: string;
}

/** Tagged per-host result returned by the mutation fan-out. */
export interface FleetDlqMutationHostRow {
  readonly host: string;
  readonly ok: boolean;
  readonly response?: DlqMutationResponse;
  readonly error?: HostError;
}

const DEFAULT_CONFIRM = (message: string): boolean => {
  // Synchronous stdin read. We intentionally do NOT use `readline` —
  // it installs an `'SIGINT'` handler that conflicts with the logs
  // follow-mode cleanup and forces async flow into what is otherwise
  // a blocking prompt. A one-shot `readSync` keeps the prompt dead
  // simple + testable.
  process.stdout.write(`${message}`);
  try {
    const buf = Buffer.alloc(1024);
    const n = readSync(0, buf, 0, buf.length, null);
    const answer = buf.subarray(0, n).toString('utf-8').trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } catch {
    // Non-TTY stdin (piped `echo n`) returns 0; treat as cancel.
    return false;
  }
};

function resolveInitiator(deps: FleetDlqMutationDeps): string {
  if (deps.initiator !== undefined && deps.initiator !== '') return deps.initiator;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

type MutationExitCode = 0 | 1 | 2 | 3;

async function runFleetDlqMutation(
  op: 'drop' | 'requeue',
  args: FleetDlqMutationArgs,
  deps: FleetDlqMutationDeps,
): Promise<MutationExitCode> {
  const io = deps.io ?? STDIO_IO;
  if (!args.id) {
    io.err(`✗ --id is required for fleet dlq ${op}\n`);
    return 1;
  }
  const kind: 'dispatch' = args.kind ?? 'dispatch';

  const hosts = await resolveHosts(deps, io);
  if (hosts === null) return 1;
  if (hosts.length === 0) {
    io.out(
      `no \`hosts:\` block in fleet.yaml — use \`declaragent dlq ${op} --kind ${kind} ${args.id}\` for the local path.\n`,
    );
    return 0;
  }

  // Target selection.
  //   --host  → exactly that host.
  //   --all-hosts → every host (confirm required).
  //   neither, 1 host → that host.
  //   neither, >1 hosts → refuse (exit 2).
  let targets: readonly FleetHost[];
  if (args.host !== undefined) {
    if (args.allHosts === true) {
      io.err('✗ pass EITHER --host <name> OR --all-hosts, not both.\n');
      return 1;
    }
    const filtered = filterHosts(hosts, args.host, io);
    if (filtered === null) return 1;
    targets = filtered;
  } else if (args.allHosts === true) {
    // Mutation across every host declared in fleet.yaml. This is the
    // hazardous path — confirm unless --yes.
    if (args.yes !== true) {
      const confirm = deps.confirm ?? DEFAULT_CONFIRM;
      const prompt = `About to ${op} dispatch-DLQ id "${args.id}" on ${hosts.length} host(s): ${hosts
        .map((h) => h.name)
        .join(', ')}.\nProceed? [y/N] `;
      const ok = await confirm(prompt);
      if (!ok) {
        io.err('✗ cancelled.\n');
        return 3;
      }
    }
    targets = hosts;
  } else if (hosts.length === 1) {
    targets = hosts;
  } else {
    io.err(
      `✗ fleet has ${hosts.length} hosts; pass --host <name> to target one, or --all-hosts --yes to mutate every host.\n`,
    );
    return 2;
  }

  const initiator = resolveInitiator(deps);
  const client =
    deps.client ??
    createCrossHostControlPlaneClient({
      ...(deps.clientOptions ?? {}),
    });

  const fanned: readonly HostTaggedResult<DlqMutationResponse>[] = await fanOut(
    targets,
    async (h) => {
      if (op === 'drop') {
        return await client.dropDlqEntry(h, { kind, id: args.id as string, initiator });
      }
      return await client.requeueDlqEntry(h, { kind, id: args.id as string, initiator });
    },
  );

  // Every host's outcome — success or transport failure — tagged with
  // the FleetHost name. The client promises a DlqMutationResponse even
  // on logical failure (404 → `ok: false`) so the `err` branch here
  // only fires on transport / 5xx / auth failures.
  const rows: FleetDlqMutationHostRow[] = fanned.map((r) =>
    'ok' in r.result
      ? { host: r.host, ok: r.result.ok.ok, response: r.result.ok }
      : { host: r.host, ok: false, error: r.result.err },
  );

  if (args.json === true) {
    io.out(`${JSON.stringify({ op, kind, id: args.id, hosts: rows }, null, 2)}\n`);
  } else {
    io.out(`${op} dispatch-DLQ id "${args.id}" across ${rows.length} host(s):\n`);
    for (const r of rows) {
      if (r.error) {
        const statusCol = r.error.status !== undefined ? `HTTP ${r.error.status}` : 'ERR';
        io.out(`  ✗ ${r.host.padEnd(20)}  ${statusCol.padEnd(10)}  ${r.error.message}\n`);
        continue;
      }
      const body = r.response;
      if (!body) continue;
      const marker = body.ok ? '✓' : '✗';
      const reason = body.ok ? '' : `  (${body.reason ?? 'unknown'})`;
      const attempts =
        body.attemptsBeforeOp !== undefined ? `  attemptsBefore=${body.attemptsBeforeOp}` : '';
      io.out(`  ${marker} ${r.host.padEnd(20)}  ${body.message ?? ''}${attempts}${reason}\n`);
    }
  }

  // Exit-code policy:
  //   0 — every targeted host succeeded (all `ok: true`).
  //   1 — at least one host failed (transport OR logical miss).
  //   This matches Sprint 4's snapshot policy: partial success still
  //   exits non-zero so `set -e` scripts halt on any host failure.
  const anyFailed = rows.some((r) => !r.ok);
  return anyFailed ? 1 : 0;
}

export async function fleetDlqDrop(
  args: FleetDlqMutationArgs = {},
  deps: FleetDlqMutationDeps = {},
): Promise<number> {
  return runFleetDlqMutation('drop', args, deps);
}

export async function fleetDlqRequeue(
  args: FleetDlqMutationArgs = {},
  deps: FleetDlqMutationDeps = {},
): Promise<number> {
  return runFleetDlqMutation('requeue', args, deps);
}

// ── Helpers for tests ──────────────────────────────────────────────────

/** Exported so tests can assert on the helper array shape. */
export type { HostTaggedResult } from './cross-host-control-plane-client.js';
