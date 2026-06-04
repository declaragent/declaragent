import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type ConfiguredSource,
  type EventSourceAdapter,
  createCronAdapter,
  createExtensionRegistry,
  createFileWatchAdapter,
  createPermissionGate,
  createWebhookAdapter,
  startDaemon,
} from '@declaragent/core';
import { connectDaemonClient } from './daemon-client.js';
import { startDaemonSocket } from './daemon-socket.js';
import {
  daemonPidPath,
  daemonSocketPath,
  eventSourcesConfigPath,
  sessionsDbPath,
} from './paths.js';

function loadConfiguredSources(): readonly ConfiguredSource[] {
  const path = eventSourcesConfigPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      process.stderr.write(
        `warning: ${path} is not an array; ignoring. Expected [{type, config}, ...].\n`,
      );
      return [];
    }
    const out: ConfiguredSource[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { type?: unknown; config?: unknown };
      if (typeof e.type !== 'string') continue;
      out.push({ type: e.type, config: e.config ?? {} });
    }
    return out;
  } catch (err) {
    process.stderr.write(
      `warning: failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

function builtinAdapters(): Record<string, EventSourceAdapter<unknown>> {
  return {
    cron: createCronAdapter() as EventSourceAdapter<unknown>,
    webhook: createWebhookAdapter() as EventSourceAdapter<unknown>,
    'file-watch': createFileWatchAdapter() as EventSourceAdapter<unknown>,
  };
}

/**
 * `declaragent daemon` — foreground daemon entry. No engine wiring yet;
 * this slice's daemon handles routing + control plane. Engine integration
 * (so webhook → skill → outbound HTTP works end-to-end) lands once the
 * provider/auth glue from `app.tsx` is extracted for reuse.
 */
export async function daemonStart(): Promise<number> {
  const socketPath = daemonSocketPath();
  const pidPath = daemonPidPath();
  const sources = loadConfiguredSources();

  const db = new Database(sessionsDbPath(), { create: true });
  db.exec('PRAGMA journal_mode = WAL;');

  const registry = createExtensionRegistry({
    logger: {
      debug() {},
      info() {},
      warn: (event, data) => process.stderr.write(`${event} ${JSON.stringify(data ?? {})}\n`),
      error: (event, data) => process.stderr.write(`${event} ${JSON.stringify(data ?? {})}\n`),
      child() {
        return this as never;
      },
    },
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    configDir: '',
  });

  const daemon = await startDaemon({
    db,
    registry,
    adapters: builtinAdapters(),
    sources,
    // SIGHUP + control-plane `reload` with no args both consult this to
    // re-derive the desired source list from disk.
    sourcesProvider: () => loadConfiguredSources(),
  });

  const server = await startDaemonSocket({ daemon, socketPath });
  writeFileSync(pidPath, String(process.pid));
  process.stdout.write(`daemon listening on ${socketPath} (pid ${process.pid})\n`);

  const cleanup = async (): Promise<void> => {
    await server.close();
    try {
      if (existsSync(pidPath)) writeFileSync(pidPath, '');
    } catch {
      // ignore
    }
  };

  process.on('SIGINT', () => {
    void daemon.shutdown();
  });
  process.on('SIGTERM', () => {
    void daemon.shutdown();
  });
  process.on('SIGHUP', () => {
    void daemon.reload().then((result) => {
      process.stdout.write(
        `reload: +${result.added.length} -${result.removed.length} ~${result.changed.length} =${result.unchanged.length}\n`,
      );
    });
  });

  await daemon.waitForShutdown();
  await cleanup();
  db.close();
  return 0;
}

async function callDaemon<T>(
  body: (client: Awaited<ReturnType<typeof connectDaemonClient>>) => Promise<T>,
): Promise<T | null> {
  const socketPath = daemonSocketPath();
  if (!existsSync(socketPath)) {
    process.stderr.write(
      `no daemon socket at ${socketPath}. Start one with 'declaragent daemon'.\n`,
    );
    return null;
  }
  let client: Awaited<ReturnType<typeof connectDaemonClient>> | null = null;
  try {
    client = await connectDaemonClient(socketPath);
    return await body(client);
  } catch (err) {
    process.stderr.write(
      `failed to talk to daemon: ${err instanceof Error ? err.message : String(err)}\n  confirm it is running with 'declaragent daemon-status', or (re)start it with 'declaragent daemon'.\n`,
    );
    return null;
  } finally {
    client?.close();
  }
}

export async function daemonStatus(): Promise<number> {
  const result = await callDaemon(async (client) =>
    client.call({ id: 'cli-status', method: 'status' }),
  );
  if (!result) return 1;
  if (result.method !== 'status') {
    process.stderr.write(
      `unexpected response method "${result.method}" (wanted "status"). Restart the daemon with 'declaragent daemon' and retry.\n`,
    );
    return 1;
  }
  if ('error' in result) {
    process.stderr.write(
      `status failed: ${result.error.message}\n  the daemon rejected the call; check its log and retry, or restart it with 'declaragent daemon'.\n`,
    );
    return 1;
  }
  const status = result.result;
  process.stdout.write(`uptime: ${Math.round(status.uptimeMs / 1000)}s\n`);
  process.stdout.write(`bus recent: ${status.busRecentCount}\n`);
  if (status.sources.length === 0) {
    process.stdout.write('sources: (none)\n');
  } else {
    process.stdout.write('sources:\n');
    for (const s of status.sources) {
      process.stdout.write(
        `  ${s.type}:${s.id} — ${s.health.status}, published=${s.metrics.eventsPublished}\n`,
      );
    }
  }
  if (status.mailbox.length > 0) {
    process.stdout.write('mailbox:\n');
    for (const m of status.mailbox) {
      process.stdout.write(`  ${m.agent}: ${m.depth}\n`);
    }
  }
  return 0;
}

export async function daemonReload(): Promise<number> {
  const result = await callDaemon(async (client) =>
    client.call({ id: 'cli-reload', method: 'reload' }),
  );
  if (!result) return 1;
  if ('error' in result) {
    process.stderr.write(
      `reload failed: ${result.error.message}\n  the daemon rejected the call; check its log and retry, or restart it with 'declaragent daemon'.\n`,
    );
    return 1;
  }
  if (result.method !== 'reload') {
    process.stderr.write(
      `unexpected response method "${result.method}" (wanted "reload"). Restart the daemon with 'declaragent daemon' and retry.\n`,
    );
    return 1;
  }
  const diff = result.result;
  process.stdout.write(
    `reload: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length} =${diff.unchanged.length}\n`,
  );
  for (const k of diff.added) process.stdout.write(`  + ${k}\n`);
  for (const k of diff.removed) process.stdout.write(`  - ${k}\n`);
  for (const k of diff.changed) process.stdout.write(`  ~ ${k}\n`);
  return 0;
}

export async function daemonShutdown(drain = true): Promise<number> {
  const result = await callDaemon(async (client) =>
    client.call({ id: 'cli-shutdown', method: 'shutdown', params: { drain } }),
  );
  if (!result) return 1;
  if ('error' in result) {
    process.stderr.write(
      `shutdown failed: ${result.error.message}\n  the daemon rejected the call; check its log and retry, or restart it with 'declaragent daemon'.\n`,
    );
    return 1;
  }
  process.stdout.write('shutdown acknowledged.\n');
  return 0;
}
