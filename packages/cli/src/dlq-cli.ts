import { existsSync } from 'node:fs';
import type { DLQEntry } from '@declaragent/core';
import { connectDaemonClient } from './daemon-client.js';
import { daemonSocketPath } from './paths.js';

export interface DlqCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: DlqCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface DlqCliDeps {
  io?: DlqCliIO;
  /** Daemon socket path. Defaults to `daemonSocketPath()`. */
  socketPath?: string;
}

async function callDaemon<
  T extends {
    id: string;
    method: string;
    params?: Record<string, unknown>;
  },
>(
  request: T,
  deps: DlqCliDeps,
  io: DlqCliIO,
): Promise<
  | { code: 1 }
  | {
      code: 0;
      client: Awaited<ReturnType<typeof connectDaemonClient>>;
      resp: Awaited<ReturnType<Awaited<ReturnType<typeof connectDaemonClient>>['call']>>;
    }
> {
  const socketPath = deps.socketPath ?? daemonSocketPath();
  if (!existsSync(socketPath)) {
    io.err(`✗ daemon not running (no socket at ${socketPath})\n`);
    return { code: 1 };
  }
  const client = await connectDaemonClient(socketPath);
  // biome-ignore lint/suspicious/noExplicitAny: ControlRequest union is narrowed by the caller; this helper forwards it.
  const resp = await client.call(request as any);
  if ('error' in resp) {
    io.err(`✗ ${request.method} failed: ${resp.error.message}\n`);
    client.close();
    return { code: 1 };
  }
  return { code: 0, client, resp };
}

export interface DlqListArgs {
  source: string;
  since?: number;
  limit?: number;
}

/** `declaragent dlq list --source <id> [--since <ms>] [--limit <n>]` */
export async function dlqList(args: DlqListArgs, deps: DlqCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const result = await callDaemon(
    {
      id: 'cli-dlq-list',
      method: 'dlq-list',
      params: {
        sourceId: args.source,
        ...(args.since !== undefined && { sinceMs: args.since }),
        ...(args.limit !== undefined && { limit: args.limit }),
      },
    },
    deps,
    io,
  );
  if (result.code === 1) return 1;
  const { client, resp } = result;
  try {
    if (resp.method !== 'dlq-list' || 'error' in resp) return 1;
    const entries = resp.result.entries;
    if (entries.length === 0) {
      io.out(`no DLQ entries for source "${args.source}".\n`);
      return 0;
    }
    io.out(`dlq entries (${entries.length}) for source "${args.source}":\n`);
    for (const e of entries) {
      const ts = e.insertedAtMs ? new Date(e.insertedAtMs).toISOString() : '(no timestamp)';
      const reason = e.reason ?? '(no reason)';
      io.out(`  ${ts.padEnd(28)}  ${e.id.padEnd(40)}  ${reason}\n`);
    }
    return 0;
  } finally {
    client.close();
  }
}

/** `declaragent dlq show --source <id> <entryId>` */
export async function dlqShow(
  sourceId: string,
  entryId: string,
  deps: DlqCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const result = await callDaemon(
    {
      id: 'cli-dlq-show',
      method: 'dlq-show',
      params: { sourceId, entryId },
    },
    deps,
    io,
  );
  if (result.code === 1) return 1;
  const { client, resp } = result;
  try {
    if (resp.method !== 'dlq-show' || 'error' in resp) return 1;
    const entry: DLQEntry | null = resp.result.entry;
    if (!entry) {
      io.err(
        `✗ DLQ entry "${entryId}" not found on source "${sourceId}" — list current entries with \`declaragent dlq list --source ${sourceId}\`.\n`,
      );
      return 1;
    }
    io.out(JSON.stringify(entry, null, 2));
    io.out('\n');
    return 0;
  } finally {
    client.close();
  }
}

/** `declaragent dlq redrive --source <id> <entryId>` */
export async function dlqRedrive(
  sourceId: string,
  entryId: string,
  deps: DlqCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const result = await callDaemon(
    {
      id: 'cli-dlq-redrive',
      method: 'dlq-redrive',
      params: { sourceId, entryId },
    },
    deps,
    io,
  );
  if (result.code === 1) return 1;
  const { client, resp } = result;
  try {
    if (resp.method !== 'dlq-redrive' || 'error' in resp) return 1;
    io.out(`redriven ${entryId} from source "${sourceId}".\n`);
    return 0;
  } finally {
    client.close();
  }
}
